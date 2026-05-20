// api/interpret.js
// Vercel 서버리스 함수 - 이용자 요청을 받아 OpenAI API로 중계
// Redis로 DAU/MAU + 시간대별 호출수 추적

import { createClient } from "redis";

let redisClient = null;
async function getRedis() {
  if (redisClient && redisClient.isOpen) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on("error", (err) => console.error("Redis 오류:", err));
  await redisClient.connect();
  return redisClient;
}

// 한국 시간 기준 날짜 문자열 (YYYY-MM-DD)
function getKoreaDate() {
  const now = new Date();
  // UTC에 9시간 더해서 한국 시간으로 변환
  const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return korea.toISOString().split("T")[0];
}

// 한국 시간 기준 30분 슬롯 (0~47)
// 예: 00:00~00:29 → 0, 00:30~00:59 → 1, 09:00~09:29 → 18, ...
function getKoreaSlot() {
  const now = new Date();
  const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hour = korea.getUTCHours();
  const minute = korea.getUTCMinutes();
  return hour * 2 + (minute >= 30 ? 1 : 0);
}

// 사용량 기록: 날짜별 SET에 userId 추가 + 30분 슬롯별 카운터 증가
async function recordUsage(userId) {
  if (!userId) return;
  try {
    const redis = await getRedis();
    const today = getKoreaDate();
    const slot = getKoreaSlot();
    const dayKey = `dau:${today}`;
    const monthKey = `mau:${today.substring(0, 7)}`;
    const slotKey = `slot:${today}:${slot}`;

    // DAU/MAU SET에 추가 (중복 자동 제거)
    await redis.sAdd(dayKey, userId);
    await redis.sAdd(monthKey, userId);
    // 60일 후 자동 만료
    await redis.expire(dayKey, 60 * 24 * 60 * 60);
    await redis.expire(monthKey, 60 * 24 * 60 * 60);

    // 전체 호출 횟수 카운터
    await redis.incr(`calls:${today}`);
    await redis.expire(`calls:${today}`, 60 * 24 * 60 * 60);

    // 30분 슬롯별 호출 횟수 카운터
    await redis.incr(slotKey);
    await redis.expire(slotKey, 60 * 24 * 60 * 60);
  } catch (err) {
    console.error("사용량 기록 실패:", err);
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { questionText, explanationText, userId } = req.body;

  if (!questionText || !explanationText) {
    return res.status(400).json({ error: "지문과 해설이 필요합니다." });
  }

  if (questionText.length > 5000 || explanationText.length > 10000) {
    return res.status(400).json({ error: "텍스트가 너무 깁니다." });
  }

  // 사용량 기록
  recordUsage(userId);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "서버 설정 오류입니다." });
  }

  const systemPrompt = `당신은 한국 의사 국가고시 문제를 분석하는 의학 전문가입니다.
사용자가 문제 지문과 해설을 줄 것이고, 당신의 임무는 답을 도출하는 추론 과정에 실제로 기여하는 핵심 조건만 골라서, 그 임상적 의미를 매핑하는 것입니다.

[최우선 원칙]
해설의 추론에 실제로 사용된 조건만 포함합니다. 이 원칙이 모든 것에 우선합니다.
해설에 언급되지 않았거나, 정상 소견으로만 언급되었거나, 단순 배경 정보인 경우는 무조건 제외합니다.

[포함 기준 — 아래 셋 중 하나에 해당하고, 위 최우선 원칙을 만족해야 함]
1. 해설의 추론 사슬에 직접 인용되거나 근거로 사용된 조건
2. 진단/치료 결정을 좌우하는 결정적 단서
3. 답안 선택에 직접 영향을 주는 환자 특성

[이미지 검사 (심전도, 가슴 X선, 심초음파 등)도 동일 원칙 적용]
- 해설이 그 검사 결과를 추론에 사용했으면 → 지문에 나온 검사명을 phrase로, 해설의 소견을 short/long으로 작성
- 해설이 그 검사를 추론에 사용하지 않았거나 정상으로만 언급했으면 → 제외

[반드시 제외]
- 정상 소견 단순 보고 (발열 없음, 부종 없음, 심음 정상 등)
- 단순 인구학적 정보 (나이, 성별) — 해설이 위험인자로 사용한 경우만 예외
- 추론에 쓰이지 않은 동반 증상/과거력
- 해설에 근거 없는 의학적 추측

[형식 규칙]
- 한 문제에 3~8개가 적정. 의심되면 빼세요.
- phrase: 지문 원문과 정확히 일치 (띄어쓰기, 문장부호, 숫자까지 동일)
- short: 4~10자. 단순 현상이 아니라 답에 어떻게 기여하는지.
- long: 2~4문장. (1) 임상적 의미 또는 검사 소견, (2) 해설에서의 역할, (3) 답과의 연결.
- JSON만 출력. 설명/주석 금지.

{"interpretations":[{"phrase":"원문 문구","short":"요약","long":"설명"}]}`;

  const userPrompt = `[지문]
${questionText}

[해설]
${explanationText}

해설의 추론에 실제로 기여한 핵심 조건만 골라 매핑하세요. 해설에 근거 없는 항목은 절대 포함하지 마세요.`;

  try {
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error("OpenAI API 오류:", errText);
      return res.status(502).json({ error: "AI 호출에 실패했습니다." });
    }

    const openaiData = await openaiRes.json();
    const content = openaiData.choices?.[0]?.message?.content;

    if (!content) {
      return res.status(502).json({ error: "AI 응답이 비어 있습니다." });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return res.status(502).json({ error: "파싱 실패: " + content.substring(0, 200) });
    }

    if (!Array.isArray(parsed.interpretations)) {
      return res.status(502).json({ error: "응답 형식 오류" });
    }

    return res.status(200).json({ data: parsed.interpretations });

  } catch (err) {
    console.error("서버 오류:", err);
    return res.status(500).json({ error: "서버 오류: " + err.message });
  }
}
