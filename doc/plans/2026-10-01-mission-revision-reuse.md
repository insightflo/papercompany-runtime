# Mission revision reuse implementation plan

> **For agentic workers:** Use subagent-driven-development for sequential bounded implementation and read-only reviews. Never run two writers concurrently.

**Goal:** A revision mission retains its source, informs planning from durable records, reuses explicitly board-approved successful outputs, and rejects unchanged failed execution configurations.
**Architecture:** Nullable source links on missions; DB-only revision dossier; versioned durable seed records with immutable producer identities; guard based on historical execution snapshots. Existing no-seed execution semantics stay unchanged.
**Tech Stack:** TypeScript, Drizzle/PostgreSQL, Zod, React, Vitest.
**Spec:** User's approved four-part task, plus doc/SPEC-implementation.md and AGENTS.md.

## Global constraints
- Work ONLY in this worktree; no other checkout writes, push, deployment or live DB/A1 access. Keep the mixed stash untouched.
- Natural language is NEVER execution authority. No parsing comments, stdout/stderr, Markdown or prose. Ignore sourceCommentId-backed legacy authority.
- Preserve company scoping, approvals, issue checkout, single assignee, budgets and activity logging.
- New implementation/test files <=300 lines. Do not grow legacy oversized files; extract small cohesive existing blocks when adding integration hooks.
- Full path first, then hardening. No partial tests represented as overall completion.
- Tests use isolated DBs and unique company/issue ids (LESSONS collision warning). Engine fixtures import workflow-control-node boundary before services.

## Current stage / evidence
- [x] Clean worktree verified: feat/mission-revision-reuse at 41fa24b; stash not applied.
- [x] Read repository instructions, lessons, goal/product/spec/development/database; read-only investigation mapped callers.
- [ ] Connect source → planner → seed admission/materialization/selection → repeat-failure plan validation.
- [ ] Add/re-run focused safety and regression tests; independent review.
- [ ] Run pnpm -r typecheck; pnpm test:run; pnpm build. Establish origin/main baseline for unrelated failures without touching other checkouts.
- [ ] Commit working parts locally and concise <=80-line final report.

## Authority and boundaries
Execution truth: workflow_runs, workflow_step_runs, workflow_run_definitions; admitted heartbeat/work-product producer records. Plan authority: structured mission_plan_decision_submissions and mission_plan_qa_verdicts only. Source snapshot must be historical, never a mutable-definition fallback.
Callers: UI missionRevisionRequest → DialogContext/NewMissionDialog → missions API/routes/service/create-records. Planning description and mission-owner-planning-context → heartbeat → manifest → runtime brief. Run trigger has workflow/plugin/webhook/scheduler callers; plan materialization also directly creates runs. Selector has tool-step-args, qa-artifact-request/consumer callers.
Reuse startStepId/preserved graph patterns, NOT their evidence assumptions. replacementIntent authorizes same-mission full restart, NOT cross-mission seeding.

## Design rulings
- Board actor is the initial seed authorization mechanism. Agents may propose but never directly self-seed. No implicit automatic reuse.
- Seed set must be ancestor-closed. Keep source producers unchanged; target seeded steps have no source issueId (prevents issue-state synchronization from mutating them).
- Store seed approval/provenance with run creation; apply completed steps during initial step materialization under run lock. Pre-inserting steps breaks claimPlainWorkflowStart's no-step invariant.
- Seeded completion readiness is derived from verified seed evidence; never manufacture dispatch/heartbeat history.
- Historical snapshot full hash includes run identity, so compare a versioned canonical execution-step/config hash instead. Source failure error codes come from scoped heartbeat records, not error prose.
- Mission-generated PAQO step ids include missionId: explicit structured source-step references / stable mapping are required, never name similarity. Definition text/labels alone must not bypass repeat-failure checks.
- Reject unsupported seed node types and missing historical evidence rather than weakening validation. Document restrictions.

