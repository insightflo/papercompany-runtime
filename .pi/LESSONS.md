# Runtime verification lessons

### 2026-09-10 — async stdout flood starved the loop instead of flooding the pipe
- Date: 2026-09-10
- Task: PR219 noisy-child subprocess-kill fixture (workflow-resume-cu-adapters).
- What failed: Generated `noisy.mjs` used `while(true) process.stdout.write(...)`; the child timed out at 10s instead of being killed by the 1MB diagnostic, reproduced twice.
- Root cause: Async `stdout.write` in a tight sync loop never yields, so backpressure callbacks never run; bytes pile into Node's internal buffer instead of reliably flooding the pipe.
- Category: test / process fixture
- Fix: Emit with blocking `writeSync(1, chunk)` on a preallocated 64KB buffer — each write reaches the kernel pipe before the loop continues, so the parent's diagnostic sees the flood and SIGKILLs.
- Prevention rule: A flood generator must actually deliver bytes to the pipe: prefer blocking writes (or await drain) over fire-and-forget async writes in unyielding loops; verify the kill path fires, not just that the child is loud.
- Reuse trigger: Subprocess-kill fixtures, output-size guards, or any `while(true)` writer feeding a pipe under test.
- Evidence: /tmp/pr219-parent-combined.log; /tmp/pr219-parent-adapters-isolated.log; /tmp/pr219-noisy-tests.log.

### 2026-09-10 — ordinary CI fixtures depended on developer-machine paths
- Date: 2026-09-10
- Task: PR219 bounded CI correction (mission-resume shorts CU evidence suites).
- What failed: Ordinary CI shorts tests executed sibling-checkout Python (`SHORTS_OPERATIONS_ROOT`, `CU_TEST_RECEIVER_SCRIPT`) and ffmpeg from the local machine, so CI could not run them at all, and the tests conflated two boundaries: consumer contract (durable DB/FS/readback) and producer semantics (real Python receiver/intake refusals).
- Root cause: Test fixtures reached outside the repo for producer executables and generated media at test time; the checked-in consumer boundary was never isolated from producer behavior.
- Category: test / dependency boundary
- Fix: Check in tiny valid media and an independently captured receipt under `server/src/__tests__/fixtures/shorts-ci/`; replace the Python receiver in ordinary tests with an explicit Node producer TEST DOUBLE emitting the literal consumer contract; configure the executable/script explicitly per test instead of env-implicit switches. Moved real producer semantics (never inventing success, snapshot-mutation refusal, actual sketch intake) to an opt-in external suite (`pnpm test:shorts-external`, `vitest.external.config.ts`) that fails loudly without configuration.
- Prevention rule: Ordinary tests must run with only repo assets and the runtime under test; any dependency on sibling checkouts, language toolchains, or PATH tools is a separate, explicitly configured suite that fails when absent. A test double may emit the contract but must not reimplement or fake producer verification.
- Reuse trigger: Tests spawning sibling-workspace scripts, ffmpeg/Python in CI, or asserting producer semantics through consumer-side fixtures.
- Evidence: /tmp/pr219-ci-red.log; /tmp/pr219-ci-green.log.

### 2026-09-08 — provider limit hidden by worker exit zero
- Date: 2026-09-08
- Task: Real mission-resume mutation-core delivery.
- What failed: Detached Pi worker exited 0 without closeout after provider 429; its last test run still failed. Parent combined rerun found 11 failed / 7 passed.
- Root cause: Process exit did not reflect JSON message_end stopReason=error; concurrent workers reached provider request limits. Test fixtures also used invalid enum values, repeated unique company prefixes and insertion order instead of UUID sort order.
- Category: delegation / verification
- Fix: Inspect structured terminal errors and require report plus fresh tests; queue corrections until capacity clears instead of immediately adding another model call. Correct fixtures using valid statuses, unique prefixes and actual key ordering.
- Prevention rule: Exit 0 is not task completion. Limit concurrent model workers after 429; preserve sessions and resume unfinished work. Real-DB fixtures must obey actual constraints before testing the intended failure.
- Reuse trigger: Detached JSON-mode agents, rate-limited providers, database contract tests.
- Evidence: /tmp/mission-resume-real-delivery/backend-core-worker.log; parent-core-verification.log.

### 2026-09-08 — late asynchronous writes erased upload sentinel
- Date: 2026-09-08
- Task: Whole-sketch bounded correction parent review.
- What failed: 72 server and 6 UI passing tests missed a delayed decision read overwriting a completed upload with old unsent state; parent controlled-promise probe observed two sends.
- Root cause: The pre-send sentinel was correct, but post-await delivery/decision writers saved stale state. Existing concurrency coverage delayed send, not decision reads.
- Category: concurrency / evidence
- Fix: Central synchronous save preserves attempted state and successful results, callers use its returned latest state. Seven late-reader regressions failed before the fix; parent final server79/UI6/external probe1 and source typechecks passed.
- Prevention rule: Review every post-await writer of no-resend state; test delayed readers against success and uncertain-send outcomes using controlled promises. File-list equality is not byte preservation: hash baseline files.
- Reuse trigger: Async approval polling, delivery sentinels, cached state writes. This local-memory proof does not establish restart/distributed durability.
- Evidence: /tmp/flow-gen/whole-sketch-correction-20260908-113051/parent-final-race.txt; parent-final-scope.json; followup-races-red.txt.

