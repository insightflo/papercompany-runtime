# QA 판정 findings 계약 최소컨텍스트 교육 + 카드 실패 폴백 버그수정

- 날짜: 2026-09-27
- 브랜치: `insightflo/verdict-findings-contract`
- 상태: 구현·검증 완료 (typecheck/전체 테스트/build 통과 — 검증 상세는 세션 최종 보고)

## 최종 목표와 승인된 범위

QA 판정(`POST /api/issues/{issueId}/workflow/verdict`)의 `findings` 계약이 이미 존재(선택 필드,
`workflowVerdictFindingSchema`: `id`≤80/`summary`≤300/`layer: source_data|artifact`, request_changes 전용)하지만
판정을 가르치는 안내 표면 어디도 언급하지 않아 소비 자동화(원천결함 라우팅, 기계적 수선, 재검수 우선목록)가
도달 불가다(실측: 9월 이후 반려 118건 중 findings 동반 0건). 이 슬라이스는:

1. 안내 3표면(루브릭/closeout/카드)+스텝 지침+스킬 예시를 findings 병기형으로 정렬(브리프당 순증가 ~100토큰 목표).
2. `escalateQaSourceDefectToOwner`가 오너 카드 확보 실패를 무시하고 항상 성공 반환하는 버그를 fail-closed로 수정.
3. 준수율 측정 쿼리와 2주 체크포인트를 이 문서에 명시(코드 구현 없음 — 데이터 이미 존재).

## 변경 지점

### A. 안내 정렬 (교체 위주, 최소 증가)

| 표면 | 파일 | 변경 |
|---|---|---|
| 루브릭 "Required verdict" | `server/src/services/workflow/dag-engine.ts` (~L641) | reason-글월 4줄 → findings 권한/reason 간결/컴팩트 JSON 예시/layer 오분류 경고/3값 일관 |
| 루브릭 missing-dep | dag-engine.ts ~L635 | `REQUEST_CHANGES: <specific missing workProduct>` → findings 항목 병기형 |
| 재작업 피드백 missing-dep | dag-engine.ts ~L837 | 동일 |
| 이슈 지침 final line | dag-engine.ts ~L1638 | `Finish with exactly PASS or REQUEST_CHANGES: <specific gaps>` → API 판정+findings 병기 |
| closeout | dag-engine.ts `buildWorkflowApiCloseoutLines` | REQUEST_CHANGES 시 findings 필수(id/summary/layer 뜻풀이)+예시 1행. remediations 세부는 인라인 확장 금지 |
| 카드 | `packages/adapter-utils/src/runtime-brief-card-section.ts` | `submit verdict with /workflow/verdict (+findings on REQUEST_CHANGES)` |
| 스킬 | `skills/paperclip/SKILL.md` L94, L110 / `skills/paperclip/references/api-reference.md` | valid verdicts에 `insufficient_evidence` 추가, verdict POST 예시에 request_changes+findings 예시 추가 |
| 배포검증게이트 | `server/src/services/workflow/delivery-verification-gate.ts` L100 | 파이널라인 인라인식 → API 판정+findings (동일 /workflow/verdict 표면, 3표면 충돌 제거) |

**제외 판정**: `server/src/services/missions/mission-plan-review-description.ts` L89 — 별도 API
(`/mission-plan-qa/verdict`, diagnostics 계약)의 명시적 파서 호환 라인. findings 계약 범위 밖, 무변경.

### B. 버그수정 (fail-closed)

`server/src/services/workflow/control-flow/loop-driver.ts` `escalateQaSourceDefectToOwner`:
`ensureQaSourceDefectOwnerCard` 결과(`created|replayed|conflict|failed`)를 무시하고 항상 `true` 반환 →
카드 없이 재작업도 없이 런 방치 가능. 수정: `conflict`/`failed`면 `false` 반환.
caller(`applyBackEdgeReworkPass`)는 `source_only && escalated`일 때만 리셋 스킵하므로 `false`면 기존 재작업
경로로 자연 폴백(iteration 소모) — 이미 검증된 경로, 신규 실행 경로 없음.

### C. 준수율 측정 (이 문서 명시, 코드 없음)

측정 쿼리(workflow_transition_events, 데이터 이미 존재):

```sql
-- 전사: REQUEST_CHANGES 판정 중 findings 동반 비율
SELECT
  count(*) FILTER (WHERE verdict = 'request_changes') AS rc_total,
  count(*) FILTER (WHERE verdict = 'request_changes' AND payload->'findings' IS NOT NULL
                   AND jsonb_array_length(payload->'findings') > 0) AS rc_with_findings,
  round(100.0 * count(*) FILTER (WHERE verdict = 'request_changes' AND payload->'findings' IS NOT NULL
        AND jsonb_array_length(payload->'findings') > 0)
        / NULLIF(count(*) FILTER (WHERE verdict = 'request_changes'), 0), 1) AS pct
FROM workflow_transition_events
WHERE event_type = 'workflow_validation_verdict'
  AND created_at >= now() - interval '2 weeks';

-- 회사별: 같은 쿼리에 GROUP BY company_id.
```

**2주 체크포인트 기준**: 배포 시점부터 2주 뒤 측정하여 **전사 rc_with_findings 비율 ≥ 60% 도달 시
2단계(완료 게이트 강제 — findings 없는 request_changes를 게이트에서 거부) 착수를 착수 판정의 기본값으로 한다.**
미달 시 원인 분석(표면 도달률 vs 이해도) 후 안내 조정을 우선한다. 미달 자체로 2단계를 자동 폐기하지 않는다.

## 테스트 계획

- 렌더: 루브릭/closeout/카드에 findings 예시 존재 + `REQUEST_CHANGES: <specific gaps>` 류 문구 소멸 + 3표면 동일 스키마 설명.
- 버그: 기존 통합테스트 하네스(`qa-source-defect-owner-card-integration.test.ts`) 재사용 — 같은 requestKey에 다른
  requestHash 카드를 선삽입해 `conflict`를 유발 → 생산자 리셋 폴백(iteration 소모) + 라우팅 이벤트는 잔존 확인.
- 기존 렌더 테스트는 계약에 맞게 갱신(무단 축소 금지).
- 대표 회귀: loop-driver/hybrid-qa/rubric·closeout 렌더 관련.

## 완료 조건

1. `pnpm -r typecheck` 통과
2. 신규/갱신 테스트 + 대표 회귀 통과
3. 전체 `pnpm test:run`, `pnpm build` 통과
4. 검증 출력 원문 최종 보고 첨부

## 명시적 제외

완료 게이트 강제(2단계), layer 피드백 루프/승격 설계, remediation 이벤트 해시·생산자 통지, 오버레이 통합, API 스키마 변경, UI.
