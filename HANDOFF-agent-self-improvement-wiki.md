# Handoff: Agent 자가학습 Wiki 시스템 (Self-Improving Knowledge Base)

> **목표**: papercompany 에이전트가 반복되는 오류(workProduct 미등록, adapter 자식 미종료, 529 재시도 등)에서 **자동으로 학습**하여, 같은 실수를 반복하지 않게 만드는 자가학습 wiki 시스템 구축.

> **작성일**: 2026-06-19
> **이전 세션 commit**: f33715d / f8335c0 / 91e2219 / 0dcbd59 / 931a110(ruyfowpx) / 1adbfd4 / c176dbc / a803559 / e10a5c9

---

## 1. 배경

### 반복 오류 사례
- **workProduct 미등록**: 에이전트가 산출물 파일은 생성하지만 `POST /api/issues/{id}/work-products`로 공식 등록 안 함 → mission artifact gate가 block → main executor 수동 복구. **며칠째 반복**.
- **adapter 자식 미종료**: issue done 후 opencode 자식이 exit 안 함 → run running 유지 → maxConcurrentRuns 블록 (commit e10a5c9로 즉시 kill 추가 완료).
- **529 재시도**: z.ai GLM 과부하 → adapter가 backoff 재시도 (commit f8335c0).
- **stdout 폭발**: adapter 자식이 무한 stdout → 서버 hang (commit 1adbfd4 cap-kill).

### 근본 원인
**에이전트가 학습하지 못함** — 매 run이 독립 세션이라 이전 실패 경험이 다음 run에 전달되지 않음. 복구는 됐지만 교훈이 어디에도 축적되지 않는 구조.

### papercompany 현황
- **knowledge-base plugin**: src 빈, DB 테이블 없음 (사실상 미구현).
- **gate 감지**: `heartbeat.ts:2045` "Mission artifact gate: workProduct registration missing".
- **agent instructions/learnings**: agent adapter_config.promptTemplate + instructionsFilePath (conan.md learnings 등). 수동 관리.
- **company skills**: agent가 쓰는 skill 파일(markdown). 수동.

---

## 2. 참고 연구

