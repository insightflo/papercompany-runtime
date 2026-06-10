---
name: report-for-beginners
description: Use when producing Korean HTML research reports, investment reports, market reports, policy reports, risk reports, validation reports, or beginner-readable reports that need evidence tables, charts, scenarios, footnotes, numbered sections, and source-backed conclusions.
---

# Report for Beginners

복잡한 리서치를 **초보자도 읽을 수 있지만 보고서답게 검증 가능한 HTML 보고서**로 만드는 스킬. `html-for-beginners`의 쉬운 해석 톤을 유지하되, 판단표·계산식·도표·각주·시나리오·리스크 매트릭스로 구조화한다.

## When to Use

- "보고서 HTML", "리서치 보고서", "검증 보고서", "시장/산업/정책/투자 보고서" 요청
- 초보자용 설명이 필요하지만 단순 학습 자료가 아니라 **근거 기반 결론**이 필요한 경우
- 숫자, 출처, 반론, 시나리오, 리스크, 정책/전략 제언을 함께 제시해야 하는 경우
- 표·그래프·각주·순번·신뢰도 등 보고서 구성 요소가 필요하다는 요청

## Core Principle

한 문장 요약으로 압축하지 않는다. 독자가 판단할 수 있게 **주장 → 근거 → 계산 → 해석 → 리스크 → 조건부 결론** 순서로 보여준다.

## Output Contract

1. 단일 HTML 파일로 작성한다.
2. 외부 JS 라이브러리, Tailwind CDN, 아이콘 폰트는 쓰지 않는다.
3. 도표는 CSS 기반 HTML 차트 또는 직접 생성한 이미지로 만든다. 차트에는 반드시 제목, 단위, 해석 캡션을 붙인다.
4. 표는 보고서에서 허용하되 모바일 대응을 위해 `.table-scroll`로 감싼다.
5. 모든 핵심 수치에는 출처 각주 또는 출처 섹션 번호를 붙인다.
6. Paperclip 이슈 산출물이라면 파일 저장만으로 끝내지 말고 assigned issue의 공식 `workProduct`로 등록한다. 로컬 파일은 `provider:"local"`과 `metadata.path`를 사용한다.

## Required Report Structure

가능하면 아래 순서를 따른다. 원문이 짧으면 섹션을 줄여도 되지만, 1·2·마지막 출처는 유지한다.

```
header
  kicker: 주제 · 보고서 유형 · 날짜
  h1: 명확한 보고서 제목
  subtitle: 결론을 단정하지 않고 범위와 검증 방식을 설명
  meta-row: 검토 범위, 신뢰도 체계, 작성 기준일

1. 핵심 요약
  verdict-grid: 판단 항목 / 결론 / 신뢰도
  key-number-strip: 핵심 숫자 3~5개
  beginner-brief: 초보자용 쉬운 해석

2. 검증 기준과 자료 보정
  evidence-table: 원 주장 / 확인 결과 / 보고서 반영 방식
  confidence legend: A/B/C 기준

3. 현황과 계산
  calculation-list: 계산식과 단위
  comparison table or bar chart

4~N. 본문 분석
  섹션마다 "무슨 뜻인가" 설명 + 근거 + 리스크
  필요 시 matrix, scenario cards, risk register, timeline

마지막. 결론과 제언
  조건부 결론
  실행 제안 3~5개
  모니터링 지표

References
  번호 매긴 출처 목록
```

## Tone Rules

`html-for-beginners`의 설명 톤을 가져온다.

- 전문 용어는 첫 등장 시 영어 풀어쓰기, 한국어 뜻, 일상 비유를 함께 제시한다.
- 숫자는 그냥 나열하지 말고 "이 숫자가 왜 중요한지"를 한 문장으로 풀어준다.
- 결론은 단정 대신 조건을 붙인다. 예: "가능성이 높다"보다 "A와 B가 충족될 때 가능성이 높다".
- 반론과 리스크를 숨기지 않는다. 좋은 보고서는 확신만 주는 글이 아니라 **판단 경계**를 보여준다.
- 개인 메모리나 사용자의 다른 프로젝트 맥락을 본문에 끌어들이지 않는다.

