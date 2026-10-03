# Tool failure recovery brief implementation plan

> For agentic workers: use subagent-driven-development and TDD; read the user's approved Stage 1 + Stage 2 request and `.recovery-work/authority-investigation.md` before implementation.

**Goal:** Give every issue-less failed tool step a bounded, secret-safe machine-facts brief without changing execution authority or behavior.
**Architecture:** Transaction-local, company-scoped read-only fact collection feeds a pure renderer. Narrow pure eligibility predicates are shared with existing executors, retaining their ordering and semantics. Optional versioned tool recovery declarations live in existing adapterConfig JSONB and are display-only.
**Tech stack:** TypeScript, Zod, Drizzle/PostgreSQL, Vitest, pnpm.
**Spec:** User request in this session (approved Stage 1 + Stage 2); existing V1 contract and AGENTS remain authoritative.

## Global constraints / progress
- Work ONLY in this worktree/branch. No deploy, SSH, push, non-test DB writes, or other-checkout edits. Local commits required.
- Whole scope: creation → machine facts → decision/registration applicability → declared metadata validation/sync → display/tests. Stage 1 must be complete and green before Stage 2 begins.
- Current phase: Stage 1 review corrections (child). Unmet gate: diagnostic secret safety and accurate producer/result instructions; full serial verification and independent acceptance remain parent-owned. This pass fixes only Basic-auth/non-HTTP DSN display redaction, native toolResult.error display and the recover_artifact producer-reference prerequisite. No executor/Stage2 changes or commit.
- Review correction path/evidence: stored toolResult → classification/facts → final persisted issue description, including missing/SQL-unavailable registry. First add confirmed RED regressions, then minimal display-only fixes, focused tests and a synthetic description under `.recovery-work/stage1-review-fix-*`. Existing diagnostic-prefix/fixture lessons apply; do not infer error codes from prose or broaden execution authority.
- Stage 1 execution evidence: pending `.recovery-work/stage1-*.log`. Callers/tests mapped in authority investigation: supervision → owner-actions → tool-recovery-card; owner decision API → owner-recovery-target; owner-tool-recovery → native retry/completion; workflow artifact route authorization; workproduct-same-run → selector. Preserve original frozen/generation/retry fixtures; no stale-producer repair.
- Execution authority stays durable structured records. No prose classification/metadata may control execution. No per-tool/workflow hardcoding.
- Preserve existing cards, retry consumption, frozen definitions, actual attempts and producer provenance. Do not unify differing legacy tool predicates.
- New source/test/support files <=300 lines. Reduce touched oversized legacy files via narrow cohesive extraction rather than grow them.
- Optional reads must not abort creation: nested transaction/savepoint needed for SQL errors, not merely catching within a failed PostgreSQL transaction.
- Existing lessons: preserve historical fixtures and real generation/retry/iteration proof; distinguish setup errors from test RED; partial green does not mean full goal achieved.

