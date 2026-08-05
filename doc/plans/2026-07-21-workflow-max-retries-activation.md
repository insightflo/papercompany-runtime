# Workflow `maxRetries` Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workflow editor's retry policy real in the native DAG runtime, while preserving every existing recovery mechanism and reporting a mission to Human Operator only after the configured workflow-step retries are genuinely exhausted.

**Architecture:** Add a pure retry-policy module and one database-backed retry scheduler. The DAG engine asks the scheduler to convert an eligible failed step into a retry-waiting `pending` step with an atomic compare-and-set update; immediate retries are dispatched by normal sync, delayed retries are released by reconciliation. Existing process-loss retry, adapter fallback, manual tool recovery, QA back-edge rework, planning recovery, IF/Complete invariants, and failure-edge routing remain separate and authoritative.

**Tech Stack:** TypeScript, Drizzle ORM/PostgreSQL, Express workflow services, React/Vite workflow editor, Vitest.

---

## Delivery boundary and prerequisite

The terminal Human Operator reporting change from `insightflo/gazua-n8n-terminal-blocker-reporting` has landed, and this plan has been refreshed against its current code paths. Its deployment and production verification remain a separate release concern; do not weaken the contracts below.

The implementation must not be combined with the Gazua n8n migration or the first terminal-reporting deployment. This gives production one behavioral change at a time and leaves a clean rollback boundary.
## Current implementation status (2026-07-22)

The runtime/UI retry activation work is implemented in this worktree and has focused verification evidence. Repository-wide gate verification, Codex full verification, merge, and deployment are still pending.

Focused verification executed so far:
- `pnpm test:run ui/src/pages/workflows/workflow-definition-edit-patch.test.ts ui/src/pages/workflows/graph-editor/GraphInspectorPolicyAdvanced.retry.test.tsx` — 2 files, 5 tests passed.
- `pnpm test:run server/src/__tests__/terminal-mission-retry-exhaustion-summary.test.ts server/src/__tests__/terminal-mission-supervision-authority.test.ts server/src/__tests__/terminal-mission-issue-less-retry.integration.test.ts server/src/__tests__/terminal-mission-human-operator-alert.test.ts server/src/__tests__/terminal-mission-human-operator-alert.integration.test.ts` — 5 files, 45 tests passed.
- `pnpm test:run server/src/__tests__/workflow-step-retry-reconciler.test.ts server/src/__tests__/workflow-step-retry-reconciler-accounting.test.ts server/src/__tests__/workflow-step-retry-reconciler-entry.integration.test.ts server/src/__tests__/workflow-step-retry-reconciler-release.test.ts` — 4 files, 13 tests passed.
- `pnpm test:run server/src/__tests__/hybrid-qa-retry-cas.test.ts server/src/__tests__/workflow-step-retry-policy.test.ts server/src/__tests__/workflow-step-retry-issue-less.integration.test.ts server/src/__tests__/workflow-step-retry-issue-backed.integration.test.ts server/src/__tests__/terminal-mission-retry-exhaustion-summary.test.ts` — 5 files, 47 tests passed.
- `pnpm --filter @paperclipai/ui typecheck` — passed.
- `pnpm --filter @paperclipai/server typecheck` — passed.
- `git diff --check` — clean.

Full gate still pending:
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
Per-task commit checkboxes remain intentionally unchecked in this worktree because this run is explicitly no-commit until review/merge.



## Fixed behavior contract

- `onFailure: "retry"` is the only setting that activates generic workflow-step retries.
- `maxRetries` means **additional attempts after the initial attempt**. An omitted value defaults to `2`, matching the current editor copy. `0` disables generic retries.
- `workflow_step_runs.retry_count` is the number of generic retries already scheduled. Increment it exactly once in the same compare-and-set operation that resets a failed attempt to `pending`.
- A retry is scheduled only after existing recovery has settled. Process-loss retry, adapter fallback, tool recovery, QA rework, planning recovery, and owner override keep their present authority. Ordinary failure/always branches remain pending until generic retries are exhausted or disabled.
- Native `if` and `complete` node contract failures are never retried. Structural/semantic QA `request_changes` outcomes are handled only by the existing QA rework contract and are never counted as generic retries.
- Ordinary issue-backed `agent`/`tool` steps and issue-less `tool` steps are eligible. Unknown step types fail closed and are not retried.
- A retry waiting for `nextEligibleAt` keeps the workflow run `running`. It is an active automatic continuation, so terminal Human Operator reporting is suppressed.
- When `retryCount >= maxRetries`, the failed step remains failed. Normal conditional failure routing and, if no continuation exists, terminal Human Operator reporting then apply.
- Concurrent sync/reconciler processes may create only one retry attempt for the same failed snapshot.
- A successful later attempt clears live retry-wait metadata but preserves a bounded attempt-history audit.

