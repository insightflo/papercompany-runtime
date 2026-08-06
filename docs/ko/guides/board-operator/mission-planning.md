---
title: 미션 계획(Mission Planning)
summary: 미션을 증거 게이트 실행 슬라이스로 계획하기
---

미션은 결과의 경계(outcome boundary)입니다. 미션 계획은 숨겨진 프롬프트, 긴 태스크 리스트, 또는 에이전트에게 "모든 것을 시도하라"는 요청이 되어서는 안 됩니다. 유지되어야 할 불변 조건(invariant), 현재 테스트 중인 슬라이스, PASS에 필요한 증거, 그리고 재사용 가능한 운영 자산으로 승격해야 할 것이 무엇인지 명시해야 합니다.

## 다이내믹 워크플로 운영 모델(Dynamic workflow operating model)

papercompany에서 다이내믹 워크플로(dynamic workflow)는 "서브에이전트를 더 쓰거나", "모든 것을 병렬로 실행"하는 것이 아니라 **게이트가 있는 불확실성 축소(uncertainty reduction with gates)** 를 의미합니다.

미션 오너 또는 리드 에이전트를 컨트롤러로 사용하세요:

```text
mission invariant
  -> scope hypothesis
  -> bounded execution slice
  -> worker/agent/tool output with evidence
  -> validator gate
  -> promote reusable learning or choose the next slice
```

컨트롤러는 계획하고, 위임하고, 검토하고, 중재하고, 다음 범위를 결정해야 합니다. 미션이 의도적으로 사소한 것이 아니라면, 컨트롤러가 소스 수집, 프로덕션, 검증, 전달 작업을 모두 스스로 흡수해서는 안 됩니다.

## 미션 계획 블록(Mission plan blocks)

실행이 시작되기 전에 미션 계획, 계획 이슈 또는 부모 이슈에 다음 블록을 포함하세요.

```md
## Mission Invariant
- Product, safety, operational, and taste principles that must remain true for this mission.
- Example: Do not over-constrain with RPA-style hard rules when rule/KB/workflow assets are only judgment harnesses.
- Example: Report slice completion separately from end-to-end completion.

## Scope Hypothesis
- One sentence: this slice will prove, disprove, or unblock <specific uncertainty>.

## Execution Slice
- In scope: the exact workflow, issue, file set, config rows, or artifact this slice may touch.
- Out of scope: code/runtime/schema/deploy/push/external publish/side effects unless explicitly approved.
- Split by invariant, evidence, uncertainty, and ownership first; split by file path only when that is the true boundary.

## Evidence Required
- List concrete evidence required before PASS: diff, API response, DB/config readback, test output, screenshot, logs, generated artifact, user-flow proof, or peer review.
- ACKs and self-reported completion are not evidence by themselves.

## Gate
- PASS: required evidence is present and mission invariant still holds.
- REQUEST_CHANGES: evidence is missing, scope drifted, or the worker produced unverifiable output.
- BLOCKED: required input, approval, tool access, or runtime capability is unavailable.
- Name the validator or gate owner and the next-scope promotion condition.

## Promotion / Asset Update
- Promote reusable decisions into workflow, tool config, rule, KB, role harness, or skill only when the judgment will repeat.
- Do not promote stale session outcomes, PR numbers, issue IDs, commit hashes, one-off logs, or temporary status.
```

## 하위 이슈 / 워커 프롬프트 계약(Child issue / worker prompt contract)

위임된 모든 하위 이슈 또는 워커 프롬프트는 어떤 증거가 돌아와야 하는지 명시해야 합니다:

```md
Objective:
- <bounded outcome>

Mission invariant:
- <principles that must not be broken>

Scope hypothesis:
- This slice tests/unblocks <uncertainty>.

In scope:
- <allowed edits/actions>

Out of scope:
- <forbidden edits/actions/side effects>

Evidence required for closeout:
- <commands, file paths, screenshots, API/DB readbacks, logs, tests, artifact paths>

Gate expectation:
- Return PASS-ready evidence, or REQUEST_CHANGES/BLOCKED with exact missing evidence.
```

## 분할하지 말아야 할 때(When not to split)

더 많은 에이전트를 만들기 위해 작업을 분할하지 마세요. 다음 경우에는 슬라이스를 하나로 유지하세요:

- 하나의 판단으로 유지해야 하는 단일 크로스 파일 불변 조건이 있을 때,
- 작업이 주로 제품/취향 판단일 때,
- 인터페이스가 불안정하고 탐색이 여전히 문제를 정의하고 있을 때,
- 미션 오너가 증거 요구 사항을 작성할 충분한 컨텍스트가 없을 때,
- 분할이 단일 집중 워커보다 검증을 약하게 만들 때.

## SkillOpt-lite 자기 개선 루프(SkillOpt-lite self-improvement loop)

SkillOpt를 에이전트가 자신의 지침을 검증 없이 재작성하는 허가로 사용하지 말고, 운영 패턴으로 사용하세요. papercompany 에이전트는 제한된(bounded) 증거 게이트 제안을 통해 컴퍼니 스킬, 규칙, KB, 워크플로 또는 역할 하니스(role harness)를 개선해야 합니다:

