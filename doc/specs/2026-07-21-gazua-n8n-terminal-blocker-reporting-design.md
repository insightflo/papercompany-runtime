# Gazua Native n8n Migration and Terminal Mission Blocker Reporting

**Date:** 2026-07-21

**Status:** User-approved design; implementation starts only after written-spec review

**Target branch:** `insightflo/gazua-n8n-terminal-blocker-reporting`
**Production company:** Gazua (`44a06e9c-3e68-4249-b941-ad337ccfdab8`)

## 1. Goal

Deliver two coordinated operational changes:

1. Move the five remaining Gazua built-in collection/analysis tools to native
   n8n workflows and change their Papercompany tool adapters to authenticated
   HTTP.
2. Report a mission to Human Operator exactly when the runtime can prove that
   the mission has stopped and no automatic retry, fallback, failure branch,
   QA rework, or queued recovery path can continue it.

The runtime change is a reporting change. It must not introduce a new generic
retry engine or change the limits and semantics of existing retry mechanisms.

## 2. Confirmed Current State

### 2.1 Gazua tool migration scope

The five migration targets are:

- `collect-premarket-futures`
- `collect-metadata`
- `collect-us-stockflow`
- `collect-kr-futures-flow`
- `collect-signals-kr`

`gazua.oracle-data-sync` is explicitly excluded. It remains `builtin` and must
be protected by a migration assertion.

The Gazua tools already backed by HTTP/n8n are outside this migration.

### 2.2 Runtime retry distinction

The runtime already has bounded recovery mechanisms, including process-loss
retry, adapter fallback, tool-step recovery, QA back-edge rework, and planning
recovery. Those mechanisms remain authoritative.

The workflow step field `maxRetries` is present in shared types, validation,
the workflow editor, and `workflow_step_runs.retry_count`, but current
`origin/main` does not use the field to schedule workflow-step retries. The
control-flow plan records it as type-only. This task does not activate it,
change `retryCount`, or add a replacement generic retry engine.

## 3. Non-goals

- Do not change `gazua.oracle-data-sync`.
- Do not call A1 Python scripts, shell commands, SSH, or rsync from the new n8n
  collection workflows.
- Do not activate workflow step `maxRetries`.
- Do not change process-loss retry counts, adapter fallback order, QA
  `maxIterations`, or existing tool-recovery authority.
- Do not report a transient failure while an automatic recovery path remains.
- Do not put mission-less standalone workflow runs in the mission-scoped Human
  Operator queue.
- Do not expose secrets, raw remote responses, unbounded stderr, or complete
  tool payloads in escalation summaries.

## 4. Selected Architecture

### 4.1 Gazua tools

Use one authenticated n8n webhook workflow per tool. Each workflow has a
single responsibility and can fail independently.

```text
Papercompany HTTP tool
  -> authenticated n8n webhook
  -> native HTTP Request and Code nodes
  -> source-specific normalization and validation
  -> immutable Shared Data run/history object
  -> Shared Data latest object
  -> { result, artifact } HTTP response
  -> Papercompany exact-run work product mirror
```

The webhook header secret remains a Papercompany secret reference. Provider
credentials remain named n8n credentials. No secret value is written into a
workflow export, Code node, migration script, log, or tool definition.

### 4.2 Runtime terminal blocker reporting

Existing recovery mechanisms execute unchanged. A common terminal-blocker
classifier runs only after current state has been synchronized.

```text
existing retry/fallback/rework/recovery
  -> synchronize authoritative DB state
  -> classify remaining automatic continuation paths
  -> if any path remains: no Human Operator event
  -> if none remains and the mission cannot advance:
       materialize/reuse one owner-action issue
       add one structured system escalation comment
       record the existing mission.owner.human_input_requested event
```

The primary execution path writes durable evidence immediately. Mission
supervision is the reconciliation fallback when materialization fails or a
process stops between the evidence write and Human Operator event creation.

## 5. HTTP Correlation Contract

The existing HTTP adapter already sends:

- `X-Papercompany-Request-Id`

The adapter will additionally send the following non-secret context headers
when the values are available:

