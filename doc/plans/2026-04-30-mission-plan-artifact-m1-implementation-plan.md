# M1 Mission Plan Artifact 최소 Persistent Model Implementation/TDD Plan

Date: 2026-04-30
Status: docs-only implementation/TDD plan
Scope: Papercompany Mission Ownership Substrate M1 — `mission_plan` artifact minimal persistent model
Previous: `doc/plans/2026-04-30-mission-ownership-substrate-plan.md`

## 1. Goal

M1의 목표는 mission owner / main executor가 사용할 최소 작전판을 persistent하게 저장하고 조회할 수 있게 하는 것이다.

이 plan artifact는 agent 판단을 대체하는 RPA 절차표가 아니다. Mission owner가 다음을 세션/실행 간 유지할 수 있게 하는 memory substrate다.

- mission goal과 현재 plan revision
- rule/KB/workflow/issue reference
- assumptions와 required inputs
- success criteria와 risks
- plan steps와 linked issue/workflow step 후보
- runtime brief에 넣을 수 있는 compact summary

기존 `mission_main_executor_plan` issue는 유지한다. M1은 이를 대체하지 않고 병행/연결한다.

## 2. Non-goals

이번 문서는 implementation/TDD plan만 작성한다. 이번 단계에서는 아래를 하지 않는다.

- DB migration 생성/적용
- Drizzle schema 코드 변경
- server/service/runtime 코드 구현
- UI/API 구현
- delegation_record 구현
- supervision loop / stale detection 구현
- failure diagnosis 구현
- recovery/replan artifact 구현
- outcome report 구현
- hard enforcement / block 로직
- Phase B audit field 확장
- RPA식 `condition -> action` 규칙 엔진화

## 3. Current schema inspection summary

### Confirmed surfaces

| Area | Confirmed current element | M1 connection point |
| --- | --- | --- |
| Missions | `packages/db/src/schema/missions.ts` has `missions.id`, `companyId`, `ownerAgentId`, `title`, `description`, `status`, `goalId`, timestamps. | `mission_plan_artifacts.missionId` references this row; `ownerAgentId` becomes initial artifact owner; `title/description` seed `missionGoal`. |
| Mission agents | `mission_agents` stores mission roster with `missionId`, `agentId`, `role` and unique `missionId + agentId`. Roles are coarse `executor/reviewer/observer`. | Use only as context/roster. Do not treat it as delegation-level responsibility. Plan steps can optionally include `intendedRole`/`assignedAgentId` in JSON, but M2 owns real delegation. |
| Mission sessions | `mission_sessions` stores active adapter/session continuity with `missionId`, `agentId`, `companyId`, `adapterType`, `status`, `lastActiveAt`, `runCount`. | Runtime summary should be compatible with session continuity. M1 does not mutate sessions. |
| Issues | `issues` has `companyId`, `missionId`, `assigneeAgentId`, `originKind`, `originId`, `originRunId`, `executionRunId`, `parentId`, status/timestamps. | Existing plan/oversight issues remain visible work objects. M1 should link to `mission_main_executor_plan` issue by refs JSON or `originKind` lookup, not replace it. |
| Main executor planning issue | `server/src/services/missions.ts` creates a manual planning issue with `originKind: "mission_main_executor_plan"` for manual missions. | M1 initial plan creation should run alongside this path. The issue remains human/operator-visible; artifact is structured substrate. |
| Main executor oversight issue | `server/src/services/missions.ts` creates `originKind: "mission_main_executor_oversight"` for workflow-created missions/oversight paths. | Workflow-created mission plans can reference oversight issue/workflow refs, but do not require a manual planning issue. |
| Workflow runs | `workflow_runs` has `companyId`, `missionId`, `workflowId`, `status`, `triggeredBy`, timestamps. | M1 `refs` JSON can include workflow run refs; service can summarize latest workflow run status. |
| Workflow step runs | `workflow_step_runs` has `workflowRunId`, `stepId`, `issueId`, `status`, timestamps. | M1 `steps` JSON can include `workflowStepId` and `issueId` refs, but no step-state reconciliation yet. |
| Activity log | `activity_log` has `companyId`, `actorType`, `actorId`, `action`, `entityType`, `entityId`, optional `agentId`, `runId`, `details`. | Plan create/revision events should be logged as mutations when route/service paths are invoked. M1 can log `mission_plan.created` / `mission_plan.revised`. |
| Runtime brief | `packages/adapter-utils/src/runtime-brief.ts` renders compact manifest/context lines; `server/src/services/step-input-manifest.ts` shapes context inputs. | M1 can add a `missionPlan` / `paperclipMissionPlan` summary object to context and render only compact latest active summary. |
| Tests | Existing mission tests cover manual planning issue creation and workflow-created mission behavior. `server/src/__tests__/runtime-brief.test.ts` covers compact runtime brief rendering. | M1 tests should extend these surfaces instead of creating broad new E2E flows. |