## Retry delay contract

Keep the editor's existing names for backward-compatible workflow JSON and add them to the shared contract:

- `graphRetryDelaySeconds?: number` — non-negative integer; omitted means `0`.
- `graphRetryBackoff?: "fixed" | "linear" | "exponential"` — omitted means fixed.
- `graphRetryJitter?: boolean` — omitted means false.

For retry number `n`, starting at `1`:

```ts
fixed      = baseSeconds
linear     = baseSeconds * n
exponential = baseSeconds * 2 ** (n - 1)
```

Cap the final delay at 86,400 seconds. Jitter applies a factor in `[0.8, 1.2]` before the cap. Inject the random function into the pure calculator so tests remain deterministic. A base delay of `0` always produces `0`, including when jitter is enabled.

Store only bounded operational data under `workflowStepRuns.metadata.workflowRetry`:

```ts
type WorkflowRetryMetadata = {
  state: "waiting" | "dispatching";
  retryNumber: number;
  maxRetries: number;
  nextEligibleAt: string;
  sourceRequestId: string | null;
  sourceCompletedAt: string | null;
  lastErrorSummary: string | null;
};
```

Store prior attempt summaries in `metadata.workflowRetryAttempts`, capped to the latest 20 entries. Limit every copied error summary to 500 characters. Never copy raw tool payloads, stdout/stderr, credentials, request headers, or secret values.

## Task 0: Refresh after terminal reporting lands and lock the regression baseline

**Files:**
- Modify only if landed code moved: `docs/superpowers/plans/2026-07-21-workflow-max-retries-activation.md`
- Test: `server/src/__tests__/workflow-step-retry-issue-less.integration.test.ts`

- [x] Refresh this plan from current main after the terminal-reporting landing and record any moved paths before adding code.
- [x] Read the landed terminal-blocker classifier and its tests. The landed classifier is `server/src/services/missions/terminal-mission-workflow-continuation.ts` and the reporting module is `terminal-mission-human-operator-alert.ts`. Tests: `server/src/__tests__/terminal-mission-human-operator-alert.test.ts` and `server/src/__tests__/terminal-mission-human-operator-alert.integration.test.ts`.
- [x] Preserve characterization coverage for issue-less retry activation in `server/src/__tests__/workflow-step-retry-issue-less.integration.test.ts`.
- [x] Run the focused issue-less retry coverage and record the result in the current status section.
- [ ] Historical pre-implementation failing-test commit flow is not part of the current single-worktree execution.


```sh
git add server/src/__tests__/workflow-step-retry-issue-less.integration.test.ts
git commit -m "test: characterize dormant workflow max retries"
```

## Task 1: Synchronize the shared retry-policy contract

**Files:**
- Modify: `packages/shared/src/types/workflow.ts`
- Modify: `packages/shared/src/validators/workflow.ts`
- Test: `packages/shared/src/validators/workflow.test.ts`
- Modify: `server/src/services/workflow/dag-engine.ts`

- [x] Add shared-validator coverage for valid fixed/linear/exponential settings and invalid negative delay, fractional delay, unknown backoff, and non-boolean jitter.
- [x] Add the three `graphRetry*` fields to `WorkflowStepDefinition` and `workflowStepDefinitionSchema`.
- [x] Narrow the DAG engine's local `WorkflowStep` fields to the same literal backoff union instead of maintaining a looser duplicate contract.
- [x] Keep `maxRetries` non-negative with no new arbitrary upper limit; existing saved workflow definitions must continue to parse.
- [ ] Run the shared validator tests and typecheck.
- [ ] Commit the contract change.


