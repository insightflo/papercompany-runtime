# Operator card readability implementation plan

> **For agentic workers:** Use subagent-driven-development for implementation and independent review. Track checkboxes below.

**Goal:** Implement every display-only requirement in TASK-BRIEF.md for all twelve card forms, using company.defaultLanguage (en/ko).
**Architecture:** A minimal company language context and bilingual label helper feed existing cards. Structured facts are deduplicated for display only; original content and execution contracts remain unchanged.
**Tech Stack:** React, TypeScript, Vitest, pnpm.
**Spec:** TASK-BRIEF.md (approved and binding).

## Global constraints
- Display layer only; no server, API, schema, authorization, outcome or continuation changes.
- Preserve agent-authored title/labels/descriptions/packet content/fact values and replacement evidence identifiers.
- Preserve aria/test-id attributes and existing assertions (update language setup, do not delete assertions).
- New files <=300 lines; oversized existing files must not grow. Extract narrowly cohesive display helpers if necessary.
- Work only in this worktree; no deploy, push, PR or unrelated cleanup. Preserve untracked TASK-BRIEF.md.
- English fallback without providers; explicit language override > selected company > English.

## Global progress
Current stage: verification blocked / partial closeout. Implementation and independent review are complete. Typecheck and build pass; root test gate fails and exact-base execution does not reproduce all current failures. No unrelated server fixes or further blind reruns. Completion is NOT claimed.
This stage closes: language helper, all 12 specified display paths and focused regressions. Does not close: independent review, root typecheck/test/build, runtime deployment or producer content quality.
Evidence: `/tmp/operator-card-red.log` (2 behavioral failures before production edits); `/tmp/operator-card-final-focused.log` (11 files / 44 tests passed, 5.18s); `/tmp/operator-card-final-regressions.log` (16 tests passed after final assertion strengthening); `/tmp/operator-card-final-typecheck.log` (UI typecheck exit 0). Scope audit: only UI and this plan changed; new files <=300 lines; oversized files reduced. No spawn/push/deploy/PR in Task 1.
Verification correction: invoking Vitest without a path filter accidentally discovered root tests; it timed out at 120s and is NOT a root-suite pass. Subsequent commands explicitly specify UI paths. Broad UI check was diagnostic (540/542 passed before a second partial-mock fix); final scoped gates pass. Details in `/tmp/operator-card-implementation-report.md`.
Lessons: fixture setup failures are not product RED; full-suite isolated reruns are not full-suite success; baseline workspace resolution must point to baseline packages.

## Delegation / tasks
- [x] Task 1: Implement language infrastructure and all twelve card display paths, with focused regressions. Single implementation worker owns UI files and related tests to avoid shared-file conflicts. Worker reads TASK-BRIEF.md fully and writes report including RED/GREEN commands. Use `resolveCompanyLanguage`, `CompanyLanguageProvider`, `useCompanyLanguage`, `L` exactly as specified; use bilingual humanLabels with raw fallback. Test English/default and Korean cards, common facts once, long fact preservation, known/unknown distinction. Commit logical units using feat(ui) style.
- [x] Task 2: Independent spec and quality review of Task 1 diff against base 46cf6129. Separate reviewer reports file/line findings, unchanged content/requests evidence and test gaps. Fix confirmed in-scope issues with covering tests, then scoped re-review.
- [ ] Task 3: Run `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`, recording exit code, duration, output and counts. Any failure requires diagnosis; unrelated failures require identical-condition base 46cf6129 proof. No scope-expanding fixes.
- [x] Task 4: Final audit and Korean partial closeout: plan, files/behavior, additions/reasons, implicit operating effects, verified/unverified conditions and command summaries. No claim of completion unless all gates satisfied.

Task 2 fix evidence: `/tmp/operator-card-fix-red.log` reproduced card/log omissions; `/tmp/operator-card-fix-page-red.log` reproduced all five approval-page regressions after fixing a missing Sidebar test dependency. Final `/tmp/operator-card-fix-final.log`: 10 files / 49 tests passed (6.98s); UI-only typecheck passed (`/tmp/operator-card-fix-typecheck.log`); `git diff --check` passed. SelectedCompany ko card cases, requester roles, exact status/all-option intersection, single-option preservation and 200/201 character boundary are covered. No fact algorithm change was needed. Root gates remain unrun by this worker.

## Final verification evidence
- Final independent review: `/tmp/operator-card-final-review.md`; 10 files / 49 focused tests passed. Localization findings resolved; no execution contract changes or weakened assertions found. Minor remaining style note: unknown enum fallback in activity is not monospaced.
- `pnpm -r typecheck`: exit 0, 274.82s, 21 packages completed.
- `pnpm test:run`: exit 1, 2144.74s; 1038 passed / 14 failed files, 7810 passed / 4 failed / 60 skipped tests, 4 unhandled errors.
- `pnpm build`: exit 0, 145.11s; 25 packages completed, 5072 UI modules transformed.
- Exact base 46cf6129: independently installed/built archive inside ignored `tmp/operator-card-baseline-46cf6129`, same root test command exit 1, 2263.12s; 1029 passed / 19 failed files, 7764 passed / 11 failed / 78 skipped tests, 3 unhandled errors. All 3527 tracked source blobs unchanged; dependency links stay within baseline.
- Seven distinct failure IDs overlap, eight current-only IDs do not reproduce (including two context-budget-preflight failures). Therefore the user exception for all failures proven pre-existing is NOT satisfied. Resource nondeterminism is possible, not established.
- Durable summary: `doc/plans/2026-10-04-operator-card-readability-results.md`. Raw logs and JSON: `/tmp/operator-card-gates/`. No browser verification, deployment, push, or PR. Task 3 remains unchecked because its pass/baseline-proof condition is unmet.

## Review checkpoints
Shared interface: Task 1 produces companyLanguage and humanLabels, every consuming UI path uses them; Task 2 checks these together. Task 3 runs only after implementation/review fixes settle. Task 4 consumes actual logs, not worker success labels.
Preflight: all tasks agree with display-only constraints. TASK-BRIEF language requirements override existing Korean-only tests. Legacy oversized components require targeted extraction/reduction, not wholesale refactoring.
