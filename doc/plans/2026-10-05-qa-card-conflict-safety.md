# QA card conflict safety — 2026-10-05

## Goal and approved scope
Resolve the four findings in TASK-BRIEF.md plus the subsequently approved legacy-terminal reuse and language-preserving replay corrections. The later user approval extends delivery to a PR; the original worker-only no-PR limit is superseded. No merge or deployment.

## Final verification checkpoint
- Approved endpoint remains independently reviewed PR; no merge/deployment or generation/materiality redesign.
- Independent final re-review approves the exact source-scope guard with no remaining material blocker (`/tmp/qa-card-final-rereview.md`). This is source-review approval, not whole-suite approval.
- Prior full run: `pnpm test:run` exit1 (1054 files passed, 3 failed; 7931 tests passed, 2 failed, 12 skipped;1498.58s). Failed paths: `paqo-definition-identity-migration.test.ts` DB startup/hook timeout, `issues-service.test.ts` DB startup, `heartbeat-producer-lineage.test.ts` 10-second timeout. `/tmp/qa-card-final-tests.log`.
- Fresh final-source run: `pnpm exec vitest run packages/db/src/paqo-definition-identity-migration.test.ts server/src/__tests__/issues-service.test.ts server/src/__tests__/heartbeat-producer-lineage.test.ts server/src/__tests__/qa-source-defect*test.ts server/src/__tests__/qa-card-*test.ts ui/src/components/OperatorDecisionFacts.boundary.test.tsx --maxWorkers=1` →14 files/140 tests passed, no skips, exit0,93.81s (`/tmp/qa-card-closeout-tests.log`). This covers all three previously failing files and the final four-line guard.
- Fresh `pnpm -r typecheck` exit0 (`/tmp/qa-card-closeout-types.log`); `pnpm build` exit0 (`/tmp/qa-card-closeout-build.log`, UI chunk-size warning remains). `git diff --check` exit0. Source snapshot matches the independent reviewer fingerprints; only this report changed afterward.
- Failure attribution: DB setup failures occur before tested service actions. No evidence the QA card path ran at the heartbeat timeout; indirect imports and extra test-resource load remain possible. Sequential success does NOT prove a pre-existing defect or resource-contention root cause. No unrelated test code or timeout changed; no baseline reproduction claimed (`/tmp/qa-card-failure-attribution.md`).
- Delivery will be a draft PR with full-suite failure explicitly disclosed; complete full-suite/CI approval remains outstanding. No final whole-goal completion claim.

### Changes beyond the original four-item brief / implicit effects
- Explicitly approved follow-up: reuse known same-generation historical terminal decisions and preserve the original display language when company-language lookup recovers or changes. Exact full payload hashes still reject changed non-display inputs; unknown historical terminal payloads conflict.
- Supporting safety corrections: reconstruct the actual historical schema; recover interrupted legacy upgrades only from scoped schema-versioned machine cancellation receipts; perform stale cleanup on valid replay; verify company/sourceType/full sourceId before legacy cancellation. These keep existing shared writers/notifications and never use prose as execution authority.
- Overflow keys use a separate SHA-256 namespace. A raw source identity longer than200 UTF-16 units or an overflow-path identity changed by NFC normalization conflicts before DB writes. These constraints avoid collisions/cleanup mismatch, not a shared-validator change.
- Intended operational effects: matching pending legacy cards can be cancelled and replaced through the unchanged shared writer; human terminal choices are not reopened; a colliding unrelated source now conflicts without cancellation, cleanup, audits or continuation changes. No data/schema replacement, deployment, or shared-control changes.
- Truncation remains UTF-16-limit compatible and avoids splitting surrogate pairs; this supersedes the brief's code-point proposal. UI folding/preview limits remain200/120 units.

## Independent-review correction checkpoint
- Approved goal unchanged: four corrections plus two blockers, verified PR only after parent gates; no deployment.
- Current stage: three review corrections implemented and locally verified; independent re-review/full gates remain. Real historical terminal replay, interrupted/concurrent upgrade recovery and valid-replay stale cleanup now have regression coverage.
- This child: RED/GREEN against frozen Git-produced historical payloads and real disposable DB interruption/concurrency paths; QA-local helper/builder/tests only. Preserve all dirty work, shared writer root-commit publication, non-display conflicts and human terminal decisions.
- Lessons applied: historical fixtures must retain the real old contract; controlled overlap instead of timing guesses; serial embedded DB tests, zero skips; source typecheck does not cover tests.
- Evidence: `/tmp/qa-card-review-red-confirmed.log` (9 intended failures/6 passes, exit1) → `/tmp/qa-card-review-focused-final.log` (9 files/84 passed, zero skips, exit0). Server typecheck `/tmp/qa-card-review-typecheck-final2.log` exit0; source+two new test files `/tmp/qa-card-review-new-test-types-final.log` exit0. Builder remains428; helpers186/104/39 lines; new tests227/19. Report `/tmp/qa-card-review-fixes.md`.
- Parent retains independent re-review/full gates/PR. No commit/push/deploy. Supplemental check including the older resume suite exposes three unchanged seed-helper excess `companyId` properties; not fixed or counted as a passing all-tests type gate. Runtime focused tests all pass. Full suite/build/UI were not rerun by this child.

