// api/stats.js
// 본인이 DAU/MAU 통계를 확인하기 위한 비밀 엔드포인트
// URL 예: https://allens-helper-server.vercel.app/api/stats?password=YOUR_PASSWORD

import { createClient } from "redis";

let redisClient = null;
async function getRedis() {
  if (redisClient && redisClient.isOpen) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on("error", (err) => console.error("Redis 오류:", err));
  await redisClient.connect();
  return redisClient;
}

export default async function handler(req, res) {
  // 비밀번호 확인 (다른 사람이 통계 못 보게)
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
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];
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
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const monthStr = date.toISOString().substring(0, 7); // YYYY-MM
      const userCount = await redis.sCard(`mau:${monthStr}`);
      mauData.push({ month: monthStr, users: userCount });
    }

    // HTML로 예쁘게 표시
    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>알렌의 서재 조건 해석 - 통계</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           max-width: 800px; margin: 40px auto; padding: 20px; color: #222; }
    h1 { font-size: 22px; }
    h2 { font-size: 16px; margin-top: 30px; color: #4f46e5; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f9fafb; font-weight: 600; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .today { background: #fef3c7; }
  </style>
</head>
<body>
  <h1>📊 알렌의 서재 조건 해석 — 사용 통계</h1>
  <p style="color:#666;font-size:13px;">업데이트: ${new Date().toLocaleString("ko-KR")}</p>

  <h2>최근 7일 DAU (일별 활성 사용자)</h2>
  <table>
    <thead><tr><th>날짜</th><th class="num">사용자 수</th><th class="num">총 호출</th></tr></thead>
    <tbody>
    ${dauData.map((d, i) => `
      <tr class="${i === 0 ? "today" : ""}">
        <td>${d.date}${i === 0 ? " (오늘)" : ""}</td>
        <td class="num">${d.users} 명</td>
        <td class="num">${d.calls} 회</td>
      </tr>`).join("")}
    </tbody>
  </table>

  <h2>최근 3개월 MAU (월별 활성 사용자)</h2>
  <table>
    <thead><tr><th>월</th><th class="num">사용자 수</th></tr></thead>
    <tbody>
    ${mauData.map((d, i) => `
      <tr class="${i === 0 ? "today" : ""}">
        <td>${d.month}${i === 0 ? " (이번달)" : ""}</td>
        <td class="num">${d.users} 명</td>
      </tr>`).join("")}
    </tbody>
  </table>

  <p style="color:#999;font-size:12px;margin-top:40px;">
    * DAU/MAU는 익명 설치 ID 기준이며, 한 사람이 여러 기기에 설치하면 중복 계산될 수 있습니다.
  </p>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);

  } catch (err) {
    console.error("통계 조회 오류:", err);
    return res.status(500).json({ error: "통계 조회 실패: " + err.message });
  }
}
