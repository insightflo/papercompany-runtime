# Runtime QA genericization — Phase B

## Approved scope and whole path
Replace prose/tool-name execution decisions with explicit validated step settings
and artifact roles: save/authorization → planning topology → definition snapshot →
delivery/readback/cap decisions → durable evidence. No operational migration,
deployment, remote DB writes, heartbeat-finalization changes, push, PR, other
worktree edits or handoff.

## Implementation and delegation
- [x] Workflow worker: validated deliveryVerification/capAcceptance, role-only
  classification, scoped tool resolution, frozen policy, delivery/cap callers,
  existing board authorization/audit reuse and focused DB tests.
- [x] Planning worker: contract-driven intent/topology/autofill/rework, generic
  context and optional site resource configuration, explicit generated roles.
- [x] Template/integration worker: generic seed, non-destructive forward data
  migration, scoped contracts in general definition save and replay synthesis.
- [x] External mapping worker: surveyed workflow/tool settings, missing evidence
  marked not migration-ready; operational content remains outside the repository.
- [x] Independent review and corrections: retain structural QA with a frozen
  verifier role, reject board-only policies in plans rather than silently drop,
  exclude escalation-only oversight metadata, preserve qaType in supervision,
  remove remaining prose-derived artifact-kind placement rejection.
- [x] Full gates, literal inventory, local commits and external report.

## Evidence and failures
Tests were written before each behavior change; isolated logs record RED and GREEN.
Initial whole-stage gates: typecheck/build exit 0, tests exit 1 (23 files / 55 tests
failed). Name-derived fixture roles were replaced with explicit settings without
weakening verdict/generation/request assertions. One unexpected HTTP 401 did not
reproduce; response-origin diagnostics were added, not an unproven production fix.

Final ordered whole-stage gates on unchanged source:
- `pnpm -r typecheck`: exit 0.
- Isolated full `pnpm test:run --maxWorkers=1 --no-file-parallelism`: exit 0;
  **1,001 files passed, 7,551 tests passed, 2 expected skips, 0 failures**.
- `pnpm build`: exit 0.
- Source hashes: 3,131 entries unchanged throughout all three gates.
- `git diff --check`: passed. Independent final review approved the local change.
- Logs and exact commands: `/tmp/qag/phase-b-final-summary.json` and
  `/tmp/qag/phase-b-final-{typecheck,test,build}.log`.
- Final report and literal inventory: `/tmp/qag/phase-b-report.md` and
  `/tmp/qag/phase-b-remaining-hits.txt`.

## Non-obvious changes and rollout limits
See `doc/runbooks/declarative-workflow-policy.md` for exact settings, planning
restrictions, removed inference and the retired-template migration.

Names, tags and ID prefixes no longer grant roles. Explicit mode replaces dynamic
workflow-name inference. Research tooling, audience/scenario/quality requirements,
template selection and input-kind rejection no longer arise merely from prose.
The generic site-root environment variable has no default or legacy alias.

Legacy snapshots share version 1 and may contain title-only QA. There is **no
runtime compatibility guard** for those snapshots. Before rollout, stop admissions
and schedules in the old runtime, finish or cancel every resumable old execution,
review explicit settings, and use reviewed replacement runs when needed. Never
mutate immutable snapshots. Seamless old-run continuation needs a separate versioned
migration design and is not claimed here.

The external mapping is review-only, not executable or fully migration-ready:
`/tmp/qag/phase-b-migration-mapping.json`. Exact live workflow IDs and missing full
producer contracts remain unconfirmed; all former implicit roles must be surveyed,
not only the supplied examples. No deployment or operational parity is claimed.

## Constraints and lessons
Public repository uses neutral fixtures. New files stay below 300 lines; existing
oversized implementation/test files did not grow. Full tests used fresh isolated
temp/log directories and serial workers after checking for competitors. No unowned
process was killed. Focused success was never substituted for a full successful run.
