# Generic stale producer rebind implementation

## Approved scope / completion gates
- Goal: generation-only same-run consumer mismatches recover without role/step branches; new producer registrations seal disk bytes.
- Preserve late-write fences, generation increments, promotion authority, #338 filters/claims. No deployment, live DB, push, or original checkout writes.
- Read-only design: sibling artifacts plan dated 2026-10-07; user prompt supersedes its unapproved status.
- Current stage: local implementation and verification complete; finishing the documentation commit. Runtime deployment/readback is outside the approved scope.
- Continuation owner: PID 30433. The previous PID 27463 exited; no other Pi implementation process remained when continuing. Preserve the historical blocker record below.
- Work directly in fix/generic-stale-producer-rebind; no delegation (user requirement).

## Execution authority and lock decision
DB workflowProducer + heartbeat admission proof + current step attempt + local disk bytes are authority; text is not.
Choose (b): read-only selector signals a typed generation-only recovery request. At the outer consumer transaction boundary rollback first, issue using mission -> run -> all sorted steps -> product UPDATE locks, then rerun validation/consumer transaction. Root selectors use the same retry entry; nested transactions only propagate the typed signal, never issue while locks are held. Track each requested product once per operation (no infinite retries).

| Caller | Existing context | Retry boundary |
| --- | --- | --- |
| qa-artifact-request | Core executor, no transaction/row locks at selection | root selector |
| qa-artifact-consumer | Core executor, no transaction/row locks at selection | root selector |
| workflow-output-binding | Seed path: transaction, mission/run/referenced+consumer steps UPDATE | pin transaction boundary |
| tool-step-args | withSelectedInputTransaction: mission/run/producer+consumer steps UPDATE | selected-input transaction boundary |
| seed-interpreted-inputs | admission or materialization transaction; can render tool args without consumer pin | outer admission/materialization boundary; preserve typed request through error translation |
| workflow-seed-admission | nested inside createAdmittedWorkflowRun; target mission UPDATE, source run/step/products SHARE | outer admitted-run creation boundary |
| workflow-seed-evidence (additional transitive consumer) | seed materialization holds target run lock; may traverse other missions | outer step materialization boundary |

## Checklist / evidence
- [x] Frozen install, clean branch/worktree, required docs and lessons read.
- [x] Six callers plus seed-evidence transitive caller examined; do not upgrade SHARE under existing product/target locks.
- [x] RED: auto-red.log recorded 13 missing-behavior failures; inherited seal-red.log recorded absent seals/authority protection. A cancelled-wake fixture incorrectly expected rejection; use the actually prohibited coalesced proof.
- [x] GREEN: common proof issuer, typed root-only rollback/retry, paired producer seals; board/promotion/#338/write-fence contracts preserved.
- [x] Regression: related-final.log: 30 files / 244 tests passed, covering all eight requested categories, promotion, #338, stale writes, terminal stamping, seeds, locks, and proof changes while waiting.
- [x] Full gates separately: typecheck-final.exit=0; full-test.exit=0 (1090 files, 8173 passed, 2 unchanged existing skips, 2044.26s); build.exit=0. New boundary file added after full-suite discovery also passed in new-final.log (53 new tests). Logs/exit files: ~/.cache/generic-stale-producer-rebind/.
- Build emitted the existing large-chunk warning; full tests emitted React act-environment warnings. No new test skips, deleted tests, live DB checks, or deploys.
- [x] Supplemental TypeScript check of new tests: new-tests-typecheck-final.log, exit 0 (normal server tsconfig excludes tests).
- [x] Direct specification/correctness review: proof preserved, root lock boundaries verified, return shape unchanged, original stamp/fences and #338 unchanged; git diff --check passed. User prohibits delegation; no independent-review claim.
- [x] Implementation commits: 16b3f3f6 (production seals), f6071e50 (generic automatic recovery); documentation/lessons form the third logical commit. Preserve inherited `.superpowers/` and alternate implementation-plan file untracked; no push or merge.

