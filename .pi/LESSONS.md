# Runtime verification lessons

### 2026-10-03 — recovery diagnostics need whole-header and non-HTTP URI redaction
- Date: 2026-10-03
- Task: Stage 1 review fixes (display only).
- What failed: Basic/other authorization schemes retained credential payloads; non-HTTP connection URLs retained passwords. Structured result display omitted native `toolResult.error`.
- Root cause: Bearer/HTTP-only special cases plus one-token key masking; test fixture invented `errorCode`. Re-review found quote/newline URL token boundaries could publish password suffixes even after URL parsing.
- Category: security / fixture fidelity.
- Fix: Suppress authorization line tails. For scheme:// diagnostics, inspect the entire remaining fragment and suppress it when credential-bearing, ambiguous or unparseable; never preserve a guessed quoted/newline URL boundary. Expose redacted native `error` only.
- Prevention rule: Verify entire persisted descriptions with Basic/DSN sentinels and missing/SQL-unavailable registry; include apostrophe, double quote, backtick, encoding, newline and malformed credentials. Prefer suppressed diagnostic tails to secret-bearing URL usability; mirror native fields.
- Reuse trigger: Publishing diagnostic/config text into owner issue descriptions.
- Evidence: `.recovery-work/stage1-review-fix-red.log` (13 failures); `.recovery-work/stage1-url-boundary-red.log` (17 failures/18 passes), `stage1-url-boundary-focused.log` (9 files/88 passes/zero skips), `stage1-url-boundary-types.log` (test-inclusive tsc pass).

### 2026-10-03 — recovery brief fixtures and diagnostic redaction
- Task: Stage 1 structured tool recovery brief.
- What failed: Producer/pattern fixture setup omitted required status/source fields; a producer selector used unsupported type=file. The first redaction pass missed token values after a preceding diagnostic label consumed the regex match. An auxiliary test tsconfig omitted Node/Express types and inherited declaration emission.
- Root cause: Incomplete fixture schemas, non-overlapping key/value scanning, and test compiler setup rather than product contracts.
- Category: test fixture / redaction.
- Fix: Use schema-valid document/active/operator fixtures; redact sensitive key spans independently (including quoted JSON); explicit Node typeRoots, Express declarations and declaration=false in test-only config.
- Prevention rule: Validate full insert and selector schemas before counting RED; test secrets after diagnostic prefixes and inside quoted JSON; source typecheck is not test typecheck.
- Reuse trigger: Diagnostic brief redaction, optional DB read tests, auxiliary test-inclusive TypeScript check.
- Evidence: `.recovery-work/stage1-producer-red-confirmed.log`, `stage1-boundaries-red.log`, `stage1-focused-green.log` (21 files/249 tests), `stage1-test-types-green.log`.


### 2026-10-02 — declarative role migration must preserve execution equivalence
- Date: 2026-10-02
- Task: QA genericization integration with revision repeat guards and seeded reuse.
- What failed: Updating a failed-source fixture to `action` hid the legacy `agent` → declared `action` hash mismatch; original failing work was admitted to PLAN-QA instead of rejected.
- Root cause: Comparison treated the role spelling change as a new execution configuration.
- Category: integration / regression fixture fidelity.
- Fix: Canonicalize only untyped/agent/action execution for both comparison purposes; retain legacy-source fixtures and assert real repeat rejection and seeded product identity. QA/control/tool roles remain distinct.
- Prevention rule: Preserve historical fixture definitions when migrating declarations; add cross-version comparisons instead of modernizing both sides.
- Reuse trigger: Declarative role/config migrations affecting revision hashes or reuse admission.
- Evidence: `/tmp/qag/phase-b3-investigation/legacy-red.log`, `delivery-red-integration.log`, `seed-diagnostic.log`.

### 2026-10-02 — exported baselines must resolve their own workspace packages
- Date: 2026-10-02
- Task: Compare PAQO integration timing with origin/main without touching other worktrees.
- What failed: A baseline export with directory-level node_modules symlinks resolved current shared validators, producing a false baseline assertion failure.
- Root cause: Workspace dependency symlinks resolved through the original dependency directory.
- Category: verification environment.
- Fix: Link external dependencies individually and redirect workspace links to the exported commit; exact main then passed 6/6 tests.
- Prevention rule: Verify workspace-package resolution before treating an exported baseline run as evidence. Setup failures and tool-launch errors are not product RED results.
- Reuse trigger: git archive baseline comparisons with pnpm workspaces.
- Evidence: `/tmp/qag/phase-b3-investigation/main.log`, `main-isolated.log`.

