---
name: storm-research
description: |
  Stanford STORM 방법론(다관점 질문 + 출처 grounding)을 papercompany 미션/이슈 시스템으로 구현한 딥리서치 스킬.
  Research Director가 5개 관점 에이전트에게 이슈를 할당하고, 각 에이전트가 출처 강제 딥리서치를 수행.
  Synthesis Editor가 모순 지도 + 종합, Report Validator가 동료 검토. HTML 리포트 산출.
  cmux 불필요 — heartbeat + mission + workflow 기반.
  트리거 — "STORM 리서치", "다관점 딥리서치", "5관점으로 조사", "스톰 방법", "/storm-research".
---

# storm-research: papercompany STORM 딥리서치

> **방법론 SSOT**: [`references/storm-pipeline.md`](./references/storm-pipeline.md)
> **출처 규칙**: [`references/provenance.md`](./references/provenance.md)
> **관점 charter**: [`perspectives/`](./perspectives/) 폴더의 5개 파일

## 핵심 원칙

1. **출처 없는 단언 금지** — 모든 주장에 `[출처: URL]`. 추측은 `[추론]` 라벨.
2. **5관점 강제** — 한 주제를 5개의 다른 렌즈로 조사. 단일 관점 수렴 금지.
3. **모순을 숨기지 않는다** — 관점 간 충돌을 명시적으로 도식화.
4. **동료 검토 없이 최종화 금지** — 출처 편향·비약·가짜 출처 점검 필수.

## papercompany 실행 모델 (cmux 없음)

```
Research Director (오케스트레이터)
  │
  ├─ Phase 1: 관점 도출 + 이슈 5개 생성 (각 researcher 에이전트에 할당)
  │     ├─ Economics Research Agent     ← perspectives/economist.md charter 주입
  │     ├─ Policy/Society Research Agent ← perspectives/policy.md charter 주입
  │     ├─ Science Research Agent        ← perspectives/scientist.md charter 주입
  │     ├─ Technology Research Agent     ← perspectives/technologist.md charter 주입
  │     └─ Skeptic (Report Validator 겸용 또는 별도) ← perspectives/skeptic.md charter 주입
  │
  ├─ Phase 2: 각 researcher가 출처 기반 딥리서치 수행 (issue work-product로 산출)
  │
  ├─ Phase 3: Synthesis Editor가 5개 결과 취합
  │     ├─ 모순 지도 (prompts/2-contradiction-map.md)
  │     └─ 종합 (prompts/3-synthesis.md)
  │
  ├─ Phase 4: Report Validator가 동료 검토 (prompts/4-peer-review.md)
  │
  └─ Phase 5: Synthesis Editor가 HTML 리포트 산출 (report-for-beginners 스킬 또는 직접)
```

## Phase 상세

### Phase 0 — 주제 확보

- 사용자 주제가 모호하면 한 번만 되묻는다 (범위·기간·지역·관심 각도).
- 주제가 명확하면 Research Director가 **mission을 생성**하고 5개 step을 가진 workflow를 시작.

### Phase 1 — 관점 도출 + 이슈 할당

Research Director가 수행:

1. **관점 결정**: 기본 5관점 팩(economist/policy/scientist/technologist/skeptic) 사용.
   - 주제가 특정 도메인이면 관점을 **재도출** 가능.
   - **회의주의자(skeptic) 관점은 항상 유지** — 이것이 STORM의 품질 보증.
2. **이슈 5개 생성**: 각 researcher 에이전트에게 하나씩 할당.
   - 이슈 description에 **관점 charter**(`perspectives/*.md`)를 주제에 맞게 변환해서 삽입.
   - charter에는: 핵심 질문 5개 + 리서치 스타일 + 출처 규칙 + 출력 구조 포함.
3. **동시 실행**: 5개 이슈를 같은 미션에 배정. workflow step이 병렬 실행을 보장.

