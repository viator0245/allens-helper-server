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

export default async function handler(req, res) {
  const password = req.query.password;
  const correctPassword = process.env.STATS_PASSWORD;

  if (!correctPassword || password !== correctPassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const redis = await getRedis();

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

    // 오늘 시간대별 호출 수
    const today = getKoreaDate(0);
    const slotData = [];
    for (let slot = 0; slot < 48; slot++) {
      const count = (await redis.get(`slot:${today}:${slot}`)) || 0;
      slotData.push({ slot, time: slotToTime(slot), calls: parseInt(count) });
    }

    // ─── 그래프 SVG 설정 ───
    const Y_MAX = 100;          // Y축 최대값
    const Y_STEP = 10;          // Y축 눈금 간격
    const chartHeight = 250;
    const barWidth = 14;
    const barGap = 2;
    const chartLeft = 40;       // Y축 라벨 자리
    const chartTop = 10;
    const chartInner = 48 * (barWidth + barGap);
    const chartWidth = chartLeft + chartInner;

    // Y축 격자선 + 라벨
    const yGridLines = [];
    const yLabels = [];
    for (let y = 0; y <= Y_MAX; y += Y_STEP) {
      const yPos = chartTop + chartHeight - (y / Y_MAX) * chartHeight;
      // 점선 격자
      yGridLines.push(
        `<line x1="${chartLeft}" y1="${yPos}" x2="${chartLeft + chartInner}" y2="${yPos}" stroke="#d1d5db" stroke-width="1" stroke-dasharray="3,3"/>`
      );
      // 라벨
      yLabels.push(
        `<text x="${chartLeft - 6}" y="${yPos + 4}" font-size="11" fill="#6b7280" text-anchor="end">${y}</text>`
      );
    }

    // 막대 그리기
    const bars = slotData
      .map((d, i) => {
        const x = chartLeft + i * (barWidth + barGap);
        const h = Math.min(d.calls, Y_MAX) / Y_MAX * chartHeight;
        const y = chartTop + chartHeight - h;
        return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="${d.calls > 0 ? "#4f46e5" : "#e5e7eb"}" rx="2">
          <title>${d.time}: ${d.calls}회</title>
        </rect>`;
      })
      .join("");

    // X축 라벨 (3시간마다)
    const xLabels = [];
    for (let h = 0; h <= 24; h += 3) {
      const x = chartLeft + h * 2 * (barWidth + barGap);
      xLabels.push(
        `<text x="${x}" y="${chartTop + chartHeight + 20}" font-size="11" fill="#6b7280">${String(h).padStart(2, "0")}시</text>`
      );
    }

    const maxCalls = Math.max(...slotData.map((d) => d.calls), 0);

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>알렌의 서재 조건 해석 - 통계</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; color: #222; }
h1 { font-size: 22px; }
h2 { font-size: 16px; margin-top: 30px; color: #4f46e5; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
th { background: #f9fafb; font-weight: 600; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.today { background: #fef3c7; }
.chart-box { margin-top: 16px; overflow-x: auto; padding: 16px; background: #f9fafb; border-radius: 8px; }
.chart-info { color: #6b7280; font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<h1>📊 알렌의 서재 조건 해석 — 사용 통계</h1>
<p style="color:#666;font-size:13px;">업데이트: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>

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
* 시간대 그래프는 매일 자정(한국 시간)에 초기화되며 30분 단위로 누적됩니다.
</p>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);

  } catch (err) {
    return res.status(500).json({ error: "통계 조회 실패: " + err.message });
  }
}