## Latest approval and execution checkpoint

User approved both reproduced blockers with “해”, followed by “Proceed”. This supersedes earlier approval-required/no-PR statements below. Target: implement, independently review, run full verification, and open PR; no deployment or merge.
- Required paths: legacy terminal same-generation replay; language lookup failure/recovery replay; unchanged non-display input conflict enforcement.
- Current stage: corrective implementation. Missing: desired-behavior regression RED/GREEN, independent review, fresh typecheck/full tests/build, PR.
- This iteration: change only QA card builder/cohesive helper and regression tests. Shared writer, validators, continuation, options, callers and runtime data excluded.
- Delegation: one execution-sensitive implementer, then an independent reviewer; native child model inherited (no unverified model identity claim). Controller verifies full gates and prepares PR.
- Evidence: previous 42 server + 4 UI focused assertions passed; diagnostic 3 tests demonstrated unsafe behavior, not safety. Fresh results required after changes.
- Checklist: [ ] two corrections + regression tests; [ ] independent review; [ ] full gates; [ ] PR.

## Resume checkpoint — 2026-10-05
Latest user instruction: proceed with remaining work; parent scope extends through a verified PR, with deployment requiring separate approval (supersedes earlier worker-local no-PR limit). Preserve all existing edits. Current stage: verification, not completion. Missing conditions: fresh focused/full-test result, independent review of terminal legacy-key replay and language-change conflicts, evidence-backed closeout. Delegate read-only execution-safety review; parent diagnoses owned test processes and runs bounded verification. No extra features, shared validators, workflow execution, deployment, or broad process termination. Evidence must include actual commands/exit status; partial tests are not whole-goal proof.

## Resume verification result — blocking findings
- Fresh server focused run: `pnpm exec vitest run server/src/__tests__/qa-source-defect*test.ts --maxWorkers=1`, 6 files / 42 passed, exit 0; `/tmp/qa-card-resume-focused.{log,exit}`. UI boundary: 1 file / 4 passed, exit 0; `/tmp/qa-card-resume-ui.{log,exit}`. These do not establish whole-goal safety.
- Independent read-only reviewer identified two blockers. DB diagnostic `server/src/__tests__/qa-card-resume-diagnostic.integration.test.ts` reproduces both: legacy resolved/cancelled same-generation cards each produce a NEW pending v2 card; English fallback then Korean language recovery yields request-key conflict. Diagnostic 3 tests passed with assertions of the unsafe behavior, NOT safety acceptance; `/tmp/qa-card-resume-diagnostic.{log,exit}`. Resolve/cancel uses shared writer; database is disposable embedded PostgreSQL. No live writes.
- Static consequence: loop-driver treats only created/replayed as card success, so conflict can fall through toward producer reset subject to caps/other conditions. Actual producer reset and duplicate continuation execution were NOT tested.
- PR/deployment paused. Proposed minimal extra behavior requires approval: preserve/reuse terminal same-generation legacy decisions; retain initial display language on same-generation replay while preserving detection of non-display input changes. Do not implement unconditional conflict replay or alter shared writer/validators/continuation. Exact design and concurrency behavior need review before implementation.
- Existing production changes preserved; this resume added only diagnostic test and plan evidence. Full gates not rerun while these correctness blockers remain. No process termination was needed: a fresh process inspection showed no active Vitest processes before the diagnostic/focused runs.

## Authoritative scope decision
The user chose to keep shared validators OUT OF SCOPE. Limits remain UTF-16 code units, not code points: return the longest prefix of at most N units, excluding a surrogate pair if the boundary would split it. UI folding remains `length > 200`, with a safe 120-unit preview. This supersedes the original brief's code-point proposal and preserves the existing shared write contract.