### Proposed surfaces

| Proposed object | Why it is needed | M1 boundary |
| --- | --- | --- |
| `mission_plan_artifacts` table | Issue descriptions cannot reliably store revision, assumptions, required inputs, success criteria, risks, refs, and structured steps. | Add minimal table and service methods only. |
| `missionPlanService` or `missionPlanArtifactService` | Keeps plan revision logic separate from broad `missionService` while allowing mission creation integration. | Create/get/revise/summarize functions. |
| Runtime mission plan summary | Mission owner needs latest plan context without dumping entire revision history. | Compact summary only; no planner enforcement. |
| Route/API exposure | External API can be useful but is not required for first persistent substrate if service/runtime integration is enough. | Prefer internal service first. If route is included in M1, make it narrow and board/company-scoped. |

## 4. Proposed minimal DB model

### Table name decision

Recommended name: `mission_plan_artifacts`.

Reasons:

- Matches M0 language: this is an artifact/document substrate, not the mission itself.
- Leaves room for future `mission_plans` view/domain wrapper if normalized tables appear later.
- Avoids implying that there is only one plan object. The design is revisioned artifacts.

Acceptable alternative: `mission_plans` if the team prefers shorter names. If choosing this, keep service/type names explicit enough to preserve artifact semantics.

### Minimal Drizzle shape

```ts
export const missionPlanArtifacts = pgTable(
  "mission_plan_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    status: text("status").notNull().default("active"),
    ownerAgentId: uuid("owner_agent_id").notNull().references(() => agents.id),
    missionGoal: text("mission_goal").notNull(),
    refs: jsonb("refs").$type<MissionPlanRefs>().notNull().default(sql`'{}'::jsonb`),
    assumptions: jsonb("assumptions").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    requiredInputs: jsonb("required_inputs").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    successCriteria: jsonb("success_criteria").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    risks: jsonb("risks").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    steps: jsonb("steps").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyMissionIdx: index("idx_mission_plan_artifacts_company_mission").on(table.companyId, table.missionId),
    missionRevisionUq: uniqueIndex("mission_plan_artifacts_mission_revision_key").on(table.missionId, table.revision),
    missionStatusRevisionIdx: index("idx_mission_plan_artifacts_mission_status_revision").on(table.missionId, table.status, table.revision),
  }),
);
```

Notes:

- Include `companyId` even though `missionId` implies company, because every domain entity should remain company-scoped and route/service checks should be easy.
- `ownerAgentId` should normally mirror `missions.ownerAgentId` at creation/revision time. This preserves historical ownership if mission owner changes later.
- `missionGoal` should seed from mission title + description. It is intentionally text, not a generated decision script.
- JSON-first fields keep M1 small. Normalized child tables are deferred until delegation/supervision/reporting semantics stabilize.

### Status vocabulary

Recommended minimal status values:

- `draft`: created but not yet runtime-active.
- `active`: latest plan revision used for runtime summary.
- `superseded`: previous active revision after replan.
- `completed`: retained final plan when mission is closed.
- `archived`: operator/system-retained but not active.

M1 should validate status in service code. A DB enum is not required in the first slice because current schema uses text statuses broadly.

### Unique / active revision strategy

Required DB constraint:

- `unique(mission_id, revision)`

Recommended service invariant:

- `createInitialMissionPlan(...)` creates revision `1` if none exists.
- `createMissionPlanRevision(...)` reads current highest revision for mission, writes `revision + 1`, and marks previous active row as `superseded` in the same transaction.
- `getActiveMissionPlan(missionId)` queries `status = 'active'` ordered by `revision desc`, limit 1.

Optional later DB constraint:

- partial unique index for one active row per mission: `(mission_id) where status = 'active'`.

