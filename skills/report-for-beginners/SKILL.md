---
name: report-for-beginners
description: Use when producing Korean HTML research reports, investment reports, market reports, policy reports, risk reports, validation reports, or beginner-readable reports that need evidence tables, charts, scenarios, footnotes, numbered sections, and source-backed conclusions.
version: 1.0.0
author: Papercompany / Hermes Agent
license: internal
origin: /Users/kwak/.hermes/skills/research/report-for-beginners
installed_at: /Users/kwak/Projects/ai/papercompany/papercompany-runtime/skills/report-for-beginners
adapted_for: papercompany
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

### Design Direction

이 스킬은 `html-for-beginners`를 대체하는 별도 보고서 테마가 아니다. 기본값은 **html-for-beginners 디자인 시스템과 읽는 톤을 그대로 유지**한다.

- `--bg:#f5f5f0`, `--accent:#e63946`, Pretendard + Noto Serif KR, `.wrap` 760px, 빨간 원형 h2 번호, `.hero-analogy`, `.term`, `.analogy`, `.danger`, `.good`, `.card-block`, `.comic-strip`, `.try`를 기본 골격으로 쓴다.
- 보고서성이 필요한 부분만 얇게 추가한다: 근거자료 맵, 핵심 지표 카드, 비교 카드, CSS 막대그래프, 리스크/시나리오 카드.
- 별도 teal/enterprise/report 테마처럼 전체 톤을 갈아엎지 않는다. 사용자가 “보고서스럽게”라고 해도 초보자용 HTML의 따뜻한 학습지 느낌이 우선이다.
- 표는 필요한 경우에만 쓰고, 가능하면 html-for-beginners 카드/박스 위에 지표·근거·비교 시각 요소를 얹는다.

### Tone Calibration from Gazua v0/v2 feedback

보고서 요소를 얹더라도 문장은 “어떻게 만들었는가”가 아니라 **독자가 지금 무엇을 이해해야 하는가**를 말해야 한다.

- **Subtitle:** “v2는 어떤 디자인으로 만들었다” 같은 제작 설명을 쓰지 않는다. 문서 주제의 결론을 한 문장으로 쓴다. 예: `3일 만에 시장이 완전히 뒤집힌 날 — Risk-Off 전환 확정`.
- **Section 0:** 곧바로 나올 핵심 지표·용어를 먼저 풀어준다. 시장 리포트라면 VIX, SOX, breadth, FTD처럼 뒤에서 판단 근거가 되는 용어를 여기서 설명한다.
- **Hero message:** 해설식 명제보다 일상 비유가 우선이다. 예: `반도체 서사가 끝난 것은 아니다`보다 `3일 전엔 비가 오다 말았는데, 오늘은 태풍이 왔다`가 더 beginner-friendly하다. 분석 결론은 그 아래 문단에서 풀어쓴다.
- **Evidence section:** `어떤 자료를 확인했습니다`라는 과정 설명으로 채우지 않는다. 실제 수치, 이전 대비 변화, 심플한 해석을 보여준다. 예: `VIX 15.4 → 21.5 = 공포 급등`, `SOX -2.15% → -10.26% = 반도체 급락`.
- **Comparison section:** 카드 구조는 좋지만 카드만으로 끝내지 말고 `공포 급등`, `반도체 급락`, `시장 폭 붕괴`, `방어만 생존` 같은 짧은 결론 라벨을 바로 붙인다.
- **Sector section:** 차트로 열량·방향을 보여준 뒤, 설명은 v0처럼 “무슨 일이 있었고, 그래서 어떤 판단인가”를 자연어로 풀어쓴다.
- **Remainder:** 핵심 질문, 로테이션 결론, 지식 만화는 v0의 일상적·교육적 톤을 유지한다. 만화는 보고서 요약이 아니라 비유를 완성하는 4컷이어야 한다.

## Output Contract

1. 단일 HTML 파일로 작성한다.
2. 외부 JS 라이브러리, Tailwind CDN, 아이콘 폰트는 쓰지 않는다.
3. 도표는 CSS 기반 HTML 차트 또는 직접 생성한 이미지로 만든다. 차트에는 반드시 제목, 단위, 해석 캡션을 붙인다.
4. 표는 보고서에서 허용하되 모바일 대응을 위해 `.table-scroll`로 감싼다.
5. 모든 핵심 수치에는 출처 각주 또는 출처 섹션 번호를 붙인다.
6. Papercompany/Paperclip 이슈 산출물이라면 파일 저장만으로 끝내지 말고 assigned issue의 공식 `workProduct`로 등록한다. 로컬 파일은 `provider:"local"`과 `metadata.path`를 사용한다.
7. Hermes 일반 작업에서는 사용자가 지정한 경로에 저장하고, 지정이 없으면 현재 프로젝트의 적절한 `reports/` 또는 사용자에게 전달 가능한 파일 경로를 사용한다.

## Required Report Structure

가능하면 아래 순서를 따른다. 원문이 짧으면 섹션을 줄여도 되지만, 1·2·마지막 출처는 유지한다.

```text
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

## Dashboard-bound HTML artifacts

Gazua 같은 dashboard report viewer에 들어갈 HTML이면 일반 단일 HTML 계약에 더해 viewer contract를 보존한다.

- `data-gazua-report="beginner-html"` 마커를 유지하거나 추가한다.
- 추적성을 위해 `data-report-style="report-for-beginners"`를 추가한다.
- `GAZUA_BEGINNER_REPORT_META` 주석에 `title`, `summary`, `category`, `market`, `published_at`, `read_time`, `source_path`, `format`을 남긴다.
- 기존 dashboard artifact를 덮어쓸 때는 public/private 데이터 정책과 viewer가 읽는 경로를 확인한다.

자세한 Gazua 변환 패턴은 `references/gazua-dashboard-report-conversion.md`를 참고한다.

## Verification

완료 전 최소 검증:

- `<!DOCTYPE html>`로 시작하고 `</html>`로 끝나는지 확인한다.
- 핵심 구조가 있는지 확인한다: verdict table, KPI grid, evidence table, calculation list, chart card, risk grid, scenario grid, references, footnotes.
- raw Markdown heading이 HTML에 남지 않았는지 확인한다.
- 숫자 산식이 출처 문장과 맞지 않으면 조용히 고치거나 숨기지 말고 evidence/calculation 섹션에서 보정 설명을 남긴다.
- 가능하면 브라우저로 로컬 파일 또는 dashboard viewer를 열어 시각 확인한다: 헤더, 표, 카드, 모바일 대응, raw Markdown 노출 여부.

## File and Handoff

- 파일명 예: `korea_non_memory_semiconductor_report_for_beginners.html`
- 사용자가 경로를 지정하지 않으면 Paperclip 로컬 미션에서는 `~/Downloads/`에 저장한다.
- Paperclip issue 수행 중이면 저장 후 `POST /api/issues/{issueId}/work-products`로 등록하고, `metadata.path`에 절대 경로를 남긴다.
- Hermes 일반 작업에서는 최종 응답에 파일 경로 또는 `MEDIA:<path>` 전달 방식을 명확히 남긴다.