### 2026-10-01 — reused consumer rows need native input invalidation proof
- Date: 2026-10-01
- Task: Final seeded revision rework binding blocker.
- What failed: New-consumer tests hid permanent old pins on reused QA rows; the first complete-path fixture also replaced native producer-generation metadata and accidentally gave a structural tool an agent ID while correcting types.
- Root cause: Bindings key consumer row, not attempt; native rework reuses rows. Fixture dispatch must preserve native reset metadata, and structural gates require empty agentId.
- Category: lifecycle / test fidelity / concurrency.
- Fix: Retire seed/earlier-attempt pins atomically only with native producer-transition and consumer-reset proof; retain audit. Seed pin writers lock/revalidate. Use same IDs, exact producer completion time, preserved metadata, empty agentId, actual runner/receipt, and test-inclusive tsc.
- Prevention rule: Same-row rework, not a newly inserted consumer, is the acceptance path. Test manual mutation, stale reset snapshot, concurrent pin writer, finalization OFF/ON, old audit and new pin together.
- Reuse trigger: Immutable input pins combined with reset/retry/rework of persistent step rows.
- Evidence: `/tmp/seed-binding-red2.log`, `/tmp/seed-binding-safety-red.log`, `/tmp/seed-binding-stale-red.log`; `/tmp/seed-binding-focused-final2.log` 9 files/51 tests, zero skips; source/test-inclusive typechecks passed.

### 2026-10-01 — revision failure identity and approval serialization
- Date: 2026-10-01
- Task: Independent review findings 2/6/7 and excessive revision mapping restrictions.
- What failed: QA rejection/tool failure was treated as missing adapter evidence; generation-only queries mixed retry/iteration attempts; board admission could commit while a verdict revocation was uncommitted. Mandatory mapping/removal prohibition exceeded the request.
- Root cause: Display failure status substituted for failure authority, and mission-only admission locking did not coordinate PLAN-QA writers. Generated IDs were used as comparison identity.
- Category: execution authority / concurrency / product scope.
- Fix: Original wake admission proves current heartbeat attempt; official QA/tool result failures are distinct from heartbeat error codes; typed forward-graph hashes compare unlinked equivalent steps without granting reuse; shared mission→plan→issue→heartbeat→verdict ordering retains approval locks through run commit. New/removal plan units allowed.
- Prevention rule: Test succeeded-heartbeat request_changes, issue-less tool verdicts, multiple retries in one generation, actual generated QA/machine gates, and both two-transaction orderings. Do not add stricter product restrictions to simplify identity matching.
- Reuse trigger: Revision comparisons, retry dossiers, approval-to-run admission, generated workflow identities.
- Evidence: `/tmp/review-267-red.log`, `/tmp/review-267-red7.log`, `/tmp/review-267-focused-final.log` (20 files/96 tests), `/tmp/review-267-regressions.log` (6 files/124 tests). Zero skips. Generated QA→changed PLAN→board verdict→fresh run exercised through real services.
- Fixture corrections: Use actual storage in a scoped temp root, not a partial storage double with missing objectKey; use original admission helper rather than direct heartbeat insertion. A /tmp test tsconfig needs explicit repo typeRoots/types (otherwise Node EventEmitter members disappear); corrected test-inclusive check passes.

### 2026-10-01 — revision fixes require generated-plan and attempt lifecycle proof
- Date: 2026-10-01
- Task: Independent mission revision findings 1/3/4/5.
- What failed: HTTP omitted mission IDs bypassed board wait; generated PAQO dropped artifact contracts; seed selection rejected legitimate rework forever; second-revision hashes compared different coordinate systems.
- Root cause: Request identity was trusted over definition ownership; manual test definitions bypassed the real builder; initial seed provenance was treated as lifetime execution authority; both sides followed historical source links.
- Category: execution authority / integration coverage.
- Fix: Definition-owned early admission; preserve/validate/remap PAQO contracts; retire seed authority on native target attempt advancement and require same-run official output; normalize target references only.
- Prevention rule: Test actual HTTP omission/substitution with no-mutation checks, generated PAQO through the real tool runner, original plus new-attempt provenance, and revision-of-revision dependent steps. Run rework via sync (execute is initial-start/idempotent), record official QA verdicts, and capture structural producer tokens. QA receipt verification already rejects `ok:false`; do not invent successful rejection receipts.
- Reuse trigger: Durable evidence reuse, generated workflow contracts, cross-run mapping, retries/rework.
- Evidence: `/tmp/review-1-red.log`, `/tmp/review-3-red.log`, `/tmp/review-4-red2.log`, `/tmp/review-5-red-1-green.log`; final focused/typecheck logs referenced in plan.

