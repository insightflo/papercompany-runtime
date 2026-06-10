# 디자인 시스템 가이드

`html-for-beginners` 스킬이 만드는 HTML의 시각 시스템 정의. 새 HTML을 생성하기 전 한 번 훑어볼 것.

## 디자인 토큰 (절대 변경 금지)

이 값들은 시리즈 일관성을 위해 고정. 다른 색·폰트로 바꾸지 말 것.

```css
:root{
  --bg:#f5f5f0;        /* 본문 배경 — 따뜻한 오프화이트 */
  --ink:#1a1a1a;       /* 본문 텍스트 */
  --ink-soft:#4a4a4a;  /* 부드러운 본문 */
  --ink-mute:#7a7a7a;  /* 약한 회색 (메타 정보용) */
  --line:#d8d8d0;      /* 경계선 */
  --card:#ffffff;      /* 카드 배경 */
  --accent:#e63946;    /* 강조색 — 빨강 */
  --accent-soft:#fce4e6; /* 강조 배경 약한 분홍 */

  /* 박스별 배경/테두리 */
  --term-bg:#fffaf2;       /* 노랑 (용어) */
  --term-border:#e8d9b8;
  --analogy-bg:#f0f4f8;    /* 파랑 (비유) */
  --analogy-border:#b8cad8;
  --danger-bg:#fff0ee;     /* 빨강 (함정) */
  --danger-border:#e8b8b2;
  --good-bg:#eef7f1;       /* 녹색 (해결책) */
  --good-border:#b8d8c2;

  /* 형광 하이라이트 색 (.hl 의 --c 기본값들) */
  --hl-yellow:#ffe9a3;     /* 기본 노랑 형광 */
  --hl-blue:#cfe5f5;       /* 파랑 형광 */
  --hl-pink:#fbd3da;       /* 핑크 형광 */

  /* 폰트 */
  --serif:'Noto Serif KR',serif;        /* h1, h2, hero 박스 제목용 */
  --sans:'Pretendard Variable',Pretendard,system-ui,sans-serif;
}
```

## 폰트 임포트 (head에 무조건)

```html
<link rel="preconnect" href="https://cdn.jsdelivr.net">
<link href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.css" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;600;700&display=swap" rel="stylesheet">
```

## 박스 사용 규칙

### 용어 박스 (`.term`, 노랑)

**언제:** 영어 약자·전문 용어가 본문에 처음 등장할 때. 그 단락 안에 끼워넣기보다 직후에 별도 박스로 빼는 게 가독성 좋음.

**구조:**
```html
<div class="term">
  <div class="label">용어</div>
  <span class="word">MCP (Model Context Protocol, 모델 컨텍스트 프로토콜)</span>
  <div class="meaning">AI 모델과 외부 도구가 대화하기 위한 표준 약속. <em class="t">protocol(프로토콜)</em>은 "서로 다른 시스템이 대화하기 위한 약속"...</div>
</div>
```

**팁:** `.word` 안에 "영어 풀어쓰기 + 한국어 풀이"를 한 번에. `.meaning` 안에서 다시 한 번 비유나 사례로 풀면 학습 효과 ↑.

### 비유 박스 (`.analogy`, 파랑)

**언제:** 추상 개념을 일상 사례로 설명할 때. 도서관·신입사원·요리·사무실 등 누구나 아는 영역에서.

**구조:**
```html
<div class="analogy">
  <div class="label">도서관 비유</div>
  <p><strong>RAG 방식</strong>은 도서관 입구의 카드 카탈로그 같다...</p>
  <p>문제는 — <strong>책이 매일 들어오는데 카탈로그는 어제 기준이다.</strong></p>
</div>
```

**팁:** 한 박스 안에 `<p>` 2~3개로 비유를 전개. 첫 줄에서 비유 도입, 둘째 줄에서 약점·반전.

### 함정 박스 (`.danger`, 빨강)

**언제:** 흔한 실수 패턴·안티패턴·잘못된 직관을 강조할 때. 본문 흐름에서 "이걸 조심하라"는 신호.

**구조:**
```html
<div class="danger">
  <div class="label">함정 1</div>
  <div class="name">만들기를 검증이라고 착각하기</div>
  <p>예전엔 프로토타입 만드는 데 몇 달 걸렸지만 이젠 며칠. 그래서 검증 단계를 건너뛰고...</p>
</div>
```