| 패턴 | 핵심 | 출처 |
|---|---|---|
| **SkillOpt** | skill document를 frozen agent의 훈련 가능 외부 상태로. scored rollouts → bounded edit → validation gate. SkillOpt-Sleep(야간 offline 자가진화) | [arXiv 2605.23904](https://arxiv.org/abs/2605.23904) / [GitHub](https://github.com/microsoft/SkillOpt) |
| **SkillX** | agent 경험(rollout)에서 자동으로 skill KB 구축. 실패/성공 패턴 추출 → 구조화 저장 → 다음 run에 주입 | [arXiv 2604.04804](https://arxiv.org/html/2604.04804v2) |
| **Knowledge Bundles** | LLM introspection으로 자기 지식 번들을 생성·검증·축적 | [Medium](https://medium.com/@brzezinski_j/generative-self-improvement-with-knowledge-bundles-kb-e1f7b681259a) |
| **Gödel Agent / SICA** | verifier-based loop: 시도 → 검증 → 실패 시 원인 분석 → 지식화 → 다음 시도 적용 | [ACL 2025](https://gist.github.com/AnthonyAlcaraz/a0b70a4bb5ce521129e93bf9d33f9698) |
| **Self-Challenging Agents** | LLM이 challenger + executor 역할 동시 수행 | NeurIPS 2025 |

공통: **실패 → 자동 학습 → 구조화 저장 → 다음 run 자동 적용 → 점진적 진화**.

---

## 3. 전체 설계 (Phase 1/2/3)

### Phase 1: 자동 축적 (Auto-Accumulation)

**목표**: 에이전트 실패 시 자동으로 wiki entry 생성.

#### DB Schema (신규 테이블)

```sql
CREATE TABLE agent_wiki_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,  -- NULL = company-wide
  mission_id UUID REFERENCES missions(id) ON DELETE SET NULL,
  pattern TEXT NOT NULL,           -- "workProduct 미등록", "adapter 자식 미종료", "529 overload"
  cause TEXT NOT NULL,             -- 근본 원인
  solution TEXT NOT NULL,          -- 해결 가이드 (agent가 읽을 한국어)
  error_code TEXT,                 -- "issue_done_child_not_exited", "claude_api_error_529" 등
  step_id TEXT,                    -- workflow step ID (해당 시)
  frequency INTEGER DEFAULT 1,    -- 발생 빈도 (같은 패턴 누적)
  status TEXT DEFAULT 'active',    -- active | resolved | archived
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_agent_wiki_company_pattern ON agent_wiki_entries(company_id, pattern);
CREATE INDEX idx_agent_wiki_agent ON agent_wiki_entries(agent_id);
```

#### Drizzle Schema 파일
- `packages/db/src/schema/agent_wiki_entries.ts`
- `packages/db/src/schema/index.ts` export 추가
- migration: `packages/db/src/migrations/XXXX_agent_wiki_entries.sql`

#### 실패 감지 → Wiki Entry 자동 생성 (훅 지점)

| 실패 유형 | 감지 지점 (heartbeat.ts) | Wiki entry |
|---|---|---|
| workProduct 미등록 | `:2045` "Mission artifact gate: workProduct registration missing" | pattern: "workProduct 미등록", solution: "산출물 파일 생성 후 POST /api/issues/{id}/work-products 로 등록" |
| adapter 자식 미종료 | e10a5c9 issue done → child kill | pattern: "adapter 자식 미종료", solution: "issue done 후 opencode exit 확인" |
| 529 overload | f8335c0 classification overload | pattern: "529 overload", solution: "adapter가 backoff 재시도 (이미 구현)" |
| execution_stale | `:3952` execution_stale_timeout | pattern: "execution stale (hang)", solution: "API_TIMEOUT 10분 + idle 점검" |
| stdout 폭발 | 1adbfd4 cap-kill | pattern: "stdout 폭발", solution: "64MB cap-kill (이미 구현)" |

#### 구현
- `server/src/services/agent-wiki.ts` (신규) — wiki entry CRUD + dedup(같은 pattern + company + agent면 frequency++).
- heartbeat.ts 실패 감지 지점에서 `agentWiki(db).recordFailure({ companyId, agentId, pattern, cause, solution, errorCode })`.

### Phase 2: 자동 주입 (Auto-Injection)

**목표**: agent run 시작 시 wiki에서 관련 교훈을 검색 → promptTemplate에 자동 주입.

#### 검색 + 주입 지점
- `heartbeat.ts` adapter 실행 전 (ctx 구성, `:4344-4366` adapterConfig resolve 근처).
- 또는 adapter-utils `buildPaperclipRuntimeBrief` 에 wiki 검색 결과 추가.

#### 구현
```ts
// heartbeat.ts, adapter 실행 전
const wikiEntries = await agentWiki(db).searchRelevant({
  companyId: agent.companyId,
  agentId: agent.id,
  stepId: currentStepId,
  limit: 3,  // top 3 관련 교훈
});
if (wikiEntries.length > 0) {
  const wikiBrief = wikiEntries.map(e => `- [${e.frequency}회] ${e.pattern}: ${e.solution}`).join("\n");
  // promptTemplate 또는 runtimeBrief에 주입
  resolvedConfig.promptTemplate = (resolvedConfig.promptTemplate ?? "") + `\n\n## 과거 실패 교훈 (자동 생성)\n${wikiBrief}`;
}
```

#### 효과
- agent가 run 시작 시 "이 step에서 3회 workProduct 미등록 실패 → 등록 필수" 인지.
- 2회차부터 같은 실수 방지.

### Phase 3: 자가 진화 (SkillOpt-Sleep 패턴)

**목표**: 반복 패턴(3회+)을 agent instructions에 통합 (validation gate).

#### 구조
```
[야간/주기적 SkillOpt-Sleep]
1. wiki에서 frequency >= 3 인 active entry 수집
2. 각 패턴에 대해 agent promptTemplate/instructionsFile에 bounded edit 추가
   - "## 주의: 이 step에서는 반드시 workProduct 등록"
3. Validation: 다음 N run에서 같은 실패 빈도 감소 → accept
4. accept 시: agent config(promptTemplate) 영구 반영, wiki entry status → resolved
5. reject 시: revert, rejected-edit buffer에 저장
```

#### 구현
- `server/src/services/agent-skill-optimizer.ts` (신규) — SkillOpt-Sleep 루프.
- 주기적 실행(cron 또는 heartbeat-scheduler 별도 lane).
- validation: wiki entry frequency 추이(실패 감소 측정).

#### SkillOpt 연계 (옵션)
- `pip install skillopt` — SkillOpt 프레임워크로 agent instructions 최적화.
- SkillOpt backend: papercompany adapter 실행 환경(opencode/claude/codex).
- benchmark: papercompany workflow run(workProduct 등록 성공률).

---

## 4. 구현 순서

1. **DB schema** — agent_wiki_entries 테이블 + drizzle + migration.
2. **agent-wiki.ts service** — CRUD + dedup(frequency++) + searchRelevant.
3. **Phase 1 훅** — heartbeat.ts 실패 감지 지점(5곳)에 `agentWiki.recordFailure()` 추가.
4. **Phase 2 주입** — heartbeat.ts adapter 실행 전 `agentWiki.searchRelevant()` → promptTemplate 주입.
5. **Phase 3 SkillOpt-Sleep** — agent-skill-optimizer.ts + 주기 실행 + validation gate.
6. **검증** — workProduct 미등록 실패가 2회차부터 감소하는지 측정.

---

## 5. 핵심 파일 (수정/신규)

| 파일 | 작업 |
|---|---|
| `packages/db/src/schema/agent_wiki_entries.ts` | **신규** — drizzle schema |
| `packages/db/src/schema/index.ts` | export 추가 |
| `packages/db/src/migrations/XXXX_agent_wiki.sql` | **신규** — migration |
| `server/src/services/agent-wiki.ts` | **신규** — wiki service (CRUD + dedup + search) |
| `server/src/services/heartbeat.ts` | Phase 1: 실패 훅(5곳). Phase 2: adapter 전 주입 |
| `server/src/services/agent-skill-optimizer.ts` | **신규** — Phase 3 SkillOpt-Sleep |
| `server/src/app.ts` | agent-skill-optimizer 주기 실행 등록 |

---

## 6. 이전 세션 context (이미 해결된 것)

| commit | 해결 | 관련 Phase |
|---|---|---|
| f33715d | reconciler 주기 등록(60min stuck 컷) | 실패 감지 기반 |
| f8335c0 | adapter 529 backoff + classification overload + orphan 보존 | 529 패턴 wiki entry |
| 91e2219 | createWorkflowStepIssue idempotency | issue 증식 패턴 |
| 0dcbd59 | wrapper API_TIMEOUT 10분 | hang 패턴 |
| 931a110 | downstream pending 보존 + activeStep | workflow 60min 패턴 |
| 1adbfd4 | stdout cap-kill(64MB) | stdout 폭발 패턴 |
| c176dbc | startup Hermes Ops wake(점검 + telegram) | 서버 시작 복구 |
| a803559 | hermes ctx.config(resolved env) 우선 | telegram token 주입 |
| e10a5c9 | issue done → 자식 즉시 kill | adapter 자식 미종료 패턴 |

---

## 7. 참고 자료

- [SkillOpt (arXiv 2605.23904)](https://arxiv.org/abs/2605.23904) — text-space skill optimizer, SkillOpt-Sleep
- [SkillOpt GitHub (microsoft/SkillOpt)](https://github.com/microsoft/SkillOpt) — `pip install skillopt`, multi-backend
- [SkillX (arXiv 2604.04804)](https://arxiv.org/html/2604.04804v2) — 자동 skill KB 구축
- [Knowledge Bundles (Medium)](https://medium.com/@brzezinski_j/generative-self-improvement-with-knowledge-bundles-kb-e1f7b681259a) — self-improvement 아키텍처
- [Gödel Agent / SICA (ACL 2025)](https://gist.github.com/AnthonyAlcaraz/a0b70a4bb5ce521129e93bf9d33f9698) — verifier-based loop
- [Self-Improving AI Agents: 2026 Guide](https://o-mega.ai/articles/self-improving-ai-agents-the-2026-guide)

---

## 8. 다음 세션 시작점

1. 이 문서 Read.
2. Phase 1부터: DB schema(drizzle) → agent-wiki.ts service → heartbeat 훅.
3. tsc 검증 + 서버 재시작 + gate 실패 시 wiki entry 생성 확인.
4. Phase 2: adapter 전 주입 + agent가 wiki 교훈 인지 확인.
5. Phase 3: SkillOpt-Sleep 설계(별도 세션 가능).
