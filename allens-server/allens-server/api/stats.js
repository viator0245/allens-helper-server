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

export default async function handler(req, res) {
  const password = req.query.password;
  const correctPassword = process.env.STATS_PASSWORD;

  if (!correctPassword || password !== correctPassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const redis = await getRedis();

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

    const mauData = [];
    for (let i = 0; i < 3; i++) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const monthStr = date.toISOString().substring(0, 7);
      const userCount = await redis.sCard(`mau:${monthStr}`);
      mauData.push({ month: monthStr, users: userCount });
    }

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>알렌의 서재 조건 해석 - 통계</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
h1 { font-size: 22px; }
h2 { font-size: 16px; margin-top: 30px; color: #4f46e5; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
th { background: #f9fafb; }
.num { text-align: right; }
.today { background: #fef3c7; }
</style>
</head>
<body>
<h1>📊 알렌의 서재 조건 해석 — 사용 통계</h1>
<p>업데이트: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })}</p>
<h2>최근 7일 DAU</h2>
<table>
<thead><tr><th>날짜</th><th class="num">사용자</th><th class="num">호출</th></tr></thead>
<tbody>
${dauData.map((d, i) => `<tr class="${i === 0 ? "today" : ""}"><td>${d.date}${i === 0 ? " (오늘)" : ""}</td><td class="num">${d.users} 명</td><td class="num">${d.calls} 회</td></tr>`).join("")}
</tbody>
</table>
<h2>최근 3개월 MAU</h2>
<table>
<thead><tr><th>월</th><th class="num">사용자</th></tr></thead>
<tbody>
${mauData.map((d, i) => `<tr class="${i === 0 ? "today" : ""}"><td>${d.month}${i === 0 ? " (이번달)" : ""}</td><td class="num">${d.users} 명</td></tr>`).join("")}
</tbody>
</table>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);

  } catch (err) {
    return res.status(500).json({ error: "통계 조회 실패: " + err.message });
  }
}
