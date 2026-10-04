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
Current stage: Task 1 implementation and focused verification complete; independent review and root gates remain owned by the parent (Tasks 2–4).
This stage closes: language helper, all 12 specified display paths and focused regressions. Does not close: independent review, root typecheck/test/build, runtime deployment or producer content quality.
Evidence: `/tmp/operator-card-red.log` (2 behavioral failures before production edits); `/tmp/operator-card-final-focused.log` (11 files / 44 tests passed, 5.18s); `/tmp/operator-card-final-regressions.log` (16 tests passed after final assertion strengthening); `/tmp/operator-card-final-typecheck.log` (UI typecheck exit 0). Scope audit: only UI and this plan changed; new files <=300 lines; oversized files reduced. No spawn/push/deploy/PR in Task 1.
Verification correction: invoking Vitest without a path filter accidentally discovered root tests; it timed out at 120s and is NOT a root-suite pass. Subsequent commands explicitly specify UI paths. Broad UI check was diagnostic (540/542 passed before a second partial-mock fix); final scoped gates pass. Details in `/tmp/operator-card-implementation-report.md`.
Lessons: fixture setup failures are not product RED; full-suite isolated reruns are not full-suite success; baseline workspace resolution must point to baseline packages.

## Delegation / tasks
- [x] Task 1: Implement language infrastructure and all twelve card display paths, with focused regressions. Single implementation worker owns UI files and related tests to avoid shared-file conflicts. Worker reads TASK-BRIEF.md fully and writes report including RED/GREEN commands. Use `resolveCompanyLanguage`, `CompanyLanguageProvider`, `useCompanyLanguage`, `L` exactly as specified; use bilingual humanLabels with raw fallback. Test English/default and Korean cards, common facts once, long fact preservation, known/unknown distinction. Commit logical units using feat(ui) style.
- [ ] Task 2: Independent spec and quality review of Task 1 diff against base 46cf6129. Separate reviewer reports file/line findings, unchanged content/requests evidence and test gaps. Fix confirmed in-scope issues with covering tests, then scoped re-review.
- [ ] Task 3: Run `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`, recording exit code, duration, output and counts. Any failure requires diagnosis; unrelated failures require identical-condition base 46cf6129 proof. No scope-expanding fixes.
- [ ] Task 4: Final audit and Korean closeout: plan, files/behavior, additions/reasons, implicit operating effects, verified/unverified conditions and command summaries. No claim of completion unless all gates satisfied.

## Review checkpoints
Shared interface: Task 1 produces companyLanguage and humanLabels, every consuming UI path uses them; Task 2 checks these together. Task 3 runs only after implementation/review fixes settle. Task 4 consumes actual logs, not worker success labels.
Preflight: all tasks agree with display-only constraints. TASK-BRIEF language requirements override existing Korean-only tests. Legacy oversized components require targeted extraction/reduction, not wholesale refactoring.