### Task 1: Minimum whole-path contracts and source/planner linkage
- In progress (delegated sole writer): minimum connection only. Source DB links → scoped DB dossier → planning issue + owner context → manifest/runtime brief. Tasks 2/3, live DB and deployment excluded. Required proof: isolated unique-ID DB scope/refusal tests, UI ID forwarding, comment exclusion, focused regression tests and relevant typechecks. LESSONS: UUID-sized unique company prefixes; no prose/legacy comment authority; fixture boundary imports precede services.
Files: packages/db/src/schema/missions.ts (+ generated migration); shared mission types/validators; missions route/service/create-records; UI revision prefill/dialog; new revision-context module, planning description/context.
- [x] Tests first: foreign-company source and source-run/mission mismatch; UI preserves structured ids; DB-only dossier excludes comment prose.
- [x] Add nullable sourceMissionId/sourceWorkflowRunId with validated same-company relationship; record link in activity event.
- [x] Build context from scoped step attempts, error codes, structured QA/operator decisions and completed-step work products with stored sha256/registered producer.
- [x] Ensure planner receives delimited structured context in actual input path, not only an unused helper.
- [x] Generate migration via pnpm db:generate; focused tests; local commit (Task1 commit carries this plan).
- Evidence: `/tmp/task1-red.log` 5 expected missing-behavior failures; generated `0120_pretty_iceman.sql` contains only two nullable columns/FKs; `/tmp/task1-focused-final.log` 15 files / 82 tests pass; `/tmp/task1-types-final.log` db/shared/server/ui/adapter-utils typechecks pass; `git diff --check` clean. Actual DB test calls missionService.create and inspects persisted PLAN description, then context/manifest/runtime brief. Actual React dialog test uses DialogProvider and submits IDs to API client.
- Compatibility correction: omit absent revisionContext from ordinary manifest (existing exact-shape regression retained); extracted small mission loader and handoff summarizer so oversized files do not grow. Existing MissionRevisionActions tests still emit React act-environment warnings.
- Limits for parent: DB-only hashes are stored `metadata.sha256`, not fresh file verification; missing digest or producer means product omitted. Dossier is planning reference only, not seed admission. Heartbeat rows are current execution-generation scoped; step retry/iteration counters are separate from individual heartbeat history. No Task2/3 implementation, full suite/build, live DB, push or deploy.

### Task 2: Seed admission → materialization → explicit selector
- In progress (sole child writer): close seed admission → locked initial materialization → downstream product selection. Atomic board authorization and immutable producer/hash records are required safety boundaries. No Task3 guard, live DB, deployment, stash or other-checkout edits. Automatic revision PAQO launch must wait for explicit board trigger; API is the minimum operator path. Verify actual isolated DB materialization/selection plus refusals, then focused typechecks. Preserve ordinary no-seed behavior.
Files: shared workflow seed contract; new DB workflow_run_seeds schema/export/migration; new workflow seed service modules; engine/run creation/materialization; selector/tool args/QA consumers; workflow/plugin route forwarding.
Interface: seedFromRun: {sourceWorkflowRunId: UUID, stepIds: string[]} accepted by board-trigger contract. Versioned durable records bind destination run+step to source run+step+generation/retry/iteration, work-product ids/hashes/producers, compatible step hash, approving actor.
- [x] Tests first: completed producer seed becomes completed in target and downstream selects source output; no seed unchanged.
- [x] Reject non-board, foreign/unlinked source, incomplete source, incompatible step/output contract, missing/mutated SHA and DAG gaps with structured errors.
- [x] Atomic admission/run/provenance and materialization under existing locks; preserve ordinary same-run selector check; explicitly resolve seed provenance and revalidate bytes.
- [x] Propagate selected product paths through tool-step-args and QA paths, no legacy fallback for invalid seeds.
- [x] Minimum board API choice: explicit `seedFromRun` on native trigger/plugin bridge; revision PLAN creates definition but waits for board trigger (seed or fresh). No automatic reuse. `doc/runbooks/mission-revision-seeds.md` documents operation and limits.
- [x] Generate migration; focused tests; local commit (Task2 commit carries this plan).
- Evidence: `/tmp/task2-red.log` caught missing contract/admission/materialization; `/tmp/task2-migration.log` generated additive `0121_new_the_leader.sql`; `/tmp/task2-focused-final.log` exact serial Vitest run: 11 files / 277 tests passed, zero skips; `/tmp/task2-types-final.log` db/server typechecks plus shared/plugin-sdk builds passed; `git diff --check` clean. New real-DB tests exercise HTTP board/agent admission, actual native materialization, downstream issue/path and pin, SHA rechecks, v1 readiness, QA request and later consumer. QA result is an explicit fixture, not a real external QA deployment.
- Important Task3 integration: generated PAQO IDs contain mission IDs; Task2 deliberately requires exact IDs and full canonical step config equality. No mapping/prose heuristic added. Task3 must introduce explicit source identity and adjust compatibility/QA input identity together. `seedStepHash` in workflow-seed-evidence.ts is the current versioned conservative hash. Board waiting is enforced at automatic owner-plan run creation and agent PAQO admission; broader supervision display/materialization-gap behavior needs parent/Task3 review. Full repo suite/build, live DB and UI picker remain unverified/not run here.
- Non-obvious restrictions: ordinary agent producers only; current original heartbeat must be succeeded; local canonical mission-root files <=32 MiB; original source run/step deletion is blocked by seed provenance FKs. Seeded target issueId/start/dispatch history remain null, while evidence/dispatch readiness derive from verified approval. No source producer mutation, source issue reuse, or runtime metadata authority.