## Invariants and impact path
Card builder → existing operator-decision write/replay → existing supersede cancellation and continuation. Request hash includes display text; cancelled rows still occupy request keys. Version v2 avoids legacy-key hash conflicts. Preserve option IDs, outcomes, sourceId supersede LIKE condition, promotion, continuation, raw submitted findings and prose (except truncation). Do not modify shared write service, callers, or execution control.

`rg 'qa-source-defect:' server ui packages` found runtime key construction only in the builder; other occurrences are a test literal and descriptive supervision comment. No runtime format parser was found. Real PostgreSQL legacy-pending/cancel/create/replay tests provide DB-facing impact proof, not execution proof.

## Stages / delegation / completion conditions
1. [x] Confirm approved scope and UTF-16 decision; inspect clean branch/worktrees (only pre-existing untracked TASK-BRIEF.md).
2. [x] Delegate isolated server implementation/tests to inherited-model child; parent owns UI/docs. Child explicitly instructed on scope, invariants, RED/GREEN, 441-line no-growth restriction, no commits.
3. [x] Complete all four fixes with failing regression tests before production changes; no unrelated refactoring.
4. [ ] Focused server/UI checks; full `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`; inspect diff and line limits.
5. [ ] Logical local commits and five-section Korean report. No PR/deploy.

Current stage: final whole-gate verification and logical commits. Approved repairs, focused RED/GREEN and independent review are complete; remaining conditions are full-gate exit markers, failure isolation and same-base comparison if failures remain, evidence recording and logical commits. Do not rerun the still-running whole suite or broaden production changes. User approved option 1: reject complete `${run}:${producer}:${iteration}` identities longer than 200 UTF-16 units with `outcome: failed` and a diagnostic before any supersede/cancel/write. Hash replacement is allowed only within the 200-unit source identity contract; the readable request-key allowance is 160 units. Source storage, supersede LIKE, cleanup, callers, and shared validators remain unchanged. Remaining conditions: real DB boundary RED/GREEN, fresh whole gates, independent review, logical commits. Previous detached root test ended with exit 137 (cause not confirmed); rerun final snapshot, do not claim success.

## Evidence
- Server RED `/tmp/qa-card-server-red.log`: legacy key conflict, uncaught language failure, surrogate splits and old-key assertions failed.
- Server GREEN `/tmp/qa-card-server-final.log`: `pnpm exec vitest run server/src/__tests__/qa-source-defect*test.ts --maxWorkers=1`, 5 files / 32 tests, exit 0, no skips.
- Server source reduced 441 → 439 lines. New safety test 106 lines.
- UI RED `/tmp/qa-card-ui-red.log`: preview contained a lone high surrogate (1 failed / 3 passed). GREEN `/tmp/qa-card-ui-green.log`: 1 file / 4 passed, exit 0.
- `pnpm -r typecheck` exit 0 and `pnpm build` exit 0: `/tmp/qa-card-safety-gates/{typecheck,build}.{log,exit}`.
- `pnpm test:run` launched in background; `/tmp/qa-card-safety-gates/test.log`, completion marker `test.exit`. Not yet complete at this checkpoint. Do not interpret interim output as success.
- `git diff --check` exit 0; source 439 lines / new server test 106 lines.

## Newly confirmed blocker — approval required
Independent review found that adding `v2:` grows the request key by 3 units. A 36-unit UUID run ID, iteration 0 and ASCII producer ID of length 102/103/104 produce old keys of 158/159/160 and new keys of 161/162/163. All workflow step definitions and old-key card payloads validate. Real PostgreSQL diagnostics confirm all three: legacy pending card cancelled, v2 create rejected solely for requestKey >160, outcome failed, zero pending cards. Evidence `/tmp/qa-card-key-length-proof.log`; diagnostic source `/tmp/qa-card-key-length-proof.test.ts` (temporary repo test removed). This is a reproduced defect, not a passing safety gate.

Exact v2 format, shared validators excluded, and unchanged execution ordering cannot jointly handle these previously valid IDs. No unauthorized fix applied. Recommend approving a deterministic digest for overlength producer IDs in the versioned request key (not raw truncation, which could collide); alternatively approve a wider shared limit. Both change the approved boundary and require fresh regression tests. The user approved the bounded fallback on 2026-10-05 with these conditions: preserve readable keys within 160 units; only overflow uses a deterministic pure hash replacement of producer step ID; preserve the shared builder at both creation sites; document the format; regress two distinct long IDs for distinct bounded keys and same-generation replay.

