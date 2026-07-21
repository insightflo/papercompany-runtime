# Workflow `maxRetries` Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workflow editor's retry policy real in the native DAG runtime, while preserving every existing recovery mechanism and reporting a mission to Human Operator only after the configured workflow-step retries are genuinely exhausted.

**Architecture:** Add a pure retry-policy module and one database-backed retry scheduler. The DAG engine asks the scheduler to convert an eligible failed step into a retry-waiting `pending` step with an atomic compare-and-set update; immediate retries are dispatched by normal sync, delayed retries are released by reconciliation. Existing process-loss retry, adapter fallback, manual tool recovery, QA back-edge rework, planning recovery, IF/Complete invariants, and failure-edge routing remain separate and authoritative.

**Tech Stack:** TypeScript, Drizzle ORM/PostgreSQL, Express workflow services, React/Vite workflow editor, Vitest.

---

## Delivery boundary and prerequisite

This plan is intentionally deferred. Before implementation, the terminal Human Operator reporting change from `insightflo/gazua-n8n-terminal-blocker-reporting` must be merged, deployed, and verified in production. Then refresh this branch from the new `origin/main` and update only file paths that moved during that landing; do not weaken the contracts below.

The implementation must not be combined with the Gazua n8n migration or the first terminal-reporting deployment. This gives production one behavioral change at a time and leaves a clean rollback boundary.

## Fixed behavior contract

- `onFailure: "retry"` is the only setting that activates generic workflow-step retries.
- `maxRetries` means **additional attempts after the initial attempt**. An omitted value defaults to `2`, matching the current editor copy. `0` disables generic retries.
- `workflow_step_runs.retry_count` is the number of generic retries already scheduled. Increment it exactly once in the same compare-and-set operation that resets a failed attempt to `pending`.
- A retry is scheduled only after existing recovery has settled. Process-loss retry, adapter fallback, tool recovery, QA rework, planning recovery, owner override, and runnable failure/always branches keep their present authority.
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
- Test: `server/src/__tests__/workflow-step-retry-integration.test.ts`

- [ ] Fetch `origin/main`, rebase `insightflo/workflow-max-retries-plan`, and confirm the worktree is clean before adding code.
- [ ] Read the landed terminal-blocker classifier and its tests. Record its exact module path in this plan if it differs from `server/src/services/missions/terminal-workflow-blocker.ts`.
- [ ] Add a characterization test proving current runtime behavior: a failed issue-less tool step with `onFailure: "retry", maxRetries: 2` remains failed and `retryCount` remains `0`.
- [ ] Run the focused test and confirm it fails for the intended missing retry behavior, not fixture setup.

Run:

```sh
pnpm vitest run server/src/__tests__/workflow-step-retry-integration.test.ts
```

Expected: the new retry expectation fails before implementation.

- [ ] Commit the failing characterization test.

```sh
git add server/src/__tests__/workflow-step-retry-integration.test.ts
git commit -m "test: characterize dormant workflow max retries"
```

## Task 1: Synchronize the shared retry-policy contract

**Files:**
- Modify: `packages/shared/src/types/workflow.ts`
- Modify: `packages/shared/src/validators/workflow.ts`
- Test: `packages/shared/src/validators/workflow.test.ts`
- Modify: `server/src/services/workflow/dag-engine.ts`

- [ ] Add failing shared-validator tests for valid fixed/linear/exponential settings and invalid negative delay, fractional delay, unknown backoff, and non-boolean jitter.
- [ ] Add the three `graphRetry*` fields to `WorkflowStepDefinition` and `workflowStepDefinitionSchema`.
- [ ] Narrow the DAG engine's local `WorkflowStep` fields to the same literal backoff union instead of maintaining a looser duplicate contract.
- [ ] Keep `maxRetries` non-negative with no new arbitrary upper limit; existing saved workflow definitions must continue to parse.
- [ ] Run the shared validator tests and typecheck.

Run:

```sh
pnpm vitest run packages/shared/src/validators/workflow.test.ts
pnpm --filter @paperclipai/shared typecheck
```

Expected: both commands pass.

- [ ] Commit the contract change.

```sh
git add packages/shared/src/types/workflow.ts packages/shared/src/validators/workflow.ts packages/shared/src/validators/workflow.test.ts server/src/services/workflow/dag-engine.ts
git commit -m "feat: define workflow retry policy contract"
```

## Task 2: Implement a pure, fail-closed retry policy

**Files:**
- Create: `server/src/services/workflow/retry-policy.ts`
- Test: `server/src/__tests__/workflow-step-retry-policy.test.ts`