> 게이트: 5개 이슈가 각 researcher에게 할당돼야 Phase 2 진입.

### Phase 2 — 딥리서치 (각 researcher 병렬 수행)

각 researcher 에이전트는 자신의 이슈에서:

1. **실제 웹 검색**으로 1차 출처 수집. (검색 도구가 없으면 BLOCKED 보고 — 추측 금지.)
2. 모든 주장에 `[출처: URL]`. 추측은 `[추론]` 라벨.
3. 결과를 **issue work-product**(markdown 파일)로 등록.
4. issue 상태를 done으로 변경.

> 게이트: 최소 3/5 researcher가 출처 포함 결과를 냈을 때 종합 진입.

### Phase 3 — 모순 지도 + 종합 (Synthesis Editor)

Synthesis Editor가 5개 work-product를 취합해서:

1. **모순 지도** (`prompts/2-contradiction-map.md` 사용):
   - 5개 관점 간 합의/모순/사각/핵심긴장을 도식화.
   - 한 관점이 못 보는 "긴장 지점"이 여기서 드러남.
2. **종합** (`prompts/3-synthesis.md` 사용):
   - 스캔 + 모순 지도 → 구조화된 글. 나열이 아니라 종합.
   - 한 관점에 수렴 금지. 충돌을 통과한 결론.

### Phase 4 — 동료 검토 (Report Validator)

Report Validator가 종합본을 **적대적으로** 검토 (`prompts/4-peer-review.md` 사용):

- **출처 편향 전이**(source bias transfer) 점검 — 한 관점의 편향이 종합에 스며들었는가?
- **부당한 연결**(over-association) 점검 — 무관한 사실을 인과처럼 연결했는가?
- **미인용 주장** 점검 — 출처 없는 단언이 있는가?
- **모순 봉합** 점검 — 충돌을 얼버무렸는가?
- BLOCKER가 있으면 Synthesis Editor로 되돌림.

### Phase 5 — HTML 리포트 산출

Synthesis Editor(또는 Research Director)가:

1. 최종 종합본을 `report-for-beginners` 스킬로 HTML 변환, 또는 직접 HTML 작성.
2. 산출물을 `~/Downloads/` 또는 미션 work-product로 등록.
3. Research Director에게 완료 보고.

## 관점 재도출 규칙

주제가 기본 5관점(economist/policy/scientist/technologist/skeptic)에 안 맞으면:

1. **회의주의자(skeptic)는 항상 유지** — 이것이 품질 보증.
2. 나머지 4개 관점을 주제에 맞게 재도출.
   - 예: 양자컴퓨팅 → 물리학자/암호학자/VC/정책/회의주의자
   - 예: 기후 변화 → 기상학자/경제학자/정책/기술/회의주의자
3. charter는 가장 가까운 기존 `perspectives/*.md`를 베이스로 주제 맞춤 1~2줄만 덧댄다.

## 설치

이 스킬은 papercompany-runtime `skills/` 디렉토리에 있습니다:
```
papercompany-runtime/skills/storm-research/
├── SKILL.md                         (이 파일)
├── perspectives/
│   ├── economist.md                 (경제학자 관점 charter)
│   ├── policy.md                    (정책/사회 관점 charter)
│   ├── scientist.md                 (과학자 관점 charter)
│   ├── technologist.md              (기술 전문가 관점 charter)
│   └── skeptic.md                   (회의주의자 관점 charter)
├── prompts/
│   ├── 2-contradiction-map.md       (모순 지도 프롬프트)
│   ├── 3-synthesis.md               (종합 프롬프트)
│   └── 4-peer-review.md             (동료 검토 프롬프트)
└── references/
    ├── storm-pipeline.md            (STORM 방법론 SSOT)
    └── provenance.md                (출처 규칙)
```

Research Director의 promptTemplate 또는 instructionsFilePath에 이 스킬 경로를 추가하면 됩니다.
