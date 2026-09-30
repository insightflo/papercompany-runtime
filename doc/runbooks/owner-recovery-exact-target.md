# Owner recovery: exact-target slice

Audience: runtime/API maintainers. Scope: P6–P8 plus the P9/P10 replacement admission/initial-start slice. This runbook documents that slice; the final evidence report records whole approved-scope code/isolated-verification completion, not production deployment.

## Final verification — 2026-09-30 13:50 KST

The frozen candidate passed `pnpm -r typecheck` and `pnpm build` (exit 0). The first whole run covered all 966 files and retained two failures. Their full shards were rerun once with unchanged source/environment/concurrency; six original passing shards plus two fresh shards yield **7,236 passed, 0 failed, 2 existing skipped**. This is not a single all-green run. All 7,238 test identities match, files have no omissions/duplicates, and 3,011 runtime source hashes remain unchanged. The two skips are an existing async-cleanup test and a Windows-only probe on macOS.

Durable evidence: `/Users/kwak/Projects/ai/papercompany/papercompany-artifacts/reports/oversight-v31-implementation-20260930/{README.md,VERIFICATION.md,verification-identity.json,manifest.json}`. Historical focused records below are preserved; their pending-whole-check statements are superseded by this section. No product-code commit, deployment, live migration or mission mutation was performed. Accepted queue requests remain distinct from completed execution, and already-started external effects are not undone.

## Submission

`POST /api/issues/:id/owner-recovery/decision` requires an authenticated agent run whose
`heartbeat_runs.company_id`, `agent_id`, and `issue_id` match the owner-action issue and
mission owner. The submission issue is not the failed target issue. A null or foreign
heartbeat issue is rejected before checkout adoption/repair. Valid same-issue stale
checkout adoption remains supported. Authorship reads do not require a current checkout
or a currently running heartbeat.

The optional `recoveryTarget` uses the approved exact identity:

```json
{
  "decision": "retry_source_issue",
  "recoveryTarget": {
    "kind": "tool_step",
    "workflowRunId": "<uuid>",
    "stepRunId": "<uuid>",
    "expectedAuthorityVersion": 0,
    "expectedExecutionGeneration": 0,
    "failedDispatchRequestId": null
  }
}
```

Versions and the failed request come from current durable run/step records, never guessed
from descriptions. The writer verifies company/mission, run/step identity and current
failed attempt in the same transaction as authorization, checkout and decision insertion.
The ledger preserves the target and exposes it to execution and display readers.

## Supervision

Tool recovery uses exact run and step-run equality. It never selects the lone failed step,
a running alternative, or a Markdown marker. Legacy oversight-linked cards without an
explicit tool target return `no_op/target_missing`; they require resubmission. Invalid,
stale, terminal, exhausted or already-consumed targets never fall through to generic issue
retry. `recover_artifact` without registered evidence does not silently become retry.
No automatic safe-tool policy is registered; explicit `retry_source_issue` intent is required.

`recoveryOutcomes` exposes structured results. `dispatched` requires the native durable
request id with matching queued invocation or acceptance evidence, not merely a running
status. This means a request was accepted into the native queue, not that the tool finished.
Accepted retry outcomes are stored on the existing transition-event path, with the consumed
`authorityId`, exact accepted owner decision/target and native request ID. Queue insertion
and this outcome commit together; interrupted delivery is backfilled by the native retry
reconciler, using the original decision link stored with acceptance. Rejections
return an outcome without writing a recovery event. Ordinary supervision may still write
diagnostic comments or create unrelated recovery cards.

## Atomic tool acceptance and delivery (P8 slice)

`retry-issue-less-manual.ts` locks mission → run → steps, rechecks exact failed request,
execution generation, authority version and current owner intent, consumes the existing
`workflow_recovery_authorities` row and resets the named tool in one transaction. Any
refusal or `already_consumed` returns without resets. Explicit v2 requests require an actual
current failed terminal decision even when legacy feature flags are disabled; missing
records are not synthesized. Official recovery retains its existing all-step generation
increment, while v2 resets only the explicitly named tool's result/status.