- [ ] Write table-driven failing tests for default retry count `2`, explicit zero, exhausted count, all backoff modes, jitter boundaries, 24-hour cap, and zero-delay jitter.
- [ ] Write exclusion tests for IF/Complete, unknown types, QA request-changes/structural failures, non-`retry` failure policies, active process-loss/fallback/rework/recovery markers, and a runnable `failure`/`always` successor.
- [ ] Implement `normalizeWorkflowRetryPolicy(step)` returning a fully normalized policy.
- [ ] Implement `calculateWorkflowRetryDelaySeconds(policy, retryNumber, random)` using the fixed formulas above.
- [ ] Implement `classifyWorkflowStepRetry(input)` as a pure decision with explicit reasons:

```ts
type WorkflowStepRetryDecision =
  | { eligible: true; retryNumber: number; maxRetries: number; delaySeconds: number }
  | { eligible: false; reason: "disabled" | "exhausted" | "unsupported_step" | "control_node" | "qa_rework" | "recovery_active" | "failure_route_runnable" | "malformed_state" };
```

- [ ] Make malformed metadata and ambiguous recovery state fail closed with `malformed_state`/`recovery_active` rather than scheduling a retry.
- [ ] Run the focused tests.

Run:

```sh
pnpm vitest run server/src/__tests__/workflow-step-retry-policy.test.ts
```

Expected: all policy cases pass without database fixtures.

- [ ] Commit the pure policy.

```sh
git add server/src/services/workflow/retry-policy.ts server/src/__tests__/workflow-step-retry-policy.test.ts
git commit -m "feat: add workflow step retry policy"
```

## Task 3: Add the atomic retry scheduler and bounded attempt audit

**Files:**
- Create: `server/src/services/workflow/step-retry-scheduler.ts`
- Test: `server/src/__tests__/workflow-step-retry-integration.test.ts`
- Reference without reusing counters: `server/src/services/workflow/control-flow/step-reset.ts`
- Reference for event idempotency: `packages/db/src/schema/workflow_transition_events.ts`

- [ ] Add failing database tests for failed-to-pending reset, `retryCount` increment, bounded attempt archive, metadata cleanup, workflow run reopening, and retry exhaustion.
- [ ] Add a concurrency test that calls the scheduler twice against the same failed snapshot and proves one compare-and-set winner, one transition event, and one increment.
- [ ] Implement `scheduleWorkflowStepRetry(db, input)` in one transaction:
  - insert `workflowTransitionEvents.eventType = "workflow_step_retry_scheduled"` with idempotency key `workflow-step-retry:<stepRunId>:<retryNumber>`;
  - compare the observed `status`, `retryCount`, `completedAt`, and `lastDispatchRequestId` before resetting;
  - set `status = "pending"`, increment `retryCount`, clear dispatch/result fields, write bounded retry metadata, and reopen the workflow run as `running`;
  - if the compare-and-set loses, leave the row untouched and return a non-error `already_changed` result;
  - if the row update fails after the event insert, roll back the entire transaction.
- [ ] Do not call `resetStepRunForRework`; `iterationIndex` and `retryCount` must remain independent.
- [ ] Clear `toolResult`, `toolInvocation`, `toolQueue`, `cacheHit`, and stale control-flow skip markers while retaining unrelated safe metadata.
- [ ] Run the integration test twice to catch idempotency leakage.

Run:

```sh
pnpm vitest run server/src/__tests__/workflow-step-retry-integration.test.ts
pnpm vitest run server/src/__tests__/workflow-step-retry-integration.test.ts
```

Expected: both runs pass and create no duplicate transition records.

- [ ] Commit the scheduler.

```sh
git add server/src/services/workflow/step-retry-scheduler.ts server/src/__tests__/workflow-step-retry-integration.test.ts
git commit -m "feat: schedule workflow retries atomically"
```

## Task 4: Integrate retries into issue-less tool completion

**Files:**
- Modify: `server/src/services/workflow/dag-engine.ts`
- Modify: `server/src/services/workflow/step-retry-scheduler.ts`
- Test: `server/src/__tests__/workflow-step-retry-integration.test.ts`
- Regression: `server/src/__tests__/hybrid-qa-retry-cas.test.ts`

- [ ] Add failing tests for an issue-less tool failure scheduling retry 1, immediate redispatch with a new request ID, success on retry, and final failure after the configured count.
- [ ] Add a stale callback regression: a callback from attempt 0 cannot complete attempt 1 after dispatch state has been cleared and replaced.
- [ ] Call the scheduler only after `completeWorkflowToolStepFromResult` has applied structural-gate and existing recovery decisions.
- [ ] For delay `0`, let normal `syncWorkflowRunState` dispatch the new pending attempt immediately.
- [ ] For a future `nextEligibleAt`, keep the step pending without calling `startIssueLessToolStepRun`.
- [ ] Preserve the public manual `retryIssueLessToolWorkflowStep` route as an explicit Human/Owner recovery action; do not silently count that existing manual action against `maxRetries` in this change.
- [ ] Run focused issue-less and QA regression tests.