### 2026-10-01 — inspect an existing contract before extending it
- Task: Task3 revision unit contract.
- What failed: Shared build reported missing `missionRevisionSourceSchema` after a new unit schema overwrote its file.
- Root cause: Assumed the intended filename was new instead of reading the tracked file first.
- Category: editing / compatibility.
- Fix: Restored the original source schema and added the optional unit identity schema alongside it; shared build and source-contract tests pass.
- Prevention rule: Check tracked-file existence and read before write; extend existing contract files with targeted edits.
- Reuse trigger: Introducing a schema into an existing feature namespace.
- Evidence: `/tmp/task3-types.log` failure; `/tmp/task3-types-final.log` successful shared/server/UI checks.

### 2026-10-01 — seed/QA fixtures must use canonical paths and release read-only fixture directories
- Date: 2026-10-01
- Task: Task2 durable revision seed verification.
- What failed: Initial happy-path seed fixture used macOS `/var/...` while the safe artifact reader required canonical `/private/var/...`; QA assertions later passed but teardown hit EACCES on intentionally read-only input directories. Parallel legacy DB suites also silently skipped after embedded initialization failure.
- Root cause: Fixture filesystem contract mismatch; teardown did not restore writable permissions on its own read-only QA directories; excessive parallel embedded startup.
- Category: test / fixture
- Fix: `realpath(mkdtemp(...))`; chmod only the exact owned temporary root before cleanup, following the existing QA fixture; rerun focused suites with `--maxWorkers=1` and require zero skips.
- Prevention rule: Use canonical temporary artifact roots, account for production-created read-only directories in fixture cleanup, and inspect skip counts rather than accepting green suite labels.
- Reuse trigger: Safe artifact reader/writer DB tests and parallel embedded PostgreSQL fixtures.
- Evidence: `/tmp/task2-green1.log`, `/tmp/task2-qa.log`, `/tmp/task2-focused2.log`; final `/tmp/task2-focused-final.log` 11 files / 277 tests / zero skips.

### 2026-10-01 — optional planner context must preserve ordinary manifest shape
- Date: 2026-10-01
- Task: Task1 revision source/planner linkage.
- What failed: Focused regression expected the ordinary step manifest unchanged; unconditional `revisionContext: {}` added a field.
- Root cause: Normalizing absent optional context into an empty object changed the no-revision contract.
- Category: compatibility / test
- Fix: Emit revisionContext only when a revision dossier exists; retain the existing exact manifest assertion.
- Prevention rule: Optional planning features must preserve the ordinary manifest shape; test both present and absent paths.
- Reuse trigger: Adding optional context to a runtime manifest.
- Evidence: `/tmp/task1-focused.log` (80 pass/1 exact-shape failure); correction verified in Task1 focused rerun.
### 2026-10-01 — optional frozen markers can narrow mapped array inference
- Date: 2026-10-01
- Task: Phase B structural publication-verifier preservation.
- What failed: Focused tests passed, but server typecheck rejected assigning ordinary workflow steps to a mapped array whose `deliveryRole` property was inferred as required-with-undefined.
- Root cause: The policy projection widened runtime behavior correctly but narrowed TypeScript's inferred collection shape beyond `WorkflowStep[]`.
- Category: type contract
- Fix: Declare the builder accumulator as `WorkflowStep[]`; retain the optional marker in the canonical runtime step type.
- Prevention rule: When a projection adds optional derived fields and later receives other step sources, type the accumulator to the canonical step interface and run source typecheck.
- Reuse trigger: Frozen snapshot normalization or synthetic workflow step insertion.
- Evidence: `/tmp/qag/b-review-workflow/typecheck.log`; corrected verification in `typecheck-final.log`.

### 2026-10-01 — definition integration fixtures need grant authors and executor readiness
- Date: 2026-10-01
- Task: Phase B general workflow publication replay integration.
- What failed: Initial local DB tests stopped at missing `agent_tool_grants.granted_by`, then missing configured workflow tool executor, before reaching replay assertions.
- Root cause: Fixture omitted a required grant column and definition-save readiness prerequisite.
- Category: verification-fixture
- Fix: Supply `grantedBy: "board"` and install a definition-only executor that throws if invoked; clear it at teardown. Actual RED then showed publisher-only replay instead of publisher + verifier.
- Prevention rule: Definition-save tests using tools need complete persisted grants and an explicit non-dispatching executor; prerequisite errors are not product RED.
- Reuse trigger: Local DB workflow create/update tests with declared tools.
- Evidence: `/tmp/qag/b-templates/red.log`, `red2.log`, `red3.log`, `focused.log` (14 files / 275 tests).

