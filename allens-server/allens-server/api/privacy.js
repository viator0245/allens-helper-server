// api/privacy.js
// 개인정보처리방침 페이지

export default function handler(req, res) {
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>개인정보처리방침 - 조건 해석 for 알렌의 서재</title>
<style>
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif;
  max-width: 800px;
  margin: 40px auto;
  padding: 20px;
  color: #1f2937;
  line-height: 1.7;
}
h1 { font-size: 24px; color: #111827; margin-bottom: 8px; }
h2 { font-size: 18px; color: #4f46e5; margin-top: 32px; margin-bottom: 12px; }
p { margin: 12px 0; }
ul { padding-left: 24px; }
li { margin: 6px 0; }
.meta { color: #6b7280; font-size: 14px; margin-bottom: 24px; }
.section { background: #f9fafb; padding: 16px 20px; border-radius: 8px; margin: 16px 0; }
code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
</style>
</head>
<body>
<h1>개인정보처리방침</h1>
<p class="meta">조건 해석 (알렌의 서재용 크롬 확장 프로그램) · 최종 업데이트: ${new Date().toISOString().split('T')[0]}</p>

<div class="section">
<p><strong>요약:</strong> 본 확장 프로그램은 익명 사용 통계만 수집하며, 개인을 식별할 수 있는 정보는 일절 수집하지 않습니다.</p>
</div>

<h2>1. 수집하는 정보</h2>
<p>본 확장 프로그램은 다음 정보만 수집합니다.</p>
<ul>
  <li><strong>익명 사용자 ID</strong>: 확장 프로그램 설치 시 무작위로 생성되는 문자열 (예: <code>u_abc123xyz</code>). 이 ID는 본인의 실명, 이메일, IP 주소 등 어떠한 개인정보와도 연결되지 않습니다.</li>
  <li><strong>사용 시점</strong>: "조건 해석" 기능을 사용한 날짜 및 시간 (사용량 통계 산출 목적)</li>
  <li><strong>문제 지문 및 해설 텍스트</strong>: AI 해석 요청을 처리하기 위해 일시적으로 서버로 전송됩니다.</li>
</ul>

<h2>2. 수집하지 않는 정보</h2>
<p>본 확장 프로그램은 다음 정보를 <strong>수집하지 않습니다</strong>.</p>
<ul>
  <li>이름, 이메일, 전화번호 등 개인 식별 정보</li>
  <li>알렌의 서재 로그인 정보 또는 비밀번호</li>
  <li>학습 진도, 정답률, 시험 결과 등 학습 데이터</li>
  <li>다른 웹사이트의 탐색 기록</li>
  <li>IP 주소 (서버 로그에는 일시적으로 기록될 수 있으나 영구 저장되지 않습니다)</li>
</ul>

<h2>3. 정보 이용 목적</h2>
<ul>
  <li><strong>AI 해석 제공</strong>: 지문과 해설을 OpenAI API로 전송하여 AI 해석 결과를 생성합니다.</li>
  <li><strong>서비스 개선</strong>: 익명 사용 통계(일별/월별 사용자 수, 호출 횟수)를 통해 서비스 운영 및 개선에 활용합니다.</li>
  <li><strong>비용 관리</strong>: AI 호출 횟수를 추적하여 운영 비용을 관리합니다.</li>
</ul>

<h2>4. 데이터 보관 및 처리</h2>
<ul>
  <li>AI 해석 결과는 빠른 응답을 위해 서버에 캐시됩니다(영구). 해석 결과는 개인을 식별할 수 없는 형태입니다.</li>
  <li>익명 사용 통계는 최대 1년간 보관됩니다.</li>
  <li>OpenAI API로 전송되는 텍스트는 OpenAI의 데이터 정책에 따라 처리됩니다. 자세한 내용은 <a href="https://openai.com/policies/privacy-policy" target="_blank">OpenAI 개인정보처리방침</a>을 참고하세요.</li>
</ul>

<h2>5. 제3자 제공</h2>
<p>본 확장 프로그램은 다음 제3자 서비스를 이용합니다.</p>
<ul>
  <li><strong>OpenAI</strong>: AI 해석 생성</li>
  <li><strong>Vercel</strong>: 서버 호스팅</li>
  <li><strong>Redis (via Vercel Marketplace)</strong>: 데이터 저장</li>
</ul>
<p>위 서비스 외의 제3자에게 정보를 제공하거나 판매하지 않습니다.</p>

<h2>6. 사용자의 권리</h2>
<p>사용자는 언제든지 다음 권리를 행사할 수 있습니다.</p>
<ul>
  <li><strong>이용 중단</strong>: 크롬 확장 프로그램을 삭제하면 모든 로컬 데이터(익명 사용자 ID 포함)가 함께 삭제됩니다.</li>
  <li><strong>데이터 삭제 요청</strong>: 서버에 저장된 본인의 익명 데이터 삭제를 원하시는 경우, 아래 연락처로 본인의 익명 사용자 ID를 알려주시면 삭제 처리해드립니다.</li>
</ul>

<h2>7. 보안</h2>
<ul>
  <li>서버와의 모든 통신은 HTTPS로 암호화됩니다.</li>
  <li>익명 사용자 ID는 사용자의 로컬 브라우저에만 저장되며, 다른 사용자와 공유되지 않습니다.</li>
</ul>

<h2>8. 변경 사항</h2>
<p>본 방침이 변경될 경우, 이 페이지에 업데이트된 내용을 게시합니다. 중대한 변경 사항이 있을 경우 사용자에게 별도로 안내합니다.</p>

<h2>9. 면책</h2>
<p>본 확장 프로그램은 알렌의 서재의 공식 도구가 아니며, 알렌의 서재와 무관한 비공식 보조 도구입니다. AI 해석은 학습 보조용이며, 의학적 정확성을 보장하지 않습니다. 실제 진료 및 시험 준비 시 공식 자료를 참고하시기 바랍니다.</p>

<h2>10. 문의</h2>
<p>본 방침에 관한 문의나 데이터 삭제 요청은 다음으로 연락해주세요:</p>
<p>이메일: <a href="mailto:viator0245@gmail.com">viator0245@gmail.com</a></p>

<p class="meta" style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
이 페이지는 크롬 웹스토어 등록을 위해 게시되었습니다.
</p>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
