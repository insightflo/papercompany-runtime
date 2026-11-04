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

### Collector and notification acceptance outline

A candidate arrangement is runtime `/api/metrics` → an existing approved
scraper → rule evaluation → an explicitly approved test receiver. This is a
proposal only: the current environment, credentials and receiver are unknown,
and no installation or network transmission is implied.

| Scenario | Observable condition | Required evidence |
| --- | --- | --- |
| Scrape stopped | The scraper reports a failed or absent target, subject to an agreed interval and delay. | Test receiver gets one firing notification; restoration leads to a recovery notification. |
| Work stalled | A defined, identity-safe metric distinguishes eligible waiting work from expected HOLD and indicates the agreed elapsed duration. | A controlled stalled fixture is detected; normal completion and intentional HOLD do not become false alerts. |
| Backup failed | An authoritative backup result supplies success/failure and last successful time. Missing or stale data stays unknown. | A controlled failure reaches the test receiver and recovery reaches it after a successful result. |
| Collector query fails | The collection result and its last-success time remain distinguishable from a true zero. | DB failure and recovery are observed without writing product state or blocking requests. |

Before enabling any rule, its owner must specify target identity, data source,
collection interval, allowable read load, absence/stale semantics, threshold,
receiver, delivery/recovery deadlines and access controls. A local HTTP scrape
proves neither DB freshness nor notification delivery. The metrics draft's
fixed-mount aggregation and omitted early connection closes also limit
endpoint-level and failure-rate alerting until separately resolved.

### Extraction candidates and test grouping evidence

These are candidate boundaries for a later approved change, not implementation
instructions or completed refactors:

1. Review `AgentDetail.tsx` display-only formatting and redaction helpers
   (around lines 121–180) as one possible isolated unit. Preserve secret/path
   redaction exactly and keep the existing `agents/:agentId`, tab and run URLs.
   The page's data mutations, queries and run streaming are outside that unit.
2. Review graph model and presentation responsibilities separately:
   `workflow-graph.ts` has a broad exported surface used by graph-editor
   components and tests. Preserve exports and graph serialization; inspect the
   full consumer map before choosing a single model boundary.
3. Keep `access.ts` as a separate authorization review: its invite payload,
   replay checks and route handler have different effects. Any extracted helper
   must retain permission, replay and stored-payload behavior and its tests.
4. For `dag-engine.ts`, keep dynamic heartbeat/finalization callers and
   workflow sync transactions together until their exact boundary is proven.
   Do not combine this server step with UI or access refactoring.

Test movement should follow the selected production responsibility, one suite
at a time. Workflow DAG tests contain pure normalization and embedded-DB issue
lifecycle groups; heartbeat preflight combines context setup and completion;
mission service tests combine decision parsing and DB-backed mission behavior.
Before moving any group, record actual test discovery by name, count, skipped
status and timeout; preserve shared setup lifetime and compare the identical
commands before/after. Static source counts do not establish discovered tests.

### R1–R3 decision inputs

| Candidate | Exact observed boundary | Evidence needed before selecting it |
| --- | --- | --- |
| Backup read (`backup-lib.ts`) | `runDatabaseBackup` opens one repeatable-read, read-only transaction, builds SQL lines within it, returns those lines, then writes a compressed partial file and renames it. Its `readError` is preserved. | 1A/1B acceptance and the same snapshot, options, original errors, output ordering and restore results. The read block is too large to move wholesale under the 300-line target. |
| Shutdown (`server/src/index.ts`) | It stops the scheduler; starts durable flush and child termination concurrently; waits for the flush and grace interval; then forces child termination, clears tracking and stops only its own embedded database. | 2B acceptance and tests for the same concurrent ordering, callback/result preservation, process ownership and restart consumption. A serial rewrite would change behavior. |
| Metrics response (`server/src/routes/metrics.ts`) | The route exposes the existing registry in text and JSON and has a separate, currently unmounted legacy middleware. | 3A-02's accepted source, freshness and failure contract. If that collector already provides the needed boundary, an extra response extraction may be unnecessary. |

No extraction or new runtime state follows from these inputs. Each later change
must retain its own approved file limit and run the corresponding before/after
behavioral tests; an unverified prerequisite is not treated as an accepted one.

The T10c local decision is to leave the small text/JSON metrics response in
its existing route: HTTP observation and threshold monitoring are already
separate modules. Reassess response extraction when DB collection and freshness
are defined. Backup extraction remains pending 1A/1B evidence, and shutdown
extraction remains pending 2B acceptance; these are not claims of deployment or
mission completion.