```sh
git add packages/shared/src/types/workflow.ts packages/shared/src/validators/workflow.ts packages/shared/src/validators/workflow.test.ts server/src/services/workflow/dag-engine.ts
git commit -m "feat: define workflow retry policy contract"
```

## Task 2: Implement a pure, fail-closed retry policy

**Files:**
- Create: `server/src/services/workflow/retry-policy.ts`
- Test: `server/src/__tests__/workflow-step-retry-policy.test.ts`

- [x] Write table-driven policy tests for default retry count `2`, explicit zero, exhausted count, all backoff modes, jitter boundaries, 24-hour cap, and zero-delay jitter.
- [x] Write exclusion tests for IF/Complete, unknown types, QA request-changes/structural failures, non-`retry` failure policies, active process-loss/fallback/rework/recovery markers, and a runnable `failure`/`always` successor.
- [x] Implement `normalizeWorkflowRetryPolicy(step)` returning a fully normalized policy.
- [x] Implement `calculateWorkflowRetryDelaySeconds(policy, retryNumber, random)` using the fixed formulas above.
- [x] Implement `classifyWorkflowStepRetry(input)` as a pure decision with explicit reasons:
- [x] Make malformed metadata and ambiguous recovery state fail closed with `malformed_state`/`recovery_active` rather than scheduling a retry.
- [x] Run the focused tests.
- [ ] Commit the pure policy.


```sh
git add server/src/services/workflow/retry-policy.ts server/src/__tests__/workflow-step-retry-policy.test.ts
git commit -m "feat: add workflow step retry policy"
```

## Task 3: Add the atomic retry scheduler and bounded attempt audit

**Files:**
- Create: `server/src/services/workflow/step-retry-scheduler.ts`
- Test: `server/src/__tests__/workflow-step-retry-scheduler.integration.test.ts`
- Regression: `server/src/__tests__/workflow-step-retry-scheduler-cas.test.ts`
- Regression: `server/src/__tests__/workflow-step-retry-exhaustion-marker.test.ts`

- [x] Add failing database tests for failed-to-pending reset, `retryCount` increment, bounded attempt archive, metadata cleanup, workflow run reopening, and retry exhaustion.
- [x] Add a concurrency test that calls the scheduler twice against the same failed snapshot and proves one compare-and-set winner, one transition event, and one increment.
- [x] Implement `scheduleWorkflowStepRetry(db, input)` in one transaction:
  - insert `workflowTransitionEvents.eventType = "workflow_step_retry_scheduled"` with idempotency key `workflow-step-retry:<stepRunId>:<retryNumber>`;
  - compare the observed `status`, `retryCount`, `completedAt`, and `lastDispatchRequestId` before resetting;
  - set `status = "pending"`, increment `retryCount`, clear dispatch/result fields, write bounded retry metadata, and reopen the workflow run as `running`;
  - if the compare-and-set loses, leave the row untouched and return a non-error `already_changed` result;
  - if the row update fails after the event insert, roll back the entire transaction.
- [x] Do not call `resetStepRunForRework`; `iterationIndex` and `retryCount` must remain independent.
- [x] Clear `toolResult`, `toolInvocation`, `toolQueue`, `cacheHit`, and stale control-flow skip markers while retaining unrelated safe metadata.
- [x] Run the integration test twice to catch idempotency leakage.
- [ ] Commit the scheduler.


```sh
git add server/src/services/workflow/step-retry-scheduler.ts server/src/__tests__/workflow-step-retry-scheduler.integration.test.ts
git commit -m "feat: schedule workflow retries atomically"
```

## Task 4: Integrate retries into issue-less tool completion

**Files:**
- Modify: `server/src/services/workflow/dag-engine.ts`
- Modify: `server/src/services/workflow/step-retry-scheduler.ts`
- Test: `server/src/__tests__/workflow-step-retry-issue-less.integration.test.ts`
- Regression: `server/src/__tests__/hybrid-qa-retry-cas.test.ts`