### 해결책 박스 (`.good`, 녹색)

**언제:** 함정 박스 직후에 짝으로. 또는 단독으로 "권장 패턴"을 명시할 때.

**구조:**
```html
<div class="good">
  <div class="label">해결책</div>
  <div class="name">미리 줄여서 보내기</div>
  <p>API에 맡기지 말고, <strong>처음부터 적당한 크기로 줄여서 보낸다.</strong>...</p>
</div>
```

**짝 사용 예:** 빨강 박스(함정 1) → 녹색 박스(해결 1) → 빨강 박스(함정 2) → 녹색 박스(해결 2)...

### 영웅 비유 박스 (`.hero-analogy`, 흰 카드 + 빨강 테두리)

**언제:** 1번 섹션의 "한 줄 요약" 자리. 글 전체의 핵심 메시지를 강조.

**구조:**
```html
<div class="hero-analogy">
  <div class="tag">핵심 메시지</div>
  <h3>"좋은 모델 + 나쁜 세팅보다,<br>평범한 모델 + 좋은 세팅이 더 잘 일한다."</h3>
  <p>설명 단락...</p>
  <p>추가 보강 단락 (필요 시)...</p>
</div>
```

**팁:** `<h3>` 안에서 `<br>`로 두 줄 만들면 시각적 임팩트가 크다.

### 일반 카드 박스 (`.card-block`, 흰 카드)

**언제:** 색 의미(노랑=용어, 빨강=함정 …)가 없는 중립적인 묶음이 필요할 때. 특히 **사용 사례·단계·항목이 여러 개 나열될 때** 각각을 카드로 분리하면 가독성이 크게 좋아진다.

**구조:**
```html
<div class="card-block">
  <div class="case-label">사례 1</div>   <!-- 옵션: "사례 N", "단계 N" 라벨 -->
  <h3>카드 제목</h3>
  <p>설명 단락.</p>
  <div class="prompt-box">"예시 프롬프트나 인용"</div>  <!-- 옵션 -->
</div>
```

**`.case-label` (옵션):** 카드 맨 위의 작은 빨강 라벨. "사례 1", "단계 2", "패턴 3"처럼 카드를 줄세울 때 순서를 보여준다. 사례가 3개 이상 나열되는 글에서 특히 효과적.

### 인용 박스 (`.prompt-box`, 회색 이탤릭)

**언제:** 카드 안이든 본문이든, **그대로 옮긴 텍스트**를 시각적으로 분리할 때. 예시 프롬프트, 원문 한 줄 인용, 셸 명령어 출력, API 응답 샘플 등. 본인 설명 문장과 "남의 말/기계 출력"을 구분해 주는 역할.

**구조:**
```html
<div class="prompt-box">
  "온보딩 화면을 6가지 접근으로 만들어줘 — 레이아웃·톤·밀도를 다르게."
</div>
```

**주의:** 저작권. 원문 인용은 짧게(한 문장 수준). 긴 문단을 그대로 옮기지 말고 풀어쓸 것. 인용 박스는 "발췌"용이지 "원문 재현"용이 아니다.

### Takeaway 박스 (`.try`, 검정)

**언제:** 마지막 섹션 "시도해볼 만한 것". 글 전체 마무리.

**구조:**
```html
<div class="try">
  <div class="label">제목 위의 작은 라벨</div>
  <h3>핵심 메시지 한 줄</h3>
  <ol>
    <li><strong>제안 제목.</strong> 구체 설명...</li>
    <li><strong>제안 제목.</strong> 구체 설명...</li>
  </ol>
</div>
```

**개수:** 보통 3~5개. 너무 많으면 인상 흐려짐.

## 인라인 스타일 패턴

### 강조 배지 (`<em class="t">`)

본문 중간에 핵심 단어를 빨강 배지로 강조. 자주 쓰는 패턴.

```html
이걸 어려운 말로 <em class="t">progressive disclosure(점진적 공개)</em>라 한다.
```

### 코드 (`<code>`)

명령어·파일명·코드 단어. 회색 배경 인라인 배지로 표시.

```html
루트에 <code>CLAUDE.md</code>를 두면 매 세션마다 자동 로드된다.
```

