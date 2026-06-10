# Report Components

`report-for-beginners` HTML에서 반복 사용하는 보고서 컴포넌트 패턴.

## Page Tone

- `html-for-beginners`처럼 풀어쓰되, 보고서 신뢰도를 위해 표·각주·계산식·출처를 반드시 유지한다.
- 색상은 차분한 청록 계열을 기본으로 한다. 빨강은 위험, 초록은 확인/긍정, 노랑은 주의/전망에만 쓴다.
- 카드 안에 카드를 중첩하지 않는다. 섹션은 넓은 흐름, 카드/표/차트는 증거 단위다.

## Section Checklist

각 본문 섹션은 다음 중 3개 이상을 갖춘다.

- 초보자용 쉬운 해석 문장
- 핵심 수치 또는 인용 근거
- 계산식 또는 비교 기준
- 반론 또는 리스크
- 다음 판단으로 이어지는 결론

## Tables

표는 다음 용도에만 쓴다.

- 판단표: 항목 / 결론 / 신뢰도
- 검증표: 원 주장 / 확인 결과 / 반영 방식
- 비교표: 대상 / 강점 / 약점 / 의미
- 전략표: 과제 / 역할 / 성과지표

모든 표는 `.table-scroll`로 감싼다.

```html
<div class="table-scroll">
  <table>
    <thead>
      <tr><th>항목</th><th>결론</th><th>신뢰도</th></tr>
    </thead>
    <tbody>
      <tr><td>성장성</td><td>높음</td><td><span class="badge badge-A">A</span></td></tr>
    </tbody>
  </table>
</div>
```

## Charts

차트는 반드시 3요소를 갖춘다.

1. 제목: 무엇을 비교하는지
2. 단위: %, 억 달러, 점유율 등
3. 해석 캡션: 독자가 봐야 할 포인트

간단한 구성비, 점유율, 순위 비교는 CSS bar chart를 사용한다. 복잡한 시계열은 직접 이미지로 생성한 뒤 `.chart-wrap`에 넣는다.

## Footnotes and References

본문 각주:

```html
<sup class="footnote-ref">[1]</sup>
```

출처 목록:

```html
<section class="references">
  <h2>References</h2>
  <ol>
    <li><a href="https://example.com">기관명, 문서명</a>, 접근일 또는 발행일.</li>
  </ol>
</section>
```

원문을 길게 복사하지 않는다. 출처 목록에는 제목·기관·날짜·URL 중심으로 둔다.

## Scenario Cards

전망은 하나로 단정하지 말고 낙관/기준/비관 시나리오로 나눈다.

```html
<div class="scenario-grid">
  <div class="scenario">
    <div class="scenario-label">기준 시나리오</div>
    <h3>완만한 성장</h3>
    <p><strong>전제:</strong> 핵심 수요는 유지되지만 병목 해소는 느리다.</p>
    <p><strong>의미:</strong> 매출은 늘어도 점유율 반전은 제한적이다.</p>
  </div>
</div>
```

## Beginner Explanation Blocks

보고서가 딱딱해질 때는 `.explain` 박스를 넣는다.

```html
<div class="explain">
  <div class="label">쉽게 말하면</div>
  <p>이 숫자는 "돈을 많이 벌고 있다"보다 좁은 의미다. 지금은 어느 부문이 돈을 벌고 있는지 분리해서 봐야 한다.</p>
</div>
```

## Quality Bar

완성 전 확인한다.

- 제목만 보고도 보고서 주제를 알 수 있는가?
- 핵심 요약에 결론과 신뢰도 등급이 있는가?
- 주요 숫자의 계산식이 재현 가능한가?
- 출처 없는 강한 주장이 남아 있지 않은가?
- 리스크와 반론이 결론 앞에 등장하는가?
- 마지막 제언이 성과지표와 연결되는가?
