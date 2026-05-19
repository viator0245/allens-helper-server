// api/interpret.js
// Vercel 서버리스 함수 - 이용자 요청을 받아 Gemini API로 중계

export default async function handler(req, res) {
  // CORS 헤더 설정 (확장 프로그램에서 호출 가능하게)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // OPTIONS 요청 처리 (브라우저 preflight)
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // POST 요청만 허용
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { questionText, explanationText } = req.body;

  if (!questionText || !explanationText) {
    return res.status(400).json({ error: "지문과 해설이 필요합니다." });
  }

  // 텍스트 길이 제한 (악용 방지)
  if (questionText.length > 5000 || explanationText.length > 10000) {
    return res.status(400).json({ error: "텍스트가 너무 깁니다." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "서버 설정 오류입니다." });
  }

  const systemPrompt = `당신은 한국 의사 국가고시 문제를 분석하는 의학 전문가입니다.
사용자가 문제 지문과 해설을 줄 것이고, 당신의 임무는 **답을 도출하는 추론 과정에 실제로 기여하는 핵심 조건만** 골라서, 그 임상적 의미를 매핑하는 것입니다.

[선별 기준 — 매우 엄격하게 적용]
다음 셋 중 하나에 해당하는 조건만 선택합니다:
1. 해설의 추론 사슬에 직접 인용되거나 근거로 사용된 조건
2. 진단/치료 결정을 좌우하는 결정적 단서
3. 답안 선택에 직접 영향을 주는 환자 특성

[반드시 제외할 것]
- 정상 소견을 단순히 보고하는 부분 (예: "발열 없음", "부종 없음", "심음 정상"). 해설이 이걸 명시적 배제 근거로 언급한 경우에만 예외적으로 포함.
- 단순 인구학적 정보 (나이, 성별)는 해설이 그 위험 인자를 추론에 사용한 경우에만 포함.
- 검사 시행 사실의 단순 언급 — 절대 포함 안 함.
- 추론에 쓰이지 않은 동반 증상이나 과거력.

[원칙]
- 의심되면 빼세요. 한 문제에 보통 3~8개 정도가 적정합니다.
- 해설에 명시되지 않은 의학적 추측은 절대 하지 마세요.

[응답 형식 규칙]
- "phrase": 지문에 등장하는 문구와 정확히 일치 (띄어쓰기·문장부호·숫자까지 동일)
- "short": 4~10자. 단순 현상이 아니라 답에 어떻게 기여하는지가 드러나게.
- "long": 2~4문장. (1) 임상적 의미, (2) 해설에서의 역할, (3) 답과의 연결.
- JSON 객체 하나만 출력. 다른 설명/주석 절대 금지.

응답 형식:
{
  "interpretations": [
    { "phrase": "지문에 그대로 나온 문구", "short": "추론 기여 요약", "long": "설명" }
  ]
}`;

  const userPrompt = `[지문]
${questionText}

[해설]
${explanationText}

위 지문과 해설을 바탕으로, 답을 도출하는 데 실제로 기여한 핵심 조건만 골라서 매핑하세요.`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            {
              parts: [{ text: userPrompt }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API 오류:", errText);
      return res.status(502).json({ error: "AI 호출에 실패했습니다." });
    }

    const geminiData = await geminiRes.json();
    const content = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!content) {
      return res.status(502).json({ error: "AI 응답이 비어 있습니다." });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return res.status(502).json({ error: "AI 응답 파싱 실패: " + content.substring(0, 200) });
    }

    if (!Array.isArray(parsed.interpretations)) {
      return res.status(502).json({ error: "AI 응답 형식 오류" });
    }

    return res.status(200).json({ data: parsed.interpretations });

  } catch (err) {
    console.error("서버 오류:", err);
    return res.status(500).json({ error: "서버 오류: " + err.message });
  }
}