- [x] Add failing tests for an issue-less tool failure scheduling retry 1, immediate redispatch with a new request ID, success on retry, and final failure after the configured count.
- [x] Add a stale callback regression: a callback from attempt 0 cannot complete attempt 1 after dispatch state has been cleared and replaced.
- [x] Call the scheduler only after `completeWorkflowToolStepFromResult` has applied structural-gate and existing recovery decisions.
- [x] For delay `0`, let normal `syncWorkflowRunState` dispatch the new pending attempt immediately.
- [x] For a future `nextEligibleAt`, keep the step pending without calling `startIssueLessToolStepRun`.
- [x] Preserve the public manual `retryIssueLessToolWorkflowStep` route as an explicit Human/Owner recovery action; do not silently count that existing manual action against `maxRetries` in this change.
- [x] Run focused issue-less and QA regression tests.
- [ ] Commit the issue-less integration.


```sh
git add server/src/services/workflow/dag-engine.ts server/src/services/workflow/step-retry-scheduler.ts server/src/__tests__/workflow-step-retry-issue-less.integration.test.ts
git commit -m "feat: retry failed workflow tool steps"
```

## Task 5: Integrate issue-backed agent/tool retries with fresh wakes

**Files:**
- Modify: `server/src/services/workflow/dag-engine.ts`
- Modify: `server/src/services/workflow/step-retry-scheduler.ts`
- Test: `server/src/__tests__/workflow-step-retry-issue-backed.integration.test.ts`
- Regression: `server/src/__tests__/workflow-step-retry-recovery-guard.test.ts`

- [x] Add failing tests for a failed linked issue becoming a pending retry, reuse of the same issue, a fresh session, and exactly one `workflow_resume` wake request.
- [x] After the scheduler wins, call `wakeExistingWorkflowStepIssue` with:
- [x] Do not update the issue status directly. Keep assignment restoration, structural readiness, wake queueing, and activity logging inside the existing wake helper.
- [x] If the immediate wake is rejected, keep the retry pending and let reconciliation decide whether it can be released later; do not consume another retry count.
- [x] Prove that ordinary failure/always successors stay pending through retry attempts and launch only after retry exhaustion.
- [x] Run the focused tests.
- [ ] Commit the issue-backed integration.


```sh
git add server/src/services/workflow/dag-engine.ts server/src/services/workflow/step-retry-scheduler.ts server/src/__tests__/workflow-step-retry-issue-backed.integration.test.ts
git commit -m "feat: retry issue backed workflow steps"
```

## Task 6: Release delayed retries through reconciliation

**Files:**
- Create: `server/src/services/workflow/retry-reconciler.ts`
- Modify: `server/src/services/workflow/reconciler.ts`
- Modify: `server/src/services/workflow/runnable-step-wakeups-reconciler.ts`
- Modify: `server/src/services/workflow/dag-engine.ts`
- Test: `server/src/__tests__/workflow-step-retry-reconciler.test.ts`
- Regression: `server/src/__tests__/workflow-step-retry-reconciler-accounting.test.ts`

- [x] Add clock-controlled failing tests for future retry suppression, due retry release, immediate retry, duplicate reconciliation, and malformed retry metadata.
- [x] Implement `reconcileDueWorkflowStepRetries(db, now)` and invoke it before the generic runnable-step wakeup reconciler.
- [x] Make every launch path consult `isWorkflowRetryDue(stepRun, now)`. A future retry may not be started merely because its status is `pending`.
- [x] Ensure the existing runnable-step reconciler does not bypass the delay and does not require a retry to be older than its normal five-minute settling cutoff once it is due.
- [x] Treat a valid future retry as live work in the stuck/deadlock reconcilers so they do not mark the run failed or skip its pending step.
- [x] On due issue-less retries, call normal workflow sync. On due issue-backed retries, use `wakeExistingWorkflowStepIssue` with the deterministic retry idempotency key.
- [x] On malformed retry metadata, do not launch. Record a bounded reconciliation failure and leave terminal reporting to re-evaluate the now-unrecoverable state.
- [x] Run retry and existing reconciler tests.
- [ ] Commit reconciliation support.


```sh
git add server/src/services/workflow/retry-reconciler.ts server/src/services/workflow/reconciler.ts server/src/services/workflow/runnable-step-wakeups-reconciler.ts server/src/services/workflow/dag-engine.ts server/src/__tests__/workflow-step-retry-reconciler.test.ts server/src/__tests__/workflow-dag-engine.test.ts
git commit -m "feat: reconcile delayed workflow retries"
```