### 2026-10-01 — isolate full-suite resources and fixture clocks
- Date: 2026-10-01
- Task: Runtime QA Phase A full gates.
- What failed: Default full suite terminated; serial run later failed PG setup, continuation claiming and a CU request, although failed files passed isolated.
- Root cause: Continuation fixtures mixed DB microsecond time and JavaScript millisecond time; competing test runners and PG resource pressure were observed, but original PG timeout/CU 401 causes remain unproven.
- Category: test determinism / resource contention
- Fix: Fixed fixture clock, restored CU environment with failure diagnostics, closed DB client before cleanup; waited for other Vitest processes, used fresh temp directories and one worker. Fresh full suite passed 991 files / 7,468 tests, with two expected skips.
- Prevention rule: Do not count isolated reruns as full-suite success. Avoid competing full suites, explicitly set due times, restore fixture environment and inspect unexpected DB skips. Never kill another worktree's processes.
- Reuse trigger: Embedded Postgres full gates fail only under sustained suite execution.
- Evidence: `/tmp/qag/full-test-serial-summary.md`, `/tmp/qag/test-determinism-focused.log`, `/tmp/qag/final-gates-summary.md`.

### 2026-10-01 — authorize policy replacement against the locked current row
- Date: 2026-10-01
- Task: Phase A board-only QA configuration and frozen attempt start.
- What failed: A controlled local-DB HTTP regression let an agent overwrite a board policy added after the route's initial read (200 instead of 403). An initial failure cleanup also erased the current attempt's frozen policy on dispatch rejection.
- Root cause: Authorization compared a stale route snapshot; cleanup did not distinguish a prior attempt from the current request.
- Category: authorization / concurrent writes / durable evidence
- Fix: Compare agent step replacements under a workflow-definition row lock and write in the same transaction; clear artifact snapshots only when dispatch request identity changes.
- Prevention rule: Read-compare-write authorization needs a lock or fenced write. Attempt cleanup must preserve current-request evidence while removing prior-request evidence.
- Reuse trigger: Board-owned policy within agent-editable documents, or attempt-metadata cleanup shared by start and dispatch failure.
- Evidence: `/tmp/qag-auth-race-red.log` (200 versus 403), `/tmp/qag-auth-race-green.log` (35 tests), `/tmp/qag-auth-freeze-edge-red.log` (2 failures), `/tmp/qag-auth-freeze-final.log` (101 tests before final race addition).

### 2026-10-01 — capture artifact dispatch before deployment byte reads
- Date: 2026-10-01
- Task: Phase A generic artifact pipeline plumbing.
- What failed: Existing DB regression tests detected generation/retry/iteration changes during deployment hash reads, yet publication still launched.
- Root cause: The consumer captured its dispatch fence only after deployment hashing, adopting the newer attempt rather than the original request snapshot.
- Category: execution-control / awaited-read ordering
- Fix: Capture the original dispatch fence before any awaited deployment or input byte read; pass that same guard into consumer validation and launch. All 13 p2 regression tests passed afterward.
- Prevention rule: Any new awaited preparation before a launch must occur after the original attempt guard is captured. Never rebase the guard after awaited I/O.
- Reuse trigger: Adding deployment/provenance/config reads around guarded tool execution.
- Evidence: `/tmp/qag-pipeline-regression.log` (three fencing failures), `/tmp/qag-pipeline-cas.log` (16 passing byte/DB regression tests).