### Bold (`<strong>`)

본문 안 짧은 강조에. `<em class="t">`보다 약한 강조.

### 형광 하이라이트 (`.hl`, 스르륵 자동 재생)

**언제:** 본문 prose 안에서 **핵심 문장·구절 하나**를 형광펜으로 칠하듯 강조할 때. `<em class="t">`(짧은 용어 배지)와 역할이 다르다 — `.hl`은 "이 문장이 핵심"이라는 신호용 구절 강조다. 한 글에 **2~4개 정도만**. 남발하면 형광펜 의미가 사라진다.

**효과:** 얇은 라인(텍스트 하단 ~24%) + 둥근 끝 + 페이지 로드 시 1회 스르륵 칠해지는 애니메이션을 한 클래스에 합친 것. 호버가 아니라 **자동 재생**이라 모바일에서도 발동한다.

**구조:**
```html
<p>그래서 AI가 추측 대신 <span class="hl">실제 상황을 보고 일하게</span> 된다.</p>
```

**색 바꾸기:** 기본은 노랑(`--hl-yellow`). 파랑·핑크는 modifier 클래스로.
```html
<span class="hl">노랑(기본)</span>
<span class="hl blue">파랑</span>
<span class="hl pink">핑크</span>
```

**CSS (템플릿에 이미 포함):**
```css
.hl{
  --c:var(--hl-yellow);
  background-image:linear-gradient(transparent 76%, var(--c) 76%); /* 76%→하단 24% 띠. 더 얇게는 80~82%로 */
  background-repeat:no-repeat;
  background-size:0% 100%;          /* 스르륵 시작점 */
  padding:1px 7px;
  border-radius:4px;                /* 둥근 끝 */
  box-decoration-break:clone;        /* 여러 줄에서도 끝 유지 */
  -webkit-box-decoration-break:clone;
  animation:hl-sweep .7s cubic-bezier(.4,0,.2,1) .25s forwards; /* 로드 시 1회 */
}
.hl.blue{--c:var(--hl-blue)}
.hl.pink{--c:var(--hl-pink)}
@keyframes hl-sweep{to{background-size:100% 100%}}
@media (prefers-reduced-motion:reduce){      /* 모션 최소화 설정 존중 */
  .hl{animation:none;background-size:100% 100%}
}
```

**주의:**
- **무JS 원칙 유지.** 자동 재생은 CSS `@keyframes`만으로 구현했다. 스크롤 진입 시점 트리거는 JS(IntersectionObserver) 또는 `animation-timeline:view()`(2026년 초 기준 브라우저 지원 불완전)가 필요해 이 스킬에서는 쓰지 않는다.
- **호버 트리거 금지.** 모바일/터치에서 발동하지 않아 읽기 자료에 부적합.
- **색 띤 박스 안에서는 쓰지 말 것.** 노랑/파랑/녹색/빨강 박스 위에 형광을 겹치면 탁해진다. `.hl`은 본문(`--bg`) 또는 흰 카드(`.card-block`) 위에서만.
- 끝 둥글기(`border-radius`)와 칠해짐(`background-size`)을 분리해 둘이 간섭하지 않게 했다. 라인 두께는 `76%` 숫자만 조절.

### h2 빨강 원 번호

```html
<h2><span class="num">1</span>제목</h2>
<p class="h2-sub">부제 한 줄</p>
```

`.num`은 자동으로 빨강 원으로 렌더링됨. 부제는 옵션이지만 있으면 시각 흐름 좋음.

## 모바일 대응

`@media (max-width:640px)` 블록 안에 반응형 규칙. 템플릿에 이미 들어 있으니 임의 수정 금지. 핵심은:

- `.wrap` 패딩 축소
- h1·h2 폰트 작아짐
- 그리드 1열 변환
- 매트릭스/표는 한 줄 카드로 분해

## 자주 발생하는 시각 사고

1. **박스 안에 박스 중첩** — 금지. 한 단계로 평평하게.
2. **`.try` 마지막 박스에 표 삽입** — 깨짐. 번호 리스트만.
3. **모바일에서 h2 잘림** — `<br>`로 강제 줄바꿈 피하고 자연 흐름에 맡길 것.
4. **함정 박스 연속 5개** — 너무 무거움. 사이에 prose 단락이나 비유 끼우기.