For M1, prefer service transaction + tests over relying solely on partial unique active constraint. This keeps the implementation portable with the current dev/test DB setup while still making the active lookup deterministic.

### JSON-first vs normalized child tables

Recommendation: start JSON-first.

Reason:

- M1 is the first persistent substrate and should avoid premature modeling of steps/required inputs/risk refs.
- `steps` will later connect to delegation records, issue links, workflow steps, stale/failure states, and outcome evidence. Normalizing before those semantics are tested risks locking in an RPA-like shape.
- JSON keeps agent-authored plan data flexible while service methods validate only minimal shape and compact summary requirements.

Deferred normalized candidates:

- `mission_plan_steps`
- `mission_plan_required_inputs`
- `mission_plan_refs`
- `mission_plan_success_criteria`

Do not add these in M1.

## 5. Proposed service API

Recommended file:

- `server/src/services/mission-plan-artifacts.ts`

Alternative:

- Add a small submodule under `server/src/services/missions/mission-plan-artifacts.ts` only if service directory split is already preferred.

### Types

```ts
type MissionPlanArtifactStatus = "draft" | "active" | "superseded" | "completed" | "archived";

type MissionPlanRefs = {
  planningIssueId?: string | null;
  oversightIssueId?: string | null;
  workflowRunIds?: string[];
  workflowStepIssueIds?: string[];
  ruleRefs?: Array<{ id: string; name?: string; source?: string }>;
  kbRefs?: Array<{ id: string; name?: string; reason?: string }>;
};

type MissionPlanStep = {
  id: string;
  title: string;
  intendedRole?: string | null;
  assignedAgentId?: string | null;
  issueId?: string | null;
  workflowStepId?: string | null;
  expectedOutput?: string | null;
  status?: "planned" | "delegated" | "running" | "blocked" | "done" | "cancelled";
};
```

Keep validation permissive but structured enough to avoid garbage runtime summaries.

### `createInitialMissionPlan(...)`

Purpose:

- Create revision 1 for a mission if no plan exists.
- Seed goal and refs from the mission row and existing planning/oversight/workflow context.

Candidate signature:

```ts
async function createInitialMissionPlan(input: {
  companyId: string;
  missionId: string;
  ownerAgentId?: string;
  missionGoal?: string;
  refs?: MissionPlanRefs;
  assumptions?: unknown[];
  requiredInputs?: unknown[];
  successCriteria?: unknown[];
  risks?: unknown[];
  steps?: MissionPlanStep[];
  status?: "draft" | "active";
  actor?: ActivityActor;
}): Promise<MissionPlanArtifactRow>;
```

Behavior:

- Verify mission exists and belongs to `companyId`.
- Default `ownerAgentId` from mission.
- Default `missionGoal` from mission title/description.
- If a plan already exists for the mission, return existing revision 1 or active plan rather than creating duplicate initial artifacts.
- Log `mission_plan.created` if this is a new row and the path has actor context.

### `getActiveMissionPlan(missionId)`

Purpose:

- Return latest active plan artifact for runtime summary and mission detail/service calls.

Candidate signature:

```ts
async function getActiveMissionPlan(input: {
  companyId: string;
  missionId: string;
}): Promise<MissionPlanArtifactRow | null>;
```

Behavior:

- Verify mission company boundary.
- Query `status = 'active'` ordered by `revision desc`.
- Return null if no plan exists. Do not synthesize hidden plan in read path.

### `createMissionPlanRevision(...)`

Purpose:

- Preserve previous revisions and write a new active revision.

Candidate signature:

```ts
async function createMissionPlanRevision(input: {
  companyId: string;
  missionId: string;
  ownerAgentId?: string;
  missionGoal?: string;
  refs?: MissionPlanRefs;
  assumptions?: unknown[];
  requiredInputs?: unknown[];
  successCriteria?: unknown[];
  risks?: unknown[];
  steps?: MissionPlanStep[];
  status?: "draft" | "active";
  actor?: ActivityActor;
}): Promise<MissionPlanArtifactRow>;
```

Behavior:

- Verify mission and company boundary.
- In one transaction:
  - find current highest revision;
  - mark current active rows as `superseded` if the new revision is active;
  - insert new row with `revision = highest + 1`.
- Log `mission_plan.revised` with from/to revision and active/superseded details.