## Task 7: Interlock retry liveness with Human Operator reporting

**Files:**
- Modify: `server/src/services/missions/terminal-mission-human-operator-alert.ts`
- Modify: `server/src/__tests__/terminal-mission-human-operator-alert.test.ts`
- Test: `server/src/__tests__/terminal-mission-human-operator-alert.integration.test.ts`, `server/src/__tests__/terminal-mission-issue-less-retry.integration.test.ts`, `server/src/__tests__/workflow-step-retry-issue-less.integration.test.ts`, `server/src/__tests__/workflow-step-retry-issue-backed.integration.test.ts`, and `server/src/__tests__/workflow-step-retry-reconciler.test.ts`

- [x] Add retry-liveness coverage proving no Human Operator event while a retry is immediate, delayed, dispatching, or recoverably pending.
- [x] Add coverage proving one report after the last configured retry fails and no fallback, rework, recovery action, or conditional continuation remains.
- [x] Add malformed/inconsistent retry-state coverage. The classifier distinguishes “known live retry” from malformed metadata; malformed state cannot be treated as live forever.
- [x] Teach the terminal classifier to read retry liveness through the shared retry-policy helper rather than duplicating max-count arithmetic.
- [x] Keep the landed idempotency contract: repeated sync/supervision after exhaustion reuses the same owner-action issue/comment/event.
- [x] Ensure the report summary includes bounded `attempts: initial + retryCount` and `maxRetries`, but no raw result/error payload.
- [x] Run terminal-reporting and retry integration tests together.
- [ ] Commit the reporting interlock.


```sh
git add server/src/services/missions/terminal-mission-human-operator-alert.ts server/src/services/missions/terminal-mission-retry-summary.ts server/src/__tests__/terminal-mission-human-operator-alert.test.ts server/src/__tests__/terminal-mission-retry-interlock.test.ts server/src/__tests__/terminal-mission-retry-exhaustion-summary.test.ts server/src/__tests__/terminal-mission-human-operator-alert.integration.test.ts server/src/__tests__/terminal-mission-issue-less-retry.integration.test.ts server/src/__tests__/workflow-step-retry-issue-less.integration.test.ts server/src/__tests__/workflow-step-retry-issue-backed.integration.test.ts server/src/__tests__/workflow-step-retry-reconciler.test.ts
git commit -m "feat: report exhausted workflow retries"
```

## Task 8: Align workflow editor and run visibility with runtime behavior

**Files:**
- Modify: `ui/src/pages/workflows/graph-editor/GraphInspector.tsx`
- Modify: `ui/src/pages/workflows/graph-editor/GraphInspectorPolicyAdvanced.tsx`
- Modify: `ui/src/pages/workflows/workflow-graph.ts`
- Modify: `ui/src/pages/workflows/step-editor.tsx`
- Modify: `ui/src/pages/workflows/graph-editor/GraphRunPreview.tsx`
- Test: `ui/src/pages/workflows/workflow-graph.test.ts`
- Regression: `ui/src/pages/workflows/graph-editor/GraphInspectorPolicyAdvanced.retry.test.tsx`
- Regression: `ui/src/pages/workflows/workflow-definition-edit-patch.test.ts`

- [x] Add UI tests for default two retries, explicit zero, all backoff choices, delay zero, and serialization round-trip.
- [x] Change retry delay inputs from `min={1}` to `min={0}` so the editor matches the runtime contract.
- [x] Disable or visually mark delay/backoff/jitter controls as inactive unless `onFailure === "retry"`; preserve their saved values when temporarily inactive.
- [x] Display `attempt N of M` and `retry scheduled at <time>` from `retryCount` and bounded `workflowRetry` metadata in run preview/details.
- [x] Remove any copy that implies retries are active for non-`retry` failure policies.
- [x] Keep the existing “default 2” wording and make clear that `maxRetries` excludes the initial attempt.
- [x] Run focused UI tests and typecheck.

Run:

```sh
pnpm vitest run ui/src/pages/workflows/workflow-graph.test.ts
pnpm --filter @paperclipai/ui typecheck
```

Expected: serialization and rendering tests pass; UI typecheck passes.

- [ ] Commit the UI alignment.