After commit, `tool-recovery-delivery.ts` rechecks the accepted receipt against its consumed
registry row and current run/generation under the same lock order, then uses native sync to
write the durable tool invocation/queue. The existing retry reconciler redelivers only that
pending accepted attempt after a process interruption. It neither consumes again nor resets
again. Cancelled missions/runs, superseded generations and invalid receipts do not dispatch.
The receipt in step metadata is delivery linkage, not an alternative execution authority.
Acceptance and delivery both check current source-run liveness and company/owner budget
under the mission → run → step locks. Generic retry-exhaustion remains a refusal; a new
request key does not authorize another automatic attempt.

Cap dispatch and compensation now use that same lock order and reject cancelled/replaced
sources, inactive missions, live execution and exhausted budgets before any write. Cap queue
acceptance and its audit commit in one transaction. The cap path inserts a native durable
wakeup request; it does not call an adapter before commit. Failed acceptance leaves no
skipped queue row. Fresh-apply compensation is a separate guarded transaction and cannot
restore a cancelled/replaced or now-active source.

New tool cards and `owner_tool_recovery_target_v1` identity links commit together. Existing
QA-cap claim rows distinguish QA cards from tool cards despite their shared oversight origin.
An explicit issue target overrides inference and conflicting structured references reject
without fallback. Artifact recovery passes the recorded failed request and confirms the
actual completed step/result before reporting recovery.

## Remaining boundaries and compatibility

- P9/P10 admission now uses migration 0119 to extend the consumed-only recovery ledger.
  Target/approval/owner-decision foreign keys, request hash and strict replacement contract
  join target creation, frozen definition and audit in one transaction. Same request replays
  return the linked target without another start; conflicting intent cannot consume again.
- Authenticated REST/plugin agent identity reaches the common trigger boundary. A second
  top-level agent run requires replacement intent, regardless of caller `triggeredBy`.
  Plugin replacement skips plugin-to-native definition refresh. First agent-run creation
  rechecks under the mission lock. Board, scheduler and child paths remain separate.
- Board-only proposal endpoint is `/companies/:companyId/workflow-replacements`;
  `.../:approvalId/{approve,reject,request-revision,resubmit}` handles the review lifecycle.
  Generic mutation endpoints cannot process this type. The run-detail proposal and approval
  review UI use the dedicated company-scoped API and show exact source/target, generation,
  input/definition hashes and the operator reconciliation limitation. Resubmission can update
  content through the API; the current UI resubmits unchanged content. No automatic replacement
  is enabled. Local browser proposal→review navigation and the decision controls were exercised.
- Source-issue failed-run acceptance now combines recovery and exact step update in one
  transaction and never treats `already_consumed` as reset permission. Formal recovery,
  store resume, direct engine resets, tool retry, scheduler, cap fresh apply and resume/apply
  reject a replacement source under its run lock. Cancellation is rejected even with the
  old reopen flag off. Scheduler refusals preserve the existing `already_changed` result.
- Plain initial start now claims only untouched pending/version-0 runs with no step rows or
  consumed source recovery. Mission cancellation and replacement target evidence are checked
  under locks. Concurrent claim losers cannot rewrite startedAt or materialize. Instant
  advance and accepted engine resume use running-only sync, not the initial-start path.
  The existing retry reconciler redelivers linked pending replacement targets and claimed
  running targets whose server-written `replacementStart` receipt has no delivery timestamp.
- QA cap marker detection and QA-step description parsing remain legacy control-plane risks.
  The producer-description fallback was removed; no new prose authority was added.
- Tool-card identity no longer parses legacy descriptions. A new structured card may be
  created alongside an unlinked legacy card; old cards are not silently backfilled/deleted.
- Legacy non-v2 retry keeps its flag-dependent fallback/reset behavior, now transactionally,
  except replacement/cancel exclusion. Migration 0119 is additive; existing rows are not
  backfilled. No deployment, live mutation or mission resume/cancel was performed.