### `summarizeMissionPlanForRuntime(...)`

Purpose:

- Convert latest active plan into compact agent-visible context.
- Avoid dumping full JSON/history into prompt.

Candidate signature:

```ts
function summarizeMissionPlanForRuntime(plan: MissionPlanArtifactRow | null): {
  available: boolean;
  missionPlanId?: string;
  revision?: number;
  status?: string;
  ownerAgentId?: string;
  missionGoal?: string;
  requiredInputsCount?: number;
  openRequiredInputs?: string[];
  successCriteriaCount?: number;
  riskCount?: number;
  stepCount?: number;
  stepSummary?: string[];
  refs?: {
    planningIssueId?: string | null;
    oversightIssueId?: string | null;
    workflowRunIds?: string[];
  };
};
```

Runtime brief rendering should be compact, e.g.

```text
- Mission plan: rev 2 active — Customer homepage rollout
- Mission plan inputs: 1 open required input
- Mission plan steps: 3 planned/delegated steps
```

Do not render long assumptions, full step bodies, or historical revisions.

## 6. API exposure boundary

M1 can be split into internal service first and route/API later.

Recommended M1a boundary:

- DB schema + migration
- `missionPlanArtifactService`
- mission creation integration
- runtime summary utility and runtime brief rendering
- tests
- no public route/UI yet

Optional M1b route if needed after M1a passes:

- `GET /missions/:id/plan` — board/agent company-scoped latest active plan summary or full artifact
- `POST /missions/:id/plan/revisions` — create active revision

If route is added, requirements:

- call `svc.getById(req.params.id)` or equivalent to assert mission exists and company access
- use `assertCompanyAccess(req, mission.companyId)`
- write `activity_log` for mutation
- validate payload via shared/server validator
- no UI implementation in M1 unless separately requested

This plan recommends deferring route/UI until service/runtime substrate is proven by tests.

## 7. Integration points

### A. Manual mission creation

Current behavior:

- `missionService.create({ source: "manual" })` creates mission row.
- Adds owner to `mission_agents` as `executor`.
- Ensures `mission_main_executor_plan` issue.

M1 integration:

1. Keep existing planning issue creation.
2. Create initial `mission_plan_artifacts` revision 1 after mission row exists.
3. Include `refs.planningIssueId` if it can be obtained without large refactor.
   - If `ensureMainExecutorPlanningIssue(...)` currently returns void, M1 can either:
     - update it to return the existing/created issue id; or
     - look up by `missionId + originKind` after ensure.
4. Seed `missionGoal` from `mission.title` + `mission.description`.
5. Add basic success criterion from title/description only if not too speculative. Prefer empty `successCriteria` over hallucinated criteria if mission data is sparse.

### B. Workflow-created mission/materialization

Current behavior:

- `missionService.create({ source: "workflow", status: "active" })` avoids manual planning issue.
- Existing service has workflow run/step run linkage and oversight issue support.

M1 integration:

1. Do not create a manual `mission_main_executor_plan` issue for workflow-created missions.
2. Create initial plan artifact if mission creation has enough context, or create it when workflow run is linked/materialized.
3. Include `refs.workflowRunIds` and, when available, `steps` derived from workflow definition/step runs.
4. Link `refs.oversightIssueId` if an oversight issue is ensured.
5. Do not force step-by-step execution. The plan is owner memory, not an engine.

### C. Main executor plan issue connection

M1 must keep issue and artifact distinct:

- Issue: operator/agent-visible work item and conversation anchor.
- Artifact: structured revisioned substrate for resumption/runtime summary.

Connection options:

- Store `refs.planningIssueId` on the plan artifact.
- Keep `issues.originKind = "mission_main_executor_plan"` as discoverable fallback.
- Do not store plan JSON inside issue description.
- Do not remove or hide the issue in M1.

### D. Runtime brief / heartbeat context

Current path:

- `server/src/services/step-input-manifest.ts` creates the manifest input summary.
- `packages/adapter-utils/src/runtime-brief.ts` renders compact brief lines.
- `server/src/services/context-budget-preflight.ts` counts runtime brief text.
- `server/src/services/step-input-manifest-guard.ts` includes runtime brief in guarded prompt.

M1 candidate:

- Add `paperclipMissionPlan` or `missionPlan` context input before manifest rendering.
- Extend manifest inputs with `missionPlan: { available, revision, status, missionGoal, stepCount, requiredInputsCount, openRequiredInputs, refs }`.
- Render compact lines in `buildPaperclipRuntimeBrief`.
- Add test ensuring full plan JSON/history is not included.

## 8. TDD task breakdown

### T0 — docs-only commit for this plan

- Write this plan.
- Run `git diff --check`.
- Commit docs-only.

### T1 — DB/schema red/green

Red tests:

- Add a schema/migration smoke test or DB integration test that attempts to import/select/insert `missionPlanArtifacts` and currently fails because table/schema is missing.
- Test unique `(missionId, revision)` by attempting duplicate revision insert.

Green implementation:

- Add `packages/db/src/schema/mission_plan_artifacts.ts`.
- Export from `packages/db/src/schema/index.ts`.
- Generate migration with `pnpm db:generate`.
- Confirm generated SQL includes table, company/mission/owner refs, unique mission revision, and useful indexes.

Target command candidates:

```sh
pnpm --filter @paperclipai/db build
pnpm test:run server/src/__tests__/mission-plan-artifacts-service.test.ts
```

### T2 — service create/get initial plan

Red tests in `server/src/__tests__/mission-plan-artifacts-service.test.ts`:

- `createInitialMissionPlan` creates revision 1 active for an existing mission.
- It rejects a mission from another company.
- It is idempotent for initial creation and does not duplicate revision 1.
- `getActiveMissionPlan` returns latest active plan or null.

Green implementation:

- Create `server/src/services/mission-plan-artifacts.ts`.
- Implement company/mission verification.
- Validate minimal status and array fields.
- Add activity log only if actor context is passed; otherwise keep service pure enough for creation integration tests.

### T3 — mission creation integration

Red tests extending `server/src/__tests__/missions-service.test.ts` or a focused new test:

- Manual mission creation still creates `mission_main_executor_plan` issue.
- Manual mission creation also creates initial active plan artifact revision 1.
- Plan artifact includes `companyId`, `missionId`, `ownerAgentId`, `missionGoal`, and `refs.planningIssueId` if available.
- Workflow-created mission still does not create manual planning issue.
- Workflow-created mission can still have a plan artifact with workflow/oversight refs when materialization path supplies them.

Green implementation:

- Call mission plan service after mission row/mission_agents creation and after planning issue ensure if manual.
- Keep existing behavior intact.
- Avoid making mission creation fail on optional refs lookup unless the core artifact insert fails.

### T4 — revision semantics

Red tests:

- `createMissionPlanRevision` creates revision 2 when revision 1 exists.
- Previous active revision becomes `superseded` when new revision is active.
- `getActiveMissionPlan` returns revision 2.
- Duplicate revision cannot be inserted at DB/service layer.

Green implementation:

- Implement transaction around supersede + insert.
- Log `mission_plan.revised` with revision metadata when actor is present.

### T5 — runtime summary utility

Red tests:

- `summarizeMissionPlanForRuntime(null)` returns `{ available: false }`.
- It summarizes counts and short step labels for an active plan.
- It excludes full assumptions/risks/history/long step bodies.

Green implementation:

- Add pure summary function in mission plan service or a small shared server utility.
- Keep output JSON serializable and compact.

### T6 — runtime brief rendering

Red tests in `server/src/__tests__/runtime-brief.test.ts`:

- Runtime brief renders `Mission plan: rev N active` when manifest/context has a mission plan summary.
- It renders required input/step counts compactly.
- It does not include full JSON/history.

Green implementation:

- Extend `packages/adapter-utils/src/runtime-brief.ts` to read `manifest.inputs.missionPlan` or context fallback.
- Extend `server/src/services/step-input-manifest.ts` to include mission plan summary if provided in context.
- Add/update context-budget preflight test only if character accounting changes materially.

### T7 — optional route/API TDD only after M1a

If a route is explicitly approved:

Red tests in `server/src/__tests__/mission-routes.test.ts`:

- `GET /missions/:id/plan` enforces company access and returns active plan.
- `POST /missions/:id/plan/revisions` creates revision and logs activity.
- Payload validation rejects invalid refs/steps.

Green implementation:

- Add narrow route handlers in `server/src/routes/missions.ts`.
- Add shared/server validators if the route is public.

