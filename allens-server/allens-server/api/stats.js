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

function getDayOfWeek(dateStr) {
  return new Date(dateStr + "T00:00:00Z").getUTCDay();
}

function getMondayOfWeek(dateStr) {
  const dow = getDayOfWeek(dateStr);
  const daysBack = dow === 0 ? 6 : dow - 1;
  return addDays(dateStr, -daysBack);
}

function retentionToColor(pct) {
  if (pct === null) return "#f9fafb";
  const lightness = 95 - (pct / 100) * 65;
  return `hsl(250, 70%, ${lightness}%)`;
}

function retentionToTextColor(pct) {
  if (pct === null) return "#9ca3af";
  return pct >= 50 ? "#ffffff" : "#111827";
}

// 토큰 → 비용 계산 (gpt-5.4 기준)
// 입력: $2.50 / 1M, 출력: $15.00 / 1M
// 환율 약 1,350원/달러 가정
function calculateCost(promptTokens, completionTokens) {
  const promptCostUsd = (promptTokens / 1_000_000) * 2.50;
  const completionCostUsd = (completionTokens / 1_000_000) * 15.00;
  const totalUsd = promptCostUsd + completionCostUsd;
  const totalKrw = totalUsd * 1350;
  return { usd: totalUsd, krw: totalKrw };
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

    // DB에 저장된 문제 수
    let cachedProblemCount = 0;
    try {
      let cursor = 0;
      do {
        const result = await redis.scan(cursor, { MATCH: "problem_cache_v2:*", COUNT: 1000 });
        cursor = result.cursor;
        cachedProblemCount += result.keys.length;
      } while (cursor !== 0);
    } catch (e) {
      console.error("캐시 개수 조회 실패:", e);
    }

    // 토큰 사용량 + 비용 조회 (오늘/이번달/전체)
    async function getTokenStats(key) {
      const prompt = parseInt((await redis.get(`tokens_prompt:${key}`)) || 0);
      const completion = parseInt((await redis.get(`tokens_completion:${key}`)) || 0);
      const aiCalls = parseInt((await redis.get(`ai_calls:${key}`)) || 0);
      const cost = calculateCost(prompt, completion);
      return { prompt, completion, total: prompt + completion, aiCalls, cost };
    }

    const todayTokens = await getTokenStats(today);
    const monthTokens = await getTokenStats(currentMonth);
    const totalTokens = await getTokenStats("total");

    // 최근 7일 DAU
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

    // 최근 3개월 MAU
    const mauData = [];
    for (let i = 0; i < 3; i++) {
      const now = new Date();
      const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      korea.setUTCMonth(korea.getUTCMonth() - i);
      const monthStr = korea.toISOString().substring(0, 7);
      const userCount = await redis.sCard(`mau:${monthStr}`);
      mauData.push({ month: monthStr, users: userCount });
    }

    // 시간대별 호출 수
    const hourlyData = [];
    for (let hour = 0; hour < 24; hour++) {
      const slot1 = hour * 2;
      const slot2 = hour * 2 + 1;
      const count1 = parseInt((await redis.get(`slot:${today}:${slot1}`)) || 0);
      const count2 = parseInt((await redis.get(`slot:${today}:${slot2}`)) || 0);
      hourlyData.push({ hour, calls: count1 + count2 });
    }

    let cumulative = 0;
    const cumulativeData = hourlyData.map(d => {
      cumulative += d.calls;
      return { hour: d.hour, calls: cumulative };
    });

    // 이번 달 일별 MAU
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

    // Retention 지표
    const todayDau = await redis.sCard(`dau:${today}`);
    const thisMau = await redis.sCard(`mau:${currentMonth}`);
    const stickiness = thisMau > 0 ? ((todayDau / thisMau) * 100).toFixed(1) : 0;

    const cohortKeys90 = [];
    for (let i = 0; i < 90; i++) cohortKeys90.push(`cohort:${getKoreaDate(-i)}`);
    let totalUsers = 0;
    try {
      totalUsers = await redis.sUnionStore("temp:total_users", cohortKeys90);
      await redis.del("temp:total_users");
    } catch (e) { totalUsers = 0; }

    const dauKeys7 = [];
    for (let i = 0; i < 7; i++) dauKeys7.push(`dau:${getKoreaDate(-i)}`);
    let active7 = 0;
    try {
      active7 = await redis.sUnionStore("temp:active7", dauKeys7);
      await redis.del("temp:active7");
    } catch (e) { active7 = 0; }

    const dauKeys30 = [];
    for (let i = 0; i < 30; i++) dauKeys30.push(`dau:${getKoreaDate(-i)}`);
    let active30 = 0;
    try {
      active30 = await redis.sUnionStore("temp:active30", dauKeys30);
      await redis.del("temp:active30");
    } catch (e) { active30 = 0; }

    const rolling7 = totalUsers > 0 ? ((active7 / totalUsers) * 100).toFixed(1) : 0;
    const rolling30 = totalUsers > 0 ? ((active30 / totalUsers) * 100).toFixed(1) : 0;

    // Cohort Retention
    const COHORT_WEEKS = 12;
    const thisWeekMonday = getMondayOfWeek(today);
    const cohortTable = [];

    for (let weeksAgo = 0; weeksAgo < COHORT_WEEKS; weeksAgo++) {
      const weekStart = addDays(thisWeekMonday, -weeksAgo * 7);
      const weekEnd = addDays(weekStart, 6);

      const weekCohortKeys = [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(weekStart, i);
        if (d > today) break;
        weekCohortKeys.push(`cohort:${d}`);
      }

      let cohortSize = 0;
      if (weekCohortKeys.length > 0) {
        try {
          cohortSize = await redis.sUnionStore(`temp:cohort_${weeksAgo}`, weekCohortKeys);
        } catch (e) { cohortSize = 0; }
      }

      const weekRetentions = [];
      for (let week = 0; week < COHORT_WEEKS; week++) {
        const measureWeekStart = addDays(weekStart, week * 7);
        if (measureWeekStart > today) { weekRetentions.push(null); continue; }
        if (cohortSize === 0) { weekRetentions.push(null); continue; }

        const dauUnionKeys = [];
        for (let i = 0; i < 7; i++) {
          const d = addDays(measureWeekStart, i);
          if (d > today) break;
          dauUnionKeys.push(`dau:${d}`);
        }

        if (dauUnionKeys.length === 0) { weekRetentions.push(null); continue; }

        try {
          const measureDauKey = `temp:measure_${weeksAgo}_${week}`;
          await redis.sUnionStore(measureDauKey, dauUnionKeys);
          const intersectKey = `temp:intersect_${weeksAgo}_${week}`;
          const intersectSize = await redis.sInterStore(
            intersectKey,
            [`temp:cohort_${weeksAgo}`, measureDauKey]
          );
          await redis.del(measureDauKey).catch(() => {});
          await redis.del(intersectKey).catch(() => {});
          const pct = (intersectSize / cohortSize) * 100;
          weekRetentions.push(Math.round(pct));
        } catch (e) {
          weekRetentions.push(null);
        }
      }

      await redis.del(`temp:cohort_${weeksAgo}`).catch(() => {});
      cohortTable.push({
        period: `${weekStart} ~ ${weekEnd}`,
        cohortSize,
        retentions: weekRetentions,
      });
    }

    // ─── 그래프 그리기 헬퍼 ───
    function buildHourlyChart(data, yMax, yStep, barColor) {
      const chartHeight = 220;
      const barWidth = 22;
      const barGap = 4;
      const chartLeft = 36;
      const chartTop = 10;
      const chartInner = 24 * (barWidth + barGap);
      const chartWidth = chartLeft + chartInner;

      const yGridLines = [];
      const yLabels = [];
      for (let y = 0; y <= yMax; y += yStep) {
        const yPos = chartTop + chartHeight - (y / yMax) * chartHeight;
        yGridLines.push(
          `<line x1="${chartLeft}" y1="${yPos}" x2="${chartLeft + chartInner}" y2="${yPos}" stroke="#d1d5db" stroke-width="1" stroke-dasharray="3,3"/>`
        );
        yLabels.push(
          `<text x="${chartLeft - 6}" y="${yPos + 4}" font-size="11" fill="#6b7280" text-anchor="end">${y}</text>`
        );
      }

      const bars = data.map((d) => {
        const x = chartLeft + d.hour * (barWidth + barGap);
        const h = Math.min(d.calls, yMax) / yMax * chartHeight;
        const y = chartTop + chartHeight - h;
        return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="${d.calls > 0 ? barColor : "#e5e7eb"}" rx="2">
          <title>${String(d.hour).padStart(2, "0")}시: ${d.calls}회</title>
        </rect>`;
      }).join("");

      const xLabels = [];
      for (let h = 0; h <= 24; h += 3) {
        const x = chartLeft + h * (barWidth + barGap);
        xLabels.push(
          `<text x="${x}" y="${chartTop + chartHeight + 20}" font-size="11" fill="#6b7280">${String(h).padStart(2, "0")}시</text>`
        );
      }

      return {
        svg: `<svg width="${chartWidth}" height="${chartTop + chartHeight + 35}" xmlns="http://www.w3.org/2000/svg">
          ${yGridLines.join("")}
          ${yLabels.join("")}
          ${bars}
          ${xLabels.join("")}
        </svg>`,
        maxValue: Math.max(...data.map(d => d.calls), 0),
      };
    }

    const hourlyChart = buildHourlyChart(hourlyData, 100, 10, "#4f46e5");
    const cumulativeChart = buildHourlyChart(cumulativeData, 300, 20, "#10b981");

    // 일별 MAU 그래프
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

    const cohortHeaders = [];
    for (let w = 0; w < COHORT_WEEKS; w++) {
      cohortHeaders.push(`<th>W${w}</th>`);
    }

    const cohortRows = cohortTable.map(row => {
      const cells = row.retentions.map(pct => {
        if (pct === null) {
          return `<td style="background:#f9fafb;color:#d1d5db;">–</td>`;
        }
        const bgColor = retentionToColor(pct);
        const textColor = retentionToTextColor(pct);
        return `<td style="background:${bgColor};color:${textColor};font-weight:600;">${pct}%</td>`;
      }).join("");
      return `<tr>
        <td class="period-col">${row.period}</td>
        <td>${row.cohortSize}명</td>
        ${cells}
      </tr>`;
    }).join("");

    // 비용 카드 만들기 헬퍼
    function costCard(label, tokens) {
      return `
        <div class="cost-card">
          <div class="cost-label">${label}</div>
          <div class="cost-amount">₩${Math.round(tokens.cost.krw).toLocaleString()}</div>
          <div class="cost-amount-sub">($${tokens.cost.usd.toFixed(4)})</div>
          <div class="cost-detail">
            AI 호출 ${tokens.aiCalls.toLocaleString()}회<br>
            입력 ${tokens.prompt.toLocaleString()} / 출력 ${tokens.completion.toLocaleString()} 토큰
          </div>
        </div>
      `;
    }

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>알렌의 서재 조건 해석 - 통계</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 1200px; margin: 40px auto; padding: 20px; color: #222; }
h1 { font-size: 22px; }
h2 { font-size: 16px; margin-top: 30px; color: #4f46e5; }
h3 { font-size: 14px; color: #4f46e5; margin-top: 24px; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
th { background: #f9fafb; font-weight: 600; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.today { background: #fef3c7; }
.chart-box { margin-top: 16px; padding: 16px; background: #f9fafb; border-radius: 8px; }
.chart-info { color: #6b7280; font-size: 12px; margin-top: 8px; }
.chart-title { font-size: 13px; color: #4b5563; font-weight: 600; margin-bottom: 8px; }

.dual-chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
.dual-chart-box { padding: 16px; background: #f9fafb; border-radius: 8px; overflow-x: auto; }

.retention-box { margin-top: 16px; padding: 20px; background: #f9fafb; border-radius: 8px; }
.metric-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
.metric-card { background: white; padding: 16px; border-radius: 6px; border: 1px solid #e5e7eb; }
.metric-label { font-size: 13px; color: #6b7280; margin-bottom: 4px; }
.metric-value { font-size: 28px; font-weight: 600; color: #111827; }
.metric-value small { font-size: 14px; color: #6b7280; font-weight: 400; }
.metric-desc { font-size: 11px; color: #9ca3af; margin-top: 4px; }

.cohort-table { background: white; border-radius: 6px; overflow: hidden; }
.cohort-table th, .cohort-table td { text-align: center; font-size: 12px; padding: 8px 6px; border: 1px solid #e5e7eb; }
.cohort-table .period-col { text-align: left; font-size: 11px; white-space: nowrap; }
.cohort-table thead th { background: #f3f4f6; color: #4b5563; }
.cohort-scroll { overflow-x: auto; }

.cost-box { margin-top: 16px; padding: 20px; background: #f9fafb; border-radius: 8px; }
.cost-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.cost-card { background: white; padding: 16px; border-radius: 6px; border: 1px solid #e5e7eb; }
.cost-label { font-size: 13px; color: #6b7280; margin-bottom: 8px; }
.cost-amount { font-size: 24px; font-weight: 600; color: #dc2626; }
.cost-amount-sub { font-size: 12px; color: #9ca3af; margin-top: 2px; }
.cost-detail { font-size: 11px; color: #6b7280; margin-top: 8px; line-height: 1.5; }

@media (max-width: 900px) {
  .dual-chart-row, .cost-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<h1>📊 알렌의 서재 조건 해석 — 사용 통계</h1>
<p style="color:#666;font-size:13px;">업데이트: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>

<div style="margin-top:16px;padding:16px 20px;background:#eef2ff;border-radius:8px;border-left:4px solid #4f46e5;">
  <div style="font-size:13px;color:#6b7280;">💾 DB에 저장된 해석</div>
  <div style="font-size:24px;font-weight:600;color:#4f46e5;margin-top:4px;">${cachedProblemCount.toLocaleString()}<span style="font-size:14px;color:#6b7280;font-weight:400;"> 문제 / 약 8,000 문제</span></div>
  <div style="font-size:12px;color:#9ca3af;margin-top:4px;">진행률: ${((cachedProblemCount / 8000) * 100).toFixed(1)}%</div>
</div>

<h2>💰 AI 사용량 및 비용 (gpt-5.4)</h2>
<div class="cost-box">
  <div class="cost-grid">
    ${costCard("오늘", todayTokens)}
    ${costCard("이번 달 (" + currentMonth + ")", monthTokens)}
    ${costCard("전체 (누적)", totalTokens)}
  </div>
  <div class="chart-info" style="margin-top:16px;">
    * 비용은 OpenAI 응답의 실제 토큰 사용량 × 단가(입력 $2.50/M, 출력 $15.00/M) 기준<br>
    * 환율 1,350원/달러 가정 · 캐시 적중 시 AI 호출 없으므로 비용 0원
  </div>
</div>

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

  <h3>📊 Cohort Retention Table (12주 추이, 월~일 기준)</h3>
  <div class="cohort-scroll">
    <table class="cohort-table">
      <thead>
        <tr>
          <th class="period-col">가입 주차</th>
          <th>신규</th>
          ${cohortHeaders.join("")}
        </tr>
      </thead>
      <tbody>
        ${cohortRows}
      </tbody>
    </table>
  </div>
  <div class="chart-info">
    각 행 = 그 주에 처음 들어온 사용자 코호트 · W0 = 가입한 주차, W1 = 그 다음 주, ...<br>
    예: "W2 30%" = 가입한 지 2주 후에도 30%가 다시 사용 · "–" = 측정 전 (미래)<br>
    색이 진할수록 retention 높음
  </div>
</div>

<h2>📈 오늘 시간대별 호출 수 (1시간 단위)</h2>
<div class="dual-chart-row">
  <div class="dual-chart-box">
    <div class="chart-title">시간대별 호출 수</div>
    ${hourlyChart.svg}
    <div class="chart-info">
      해당 시간대에 발생한 호출 횟수 · 현재 최대값: ${hourlyChart.maxValue}회
    </div>
  </div>
  <div class="dual-chart-box">
    <div class="chart-title">시간대별 누적 호출 수</div>
    ${cumulativeChart.svg}
    <div class="chart-info">
      자정부터 해당 시간까지 누적된 호출 횟수 · 현재 누적: ${cumulativeChart.maxValue}회
    </div>
  </div>
</div>

<h2>📅 이번 달 일별 MAU 추이 (${currentMonth})</h2>
<div class="chart-box" style="overflow-x:auto;">
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
* Retention은 코드 적용 이후 가입한 사용자부터 정확히 측정됩니다.<br>
* AI 비용은 토큰 추적 코드 적용 이후 발생한 호출만 집계됩니다.
</p>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);

  } catch (err) {
    return res.status(500).json({ error: "통계 조회 실패: " + err.message });
  }
}