## Stage 1 — structured system facts
- [x] Add failing renderer/integration/eligibility tests, run confirmed RED. `.recovery-work/stage1-red.log` (4 meaningful feature failures); producer confirmed RED in `stage1-producer-red-confirmed.log`. Guard extraction characterized by existing executor suites and focused guard tests.
- [x] Remove retryPolicy recommendation; retain class only as text-based guess, never action advice. Classification consumers in supervision are finding/reason display only; no dispatch branch added. Generic broad-action brief replaced with tool-specific scope.
- [x] Expose exact recoveryTarget JSON (kind, workflowRunId, stepRunId, expectedAuthorityVersion, expectedExecutionGeneration, failedDispatchRequestId) from run/step.
- [x] Company-filtered registry summary, bounded command/cwd/url/instruction refs, env KEY NAMES ONLY with shared sensitivity redaction. Structured toolResult artifact/error/exit and invocation paths only. Current registry is explicitly not historical invocation config; URL credentials/query/fragment, known env/header values and sensitive diagnostic keys are suppressed.
- [x] Shared pure existing executor guards + same-run provenance comparison; exhaustive accepted-decision matrix separates owner submission, operator actions, applicability and unevaluated locked guards. Explain recover_artifact registration is not applicable on unblock issue while existing official producer artifacts remain usable. Creation has no owner decision yet: target_missing, not invented candidate authority. Same-run field diagnostics include prospective all-step generation bump; heartbeat/wake/seed/bytes remain explicitly unverified.
- [x] Related pattern ids/titles via existing helper; company language per existing practice; optional lookup failure unavailable without suppressing issue/link. All optional reads execute sequential nested transaction SAVEPOINTs; real undefined-table tests cover registry and knowledge failures.
- [x] Test secret sentinels, exact IDs, stale producer, issue restriction, absent definitions/failed optional SQL, company isolation, executor behavior parity; update requested mission tests/scenario. Final focused command: `.recovery-work/stage1-focused-green.log`, 21 files / 249 tests / zero skips (includes all 94 missions-service tests). Server typecheck `stage1-typecheck-final.log` passed; new-test-inclusive tsc `stage1-test-types-green.log` passed. Earlier logs retain fixture/compiler setup failures separately.
- [ ] Run focused regression, pnpm -r typecheck, pnpm test:run (server suite permitted if excessive), pnpm build. Record exact results and any pre-existing blockers; do not call Stage1 green with unresolved failures.
- [ ] Independent review for semantics/security/spec; fix findings, rerun; local Stage1 commit. Review fixes supplied: complete Authorization value/non-HTTP URI redaction, native error diagnostic projection, exact producer-reference prerequisite (display only). Confirmed RED: `stage1-review-fix-red.log` (13 fail/4 pass); focused GREEN: `stage1-review-fix-focused.log` (9 files/68 tests/zero skips); persisted synthetic issue inspected in `stage1-review-fix-synthetic.log`. Parent independent acceptance, full serial gates and commit remain pending.

## Stage 2 — declared metadata (blocked until Stage 1 green)
- [ ] RED: versioned bounded strict Zod recovery schema, invalid declaration rejects, sync retains metadata, brief renders declaration as display only.
- [ ] Optional adapterConfig.recovery with version:1, statusProbe(command XOR toolName, description), statePaths, operatorOnlyActions(id,description), references. Existing adapterConfig arbitrary unrelated keys stay compatible; no new column/migration.
- [ ] Validate shared create/update, direct registry service and sync boundaries. Preserve valid stored metadata when source lacks declaration; explicit null removal only if deliberately included/documented in schema (otherwise no implicit deletion).
- [ ] Catalog sync sources pluginEntities tool-config. Copy only recovery rather than merging executable adapterConfig. Show declaration source evidence. No external checkout changes or invented publication commands.
- [ ] Metadata render only; no retries/probes executed. Audit indirect adapterConfig binding hash/updatedAt effects; preserve current behavior and report invalidation of old resume previews if applicable.
- [ ] Full required verification, independent review and local Stage2 commit.

## Delegation / evidence
- Parent owns plan, stage gates, setup/full checks, final integration and report.
- Read-only authority investigator completed caller/test map in `.recovery-work/authority-investigation.md`.
- Read-only catalog investigator established actual source `server/src/services/workflow/tool-catalog.ts`; production manual-onboarding declaration absent in repo. External test references `${OVERSIGHT_OPERATIONS_ROOT}/scripts/paperclip-addon/automation/research-company/manual-onboarding/manual-onboarding-workflow-tool.mjs`, not an exact production catalog filename.
- Stage1 implementation assigned one agent for coherent extraction + read/renderer integration; independent reviewer then parent gate.
- Stage2 assigned after Stage1 green, then independent reviewer and parent gate.
- Each implementer must list callers/tests before edits, follow test-first, write logs inside `.recovery-work`, and return concise exact evidence. Safety exceptions limited to secrecy/transaction isolation, then return to planned scope.

## Final report
<=700 words, Korean: caller/impact list; actual files/behavior; additions beyond plan (or none); non-obvious effects; synthetic before/after; new contract; commands/pass counts/unrun reasons; external catalog JSON/path evidence; no migration if existing JSONB.