## 9. Files likely to change in implementation phase

Do not change these in this docs-only step. Candidate implementation files later:

- `packages/db/src/schema/mission_plan_artifacts.ts` — new table
- `packages/db/src/schema/index.ts` — export table
- `packages/db/src/migrations/0053_*.sql` or generated next migration — new table/indexes
- `server/src/services/mission-plan-artifacts.ts` — service API
- `server/src/services/missions.ts` — creation integration / planning issue link lookup
- `server/src/services/step-input-manifest.ts` — mission plan summary manifest input
- `packages/adapter-utils/src/runtime-brief.ts` — compact brief rendering
- `server/src/__tests__/mission-plan-artifacts-service.test.ts` — service/db tests
- `server/src/__tests__/missions-service.test.ts` — mission creation regression
- `server/src/__tests__/runtime-brief.test.ts` — brief rendering regression
- Optional only after approval: `server/src/routes/missions.ts`, `server/src/__tests__/mission-routes.test.ts`, shared validators/types

## 10. Verification commands

Docs-only step verification:

```sh
git diff --check
```

Implementation focused checks:

```sh
pnpm test:run server/src/__tests__/mission-plan-artifacts-service.test.ts
pnpm test:run server/src/__tests__/missions-service.test.ts
pnpm test:run server/src/__tests__/runtime-brief.test.ts
```

If route/API is added:

```sh
pnpm test:run server/src/__tests__/mission-routes.test.ts
```

Package/build checks:

```sh
pnpm --filter @paperclipai/db build
pnpm -r typecheck
pnpm test:run
pnpm build
```

Reporting pattern:

- Report focused tests separately from full-suite result.
- If full suite fails or times out outside the changed area, include exact failing command/output class and rerun the failing file(s) individually before claiming status.
- Do not claim `tests pass` unless the exact command passed in the current run.

## 11. Commit sequencing

This docs-only step:

1. Commit only `doc/plans/2026-04-30-mission-plan-artifact-m1-implementation-plan.md`.
2. Suggested commit message:

```text
docs: plan mission plan artifact m1
```

Later implementation sequencing proposal:

### Option A — one small implementation commit

Use if the implementation stays compact:

1. `feat: add mission plan artifact substrate`
   - schema/migration
   - service
   - mission creation integration
   - runtime summary/brief
   - focused tests

### Option B — two implementation commits

Recommended if runtime brief integration gets non-trivial:

1. `feat: persist mission plan artifacts`
   - schema/migration
   - service
   - mission creation integration
   - DB/service/mission tests
2. `feat: surface mission plan in runtime brief`
   - summary utility
   - step input manifest/runtime brief rendering
   - runtime brief/context budget tests

Do not include UI/API routes in the same commit unless explicitly approved; keep route exposure as M1b.

## 12. Risks and open questions

### Risks

- Plan artifact could drift into RPA if step status is treated as a mandatory execution engine. Mitigation: keep it as owner memory/summary and defer enforcement.
- JSON-first can accumulate inconsistent shapes. Mitigation: minimal validators + runtime summary sanitizer; normalize only after M2/M3 semantics are proven.
- Mission creation integration can accidentally change existing `mission_main_executor_plan` behavior. Mitigation: regression tests must assert existing issue behavior stays unchanged.
- Runtime brief could become too verbose. Mitigation: compact counts/short labels only; test that full JSON is omitted.

### Open questions for implementation review

- Should initial artifact creation happen for every mission, or only when a mission owner/main executor is expected to run?
- Should `refs.planningIssueId` be required for manual missions, or best-effort?
- Should workflow-created missions create an active plan immediately or wait until workflow run/definition context is attached?
- Should route/API exposure be deferred to M1b, as recommended here, or included in M1 for operator inspection?

## 13. Acceptance criteria for M1 implementation later

M1 implementation can be called complete only when all are true:

- A company-scoped, revisioned `mission_plan_artifacts` persistent model exists.
- Initial active plan creation works for mission creation without replacing main executor planning/oversight issues.
- Revision creation preserves prior revisions and makes latest active lookup deterministic.
- Runtime summary can include latest active plan compactly.
- Focused tests cover DB/service/mission integration/runtime brief behavior.
- `pnpm -r typecheck`, focused tests, and agreed full-suite/build checks are run and reported with exact outcomes.