- `X-Papercompany-Workflow-Run-Id`
- `X-Papercompany-Step-Id`

These headers allow the n8n workflows to keep an immutable attempt identity
while also correlating all collector outputs from one workflow run. Tool tests
and standalone calls may omit the workflow-run header; their artifacts remain
request-scoped and must not be consumed as exact-run dependencies.

`X-Papercompany-Request-Id` is the idempotency key for one remote attempt. A
repeat of the same request ID returns the existing stored result. It must not
perform a second source collection or overwrite conflicting content.

## 6. Common n8n Response and Storage Contract

Every workflow returns the existing remote-tool response envelope:

```json
{
  "result": {
    "ok": true,
    "status": "success",
    "requestId": "bounded-request-id",
    "workflowRunId": "optional-run-id",
    "observedAt": "2026-07-21T07:00:12+09:00",
    "summary": "bounded human-readable result",
    "sourceStatus": []
  },
  "artifact": {
    "schema": "gazua.<category>.v1",
    "requestId": "bounded-request-id",
    "workflowRunId": "optional-run-id",
    "observedAt": "2026-07-21T07:00:12+09:00",
    "status": "success",
    "sourceStatus": [],
    "data": {}
  }
}
```

The bounded `result` is suitable for workflow metadata. The full `artifact`
is persisted in the assigned step output directory and mirrored to configured
company work-product storage by the runtime.

Each n8n workflow also writes cumulative company Shared Data:

```text
<category>/history/<workflowRunId-or-standalone>/<requestId>.json
<category>/runs/<workflowRunId>/latest.json     # workflow runs only
<category>/latest.json
```

Write order is immutable history first, run-scoped latest second, and global
latest last. A failure before all required writes complete fails the tool.
Global latest never substitutes for run-scoped input when a consumer has a
workflow run ID.

Source values use explicit `ok`, `stale`, or `failed` status and carry the
source observation time. Missing values are never converted to zero, empty
collections, or neutral signals.

## 7. Tool-specific Contracts

### 7.1 `collect-premarket-futures`

- Reuse the provider/symbol mappings already proven in the active Market Pulse
  n8n implementation through a reusable sub-workflow or equivalent shared
  versioned builder.
- Collect the existing futures, indices, FX, rates, and market proxies with
  source and observation time per instrument.
- Require usable ES, NQ, and USD/KRW observations. Optional instruments may
  carry explicit source failure without replacing their previous values with
  null or zero.
- Shared Data category: `futures`.

### 7.2 `collect-metadata`

- Collect the KRX fields actually consumed by KR signal calculation: code,
  name, market, change ratio, trading amount, and market capitalization.
- Require a non-empty normalized universe containing usable KOSPI and KOSDAQ
  rows.
- Do not reproduce the unused top-100 Alpha/Beta batch in this HTTP contract.
- Shared Data category: `metadata`.

### 7.3 `collect-us-stockflow`

- Replace browser scraping of WhaleWisdom with HTTP retrieval of official SEC
  13F filing data for the versioned manager/CIK mapping.
- Record filing period, filed-at time, accession identifier, source URL, and
  holdings. Compare with the previous Shared Data object to derive additions
  and removals.
- Quarterly age is expected and is not itself a failure. A source request
  failure, invalid filing, or unresolved required manager is a failure and may
  not be silently skipped.
- Shared Data category: `us-stockflow`.

### 7.4 `collect-kr-futures-flow`

- Use n8n HTTP credentials for KIS/provider access; do not load A1 environment
  files or Python modules.
- Resolve investor-flow observations against the latest completed Korean
  trading day. Record that market date separately from the current futures
  observation time.
- Require a usable ETF investor-flow observation and a usable KOSPI 200
  futures observation. Large-cap flow may be partial only when its failed
  sources are explicit.
- A futures close/volume/open-interest tuple by itself is not success when ETF
  and large-cap investor flow are empty.
- Shared Data category: `kr-futures-flow`.

### 7.5 `collect-signals-kr`