## Approved key overflow repair
Current stage: resolve the confirmed cancellation/create blocker with RED → GREEN, then rerun final gates and review. Parent delegates server builder and focused regression tests; parent owns docs and whole-gate evidence. No shared-validator/caller/control changes. Format for normal keys remains `qa-source-defect:v2:{run}:{producer}:{iteration}`. When that key exceeds 160 UTF-16 units, the full format becomes `qa-source-defect-sha256:v2:{run}:{64 lowercase hex SHA-256 digits of the full producer ID}:{iteration}`. The distinct outer prefix prevents collisions with readable producer IDs literally named `sha256-{digest}`. Preserve run/iteration/version. Use Node built-in crypto; no dependency, mutable state, or truncation of producer identity. Full SHA-256 sharply minimizes collision risk but no fixed-length hash mathematically guarantees collision-free arbitrary input; do not claim that stronger property.

Required evidence: two distinct valid long step IDs → distinct keys <=160, real DB creates and same-generation replay; readable <=160 boundary stays unchanged, deterministic rebuild. Full gates must reflect final code, not earlier pre-repair snapshots.

### Overflow and namespace evidence
- Initial overflow RED `/tmp/qa-card-overflow-red.log`: 2 failed / 34 passed; GREEN `/tmp/qa-card-overflow-green.log`: 6 files / 36 passed.
- Review found a namespace collision between long producer `p×102` and short literal `sha256-{digest}` under the initial fallback. Fixed within the approved deterministic fallback by using a distinct outer prefix, keeping all readable keys unchanged.
- Namespace RED `/tmp/qa-card-namespace-red.log`: 2 failed / 4 passed, including real DB conflict. GREEN `/tmp/qa-card-namespace-green.log`: 6 files / 38 passed, zero skips, exit 0. Both long/short cards now created separately and replayed.
- Source remains 441 lines. Final overflow test remains below 300 lines.
- Initial root run before hash repair: exit 1, 1052 files passed / 1 failed; 7890 passed / 1 failed / 2 skipped. Failure `heartbeat-producer-lineage.test.ts` overlong ancestry timed out at 10s. Log `/tmp/qa-card-safety-gates/test.log`. This does not prove it unrelated and is not a final-code gate.
- A synchronous final gate attempt timed out at the tool level after 200s during typecheck (no completion marker). Restarted gates detached, PID20902; `/tmp/qa-card-final-gates/`. That run began before namespace repair; check timing and rerun final-code gates as needed. No broad process termination or silent failure attribution.

## Final review blocker — source identity overflow (approval required)
- Diagnostic command: `pnpm exec vitest run server/src/__tests__/qa-card-sourceid-proof.integration.test.ts --maxWorkers=1`; `/tmp/qa-card-sourceid-proof.log`, exit marker 0. Temporary diagnostic removed after capture. The test passing confirms unsafe behavior, not product correctness.
- Real PostgreSQL: schema-valid ASCII producer ID length 164, UUID run length 36; full sourceId length 203 is stored truncated to 200. Both iteration 0 and 1 return created with bounded distinct request keys (130 each), but both cards remain pending with identical sourceId, and the unchanged full-producer supersede LIKE matches zero rows.
- After marking the workflow run completed, existing cancellation reconciliation returns `{ cancelled: 0 }`; both cards remain pending. No source/caller/control fix applied because supersede and cleanup semantics are explicitly excluded.
- The prior unhashed key was 220 units and could not create these cards. Hash fallback therefore opens this formerly rejected input path. Existing 102-unit overflow regressions do not exercise this boundary.
- Recommended scope decision: bound fallback to identities whose complete sourceId fits the existing 200-unit contract (fail closed otherwise), or explicitly approve durable structured identity and matching/cleanup changes for arbitrary long IDs. The latter is larger execution-control work and requires new DB-facing lifecycle tests. Do not silently expand scope.
- Detached final gate build exit 0; typecheck completed before final namespace edit and is not final-snapshot proof. Root test still running at this checkpoint. No commits/PR/deployment.

