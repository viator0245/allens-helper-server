// api/interpret.js
// Vercel 서버리스 함수 - 이용자 요청을 받아 Gemini API로 중계

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

  const { questionText, explanationText } = req.body;

  if (!questionText || !explanationText) {
    return res.status(400).json({ error: "지문과 해설이 필요합니다." });
  }

  if (questionText.length > 5000 || explanationText.length > 10000) {
    return res.status(400).json({ error: "텍스트가 너무 깁니다." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "서버 설정 오류입니다." });
  }

  const systemPrompt = `당신은 한국 의사 국가고시 문제를 분석하는 의학 전문가입니다.
사용자가 문제 지문과 해설을 줄 것이고, 당신의 임무는 답을 도출하는 추론 과정에 실제로 기여하는 핵심 조건만 골라서, 그 임상적 의미를 매핑하는 것입니다.

[선별 기준]
1. 해설의 추론 사슬에 직접 인용되거나 근거로 사용된 조건
2. 진단/치료 결정을 좌우하는 결정적 단서
3. 답안 선택에 직접 영향을 주는 환자 특성

[반드시 제외]
- 정상 소견 단순 보고 (발열 없음, 부종 없음 등). 해설이 배제 근거로 명시한 경우만 예외.
- 단순 인구학적 정보 (나이, 성별) - 해설이 위험인자로 사용한 경우만 포함.
- 검사 시행 사실의 단순 언급.
- 추론에 쓰이지 않은 동반 증상/과거력.

[원칙]
- 의심되면 빼세요. 한 문제에 3~8개가 적정.
- 해설에 없는 추측 금지.

[형식]
- phrase: 지문 원문과 정확히 일치 (띄어쓰기, 문장부호, 숫자 포함)
- short: 4~10자. 답에 어떻게 기여하는지.
- long: 2~4문장. 임상 의미 + 해설에서의 역할 + 답과의 연결.
- JSON만 출력. 설명 금지.

{"interpretations":[{"phrase":"원문 문구","short":"요약","long":"설명"}]}`;

  const userPrompt = `[지문]\n${questionText}\n\n[해설]\n${explanationText}\n\n핵심 조건만 골라 매핑하세요.`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
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

    if (!content) return res.status(502).json({ error: "AI 응답이 비어 있습니다." });

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