- Read `metadata/runs/<workflowRunId>/latest.json` and
  `kr-futures-flow/runs/<workflowRunId>/latest.json`; never substitute global
  latest when a workflow run ID is supplied.
- Port the deterministic KR market-top, macro-regime, FTD, and theme-basket
  transformations to versioned n8n Code nodes/builders.
- Preserve source files/objects, freshness, and limitation fields in every
  signal. All four signal artifacts must be valid for overall success.
- Do not read A1 dashboard files or prior reports.
- Shared Data category: `market-signals-kr`.

## 8. Terminal Mission Blocker Definition

A terminal mission blocker is a mission-scoped workflow state in which at
least one required execution path failed and no authoritative automatic path
can advance the mission.

The classifier must fail closed: uncertainty about active recovery suppresses
the escalation and lets supervision re-evaluate later. It must not infer
terminality from `workflow_runs.status = 'failed'` alone.

### 8.1 Suppress escalation when any continuation exists

Suppress the report when any of the following is authoritative and live:

- a queued/running heartbeat or wakeup for the failed work;
- a process-loss retry or adapter fallback that has been queued but is not
  terminal;
- an open tool-step recovery action that can still apply a result or retry;
- a QA back-edge whose rework budget remains and whose activation is current;
- a source-issue native resume/owner override that has been accepted but not
  settled;
- a runnable `failure` or `always` conditional branch;
- another required workflow step that is runnable or already executing;
- a pending state whose liveness cannot yet be classified safely.

### 8.2 Escalate confirmed terminal states

Confirmed examples include:

- process-loss retry and configured adapter fallback both settled without a
  continuation;
- tool-step recovery settled unsuccessfully with no further recovery action;
- QA `maxIterations` exhausted with a current official `request_changes`
  verdict;
- an IF/control-node contract failure leaves no legal branch runnable;
- all remaining downstream steps are unreachable because required failed
  predecessors have no recovery or failure branch;
- deadlock reconciliation confirms no active execution or recovery before
  failing the run.

Pre-run workflow validation errors are API errors, not mission Human Operator
events, because no mission execution reached a terminal blocker state.

## 9. Escalation Materialization

For one confirmed terminal snapshot:

1. Write or reuse a company-scoped workflow transition event with an
   idempotency key derived from company, mission, workflow run, and the sorted
   terminal evidence tokens for the failed steps.
2. Create or reuse one high-priority `mission_main_executor_unblock` issue for
   that snapshot. If the QA-cap path already created the canonical issue,
   reuse it.
3. Add one bounded system-authored comment using the existing structured
   Mission Owner decision format with `decision: escalate`.
4. Pass that issue/comment through the existing
   `recordHumanOperatorRequestEvent` path so the activity log and live event
   remain the Human Operator source of truth.

Aggregate simultaneous failed steps into one report. A repeat sync of the same
snapshot creates nothing new. If an operator resumes the run and a later,
different terminal evidence snapshot occurs, it is a new reportable
generation.

The report contains:

- mission and workflow names;
- failed step names and bounded IDs;
- recovery mechanisms attempted and their settled states;
- attempt/rework counters already owned by those mechanisms;
- bounded last-error summaries;
- suggested next action and recovery link.

It never contains secret values, raw JSON bodies, full stderr, or full tool
artifacts.

## 10. Workflow Definition Migration

Update the live `gazua-morning` workflow descriptions so consumers use
exact-run work products and the new run-scoped Shared Data categories.

The migration utility is dry-run by default and must:

- load all current Gazua tool definitions and the target workflow;
- assert the exact five target tool names exist;
- assert `gazua.oracle-data-sync` exists and remains `builtin`;
- assert each target is in an expected pre-migration state;
- verify every backing n8n workflow is active and has a successful bounded
  manual test receipt before `--apply`;
- snapshot the five previous tool definitions and changed workflow steps;
- patch only the five targets to `adapterType: "http"`;
- read back and verify five HTTP targets plus the untouched Oracle builtin;
- print bounded rollback material without secret values.

## 11. Test Strategy

### 11.1 Runtime focused tests

- HTTP adapter adds run/step headers when present and omits them when absent.
- Existing remote-tool auth, response, artifact, and secret-redaction tests
  remain green.
