// api/interpret.js
// Vercel 서버리스 함수
// - 서버 캐시: gpt-5.4 결과 영구 저장
// - 토큰 사용량 추적: 호출마다 입력/출력 토큰 누적
// - v3 정규화 캐시 + v2 호환성 (페이지 간 캐시 공유)

import { createClient } from "redis";
import crypto from "crypto";

let redisClient = null;
async function getRedis() {
  if (redisClient && redisClient.isOpen) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on("error", (err) => console.error("Redis 오류:", err));
  await redisClient.connect();
  return redisClient;
}

function getKoreaDate() {
  const now = new Date();
  const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return korea.toISOString().split("T")[0];
}

function getKoreaSlot() {
  const now = new Date();
  const korea = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hour = korea.getUTCHours();
  const minute = korea.getUTCMinutes();
  return hour * 2 + (minute >= 30 ? 1 : 0);
}

const DAY = 24 * 60 * 60;
const RETENTION_DAU = 365 * DAY;
const RETENTION_MAU = 365 * DAY;
const RETENTION_SLOT = 60 * DAY;
const RETENTION_CALLS = 365 * DAY;
const RETENTION_MAU_SNAP = 365 * DAY;
const RETENTION_COHORT = 365 * DAY;
const RETENTION_FIRST_SEEN = 730 * DAY;
const RETENTION_TOKENS = 730 * DAY;

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex").substring(0, 16);
}

// ─────────────────────────────────────────────────────────
// 텍스트 정규화
// 같은 지문이라도 페이지마다 미세한 공백/줄바꿈 차이가 있을 수 있으므로
// 정규화해서 일관된 캐시 키 생성
// ─────────────────────────────────────────────────────────
function normalizeText(text) {
  return text
    .replace(/\s+/g, " ")  // 모든 공백/줄바꿈을 단일 공백으로
    .trim();
}

async function recordUsage(userId) {
  if (!userId) return;
  try {
    const redis = await getRedis();
    const today = getKoreaDate();
    const slot = getKoreaSlot();
    const month = today.substring(0, 7);

    await redis.sAdd(`dau:${today}`, userId);
    await redis.sAdd(`mau:${month}`, userId);
    await redis.expire(`dau:${today}`, RETENTION_DAU);
    await redis.expire(`mau:${month}`, RETENTION_MAU);

    await redis.incr(`calls:${today}`);
    await redis.expire(`calls:${today}`, RETENTION_CALLS);
    await redis.incr(`slot:${today}:${slot}`);
    await redis.expire(`slot:${today}:${slot}`, RETENTION_SLOT);

    const currentMau = await redis.sCard(`mau:${month}`);
    await redis.set(`mau_snapshot:${today}`, currentMau);
    await redis.expire(`mau_snapshot:${today}`, RETENTION_MAU_SNAP);

    const firstSeenKey = `first_seen:${userId}`;
    const isNewUser = await redis.set(firstSeenKey, today, { NX: true });
    if (isNewUser) {
      await redis.sAdd(`cohort:${today}`, userId);
      await redis.expire(`cohort:${today}`, RETENTION_COHORT);
      await redis.expire(firstSeenKey, RETENTION_FIRST_SEEN);
    }
  } catch (err) {
    console.error("사용량 기록 실패:", err);
  }
}

async function recordTokens(promptTokens, completionTokens) {
  try {
    const redis = await getRedis();
    const today = getKoreaDate();
    const month = today.substring(0, 7);

    await redis.incrBy(`tokens_prompt:${today}`, promptTokens);
    await redis.incrBy(`tokens_completion:${today}`, completionTokens);
    await redis.expire(`tokens_prompt:${today}`, RETENTION_TOKENS);
    await redis.expire(`tokens_completion:${today}`, RETENTION_TOKENS);

    await redis.incrBy(`tokens_prompt:${month}`, promptTokens);
    await redis.incrBy(`tokens_completion:${month}`, completionTokens);
    await redis.expire(`tokens_prompt:${month}`, RETENTION_TOKENS);
    await redis.expire(`tokens_completion:${month}`, RETENTION_TOKENS);

    await redis.incrBy(`tokens_prompt:total`, promptTokens);
    await redis.incrBy(`tokens_completion:total`, completionTokens);

    await redis.incr(`ai_calls:${today}`);
    await redis.incr(`ai_calls:${month}`);
    await redis.incr(`ai_calls:total`);
    await redis.expire(`ai_calls:${today}`, RETENTION_TOKENS);
    await redis.expire(`ai_calls:${month}`, RETENTION_TOKENS);
  } catch (err) {
    console.error("토큰 기록 실패:", err);
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
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

  recordUsage(userId);

  try {
    const redis = await getRedis();

    // ─── 캐시 키 만들기 ───
    // v3: 정규화된 텍스트 기반 (페이지 간 공유됨)
    // v2: 원본 텍스트 기반 (기존 캐시, 호환성 유지)
    const normalizedText = normalizeText(questionText);
    const cacheKeyV3 = `problem_cache_v3:${hashText(normalizedText)}`;
    const cacheKeyV2 = `problem_cache_v2:${hashText(questionText)}`;

    // 1순위: v3 정규화 캐시 조회
    const cachedV3 = await redis.get(cacheKeyV3);
    if (cachedV3) {
      console.log("[캐시 히트 v3]");
      return res.status(200).json({ data: JSON.parse(cachedV3) });
    }

    // 2순위: v2 기존 캐시 조회 (호환성)
    const cachedV2 = await redis.get(cacheKeyV2);
    if (cachedV2) {
      console.log("[캐시 히트 v2 → v3로 마이그레이션]");
      // v3 키로도 저장해서 다음번엔 v3에서 바로 적중
      await redis.set(cacheKeyV3, cachedV2);
      return res.status(200).json({ data: JSON.parse(cachedV2) });
    }

    // 3순위: 캐시 없음 → AI 호출
    console.log("[캐시 미스] gpt-5.4 호출");

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

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: "gpt-5.4",
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

    if (openaiData.usage) {
      const promptTokens = openaiData.usage.prompt_tokens || 0;
      const completionTokens = openaiData.usage.completion_tokens || 0;
      console.log(`[토큰] prompt=${promptTokens}, completion=${completionTokens}`);
      recordTokens(promptTokens, completionTokens);
    }

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

    // v3 키로 저장 (앞으로는 정규화된 키 사용)
    await redis.set(cacheKeyV3, JSON.stringify(parsed.interpretations));

    return res.status(200).json({ data: parsed.interpretations });

  } catch (err) {
    console.error("서버 오류:", err);
    return res.status(500).json({ error: "서버 오류: " + err.message });
  }
}
