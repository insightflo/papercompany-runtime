# Runtime QA genericization — Phase A

## Approved scope
- Goal: company/process-agnostic artifact pipeline and three-layer QA engine, preserving legacy in-flight reads and configured publication identity/date checks.
- Full path: tool contract → frozen attempt policy → bound input bytes → machine result → receipt → consumer → publication verification/readback.
- Excluded: planning/delivery keyword gates, heartbeat finalization, external tool repositories, operational DB migration, deploy, push/PR and other worktrees. No handoff tool calls on this resume.

## Completion checklist (2026-10-01)
- [x] Neutral test-only legacy fixtures; generic shared contract/result/receipt/config validation.
- [x] Contract-driven request, byte transport, deployment hashing, receipt and consumer.
- [x] Mandatory + preset + step rules; frozen contract/config hashes and current-attempt checks.
- [x] Board-only policy edits, strict save validation, locked authorization and activity audit.
- [x] Declarative publication identity/date; publication-verify consumes declared publication-result argument, not a QA receipt.
- [x] Role-aware DAG completion and result path resolution; generic and legacy-QA local DB end-to-end tests.
- [x] Generic docs/example; legacy values exported only outside repository.
- [x] Independent review; full typecheck/test/build; remaining literal inventory.
- [ ] Exact operational verifier contract: unavailable in local evidence. External export explicitly leaves it null/not migration-ready; no invented operational schema. Runtime implementation is verified with declared test producers, not the deployed tool.

## Execution and delegation
Existing dirty changes were the user-approved starting point on `feat/qa-genericization`, base `41fa24b`. Isolated children handled publication verification, DAG/path integration, mandatory/network safety, publisher declaration validation, independent reviews and full-gate runs. Parent integrated fixtures, schema changes, docs, local commits and report. All remained within this worktree and local temporary databases.

Authority remains structured: company-scoped frozen definitions, step/request/generation/retry/iteration, official output bindings, machine-result bytes and durable metadata. No prose/stdout authority. Preserve CAS, dispatch locks, bounded retry and queue semantics. Missing declarations fail closed, not name-based fallback.

## Evidence
- Publication verifier: 5 focused files / 84 tests; `/tmp/qag-publication-verify-final.log`.
- DAG/result-path integration: RED 7 failures, final 6 files / 61 tests; `/tmp/qag/integration-{red,final}.log`. Includes executor → completion → path resolution → verification → completed run with local test producers.
- Auth/freeze: locked-row agent rejection, board audit, frozen policy through edits/retry/failure; `/tmp/qag-auth-race-green.log`, `/tmp/qag-auth-freeze-final.log`.
- Safety/readback: RED internal-path/script/network cases; 12 files / 148 tests; `/tmp/qag/qa-safety-focused-final.log`.
- Publisher declaration: RED missing date declarations; 3 files / 62 tests; `/tmp/qag/publication-declaration-green.log`.
- First default full suite terminated (143); first serial suite failed 3 files, which passed isolated. Do not substitute those partial results for completion.
- Corrected test fixture clock, environment cleanup/diagnostics and DB client cleanup; 34 focused tests passed. CU transient 401 and initial PG startup timeout root causes remain unproven.
- Fresh final full gates, after waiting for competing Vitest processes: typecheck exit0; **991 files passed, 7,468 tests passed, 2 expected skips, 0 failures**; build exit0. No unexpected DB skips. `/tmp/qag/final-gates-summary.md` and `final-{typecheck,test,build}.log`.
- Final independent review found no further concrete blocker. Source hashes unchanged during full gates. `git diff --check` passed.
- Requested grep: 23 remaining lines, all in explicitly excluded planning/delivery files; `/tmp/qag/remaining-hits.txt`.

## Non-obvious changes / safety additions
- Contract tools bypass generic cache; qaConfig without a declaration fails. Frozen QA requires receipt even without optional step marker.
- Publication completion and consumers verify stored bytes/current attempt; completion uses current-request/running CAS.
- Executable inline scripts/event handlers and all iframes are conservatively rejected. JSON data scripts remain allowed.
- Readback/reachability use pinned public HTTPS, reject redirects/credentials/private ranges, and bound time/body/link counts. Reverification may perform network checks again.
- Incomplete publisher identity/date/timestamp declarations are rejected, including invalid frozen declarations. Legacy optional date arguments remain supported.
- Test-only full-gate stabilization is additional scope: deterministic continuation time, CU env restoration/error detail, DB client cleanup and fixture deduplication. Production auth/heartbeat/queue behavior unchanged.

## Delivery
Keep branch/worktree; local conventional commits only, no push. Final report: `/tmp/qag/phase-a-report.md`. Operational export: `/tmp/qag/mo-artifact-contracts.json`; confirm actual verifier format and multi-command tool role before any future migration. No deployment or complete operational migration claim.