- No escalation while a process-loss retry or adapter fallback is live.
- No escalation while tool recovery, QA rework, native resume, or a failure
  branch can continue.
- One escalation after each existing recovery path is conclusively exhausted.
- One escalation when a control-node failure leaves no runnable branch.
- One escalation when downstream work is unreachable and no recovery exists.
- Concurrent sync/supervision calls materialize one event and one owner-action
  issue.
- A repeated snapshot is idempotent; a later recovery generation can report
  again.
- Company and mission boundaries are enforced.
- Mission-less runs do not appear in Human Operator requests.
- Error summaries remain bounded and redact secret/raw payload content.
- Native IF/Complete and QA-cap regression suites stay green.

No test should assert new behavior for workflow step `maxRetries`.

### 11.2 n8n and migration tests

- Static tests validate generated workflow node types, webhook paths, auth,
  response envelopes, required source checks, and absence of shell/Python/SSH
  execution.
- Fixture tests cover source success, partial optional-source failure, required
  source failure, stale allowed data, and malformed input.
- Creator scripts default to dry-run or inactive workflow creation.
- Migration dry-run proves the exact five-target allowlist and Oracle
  exclusion.
- Each live workflow receives a manual authenticated webhook test before tool
  conversion.

### 11.3 Repository gates

Run, in order:

1. focused runtime and script tests;
2. `pnpm -r typecheck`;
3. `pnpm test:run`;
4. `pnpm build`.

If the unchanged base has unrelated failures, capture the same failing command
on base and report the delta. No task-caused failure may remain.

## 12. Landing and Production Sequence

1. GJC implements only in the assigned Orca worktree. GJC must not commit,
   push, merge, deploy, mutate live n8n/Papercompany data, or clean up.
2. Codex reviews the full diff, requests corrections in the same GJC session,
   and independently runs the required verification.
3. Codex commits, lands, and pushes the reviewed runtime change under repository
   policy.
4. Deploy runtime first so terminal-blocker reporting is active before the
   Gazua tools are switched.
5. Verify the deployed revision and `https://papercompany.showk.ing/api/health`.
6. Create the five n8n workflows inactive, perform bounded real-source tests,
   then activate them.
7. Run migration dry-run and review its exact target/readback summary.
8. Apply the five HTTP tool conversions and workflow-description update.
9. Re-read live definitions: five approved tools are HTTP and
   `gazua.oracle-data-sync` is still builtin.
10. Execute every saved tool through Papercompany, verify exact-run artifacts
    and run-scoped/global Shared Data, then run one controlled Gazua morning
    mission canary.
11. Trigger a synthetic terminal failure in production only if an existing
    dedicated test company provides isolation. Otherwise verify that path with
    integration tests and state clearly that no live failure was induced.
12. After all requested deployment evidence is green, close only the task
    terminal, remove only this worktree, and delete the merged task branch.
    Preserve `fix/inflo-runtime-ci-stabilization` and its worktree.

## 13. Rollback

- The migration snapshot restores only the five previous Gazua tool
  definitions and the changed `gazua-morning` workflow steps.
- Deactivate the new n8n workflows if tool rollback is required.
- Never change `gazua.oracle-data-sync` during rollback.
- Runtime rollback uses the previous deployed revision if terminal-blocker
  reporting causes a production regression.
- Do not delete the worktree or uncommitted evidence until rollback or recovery
  is complete and verified.

## 14. Definition of Done

- Five approved Gazua tools are live HTTP adapters backed by native n8n
  workflows.
- `gazua.oracle-data-sync` remains builtin.
- All five return valid exact-run artifacts and write the approved Shared Data
  objects.
- Existing retry/fallback/rework behavior is unchanged.
- A mission is absent from Human Operator while any automatic continuation is
  live.
- A mission appears exactly once when no automatic continuation remains and
  the mission cannot advance.
- Focused tests, typecheck, full tests, build, deploy verification, live tool
  tests, and the Gazua mission canary have completed or any explicitly
  identified base-only failure is documented with evidence.
