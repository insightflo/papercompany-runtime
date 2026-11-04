# Runtime readiness boundaries observed locally

Snapshot: runtime bbaebd5f plus the HTTP metrics draft, 2026-11-04. This is
an inventory for the existing readiness tasks; it does not authorize extraction,
change a runtime contract or establish deployment or mission completion.

## Large files and test boundaries (LF2 and LF3)

| File | Observed lines | Evidence and possible boundary |
| --- | ---: | --- |
| `server/src/services/workflow/dag-engine.ts` | 3853 | Validation, issue creation, state sync and dispatch share a module. Static and dynamic callers include the app, workflow engine, heartbeat finalization and mission services. A complete local caller listing is in `c5-candidate-backups/wbs/t10b-dag-callers.txt`; assess shared state, callbacks and transaction boundaries before selecting any extraction. |
| `ui/src/pages/AgentDetail.tsx` | 4040 | `App.tsx` lazy-loads it for agent, tab and run routes. The file contains display redaction, workspace operation views, configuration, prompts, runs and log viewing. Pure display utilities and view sections are candidates for review, with existing redaction, API, URL and state behavior preserved. |
| `ui/src/pages/workflows/workflow-graph.ts` | 5741 | Separate UI graph responsibility; inspect consumers and behavior before choosing a boundary. |
| `server/src/routes/access.ts` | 3113 | Access decisions are a separate security boundary, not a mechanical size-only extraction. |

`workflow-dag-engine.test.ts` (8412 lines),
`heartbeat-context-budget-preflight.test.ts` (7525 lines), and
`missions-service.test.ts` (7140 lines) contain shared setup and multiple
behavioral groups. A later test split must preserve every test name, assertion,
timeout, fixture lifetime and discovered count, and compare before/after on the
same command and revision. No test was moved by this inventory.

## Conditional extraction (R1, R2 and R3)

- `packages/db/src/backup-lib.ts` has `runDatabaseBackup` at line 155; its
  backup file write follows the read portion at line 521. Do not alter the
  snapshot, read, transaction and file ordering. The 1A/1B acceptance and a
  focused responsibility boundary are prerequisites for deciding whether an
  extraction is useful.
- `server/src/index.ts` sets up graceful shutdown at lines 670–745, including
  scheduler stop, flush and tracked child termination. The 2B acceptance is a
  prerequisite for deciding whether to extract this orchestration; do not change
  the order based on a size target.
- `server/src/routes/metrics.ts` owns existing registry and scrape responses.
  The HTTP middleware draft supplies only RR-3A-01. Database metrics and their
  freshness/error semantics remain unfinished, so the R3 extraction decision
  cannot be made from the HTTP slice alone.

## Collector and alerting (3B)

The local source scan of `.github`, `scripts` and `server` for
`prometheus`, `scrape_configs`, `alertmanager` and `alerting:` found no
configuration outside tests and Markdown. This is not evidence about installed
or external collectors. After the DB metrics contract is accepted, identify the
actual scraper, rule source, owner and permitted test destination; agree on
intervals and thresholds, then separately verify scrape failure, stalled work,
backup failure, delivery and recovery notices. No collector, rule or destination
was changed or contacted.