### 2026-09-08 — real-transaction tests and canonical baseline placement
- Date: 2026-09-08
- Task: Mission resume Task5c3c whole-mission roots review.
- What failed: 46 passing tests included fake-select validation calls outside the promised real readonly transaction; canonical baseline was captured after earlier selected-validation rejections. Worker also treated quoted-glob mismatch as evidence shell-expanded paths could not work.
- Root cause: Test shortcuts and evidence summaries generalized beyond the actual invocation boundaries.
- Category: test / evidence
- Fix: Removed fake reader calls, exercised malformed inputs in actual repeatable-read readonly transactions, seeded all data before the baseline and compared after each selected error. Parent exact shell-expanded combined Vitest command passed 10 files/46 tests plus source typecheck.
- Prevention rule: Every public call must honor the promised transaction surface. Capture canonical state before the earliest action being certified. Distinguish quoted glob strings from shell-expanded paths; report only what the command proves.
- Reuse trigger: Readonly collectors, selected-validation failures, Vitest file filters.
- Evidence: /tmp/mission-resume-task5c3c/fix1-parent-tests.txt; /tmp/mission-resume-task5c3c/final-scope-proof.json.

### 2026-09-08 — resource identity precedence and independent reference paths
- Date: 2026-09-08
- Task: Mission resume Task5c3b observed-resource filter review.
- What failed: 69 passing tests missed duplicate-resource scope precedence and rejected idle/crashed timestamps outside the approved contract; combined-cause fixtures also hid independent reference branches.
- Root cause: Validation applied precedence per row instead of per identity and generalized stopped-only ordering to other terminal states.
- Category: validation / test coverage
- Fix: Check all identity candidates for scope conflicts before ambiguity; enforce timestamp ordering only for stopped. Independently test service scopeId-heartbeat, issue, runtime references and both duplicate orders. Parent freshly passed 3 suites/75 tests including isolated DB checks.
- Prevention rule: Translate precedence to the exact grouping boundary; do not add stricter blocking beyond the contract. Test each independent OR/reference path with other causes absent.
- Reuse trigger: Duplicate resource records, reference joins, fail-closed state policies.
- Evidence: /tmp/mission-resume-task5c3b/fix2-parent-tests.txt; /tmp/mission-resume-task5c3b/final-scope-proof.json.

### 2026-09-08 — duplicate identity hidden by Map indexing
- Date: 2026-09-08
- Task: Mission resume Task5c3a recorded settlement review.
- What failed: 309 passing tests missed an input-order-dependent acceptance when two different heartbeats shared one finalization parent ID and only one had stages.
- Root cause: Per-heartbeat duplicate checks did not detect cross-heartbeat duplicate IDs; Map indexing discarded the other row.
- Category: validation / identity
- Fix: Track ambiguous parent IDs before indexing, reject every affected heartbeat at scope-check priority, and reject ambiguous stage references. Added stage-subset/order regressions and distinct-ID acceptance control; parent rerun 17 suites/315 tests passed.
- Prevention rule: Before trusting ID-indexed records, test duplicate IDs across ownership groups, both orders, absent/partial/complete children, and lower-rule precedence. Map overwrite is not identity validation.
- Reuse trigger: Joined histories, durable evidence readers, ID-indexed validation.
- Evidence: /tmp/mission-resume-task5c3a-parent-repro.txt; /tmp/mission-resume-task5c3a-fix1-parent-tests.txt.

### 2026-09-07 — import extraction changed mock reachability
- Date: 2026-09-07
- Task: Mission resume Task5a1 execution-definition capture review.
- What failed: Parent combined Vitest run had 282 passed / 1 failed; mission-workflow-lifecycle expected a durable wakeup row although its heartbeat mock was now called and did not persist one.
- Root cause: Removing the store→DAG runtime import cycle made the existing mock effective. The old test passed by bypassing its own mock. Package typecheck also excluded __tests__, concealing undeclared postgres.Sql and incorrect Promise<number> test annotations.
- Category: process / test
- Fix: Bounded correction delegated: preserve real mission/step/activity DB assertions, assert the exact dispatch request at the mocked boundary, await recorded asynchronous mock results; replace incorrect new-test types. Parent accepted the bounded correction after a fresh 17-file / 288-test pass and final-file review; this is capture/load foundation acceptance only.
- Prevention rule: After dependency extraction, verify which boundary a mock actually intercepts. Do not require a recording mock to produce real persistence or weaken assertions with row-or-mock alternatives. Check tsconfig coverage before claiming test types passed; passing source typecheck does not validate excluded tests.
- Reuse trigger: Dependency-cycle removal, mocked async dispatch, extracted service tests, or delegated claims based only on package typecheck.
- Evidence: /tmp/mission-resume-task5a1-parent-tests-initial.txt; /tmp/mission-resume-task5a1-fix1-brief.md.