## Evidence and Confidence

신뢰도 배지는 반드시 기준을 명시한다.

| 등급 | 기준 |
|---|---|
| A | 1차 출처, 공식 통계, 원문 보고서, 직접 계산 |
| B | 신뢰 가능한 2차 출처, 복수 매체 교차 확인, 증권사/기관 분석 |
| C | 추정, 전망, 조건부 시나리오, 단일 출처 주장 |
| 확인 불가 | 출처 불명, 원문 미확인, 계산 재현 불가 |

주장이 불확실하면 "확인할 수 없습니다"를 숨기지 말고, 보고서 반영 방식에 "정량 결론에서 제외" 또는 "정성 리스크로만 반영"이라고 쓴다.

## Components

자세한 HTML 패턴은 `references/report-components.md`와 `assets/report-template.html`을 사용한다.

### 1. Verdict Grid

핵심 요약에는 판단표를 둔다.

```html
<div class="table-scroll">
  <table>
    <thead><tr><th>판단 항목</th><th>결론</th><th>신뢰도</th></tr></thead>
    <tbody>
      <tr><td>시장 성장성</td><td>높음, 단 수요 집중 리스크 존재</td><td><span class="badge badge-A">A</span></td></tr>
    </tbody>
  </table>
</div>
```

### 2. Key Numbers

보고서 앞부분에 핵심 숫자 3~5개를 배치한다.

```html
<div class="kpi-grid">
  <div class="kpi"><div class="kpi-label">반도체 수출 비중</div><div class="kpi-value">42.3%</div><p>전체 수출 중 반도체가 차지하는 비중.</p></div>
</div>
```

### 3. CSS Bar Chart

이미지를 만들지 않아도 되는 간단 비교는 CSS 막대 그래프로 충분하다.

```html
<div class="chart-card">
  <h3>수출 구성 비교</h3>
  <div class="bar-row"><span>메모리</span><div class="bar-track"><div class="bar" style="width:86.4%"></div></div><strong>86.4%</strong></div>
  <div class="chart-caption">막대는 반도체 수출 내 구성비를 나타낸다.</div>
</div>
```

### 4. Risk Register

리스크는 글 속에 흩뿌리지 말고 표나 카드로 모은다.

```html
<div class="risk-grid">
  <div class="risk risk-high">
    <div class="risk-level">High</div>
    <h3>고객 신뢰 리스크</h3>
    <p>기술이 있어도 대형 고객이 양산을 맡기지 않으면 매출로 이어지기 어렵다.</p>
  </div>
</div>
```

### 5. Footnotes

수치와 중요한 주장에는 각주를 붙인다.

```html
반도체 수출은 전체 수출의 42.3%였다.<sup class="footnote-ref">[1]</sup>
```

출처 목록은 맨 아래에 둔다.

## Common Mistakes

- **숫자만 나열:** 계산식과 해석이 없으면 초보자는 의미를 모른다. `371.6 ÷ 877.5 × 100 = 42.3%`처럼 재현 가능하게 쓴다.
- **예쁜 카드만 있고 결론이 없음:** 각 섹션 끝에 "그래서 판단은?"을 한 문장으로 남긴다.
- **표가 너무 넓음:** 모든 표는 `.table-scroll`로 감싸고, 열은 3~5개로 제한한다.
- **각주 없는 보고서:** 핵심 숫자, 외부 주장, 전망에는 각주를 붙인다.
- **초보자 톤 상실:** 보고서라도 "이 말은 쉽게 말해..." 문장을 섹션마다 넣는다.

## File and Handoff

- 파일명 예: `korea_non_memory_semiconductor_report_for_beginners.html`
- 사용자가 경로를 지정하지 않으면 Paperclip 로컬 미션에서는 `~/Downloads/`에 저장한다.
- Paperclip issue 수행 중이면 저장 후 `POST /api/issues/{issueId}/work-products`로 등록하고, `metadata.path`에 절대 경로를 남긴다.