Run:

```sh
pnpm vitest run server/src/__tests__/workflow-step-retry-integration.test.ts server/src/__tests__/hybrid-qa-retry-cas.test.ts
```

Expected: both files pass; QA rework behavior is unchanged.

- [ ] Commit the issue-less integration.

```sh
git add server/src/services/workflow/dag-engine.ts server/src/services/workflow/step-retry-scheduler.ts server/src/__tests__/workflow-step-retry-integration.test.ts
git commit -m "feat: retry failed workflow tool steps"
```

## Task 5: Integrate issue-backed agent/tool retries with fresh wakes

**Files:**
- Modify: `server/src/services/workflow/dag-engine.ts`
- Modify: `server/src/services/workflow/step-retry-scheduler.ts`
- Test: `server/src/__tests__/workflow-step-retry-integration.test.ts`
- Regression: `server/src/__tests__/workflow-resume-wake.test.ts`

- [ ] Add failing tests for a failed linked issue becoming a pending retry, reuse of the same issue, a fresh session, and exactly one `workflow_resume` wake request.
- [ ] After the scheduler wins, call `wakeExistingWorkflowStepIssue` with:

```ts
{
  allowCompletedIssue: true,
  allowBlockedIssue: true,
  forceFreshSession: true,
  idempotencyKey: `workflow-step-retry:${stepRun.id}:${retryNumber}`,
}
```

- [ ] Do not update the issue status directly. Keep assignment restoration, structural readiness, wake queueing, and activity logging inside the existing wake helper.
- [ ] If the immediate wake is rejected, keep the retry pending and let reconciliation decide whether it can be released later; do not consume another retry count.
- [ ] Prove that a failure edge which is already runnable suppresses generic retry and proceeds through the existing branch.
- [ ] Run the focused tests.

Run:

```sh
pnpm vitest run server/src/__tests__/workflow-step-retry-integration.test.ts server/src/__tests__/workflow-resume-wake.test.ts
```

Expected: both files pass and no duplicate wake is created.

- [ ] Commit the issue-backed integration.

```sh
git add server/src/services/workflow/dag-engine.ts server/src/services/workflow/step-retry-scheduler.ts server/src/__tests__/workflow-step-retry-integration.test.ts
git commit -m "feat: retry issue backed workflow steps"
```

## Task 6: Release delayed retries through reconciliation

**Files:**
- Create: `server/src/services/workflow/retry-reconciler.ts`
- Modify: `server/src/services/workflow/reconciler.ts`
- Modify: `server/src/services/workflow/runnable-step-wakeups-reconciler.ts`
- Modify: `server/src/services/workflow/dag-engine.ts`
- Test: `server/src/__tests__/workflow-step-retry-reconciler.test.ts`
- Regression: `server/src/__tests__/workflow-dag-engine.test.ts`

- [ ] Add clock-controlled failing tests for future retry suppression, due retry release, immediate retry, duplicate reconciliation, and malformed retry metadata.
- [ ] Implement `reconcileDueWorkflowStepRetries(db, now)` and invoke it before the generic runnable-step wakeup reconciler.
- [ ] Make every launch path consult `isWorkflowRetryDue(stepRun, now)`. A future retry may not be started merely because its status is `pending`.
- [ ] Ensure the existing runnable-step reconciler does not bypass the delay and does not require a retry to be older than its normal five-minute settling cutoff once it is due.
- [ ] Treat a valid future retry as live work in the stuck/deadlock reconcilers so they do not mark the run failed or skip its pending step.
- [ ] On due issue-less retries, call normal workflow sync. On due issue-backed retries, use `wakeExistingWorkflowStepIssue` with the deterministic retry idempotency key.
- [ ] On malformed retry metadata, do not launch. Record a bounded reconciliation failure and leave terminal reporting to re-evaluate the now-unrecoverable state.
- [ ] Run retry and existing reconciler tests.

Run:

```sh
pnpm vitest run server/src/__tests__/workflow-step-retry-reconciler.test.ts server/src/__tests__/workflow-dag-engine.test.ts
```

Expected: delayed retries release once, and existing deadlock/runnable recovery remains green.

- [ ] Commit reconciliation support.

```sh
git add server/src/services/workflow/retry-reconciler.ts server/src/services/workflow/reconciler.ts server/src/services/workflow/runnable-step-wakeups-reconciler.ts server/src/services/workflow/dag-engine.ts server/src/__tests__/workflow-step-retry-reconciler.test.ts server/src/__tests__/workflow-dag-engine.test.ts
git commit -m "feat: reconcile delayed workflow retries"
```

## Task 7: Interlock retry liveness with Human Operator reporting

**Files:**
- Modify landed classifier path, expected: `server/src/services/missions/terminal-workflow-blocker.ts`
- Modify its landed test file, expected: `server/src/__tests__/terminal-workflow-blocker.test.ts`
- Test: `server/src/__tests__/workflow-step-retry-integration.test.ts`

