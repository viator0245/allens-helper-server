// api/stats.js
import { createClient } from "redis";

let redisClient = null;
async function getRedis() {
  if (redisClient && redisClient.isOpen) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on("error", (err) => console.error("Redis 오류:", err));
  await redisClient.connect();
  return redisClient;
}

function getKoreaDate(offsetDays = 0) {
  const now = new Date();
  const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  korea.setUTCDate(korea.getUTCDate() + offsetDays);
  return korea.toISOString().split("T")[0];
}

function slotToTime(slot) {
  const hour = Math.floor(slot / 2);
  const minute = (slot % 2) * 30;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function getDaysInCurrentMonth() {
  const now = new Date();
  const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = korea.getUTCFullYear();
  const month = korea.getUTCMonth();
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function getCurrentDayOfMonth() {
  const now = new Date();
  const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return korea.getUTCDate();
}

function addDays(dateStr, days) {
  const date = new Date(dateStr + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split("T")[0];
}

// 날짜의 요일 (0=일, 1=월, ..., 6=토)
function getDayOfWeek(dateStr) {
  return new Date(dateStr + "T00:00:00Z").getUTCDay();
}

// 주어진 날짜가 속한 주의 월요일 날짜
function getMondayOfWeek(dateStr) {
  const dow = getDayOfWeek(dateStr); // 0=일, 1=월, ..., 6=토
  // 일요일이면 6일 전이 월요일, 그 외엔 (dow-1)일 전
  const daysBack = dow === 0 ? 6 : dow - 1;
  return addDays(dateStr, -daysBack);
}

export default async function handler(req, res) {
  const password = req.query.password;
  const correctPassword = process.env.STATS_PASSWORD;

  if (!correctPassword || password !== correctPassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const redis = await getRedis();
    const today = getKoreaDate(0);
    const currentMonth = today.substring(0, 7);

    // ─── 최근 7일 DAU ───
    const dauData = [];
    for (let i = 0; i < 7; i++) {
      const dateStr = getKoreaDate(-i);
      const userCount = await redis.sCard(`dau:${dateStr}`);
      const callCount = (await redis.get(`calls:${dateStr}`)) || 0;
      dauData.push({
        date: dateStr,
        users: userCount,
        calls: parseInt(callCount),
      });
    }

    // ─── 최근 3개월 MAU ───
    const mauData = [];
    for (let i = 0; i < 3; i++) {
      const now = new Date();
      const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      korea.setUTCMonth(korea.getUTCMonth() - i);
      const monthStr = korea.toISOString().substring(0, 7);
      const userCount = await redis.sCard(`mau:${monthStr}`);
      mauData.push({ month: monthStr, users: userCount });
    }

    // ─── 시간대별 호출 수 ───
    const slotData = [];
    for (let slot = 0; slot < 48; slot++) {
      const count = (await redis.get(`slot:${today}:${slot}`)) || 0;
      slotData.push({ slot, time: slotToTime(slot), calls: parseInt(count) });
    }

    // ─── 이번 달 일별 MAU 스냅샷 ───
    const daysInMonth = getDaysInCurrentMonth();
    const currentDay = getCurrentDayOfMonth();
    const dailyMauData = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${currentMonth}-${String(day).padStart(2, "0")}`;
      const isFuture = day > currentDay;
      let mauValue = 0;
      if (!isFuture) {
        const snap = await redis.get(`mau_snapshot:${dateStr}`);
        mauValue = snap ? parseInt(snap) : 0;
      }
      dailyMauData.push({ day, date: dateStr, mau: mauValue, isFuture });
    }

    // ─── Retention 계산 ───

    // 1. Stickiness
    const todayDau = await redis.sCard(`dau:${today}`);
    const thisMau = await redis.sCard(`mau:${currentMonth}`);
    const stickiness = thisMau > 0 ? ((todayDau / thisMau) * 100).toFixed(1) : 0;

    // 2. Rolling Retention
    const cohortKeys90 = [];
    for (let i = 0; i < 90; i++) {
      cohortKeys90.push(`cohort:${getKoreaDate(-i)}`);
    }
    let totalUsers = 0;
    try {
      totalUsers = await redis.sUnionStore("temp:total_users", cohortKeys90);
      await redis.del("temp:total_users");
    } catch (e) {
      totalUsers = 0;
    }

    const dauKeys7 = [];
    for (let i = 0; i < 7; i++) dauKeys7.push(`dau:${getKoreaDate(-i)}`);
    let active7 = 0;
    try {
      active7 = await redis.sUnionStore("temp:active7", dauKeys7);
      await redis.del("temp:active7");
    } catch (e) {
      active7 = 0;
    }

    const dauKeys30 = [];
    for (let i = 0; i < 30; i++) dauKeys30.push(`dau:${getKoreaDate(-i)}`);
    let active30 = 0;
    try {
      active30 = await redis.sUnionStore("temp:active30", dauKeys30);
      await redis.del("temp:active30");
    } catch (e) {
      active30 = 0;
    }

    const rolling7 = totalUsers > 0 ? ((active7 / totalUsers) * 100).toFixed(1) : 0;
    const rolling30 = totalUsers > 0 ? ((active30 / totalUsers) * 100).toFixed(1) : 0;

    // 3. Day-N Retention: 월~일 고정 주별 코호트
    // 이번 주의 월요일을 기준으로, 최근 4주의 월~일 구간을 만든다
    const thisWeekMonday = getMondayOfWeek(today);
    const retentionTable = [];

    for (let weeksAgo = 0; weeksAgo < 4; weeksAgo++) {
      const weekStart = addDays(thisWeekMonday, -weeksAgo * 7);  // 월요일
      const weekEnd = addDays(weekStart, 6);                      // 일요일

      // 그 주(월~일) 7일간의 코호트 키들
      const weekCohortKeys = [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(weekStart, i);
        // 미래 날짜는 제외
        if (d > today) break;
        weekCohortKeys.push(`cohort:${d}`);
      }

      let cohortSize = 0;
      if (weekCohortKeys.length > 0) {
        try {
          cohortSize = await redis.sUnionStore(`temp:week_cohort_${weeksAgo}`, weekCohortKeys);
        } catch (e) {
          cohortSize = 0;
        }
      }

      if (cohortSize === 0) {
        await redis.del(`temp:week_cohort_${weeksAgo}`).catch(() => {});
        retentionTable.push({
          period: `${weekStart} ~ ${weekEnd}`,
          cohortSize: 0,
          d1: null, d7: null, d14: null, d30: null,
        });
        continue;
      }

      // Day-N retention: 주 마지막 날(weekEnd)로부터 N일 후의 DAU와 교집합
      const calcRetention = async (daysOffset) => {
        const targetDate = addDays(weekEnd, daysOffset);
        if (targetDate > today) return null;
        try {
          const intersect = await redis.sInterStore(
            `temp:retention_${weeksAgo}_${daysOffset}`,
            [`temp:week_cohort_${weeksAgo}`, `dau:${targetDate}`]
          );
          await redis.del(`temp:retention_${weeksAgo}_${daysOffset}`);
          return cohortSize > 0 ? ((intersect / cohortSize) * 100).toFixed(0) : 0;
        } catch (e) {
          return null;
        }
      };

      const d1 = await calcRetention(1);
      const d7 = await calcRetention(7);
      const d14 = await calcRetention(14);
      const d30 = await calcRetention(30);

      await redis.del(`temp:week_cohort_${weeksAgo}`).catch(() => {});

      retentionTable.push({
        period: `${weekStart} ~ ${weekEnd}`,
        cohortSize,
        d1, d7, d14, d30,
      });
    }

    // ─── 시간대별 호출 그래프 ───
    const Y_MAX = 100;
    const Y_STEP = 10;
    const chartHeight = 250;
    const barWidth = 14;
    const barGap = 2;
    const chartLeft = 40;
    const chartTop = 10;
    const chartInner = 48 * (barWidth + barGap);
    const chartWidth = chartLeft + chartInner;

    const yGridLines = [];
    const yLabels = [];
    for (let y = 0; y <= Y_MAX; y += Y_STEP) {
      const yPos = chartTop + chartHeight - (y / Y_MAX) * chartHeight;
      yGridLines.push(
        `<line x1="${chartLeft}" y1="${yPos}" x2="${chartLeft + chartInner}" y2="${yPos}" stroke="#d1d5db" stroke-width="1" stroke-dasharray="3,3"/>`
      );
      yLabels.push(
        `<text x="${chartLeft - 6}" y="${yPos + 4}" font-size="11" fill="#6b7280" text-anchor="end">${y}</text>`
      );
    }

    const bars = slotData.map((d, i) => {
      const x = chartLeft + i * (barWidth + barGap);
      const h = Math.min(d.calls, Y_MAX) / Y_MAX * chartHeight;
      const y = chartTop + chartHeight - h;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="${d.calls > 0 ? "#4f46e5" : "#e5e7eb"}" rx="2">
        <title>${d.time}: ${d.calls}회</title>
      </rect>`;
    }).join("");

    const xLabels = [];
    for (let h = 0; h <= 24; h += 3) {
      const x = chartLeft + h * 2 * (barWidth + barGap);
      xLabels.push(
        `<text x="${x}" y="${chartTop + chartHeight + 20}" font-size="11" fill="#6b7280">${String(h).padStart(2, "0")}시</text>`
      );
    }

    const maxCalls = Math.max(...slotData.map((d) => d.calls), 0);

    // ─── 이번 달 일별 MAU 그래프 ───
    const maxMau = Math.max(...dailyMauData.map((d) => d.mau), 10);
    const mauYMax = Math.ceil(maxMau / 10) * 10 || 10;
    const mauYStep = Math.max(Math.ceil(mauYMax / 10), 1);

    const mauChartHeight = 250;
    const mauBarWidth = 18;
    const mauBarGap = 4;
    const mauChartLeft = 40;
    const mauChartTop = 10;
    const mauChartInner = daysInMonth * (mauBarWidth + mauBarGap);
    const mauChartWidth = mauChartLeft + mauChartInner;

    const mauYGridLines = [];
    const mauYLabels = [];
    for (let y = 0; y <= mauYMax; y += mauYStep) {
      const yPos = mauChartTop + mauChartHeight - (y / mauYMax) * mauChartHeight;
      mauYGridLines.push(
        `<line x1="${mauChartLeft}" y1="${yPos}" x2="${mauChartLeft + mauChartInner}" y2="${yPos}" stroke="#d1d5db" stroke-width="1" stroke-dasharray="3,3"/>`
      );
      mauYLabels.push(
        `<text x="${mauChartLeft - 6}" y="${yPos + 4}" font-size="11" fill="#6b7280" text-anchor="end">${y}</text>`
      );
    }

    const mauBars = dailyMauData.map((d, i) => {
      const x = mauChartLeft + i * (mauBarWidth + mauBarGap);
      const h = d.isFuture ? 0 : (d.mau / mauYMax) * mauChartHeight;
      const y = mauChartTop + mauChartHeight - h;
      const fillColor = d.isFuture ? "#f3f4f6" : (d.mau > 0 ? "#10b981" : "#e5e7eb");
      return `<rect x="${x}" y="${y}" width="${mauBarWidth}" height="${h}" fill="${fillColor}" rx="2">
        <title>${d.date}${d.isFuture ? " (예정)" : ""}: ${d.isFuture ? "-" : d.mau + "명"}</title>
      </rect>`;
    }).join("");

    const mauXLabels = [];
    for (let day = 1; day <= daysInMonth; day++) {
      if (day === 1 || day % 5 === 0 || day === daysInMonth) {
        const x = mauChartLeft + (day - 1) * (mauBarWidth + mauBarGap) + mauBarWidth / 2;
        mauXLabels.push(
          `<text x="${x}" y="${mauChartTop + mauChartHeight + 20}" font-size="11" fill="#6b7280" text-anchor="middle">${day}일</text>`
        );
      }
    }

    const formatRetention = (val) => {
      if (val === null) return '<span style="color:#9ca3af;">측정 전</span>';
      return `${val}%`;
    };

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>알렌의 서재 조건 해석 - 통계</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 1000px; margin: 40px auto; padding: 20px; color: #222; }
h1 { font-size: 22px; }
h2 { font-size: 16px; margin-top: 30px; color: #4f46e5; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
th { background: #f9fafb; font-weight: 600; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.today { background: #fef3c7; }
.chart-box { margin-top: 16px; overflow-x: auto; padding: 16px; background: #f9fafb; border-radius: 8px; }
.chart-info { color: #6b7280; font-size: 12px; margin-top: 8px; }

.retention-box { margin-top: 16px; padding: 20px; background: #f9fafb; border-radius: 8px; }
.metric-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
.metric-card { background: white; padding: 16px; border-radius: 6px; border: 1px solid #e5e7eb; }
.metric-label { font-size: 13px; color: #6b7280; margin-bottom: 4px; }
.metric-value { font-size: 28px; font-weight: 600; color: #111827; }
.metric-value small { font-size: 14px; color: #6b7280; font-weight: 400; }
.metric-desc { font-size: 11px; color: #9ca3af; margin-top: 4px; }
.retention-table th, .retention-table td { text-align: center; font-size: 13px; }
.retention-table .period-col { text-align: left; }
</style>
</head>
<body>
<h1>📊 알렌의 서재 조건 해석 — 사용 통계</h1>
<p style="color:#666;font-size:13px;">업데이트: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>

<h2>🔁 Retention (재방문 지표)</h2>
<div class="retention-box">
  <div class="metric-grid">
    <div class="metric-card">
      <div class="metric-label">Stickiness</div>
      <div class="metric-value">${stickiness}<small>%</small></div>
      <div class="metric-desc">오늘 DAU / 이번달 MAU<br>20%+: 보통, 30%+: 매우 좋음</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">7일 Rolling Retention</div>
      <div class="metric-value">${rolling7}<small>%</small></div>
      <div class="metric-desc">최근 7일 안에 쓴 사람 / 전체 누적<br>${active7}명 / ${totalUsers}명</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">30일 Rolling Retention</div>
      <div class="metric-value">${rolling30}<small>%</small></div>
      <div class="metric-desc">최근 30일 안에 쓴 사람 / 전체 누적<br>${active30}명 / ${totalUsers}명</div>
    </div>
  </div>

  <h3 style="font-size:14px;color:#4f46e5;margin-top:8px;">Day-N Retention (주별 코호트, 월~일 기준)</h3>
  <table class="retention-table">
    <thead>
      <tr>
        <th class="period-col">가입 주차</th>
        <th>신규</th>
        <th>Day 1</th>
        <th>Day 7</th>
        <th>Day 14</th>
        <th>Day 30</th>
      </tr>
    </thead>
    <tbody>
      ${retentionTable.map(r => `
        <tr>
          <td class="period-col">${r.period}</td>
          <td>${r.cohortSize}명</td>
          <td>${formatRetention(r.d1)}</td>
          <td>${formatRetention(r.d7)}</td>
          <td>${formatRetention(r.d14)}</td>
          <td>${formatRetention(r.d30)}</td>
        </tr>
      `).join("")}
    </tbody>
  </table>
  <div class="chart-info">
    각 주차(월~일)에 처음 들어온 사용자 중 N일 후에도 사용한 비율 · "측정 전"은 아직 N일이 지나지 않음
  </div>
</div>

<h2>📈 오늘 시간대별 호출 수 (30분 단위)</h2>
<div class="chart-box">
  <svg width="${chartWidth}" height="${chartTop + chartHeight + 35}" xmlns="http://www.w3.org/2000/svg">
    ${yGridLines.join("")}
    ${yLabels.join("")}
    ${bars}
    ${xLabels.join("")}
  </svg>
  <div class="chart-info">
    오늘 (${today}) · 막대 위에 마우스 올리면 정확한 시간/횟수 · 현재 최대값: ${maxCalls}회
  </div>
</div>

<h2>📅 이번 달 일별 MAU 추이 (${currentMonth})</h2>
<div class="chart-box">
  <svg width="${mauChartWidth}" height="${mauChartTop + mauChartHeight + 35}" xmlns="http://www.w3.org/2000/svg">
    ${mauYGridLines.join("")}
    ${mauYLabels.join("")}
    ${mauBars}
    ${mauXLabels.join("")}
  </svg>
  <div class="chart-info">
    각 막대 = 그날 24시 기준 누적 MAU · 매월 1일에 새로 시작 · 막대 위에 마우스 올리면 정확한 값
  </div>
</div>

<h2>최근 7일 DAU (일별 활성 사용자)</h2>
<table>
<thead><tr><th>날짜</th><th class="num">사용자 수</th><th class="num">총 호출</th></tr></thead>
<tbody>
${dauData.map((d, i) => `<tr class="${i === 0 ? "today" : ""}"><td>${d.date}${i === 0 ? " (오늘)" : ""}</td><td class="num">${d.users} 명</td><td class="num">${d.calls} 회</td></tr>`).join("")}
</tbody>
</table>

<h2>최근 3개월 MAU (월별 활성 사용자)</h2>
<table>
<thead><tr><th>월</th><th class="num">사용자 수</th></tr></thead>
<tbody>
${mauData.map((d, i) => `<tr class="${i === 0 ? "today" : ""}"><td>${d.month}${i === 0 ? " (이번달)" : ""}</td><td class="num">${d.users} 명</td></tr>`).join("")}
</tbody>
</table>

<p style="color:#999;font-size:12px;margin-top:40px;">
* DAU/MAU는 익명 설치 ID 기준이며, 한 사람이 여러 기기에 설치하면 중복 계산될 수 있습니다.<br>
* Retention은 코드 적용 이후 가입한 사용자부터 정확히 측정됩니다.
</p>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);

  } catch (err) {
    return res.status(500).json({ error: "통계 조회 실패: " + err.message });
  }
}