```text
rollout evidence
  -> reflection on reusable failure/success patterns
  -> bounded add/delete/replace proposal
  -> automated validation gate against held-out or reference tasks
  -> agent-gated accept into an asset, reject with negative feedback, or queue for repair
  -> periodic slow/meta review for durable patterns
```

papercompany 매핑:

- **롤아웃 증거(Rollout evidence)**: 이슈 스레드, 런 로그, 테스트 출력, API/DB 리드백, 스크린샷, 아티팩트, 검증자 코멘트, 사용자 수정.
- **성찰(Reflection)**: 리드 또는 검증자가 바뀌어야 할 반복적 행동을 지목합니다. 예시 특정적 수정은 피하세요.
- **제한된 패치(Bounded patch)**: 한 번에 하나의 자산에 작은 add/delete/replace 편집을 제안하세요. 게이트가 명시적으로 요청하지 않는 한 전체 스킬이나 역할 하니스를 재작성하지 마세요.
- **검증 게이트(Validation gate)**: 레퍼런스 태스크, 집중 테스트 또는 체크리스트 증거에서 전후를 비교하세요. 그럴듯한 패치라도 증거가 개선되고 에이전트 검증자 또는 피어 게이트가 통과할 때까지 수용되지 않습니다. 제한된 내부 자산 채택을 사용자 승인 대기로 라우팅하지 마세요.
- **거부 편집 버퍼(Rejected-edit buffer)**: 거부된 편집 제안과 그 실패 이유를 기록해 미래 에이전트가 반복하지 않도록 하세요.
- **느린/메타 업데이트(Slow/meta update)**: 반복된 미션 후에는 배포된 스킬과 별도로 안정적인 패턴을 요약해 훈련 메모리가 런타임 지침을 부풀리지 않게 하세요.

자기 개선 후보는 다음을 포함해야 합니다:

```md
Self-improvement candidate:
- Asset: <skill | rule | KB | workflow | role harness>
- Evidence source: <issue/run/test/screenshot/user correction>
- Proposed bounded edit: <add/delete/replace, exact section>
- Validation plan: <reference task/check/test/readback>
- Rejected-edit note: <required when Auto-adoption result is rejected; optional otherwise>
- Gate owner: <agent/peer validator responsible for automatic validation>
- Auto-adoption result: <accepted | rejected | queued_for_validation | repair_needed>
```

에이전트는 클로즈아웃(closing out) 중에 이러한 후보를 제안할 수 있습니다. 제한된 내부 자산 업데이트의 경우, 증거, 제한된 패치, 검증 게이트가 통과하면 채택은 자동으로 이루어져야 합니다. 사용자 승인을 기다리지 마세요. 에이전트는 여전히 현재 이슈 범위 밖에서 또는 에이전트/피어 게이트 판정 없이 스킬, 규칙, KB, 워크플로 정의, 역할 하니스, 퍼블리시 대상 또는 어댑터 구성을 조용히 변경해서는 안 됩니다. push, deploy, publish, 자격 증명 또는 파괴적 정리 같은 외부 부작용은 이 자동 채택 경로 밖에 있습니다.

### 채택 상태와 실행자 경계(Adoption state and executor boundary)

후보 저장소와 미션 상세 표시는 읽기 전용 표면입니다. 패치를 적용하지 않습니다. 미래의 채택 실행자(adoption executor)는 다음 게이트를 가진 별도의 승인 제한 런타임 경로여야 합니다:

1. `autoAdoptionResult: accepted`이고 현재 에이전트/피어 게이트가 PASS인 후보만 선택합니다.
2. `assetType` + `assetRef`에서 정확히 하나의 내부 자산을 해석합니다. 자산을 해석할 수 없거나 후보가 여러 자산을 건드리려 하면 실패로 닫습니다(fail closed).
3. 제한된 `proposedEdit`를 임시 패치 대상에 먼저 add/delete/replace로 적용합니다.
4. 자산별 검증 계획을 실행하고 결과 diff/콘텐츠를 리드백합니다.
5. 영속 자산을 변경하기 전에 채택/거부/수리 진단을 기록합니다.
6. 외부 부작용은 범위 밖으로 유지합니다: push, deploy, publish, 자격 증명 변경, 파괴적 정리, 어댑터 재구성 없음.

이 실행자는 후보 파싱, 진단, 읽기 전용 UI 표시와 독립적으로 구현되고 검증되어야 합니다.

## 보고 규칙(Reporting rule)

항상 다음을 보고하세요:

- `slice complete` 대비 `end-to-end complete`,
- 확인된 증거,
- 게이트 판정,
- 다음 범위 또는 블로커,
- 재사용 가능한 자산이 승격되었는지 여부,
- 자기 개선 후보가 수용, 거부 또는 검증 대기 중인지 여부.

모든 하위 에이전트가 "done"이라고 말했다고 해서 미션을 완료로 표시하지 마세요. 게이트 오너가 증거를 검사하고 미션 불변 조건이 여전히 유지되는지 확인해야 합니다.