## Final scope
All eight required regression categories pass in isolated databases. Typecheck, full discovered test suite, and build pass. No live-runtime outcome, independent review, deployment, push, or original-checkout change is claimed. Legacy issuance-time byte limitations and older-validator rollback compatibility remain operational risks described in doc/operations/workproduct-producer-rebind.md.

## Additional safety and non-visible behavior
- Root transaction detection and typed-error propagation avoid savepoint lock-order inversions; one recovery/product and a 32-product budget prevent unbounded restarts.
- Selection is rechecked under parent/product UPDATE locks before issuance.
- New seals must be paired and come from readable stable regular files; reject final symlinks and never downgrade a failed seal to legacy absence.
- Ordinary metadata patches preserve DB-issued authority; genuine registration/restamp clears obsolete markers. Inherited same-task sealing changes were preserved and directly verified; no worker was dispatched in this continuation.
- Issuance commits before the retried consumer: later errors can leave a valid marker/event while the failed consumer writes roll back.
- Legacy baseline remains issuance-time bytes; older strict validators cannot read newly sealed producers after rollback.

## Lessons applied
- Full gates must run separately with sufficient lifetime; timeout is not PASS (.pi/LESSONS.md 2026-10-05).
- Real admission writer + atomic claim for producer proof; no fabricated wake/metadata authority.
- Setup failures are not product RED; distinguish missing required DB fields.
- No source-text-only regression tests; verify durable rows and bytes in isolated embedded DB.

## Ownership blocker / verification evidence (2026-10-07)
- This process is Pi PID 27463; concurrent Pi PID 30433 (parent 30432) was launched at 15:11:57 in the same worktree and SAME session file `/tmp/sol-impl/s3/2026-10-07T06-10-07-006Z_01a114fb-c61e-729e-8b5a-b1c21ec5adda.jsonl`. I did not spawn it.
- Initial git status was clean. During investigation, another implementation plan, `.superpowers/`, and producer-seal test files appeared. Do not delete, stage, stash, overwrite, or claim them as this process's work. Do not terminate the other process without permission.
- Only this plan file was authored by this process; no production code, tests, commits, live DB, deployment, push, or original checkout edits.
- `pnpm install --frozen-lockfile`: exit 0, plugin SDK dist/bin warnings.
- Three-file baseline command: exit 1, run-terminal-generation-stamp beforeAll hit default 10s timeout and teardown then failed. `baseline.log` was concurrently overwritten/interleaved: do not use its totals as exclusive evidence.
- Separate unique log: `pnpm test:run server/src/__tests__/run-terminal-generation-stamp.test.ts --maxWorkers=1 --hookTimeout=60000`: exit 0, 1 file / 4 tests PASS in 9.74s. Log: `~/.cache/generic-stale-producer-rebind/baseline-generation-serial.log`.
- Full typecheck/test/build not run; implementation and TDD RED/GREEN not reached.
- Resume only after one active owner is selected and current diff/plan is reconciled. Use process-unique log paths, not a shared task-only filename.

### Failure learning (not appended to shared LESSONS.md while another writer is active)
- Date: 2026-10-07
- Task: Generic stale producer rebind baseline verification.
- What failed: Parallel baseline DB startup exceeded 10s setup timeout; two processes also wrote the same task log.
- Root cause: Test retains default hook timeout; confirmed setup bottleneck, not feature failure. Concurrent session/worktree owner made shared log non-exclusive.
- Category: Verification environment / ownership.
- Fix: Single-worker baseline with 60s hook timeout passed; stopped before shared code edits on detecting the second live owner.
- Prevention rule: Check live owner as well as git status; use PID/session-unique evidence paths and explicit DB setup timeout. No completion claims from mixed logs.
- Reuse trigger: Resuming a possibly still-running Pi session or running embedded DB regressions.