### 2026-09-22 — conditional QA closeout: sandbox failures are not bug RED and identical-conditions rerun decides blame
- Date: 2026-09-22
- Task: PR #260 two-finding correction (durable skip cancellation + JSONB predecessor comparison) closeout and A1 deploy.
- What failed: (1) Worker sandbox listen/EPERM blocks were initially treated as bug RED, nearly producing an unauthorized Unix-socket @paperclipai/db workaround. (2) The correction's first full-suite run showed 3 failures in unrelated heartbeat/tool suites and deployment was held; causal relation to the 4-file correction was never established. (3) The JSONB key-order fix exposed a fixture that depended on the old buggy comparison semantics. (4) An independent review prompt invented an expanded fallback invariant, producing a P2 the reviewer reclassified as beyond-scope P3.
- Root cause: sandbox transport limits misread as product behavior; a single parallel-suite run treated as deterministic; test fixtures encoding current buggy behavior; review brief diverging from the approved contract.
- Category: process / test
- Fix: Actual-DB proofs moved to the parent (unsandboxed) context; identical-conditions full-suite rerun reproduced 0 failures (888 files / 6748 tests) before unblocking merge; fixture asserts semantic changed-value behavior with a positive unchanged control; boundary call-count/target asserted before outcome; review prompts restate the approved fallback contract verbatim.
- Prevention rule: Sandbox transport errors are never bug RED — move the DB check, do not mock the DB. Never claim flaky or causally related from one run; rerun identical conditions first. When fixing comparison semantics, expect fixtures that relied on the bug. Independent review prompts must copy the approved contract, not invent invariants.
- Reuse trigger: delegated implementation in sandboxes, JSONB metadata comparison changes, full-suite failure triage on bounded corrections, review-brief authoring.
- Evidence: /tmp/jev260-full-rerun.log (888 files green); /tmp/jev-qa-correction-full-tests.log (blocked run, 3 unrelated failures).

### 2026-09-21 — conditional QA fixtures must preserve artifact names and boundary import order
- Date: 2026-09-21
- Task: Jev conditional skip settlement and revival actual-DB verification.
- What failed: Both decision-rework directions kept the old IF result; an engine regression fixture started real heartbeat writers and failed teardown foreign keys.
- Root cause: Artifact registration canonicalizes the filename into the title, so `jev-mirror-N.json` did not replace the IF source `decision.json`. Importing the shared boundary after engine dependencies allowed real heartbeat services to load.
- Category: Integration fixture contracts / module initialization.
- Fix: Register each revision under a distinct directory with basename `decision.json`, assert its stored title, and import the shared control-node boundary before fixture/engine dependencies. Complete validator issues through scoped verdict/lifecycle APIs.
- Prevention rule: Verify durable registered identity, not requested title; establish mocks before service imports. Never delete queue rows to hide real asynchronous writers. Package typecheck excludes tests, so actual DB tests remain mandatory.
- Reuse trigger: Conditional work-product rework, heartbeat-backed integration fixtures, unexpected queue rows or teardown FK failures.
- Evidence: /tmp/jev-qa-targeted-r2.log; /tmp/jev-qa-f2-r3.log; /tmp/jev-qa-final-six.log (21 passed).

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

### 2026-09-30 — random test identifiers can collide before the product assertion
- Date: 2026-09-30
- Task: Oversight v3.1 frozen whole-suite verification, shard 2/8.
- What failed: `plan-qa-evidence-registry.test.ts` / `rejects tampered registry issuer` failed while creating its company, with PostgreSQL 23505 and `Key (issue_prefix)=(GTf1e4) already exists.`
- Root cause: The unchanged `seedGateWorld` fixture uses only four UUID characters for a unique company prefix (65,536 possibilities); 25 tests share one database and attempt 32 worlds without per-test company cleanup. The issuer rejection assertion had not started.
- Category: verification-fixture / random-identifier-collision
- Fix: Preserve the failed log/blob and unchanged source manifest. Collect the ongoing full suite, then perform one same-source/environment/shard/concurrency rerun before accepting the failed segment. Do not silently patch unrelated fixtures or infer pass from an earlier unrelated run.
- Prevention rule: Inspect the actual database error detail and failing SQL before assigning product blame. Test identifiers constrained unique must not depend on tiny random suffixes. A proposed fixture correction is separate scope unless authorized.
- Reuse trigger: Unexpected unique-key failure during a large isolated DB test batch.
- Evidence: `/tmp/oversight-final4-verification/shard-2.log`, `blobs/shard-2.json`, `/tmp/oversight-final4-planqa-failure-diagnosis.md`. Rerun was pending when this entry was written.

### 2026-10-01 — validation event fixture must satisfy the durable schema before RED counts
- Date: 2026-10-01
- Task: Planning review qaType-only validation gate regression.
- What failed: Four initial tests stopped inserting workflow transition events because required `layer` was omitted.
- Root cause: The fixture mirrored reader-selected columns rather than the full insert contract.
- Category: verification-fixture / schema
- Fix: Read the table schema, add `layer: workflow`, and rerun unchanged production code; 13 meaningful regression failures confirmed before implementation.
- Prevention rule: Check required database insert fields before treating a test failure as product RED; preserve setup-failure and confirmed-RED logs separately.
- Reuse trigger: New durable-event reader integration fixtures.
- Evidence: `/tmp/qag/b-review-planning/red.log`, `/tmp/qag/b-review-planning/red-confirmed.log`, `/tmp/qag/b-review-planning/final.log`.

