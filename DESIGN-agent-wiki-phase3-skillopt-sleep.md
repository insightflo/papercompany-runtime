# Design: Agent Wiki Phase 3 — SkillOpt-Sleep (자가 진화 루프)

> **상태**: 설계 완료 / 구현은 별도 세션(handoff 합의). Phase 1(자동 축적) + Phase 2(자동 주입)는 이미 구현됨.
> **작성**: 2026-06-19
> **의존**: `agent_wiki_entries` 테이블(0061), `server/src/services/agent-wiki.ts`, heartbeat 훅(5곳).

---

## 1. 목표

Phase 1+2 는 **실패 → 축적 → 다음 run 주입** 까지 제공한다. 하지만 주입은 **per-run ephemeral**(promptTemplate 문자열 append)이며,
반복 패턴이 agent의 **영구 instructions** 에 통합되지는 않는다. Phase 3 는 SkillOpt-Sleep 패턴으로
**빈도 임계치(≥3)를 넘는 반복 실패를 agent 의 영구 학습 프롬프트에 bounded edit 하고, validation gate 로 수락/기각** 한다.

핵심 루프(SkillOpt / Gödel Agent / SICA 공통):
`빈도≥3 active entry 수집 → 후보 edit 생성 → 다음 N run 빈도 추이로 검증 → 수락(영구 반영 + resolved)/기각(revert)`.

---

## 2. 현재 아키텍처 (Phase 1+2 요약)

- **축적**: `heartbeat.ts` 5곳에서 `fireWikiRecord(wikiSvc, {...})` → `agentWikiService(db).recordFailure()`.
  dedup on `(company_id, agent_id, pattern, error_code)` → `frequency++`.
- **주입**: adapter 실행 전 `wikiSvc.searchRelevant({companyId, agentId, limit:3})` → `formatWikiLessons()` → `runtimeConfig.promptTemplate` append.
  **per-run ephemeral** (runtimeConfig 에만 존재, 영구 저장 아님).
- **상태 머신**: `active` → (markResolved) → `resolved`, 또는 → `closed`. 재발 시 `recordFailure` 가 다시 `active` + `resolvedAt=null` 로 되돌림.

Phase 3 가 다루는 영구 표면(이미 존재):
- `agents.adapter_config.promptTemplate` / `instructionsFilePath` (예: conan.md / AGENTS.md).
- `server/src/services/agent-instructions.ts`: `FILE_KEY="instructionsFilePath"`, `PROMPT_KEY="promptTemplate"`, `readLegacyInstructions()` (L211), `resolveManagedInstructionsRoot(agent)`.
- Phase 2 주입은 이 표면을 건드리지 않고 runtimeConfig 에만 append → Phase 3 는 여기에 **durable** 쓰기를 추가.

---

## 3. Phase 3 컴포넌트

### 3.1 `server/src/services/agent-skill-optimizer.ts` (신규)

SkillOpt-Sleep 루프. `createNativeWorkflowReconciler` 패턴(`services/workflow/reconciler.ts:213-224`)을 그대로 따른다:
factory `{start(), stop(), tick()}` + `setInterval` + `tickInFlight` 가드 + tick try/catch(루퍼 불사) + `.unref()` 안전.

```ts
// 의사코드 (구현 시 실제 repo 스타일로 작성)
export function createAgentWikiEvolutionLoop(opts: {
  db: Db;
  intervalMs?: number;          // 기본 6h (야간 offline 진화 관념)
  frequencyThreshold?: number;  // 기본 3
  validationWindowRuns?: number;// 기본 10 (edit 후 10 run 관찰)
}) {
  let timer: NodeJS.Timeout | null = null;
  let tickInFlight = false;
  return {
    start() { timer = setInterval(() => tick().catch(()=>{}), opts.intervalMs ?? 6*3600_000); timer.unref?.(); },
    stop() { if (timer) clearTimeout(timer); timer = null; },
    async tick() {
      if (tickInFlight) return; tickInFlight = true;
      try { await evolveOnce(opts); }
      finally { tickInFlight = false; }
    },
  };
}
```

### 3.2 `evolveOnce` 단계

1. **후보 수집**: `frequency >= threshold` AND `status='active'` AND 아직 `resolved`/`archived` 아닌 entry.
   (`agentWikiService` 에 `listCandidates(threshold)` 추가 — 또는 `list(companyId)` + 메모리 필터).
2. **bounded edit 생성**: 각 패턴 → agent 의 `promptTemplate`(또는 `instructionsFilePath` 번들 끝)에
   `## 주의(자가진화 반영): {pattern} — {solution}` 섹션 append. **idempotent** 마커(`<!-- wiki-lesson:{pattern-hash} -->`)로 중복 append 방지.