### Task 3: Repeat-failure guard and final integrated hardening
- Sole child writer now closes the minimum whole path: explicit revision source-step mapping → canonical execution config comparison → structured plan rejection and atomic run guard → authoritative board wait → operator seed/fresh UI. Historical DB snapshots and scoped heartbeat errorCode only; no text similarity. Tests use isolated serial DB fixtures (canonical temporary paths, full UUID company prefixes, boundary import first). No live DB/A1, other checkouts, stash, push/deploy or full-suite claim; parent owns independent review/full verification.
Files: new missions revision-plan-guard; mission-owner-plan-decisions validation/materialization hooks; shared structured mapping if needed; spec/development additive documentation.
- [x] Tests first: same failed step + same structured code + unchanged execution config rejects; changed config allows; no source unchanged; labels/new mission id do not bypass.
- [x] Use historical source definition and authoritative attempt error codes. Return structured diagnostics through plan rejection before workflow/run creation; recheck atomically with snapshot creation (rejection rolls back run).
- [x] Connect explicit source-step identity across generated PAQO steps, preserving output compatibility and dependencies. QA reads the durable target input binding and retains source producer identity.
- [x] Close board path: Workflow-tab picker/fresh start, scoped candidate GET, current PLAN-QA readiness under mission lock, authoritative supervision wait (per-mission recommendation and sweep gap filter).
- Evidence: `/tmp/task3-red.log` 7 expected missing-behavior failures; config/mapping/admission RED logs `/tmp/task3-config-red.log`, `/tmp/task3-hash-red.log`, `/tmp/task3-admission-red.log`. Final `/tmp/task3-focused-final.log`: 11 files / 145 tests, zero skips (includes actual PAQO-generated source and target IDs, native materialization, structured submission rejection, mapped QA downstream consumer, source options HTTP, supervision, React start requests). `/tmp/task3-regressions.log`: 9 files / 41 tests, zero skips (replacement, selector, supervision, mission page). `/tmp/task3-types-final.log`: shared/plugin-sdk builds and server/UI typechecks pass; `git diff --check` clean.
- Limits/side effects: every selected revision plan unit must map to an existing unique source step; failed steps cannot be omitted. New unmapped units/removing failed steps unsupported. Fail closed on missing snapshot or scoped failed heartbeat/errorCode. Failure hash uses known executable fields (not arbitrary metadata/prose contracts); seed hash additionally preserves output contracts. Native exact machine reference tokens are remapped, never text similarity. Incoming PAQO QA back-edge is excluded from initial seed closure (forward closure retained); later rework does not gain replacement producer authority. Pre-release Task2 seed records without hash-version 2 fail closed (no backfill). Current agent adapter DB configuration is not separately snapshotted by this step hash; changing adapter config alone does not qualify as a changed step. SourceRunId remains DB-pinned.
- Parent still owns independent review/full repository checks/build. No live DB/A1, browser-live verification, external QA producer execution, stash/other-checkout edits, push or deploy performed. UI is tested with real React and mocked HTTP client; backend with isolated PostgreSQL.
- [ ] Independent read-only review of all four scopes, then focused fix/testing commit.
- [ ] Full commands + baseline proof for pre-existing failures. Final report separates approved work, extra guards, non-obvious behavior, verified/unverified.

## Delegation plan
Parent coordinates and is sole writer outside a synchronous delegated implementation. Read-only investigators have finished. Sequential child implementers may own one coherent task at a time; no parallel writers. Read-only reviewer checks scoped diff and whole-path integration; parent runs final checks. Tool cannot guarantee named model mapping, so inherit current capable model without claiming another model.
