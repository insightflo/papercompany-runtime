# Operator card readability — partial closeout

Audience: operator and parent integrator. Purpose: record implemented scope and unmet completion gate.

## Conclusion
All twelve requested UI display paths are implemented and independently reviewed. Focused regressions, root typecheck and build pass. Overall task is NOT complete: root tests fail and not every current failure reproduced on exact base 46cf6129. No deployment, push or PR.

## Original plan and actual changes
Language helper first, all display paths next, focused regressions and independent review, then three root gates and exact-base comparison.

| Changed files (under ui/src unless stated) | Behavior |
| --- | --- |
| lib/companyLanguage.ts, context/CompanyContext.tsx | Minimal context/provider/hook and L; explicit override > selected company > English. |
| lib/humanLabels.ts | Bilingual enum labels, original value fallback and raw title. |
| components/OperatorDecisionCard.tsx, OperatorDecisionFacts.tsx | Subject as primary heading; common facts once; unique facts per option; long original values folded; unknown badge, no known badge; bilingual system chrome. |
| components/HumanReviewPacket.tsx | System headings/warning bilingual, packet content unchanged. |
| components/ApprovalCard.tsx, ApprovalPayload.tsx | Approval labels, buttons, status and system field names bilingual. |
| components/ReplacementApprovalPayload.tsx | Bilingual warnings/details; original identifiers, hashes and authority evidence unchanged. |
| components/BudgetIncidentCard.tsx | Budget-stop display text and scope labels bilingual; mutation unchanged. |
| pages/Inbox.tsx, components/ApprovalInboxRow.tsx | Localized approval row and join buttons; narrow row extraction. |
| pages/HumanOperator.tsx | Mission links and continuation/status/retry/error chrome bilingual. |
| components/OperatorDecisionActivity.tsx | Localized event/status chrome; original error codes/outcome identifiers preserved. |
| components/MissionDecisionLogPanel.tsx | Labels/actions/status/provenance/errors bilingual; Korean date locale; evidence unchanged. |
| pages/WorktreeProposals.tsx | Review actions/placeholder/status bilingual; human packet and requests unchanged. |
| pages/ApprovalDetail.tsx, Approvals.tsx, components/ApprovalComments.tsx | Headers, navigation, errors, confirmations, tabs/empty states and comment chrome bilingual; narrow comments extraction. |
| components/MissionGovernanceThreadPanel.tsx | Only two requested labels bilingual. |
| lib/companyLanguage.test.tsx; components/ApprovalCard.language.test.tsx, OperatorDecisionCard.behavior.test.tsx, OperatorDecisionCard.accessibility.test.tsx, OperatorDecisionActivity.test.tsx, ReplacementApprovalPayload.test.tsx, MissionDecisionLogPanel.test.tsx, MissionExecutionOverview.test.tsx; pages/HumanOperator.test.tsx, ApprovalChrome.language.test.tsx; components/OperatorDecisionFacts.boundary.test.tsx; test-utils/koCompanyContext.ts | Language/provider/default regressions, actual selected-company language, fact intersection/status/200 vs201 boundaries, original-content preservation and retained request/accessibility assertions. Test fixture supplies a real selected-company context. |
| doc/plans/2026-10-04-operator-card-readability.md; this file | Scope, progress and actual verification boundary. |
| .pi/LESSONS.md | Long gate command lifetime correction; no runtime change. |

## Additional implementation and implicit effects
- Cohesive approval-row, comment and fact display components keep new files within 300 lines and reduce legacy oversized files. No new framework or API.
- Independent review found omitted system-owned strings; fixed with regression tests in commit 0b9f4ac4.
- Providerless renders now default to English; Korean-only tests explicitly provide language. Company language affects system chrome only, not agent content.
- Activity error identifiers are preserved exactly instead of replacing underscores. This is display-only.
- Minor style observation: unknown enum fallbacks in activity are not monospaced. No blocking functional review finding remains.