3. **버퍼링**: edit 을 즉시 확정하지 않고 `agent_wiki_entries` 에 `proposedEdit`/`editStatus='proposing'` 컬럼(또는 별도 `agent_wiki_edit_proposals` 테이블)에 저장 + 원본 프롬프트 백업(revert 용).
4. **검증(다음 tick 또는 N run 후)**: 해당 패턴의 `frequency` 추이(최근 N run 대비 실패 감소율) 측정.
   - **수락**: edit 영구 반영, `status='resolved'`, `resolvedAt=now`.
   - **기각**: revert(백업본으로 복원), `editStatus='rejected'`, rejected-edit buffer 보존(동일 edit 재시도 방지).

> 검증 신호가 약할 수 있으므로(실패는 드물고 샘플 작음), **conservative 기본**: 빈도가 **증가**하면 즉시 기각+revert, **유지/감소**면 유예 후 수락. 위험 회피 우선.

### 3.3 등록 지점: `server/src/app.ts` (~L706)

`nativeWorkflowReconciler` 등록 블록 바로 뒤에 동일 패턴으로 추가:
```ts
const agentWikiEvolution = createAgentWikiEvolutionLoop({ db });
agentWikiEvolution.start();
process.once("exit", () => agentWikiEvolution.stop());
```
(wikiPhase3 활성화는 env flag(`AGENT_WIKI_EVOLUTION_ENABLED`)로 게이트 권장 — Phase 3 검증 전까지 기본 off.)

---

## 4. 스키마 확장 (Phase 3 활성화 시)

`agent_wiki_entries` 에 검증 메타 추가(별도 migration 0062):
- `proposed_edit text` — 생성된 bounded edit 텍스트(null=미제안).
- `edit_status text DEFAULT 'none'` — none|proposing|accepted|rejected.
- `original_prompt_snapshot text` — revert 용 원본 프롬프트(또는 별도 테이블로 분리 권장 — 큰 텍스트).
- `edit_applied_at timestamptz`, `edit_decided_at timestamptz`.

또는 표면 분리: `agent_wiki_edit_proposals` 테이블(entry_id FK, proposal, snapshot, status, decided_at) — `agent_wiki_entries` 무거워지는 것 방지. **권장: 별도 테이블**.

---

## 5. 리스크 & 완화

| 리스크 | 완화 |
|---|---|
| bounded edit 가 agent 프롬프트를 오염/과잉 팽창 | idempotent 마커 + 상한(패턴당 1섹션) + 오래된 resolved 는 rollup/압축 |
| 검증 샘픐 부족(실패 드묾)으로 accept/reject 판정 불확실 | conservative 기본(증가 시 즉시 기각), env 게이트, 수동 승인 모드 옵션 |
| 영구 프롬프트 쓰기가 다른 학습/수동 편집과 충돌 | 마커 기반 surgical edit + revert 스냅샷 + 충돌 시 skip(수동 편집 우선) |
| SkillOpt 프레임워크(`pip install skillopt`) 백엔드 연동 | 옵션. 우선 순수 TS 루프로 구현, SkillOpt 연동은 benchmark 단계에서 평가 |
| 5개 고정 패턴 외 신규 패턴 자동 군집 | Phase 3+ : classification 확장(errorCode/category 기반 자동 패턴 생성). Phase 3 범위 아님 |

---

## 6. 검증 계획 (Phase 3 구현 후)

1. `frequency>=3` entry 가 `proposing` → (검증) → `accepted`/`rejected` 로 전이하는지 단위 테스트.
2. accept 시 agent `promptTemplate` 에 마커 섹션 존재 + revert 시 제거 확인.
3. workProduct 미등록 패턴에 대해: Phase 3 활성 후 **해당 패턴 빈도가 감소**하는지(주 효과 지표)를 1~2주 관측.
4. 회귀: Phase 2 ephemeral 주입은 그대로 동작(Phase 3 가 깨뜨리지 않는지).

---

## 7. 구현 순서 (별도 세션)

1. `agent_wiki_edit_proposals` 스키마 + migration 0062 + service 메서드(`listCandidates`, `proposeEdit`, `decideEdit`).
2. `agent-skill-optimizer.ts` — `createAgentWikiEvolutionLoop` + `evolveOnce` (reconciler 패턴).
3. `agent-instructions.ts` 연동 — bounded edit + revert(surgical append/remove by marker).
4. `app.ts` 등록(env 게이트).
5. 단위/통합 테스트 + conservative 검증 로직 검증.
6. tsc + 마이그레이션 적용 + `AGENT_WIKI_EVOLUTION_ENABLED` 기본 off 로 배포.