## Approved source-length repair and new Unicode blocker
- Implemented named request-key hash replacement allowance 160 and source identity rejection threshold 200. Complete raw identity >200 returns failed diagnostic before all DB work; source storage/search/cleanup unchanged. Source 440 lines (no growth over 441).
- Boundary RED `/tmp/qa-card-source-boundary-red.log`: raw sourceId201 incorrectly created (1 failed / 7 passed). GREEN `/tmp/qa-card-source-boundary-green.log`: 6 files / 40 passed, no skips. Real DB sourceId200 creates hashed card, supersedes and replays; 201 preserves existing rows unchanged.
- Independent review found Unicode NFC normalization mismatch newly admitted by hashing. Real PostgreSQL diagnostic `/tmp/qa-card-nfc-proof.log`, 2 unsafe-state tests passed, `EXIT_CODE=0`; temporary test removed, production unchanged by reviewer.
- Producer `('e\\u0301').repeat(60)`: raw source159 → persisted NFC99; iterations0/1 both created and both pending; producer iteration2 completed + QA passed cleanup cancelled0. Raw supersede/search identity no longer matches persisted identity.
- Producer `'\\u0344'.repeat(102)`: raw source141 → NFC243. Matching raw stale card cancelled before replacement fails shared sourceId/title validation. This is not a safe completion.
- User approved minimum NFC extension: only in overflow hash path (readable request key >160), reject with diagnostic before DB work when complete raw source identity differs from `.normalize("NFC")`. No line-ending expansion, storage/LIKE/cleanup/shared-validator changes. Current stage: implement NFC shrink/expand RED→GREEN and normal short/long NFC-stable DB regressions, then fresh full gates, failure isolation/base proof if needed, independent review and logical commits.
- Readable <=160 path normalization vulnerability is a pre-existing separate shared-storage task; record only, explicitly OUT OF SCOPE. This repair does not claim to fix that path.
- NFC repair RED `/tmp/qa-card-nfc-red.log`: 2 failed / 8 passed; GREEN `/tmp/qa-card-nfc-green.log`: 6 files / 42 passed, no skips. Both NFC shrink/expand now fail with diagnostic and preserve matching stale rows. Normal short IDs remain covered by title/safety/integration tests; long NFC-stable ASCII IDs create/replay in overflow tests. Source441 (no growth), new tests190/106 (<300).
- Fresh UI `/tmp/qa-card-nfc-ui-green.log`: 1 file / 4 passed, exit0. Independent final read-only review found no in-scope blocker and verified guard matches readable key construction. Fresh full gates PID64910 `/tmp/qa-card-nfc-final-gates/` running; completion markers must be inspected before committing.

## Latest full-gate evidence and incomplete gate
- Final snapshot `pnpm -r typecheck`: exit0, `/tmp/qa-card-nfc-final-gates/typecheck.{log,exit}`.
- Final snapshot independent `pnpm build`: exit0, `/tmp/qa-card-nfc-build-independent.{log,exit}`; only bundle-size warnings. Executed separately because the queued build was blocked behind the stalled test. The original launcher also starts its scheduled build after test termination.
- Root `pnpm test:run` ran about55min with1033 file result lines, then no log progress for about18min and zero-CPU parent/workers. No final summary. Sent TERM only to owned Vitest parent75059; actual `test.exit`143. This is an incomplete gate, NOT full-suite success. No unrelated processes killed.
- Observed failures: `heartbeat-producer-lineage.test.ts` overlong ancestry10s timeout; `packages/adapters/pi-local/src/server/operator-interrupt.test.ts` unavailable-stdin retry assertion. Final failed-file/error summary unavailable because suite stalled.
- Lineage isolated current:1failed/1passed, `/tmp/qa-card-nfc-lineage-isolated.{log,exit}`. Exported baseline c7a091cc same command `pnpm exec vitest run server/src/__tests__/heartbeat-producer-lineage.test.ts --maxWorkers=1`:same10s timeout1failed/1passed, `/tmp/qa-card-nfc-lineage-base.{log,exit}`. Interrupt isolated current and baseline:8passed each, `/tmp/qa-card-nfc-interrupt-{isolated,base}.{log,exit}`. These comparisons do not establish the root failure cause or whole-suite safety.
- Baseline export location recorded in `/tmp/qa-card-nfc-base.path`. It used directory-level node_modules symlinks; LESSONS warns this can resolve current workspace packages. Must verify/repair exported workspace resolution before treating baseline as authoritative (even though db/shared packages were not modified here). Do not claim conclusively unrelated without that check.
- Remaining: inspect original build marker, strengthen baseline resolution proof, record incomplete-root limitation and decide logical commits/report without claiming all gates pass. No production changes needed based on current evidence.

## Residual risk / unverified
If language lookup fails while writes succeed, an English card may conflict on a later same-version retry when the company language becomes available. Versioning addresses template changes, not changing language within a generation. No live deployment or browser visual proof is claimed. Title/sourceId emoji DB boundary cases cannot pass the existing ASCII/160-unit request-key contract; their safe truncation remains subject to code review, while persisted fact/evidence/body boundaries are exercised.