- [ ] Add failing tests proving no Human Operator event while a retry is immediate, delayed, dispatching, or recoverably pending.
- [ ] Add tests proving one report after the last configured retry fails and no fallback, rework, recovery action, or conditional continuation remains.
- [ ] Add a malformed retry-state test. The classifier must distinguish “known live retry” from malformed metadata; malformed state cannot be treated as live forever.
- [ ] Teach the terminal classifier to read retry liveness through the shared retry-policy helper rather than duplicating max-count arithmetic.
- [ ] Keep the landed idempotency contract: repeated sync/supervision after exhaustion reuses the same owner-action issue/comment/event.
- [ ] Ensure the report summary includes bounded `attempts: initial + retryCount` and `maxRetries`, but no raw result/error payload.
- [ ] Run terminal-reporting and retry integration tests together.

Run:

```sh
pnpm vitest run server/src/__tests__/terminal-workflow-blocker.test.ts server/src/__tests__/workflow-step-retry-integration.test.ts server/src/__tests__/human-operator-alert-events.test.ts
```

Expected: no transient report; exactly one exhausted report.

- [ ] Commit the reporting interlock.

```sh
git add server/src/services/missions/terminal-workflow-blocker.ts server/src/__tests__/terminal-workflow-blocker.test.ts server/src/__tests__/workflow-step-retry-integration.test.ts
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
- Test the nearest existing Graph inspector/run-preview test files discovered with `rg --files ui/src | rg 'GraphInspector|GraphRunPreview|workflow-graph.*test'`.

- [ ] Add UI tests for default two retries, explicit zero, all backoff choices, delay zero, and serialization round-trip.
- [ ] Change retry delay inputs from `min={1}` to `min={0}` so the editor matches the runtime contract.
- [ ] Disable or visually mark delay/backoff/jitter controls as inactive unless `onFailure === "retry"`; preserve their saved values when temporarily inactive.
- [ ] Display `attempt N of M` and `retry scheduled at <time>` from `retryCount` and bounded `workflowRetry` metadata in run preview/details.
- [ ] Remove any copy that implies retries are active for non-`retry` failure policies.
- [ ] Keep the existing “default 2” wording and make clear that `maxRetries` excludes the initial attempt.
- [ ] Run focused UI tests and typecheck.

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

- [ ] Replace the statement that `retry_count`, `onFailure`, and `maxRetries` are dead/type-only with the exact active semantics and exclusions above.
- [ ] Document that retry count and QA iteration count are independent.
- [ ] Document Human Operator reporting only after automatic retry exhaustion.
- [ ] Search for stale editor/runtime claims and update only the impacted text.

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

- [ ] Run focused retry/reporting tests first.

```sh
pnpm vitest run server/src/__tests__/workflow-step-retry-policy.test.ts server/src/__tests__/workflow-step-retry-integration.test.ts server/src/__tests__/workflow-step-retry-reconciler.test.ts server/src/__tests__/terminal-workflow-blocker.test.ts
```

- [ ] Run the repository handoff gate.

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: all commands pass. If the repository has a pre-existing unrelated failure, capture the exact failing test and prove all focused tests, typecheck, and build are green before requesting a merge decision.

- [ ] Run `git diff --check` and inspect the final diff for unintended schema, migration, Gazua, or secret changes.
- [ ] Deploy through the existing runtime deployment workflow only after review and merge.
- [ ] Verify the deployment job completes and the production health endpoint returns healthy.
- [ ] Run a controlled canary workflow with `onFailure: retry`, `maxRetries: 1`, and a test tool that fails once then succeeds. Verify two total attempts, `retryCount = 1`, no Human Operator report, and downstream continuation.
- [ ] Run a second controlled canary that fails both attempts. Verify `retryCount = 1`, one terminal Human Operator report, and no further wake/heartbeat after the report.
- [ ] Remove or archive only canary-specific workflow/test data according to the normal operator procedure; do not delete unrelated runs.

## Final review checklist

- [ ] `maxRetries` counts retries, not total attempts.
- [ ] `retryCount` increments once per scheduled generic retry and never for QA iteration or the existing explicit owner retry action.
- [ ] Existing retry/fallback/rework mechanisms execute before generic workflow retry eligibility is decided.
- [ ] Failure/always branches are not masked by retry.
- [ ] IF/Complete and semantic QA failures are excluded.
- [ ] Delayed retries cannot be dispatched early by any sync or reconciler path.
- [ ] A retry in progress suppresses Human Operator reporting; exhaustion enables exactly one report.
- [ ] Error/audit metadata is bounded and contains no raw payloads or secrets.
- [ ] The full verification gate and two production canaries have evidence before completion is claimed.