- P9/P10 focused acceptance evidence is complete; final whole-candidate verification is tracked
  in the shared plan, not inferred from these tests. A server-written first-start receipt now survives
  claim commit; replacement-only native sync locks mission → source/target → source steps →
  approval → frozen definition and commits initial materialization/queue plus delivery receipt
  together. Isolated issue-less tool tests prove rollback and same-target crash reentry.
  Agent-root first delivery now commits issue/linkage, native `agent_wakeup_requests` and
  delivery receipt together (`replacement-agent-delivery.ts`, 9-test regression). The existing
  scheduler starts committed requests later; acceptance is not task completion. Cap cancellation,
  replacement-source refusal and audit/queue rollback are covered by the current isolated tests.
  Actual DB probes now cover direct resume/replacement and definition/approval-edit contention.
  Real authenticated REST and both plugin action routes also contend on one source: one target,
  one consumption and one queue request. Agent plugin access is limited to the resolved native
  workflow-engine `start-workflow` replacement action; other actions remain board-only and agents
  cannot fall back to plugin worker execution. Approval remains board-only. A failed replacement
  needs its own current owner decision and a fresh explicit board approval; it uses the same
  per-source/version single-consumption rule, not an automatic chain. Unapproved local fields
  `userFixDigest`, `approvedBaseHash`, `priorIntentKey` and the blanket lineage ban were removed.
  Full-suite verification is still required.
- Operator reconciliation is an authenticated assertion, not a CMS readback integration.
  Admission, initial claim, and first delivery now inspect typed and issue-linked heartbeats,
  queued/claimed/deferred wakeups, unsettled v1 heartbeats, native tool request/result identity,
  and active tool progress records. Company/owner monthly counters and existing invocation
  budget policy are checked again at these boundaries. The actual heartbeat admission,
  promotion, claim and adapter-entry paths now resolve typed and issue-derived workflow scope,
  lock mission→run against replacement admission, reject a replaced source, and recheck company
  and executing-agent monthly counters even before a pause flag appears. Independent probes
  cover late source wake, previously queued work, updates after claim and both lock winner orders.
  Adapter lifetime does not hold the DB transaction. This protects entry, not cancellation or
  rollback of an already-started external effect. Do not treat it as a global spend reservation.
- Replacement approval records now freeze `inputContract` declarations for normalization.
  Admission/replay use those declarations, never current definition defaults. Older records
  without the optional field accept exact normalized metadata, without guessing old defaults.
- Reconciliation catches each target failure and scans ordered keyset pages through a sweep
  high-water mark. Malformed targets remain blocked and cannot starve the next page.

## Verification boundary

Latest correction evidence (2026-09-30): heartbeat `/tmp/heartbeat-recovery-final-combined2.log`
(59 tests), full cap entry `/tmp/cap-full-regression-final.log` (81), independent corrected
recovery `/tmp/oversight-corrected-independent-probes-final.log` (13, including actual 0118→0119
upgrade with pre-existing resume consumption), plugin actual HTTP `/tmp/plugin-http-final.log`
(23) plus `/tmp/plugin-http-regression.log` (35). The older plugin 403 finding in the independent
probe was corrected after that probe; the new signed-agent HTTP tests cover both routes.
UI local browser proof: `/tmp/oversight-ui-link-qa/REPORT.md` (actual React, fixture API only).
Latest full typecheck passed `/tmp/oversight-final4-verification/typecheck.status.json`.
The final sharded test/build status is tracked under `/tmp/oversight-final4-verification/`
and, if needed, its explicitly retained failed-shard revalidation. Original failed results
are never overwritten or relabeled. No live migration/deploy.

The final integrated 12-file/78-test batch (`/tmp/oversight-integrated-final-focused.log`)
adds exact P10 evidence: source resume at version 0 → failed version 1 → one replacement
consumption at version 1 → old resume rejection with unchanged rows; normal start plus two
reconcilers observed simultaneously waiting on PostgreSQL locks → one initial claim, one
startedAt write, two unique step rows and one queued request. These are permanent tests
`workflow-replacement-resume-history.test.ts` and `workflow-replacement-start-contention.test.ts`.
The heartbeat exception path also preserves a cancelled wake: only a successful failed-run
transition may update the exact company/run/wake while it is queued/claimed. A real DB trigger
test places cancellation between those two writes; terminal cancellation remains unchanged.
The final independent integration review is `/tmp/oversight-final-integrated-independent-review.md`.