```sh
git add ui/src/pages/workflows/graph-editor/GraphInspector.tsx ui/src/pages/workflows/graph-editor/GraphInspectorPolicyAdvanced.tsx ui/src/pages/workflows/workflow-graph.ts ui/src/pages/workflows/step-editor.tsx ui/src/pages/workflows/graph-editor/GraphRunPreview.tsx ui/src/pages/workflows/workflow-graph.test.ts
git commit -m "feat: show native workflow retry state"
```

## Task 9: Update runtime documentation and remove the dead-field warning

**Files:**
- Modify: `server/src/services/workflow/control-flow/PLAN.md`
- Modify: `doc/SPEC-implementation.md`
- Modify: `doc/DEVELOPING.md` only if operator commands or reconciliation behavior need documentation.

- [x] Replace the statement that `retry_count`, `onFailure`, and `maxRetries` are dead/type-only with the exact active semantics and exclusions above.
- [x] Document that retry count and QA iteration count are independent.
- [x] Document Human Operator reporting only after automatic retry exhaustion.
- [x] Search for stale editor/runtime claims and update only the impacted text.

Run:

```sh
rg -n "dead type-only|maxRetries|retry_count|Retry x|default 2" server/src/services/workflow/control-flow/PLAN.md doc ui/src packages/shared/src server/src
```

Expected: no active documentation describes `maxRetries` as unused, and no conflicting attempt-count definition remains.

- [ ] Commit the documentation update.

```sh
git add server/src/services/workflow/control-flow/PLAN.md doc/SPEC-implementation.md doc/DEVELOPING.md
git commit -m "docs: define workflow retry semantics"
```

## Task 10: Full verification, deployment, and production canary

**Files:**
- No new feature files. Fix only regressions caused by this branch.

- [ ] Run focused retry/reporting tests first. Focused subsets above are green; the final combined gate command below is still pending.

```sh
pnpm vitest run server/src/__tests__/workflow-step-retry-*.test.ts server/src/__tests__/workflow-step-retry-*.integration.test.ts server/src/__tests__/hybrid-qa-retry-cas.test.ts server/src/__tests__/terminal-mission-human-operator-alert.test.ts server/src/__tests__/terminal-mission-retry-interlock.test.ts server/src/__tests__/terminal-mission-retry-exhaustion-summary.test.ts server/src/__tests__/terminal-mission-human-operator-alert.integration.test.ts server/src/__tests__/terminal-mission-issue-less-retry.integration.test.ts
```

- [ ] Run the repository handoff gate.

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: all commands pass. If the repository has a pre-existing unrelated failure, capture the exact failing test and prove all focused tests, typecheck, and build are green before requesting a merge decision.

- [x] Run `git diff --check` and inspect the final diff for unintended schema, migration, Gazua, or secret changes.
- [ ] Deploy through the existing runtime deployment workflow only after review and merge.
- [ ] Verify the deployment job completes and the production health endpoint returns healthy.
- [ ] Run a controlled canary workflow with `onFailure: retry`, `maxRetries: 1`, and a test tool that fails once then succeeds. Verify two total attempts, `retryCount = 1`, no Human Operator report, and downstream continuation.
- [ ] Run a second controlled canary that fails both attempts. Verify `retryCount = 1`, one terminal Human Operator report, and no further wake/heartbeat after the report.
- [ ] Remove or archive only canary-specific workflow/test data according to the normal operator procedure; do not delete unrelated runs.

## Final review checklist

- [ ] `maxRetries` counts retries, not total attempts.
- [ ] `retryCount` increments once per scheduled generic retry and never for QA iteration or the existing explicit owner retry action.
- [ ] Existing retry/fallback/rework mechanisms execute before generic workflow retry eligibility is decided.
- [ ] Ordinary failure/always branches launch only after generic retries are exhausted or disabled.
- [ ] IF/Complete and semantic QA failures are excluded.
- [ ] Delayed retries cannot be dispatched early by any sync or reconciler path.
- [ ] A retry in progress suppresses Human Operator reporting; exhaustion enables exactly one report.
- [ ] Error/audit metadata is bounded and contains no raw payloads or secrets.
- [ ] The full verification gate, Codex full verification, merge/deploy, and two production canaries have evidence before completion is claimed.