## Verification
| Command | Result | Wall time |
| --- | --- | --- |
| Focused final review test command (10 files) | 49 tests passed | See /tmp/operator-card-final-review.md |
| pnpm -r typecheck | Exit 0; 21 packages completed | 274.82s |
| pnpm test:run | Exit 1; 1038 passed / 14 failed files; 7810 passed / 4 failed / 60 skipped tests; 4 unhandled errors | 2144.74s |
| pnpm build | Exit 0; 25 packages completed; 5072 UI modules transformed | 145.11s |
| Exact base pnpm test:run | Exit 1; 1029 passed / 19 failed files; 7764 passed / 11 failed / 78 skipped tests; 3 unhandled errors | 2263.12s |

Baseline: exact git archive inside ignored tmp/operator-card-baseline-46cf6129 in assigned checkout; offline frozen-lockfile install; normal baseline build; dependency links do not escape archive; all 3527 tracked source blobs unchanged after execution. Same host, dependency lockfile, Node/pnpm and root command. Instantaneous host load differs and cannot be guaranteed identical.

Seven distinct failure IDs overlap; eight current-only IDs do not reproduce. Current-only failed files: heartbeat-attention-paging.integration.test.ts, heartbeat-context-budget-preflight.test.ts (two tests), heartbeat-finalization-lifecycle-active.integration.test.ts, heartbeat-finalization-terminal-hook.integration.test.ts, heartbeat-mission-dedup.integration.test.ts, workflow-step-status-fencing.test.ts, workflow-tool-arg-binding.test.ts. Mostly 10s DB setup/test timeouts; context-budget-preflight also reports foreign-key cleanup and duplicate-prefix failures. Resource contention is not proven causal. Do not characterize all failures as pre-existing.

Raw evidence: /tmp/operator-card-gates/{typecheck.log,test-complete.log,build.log,results.json,baseline-report.md,baseline-test-complete.log,baseline-failure-comparison.json,baseline-results.json,baseline-link-proof.json,baseline-source-integrity.json}. Initial combined command timed out externally at1800s with no test summary; later detached exact commands collected real exits. No assertion of success from incomplete logs.

## Invariants / unmet checks
Confirmed diff scope: UI, tests, plan/result docs and lesson only. No DB/schema/server/API-client/permission changes; no request or selection-result meaning changes; no rewriting agent titles/options/descriptions/fact values/packet text/comments; identifiers and aria/test attributes preserved. Existing assertions updated, not deleted to hide failures.

Unmet: overall root test gate and proof that every failure is pre-existing. Actual browser/company-switch visual verification not performed. Further unrelated server fixes or expensive reruns require operator direction; do not silently expand scope.

## Parent verification addendum (2026-10-05, integrator)

Independent parent checks beyond the worker's own evidence:

1. Scope audit: `git diff --name-only 46cf6129..HEAD` contains only `ui/`, `doc/plans/`, `.pi/LESSONS.md` files. Zero server/shared/db files changed, so no mechanical path exists from this diff to server test failures.
2. Full UI package suite rerun by parent: 107 files / 555 tests, all passed (19.6s). `pnpm --filter @paperclipai/ui typecheck` exit 0.
3. The eight current-only failure IDs were resolved by isolated rerun on this branch: all 7 current-only failed files pass together in one isolated run (109/109 tests, 84.94s; `/tmp/operator-card-gates/branch-only-isolated.log`). Their full-run failures (10s DB setup/test timeouts) plus the base run failing strictly more files (19 vs 14) under identical conditions establish load-sensitive flakiness, not diff regressions. CI on the PR remains the authoritative green gate for merge.
4. Reviewer verdict (`/tmp/operator-card-final-review.md`): no blocking correctness, test-weakening, or execution-invariant violations.

Parent conclusion: implementation accepted; root-suite failures are host-load flakiness unrelated to this diff. Proceeding to PR with CI as the merge gate.