Isolated PostgreSQL tests cover same-key winner/loser, current-failure refusals, consumed
receipt refusal, cancellation between observation and locking, postcommit interruption,
concurrent delivery, and wrong-receipt/stale/cancel refusal. Broader target regression:
`/tmp/oversight-p678-regression2.log` (16 files / 201 tests); workspace typecheck:
`/tmp/oversight-p678-all-typecheck.log`; build: `/tmp/oversight-p678-build.log` (exit 0).
Final focused rerun including transactional rollback: `/tmp/oversight-p678-final-target.log`
(5 files / 50 tests). The full `pnpm test:run` attempt exceeded 600 seconds before a final
summary (`/tmp/oversight-p678-full-test.log`); that historical slice did not complete the suite.
Use the latest whole-candidate results above, not this earlier limitation. These are local
evidence, not production validation.

P9/P10 slice execution evidence (2026-09-29): initial-start RED in
`/tmp/oversight-p910-start-red.log` and missing-admission RED in
`/tmp/oversight-p910-admission-red.log`; fixture constraint errors preceding RED were not
counted as product failures. Final combined targeted run:
`/tmp/oversight-p910-combined-final.log` — 19 files / 169 tests passed. New cases include
same-intent replay, different-intent conflict, replacement versus resume, generation/approval/
definition refusal, cancelled mission lock race, transactional insertion failure, replacement
first-start contention, and source/scheduler refusal. These do not establish every P9/P10
acceptance case. `pnpm -r typecheck` passed (`/tmp/oversight-p910-all-types2.log`), final server
check passed (`/tmp/oversight-p910-final-types.log`), and `pnpm build` passed
(`/tmp/oversight-p910-build.log`, existing large-chunk warnings). Migration was generated with
`pnpm db:generate` (`/tmp/oversight-p910-migration.log`) and applied by isolated test fixtures.
The full suite was not repeated within that earlier slice; later whole-candidate results
are tracked above. Do not treat this historical note as the current verification status.

Recovery safety follow-up: `/tmp/oversight-safety-regression.log` — 10 files / 119 tests
passed (isolated PostgreSQL, single worker), including 101-target pagination, claim crash,
receipt-write rollback, simultaneous redelivery, and mission-lock cancellation/budget races.
RED: `/tmp/oversight-safety-red3.log` (14 failures), `/tmp/oversight-delivery-red.log`
(6 failures), `/tmp/oversight-crash-red.log` (2 failures), `/tmp/oversight-receipt-red.log`
(forged receipt refusal). Final direct server `pnpm exec tsc --noEmit` passed:
`/tmp/oversight-safety-server-tsc.log`. `pnpm -r typecheck` hit 300 seconds after server/UI
Done and while CLI was still running (`/tmp/oversight-safety-all-types.log`); do not report
whole-workspace typecheck passed. Full test/build were not completed in that slice. The later agent-first-delivery correction
replaced immediate external wakeups with transactionally committed native queue receipts.

Recovery follow-up (2026-09-29): `/tmp/oversight-recovery-final.log` — 14 files / 145 tests
passed using `env -u DATABASE_URL pnpm exec vitest run <focused files> --maxWorkers=1
--minWorkers=1`, real isolated PostgreSQL. RED: `/tmp/oversight-recovery-outcome-red.log`
(2 failures), `/tmp/oversight-recovery-safety-red.log` (4 failures),
`/tmp/oversight-cap-atomic-red.log` (6 failures). Tests include crash-after-acceptance,
outcome-insert rollback, exact authority/request linkage, cancelled/replaced-source unchanged
snapshots, budget/liveness refusal, mission-lock cancellation and concurrent native cap
queue acceptance. Existing integration fixtures emit missing `onOwnerActionCreated` callback
warnings; those are not new production failures. Full workspace verification belongs to the
parent integration pass, not this focused slice.
