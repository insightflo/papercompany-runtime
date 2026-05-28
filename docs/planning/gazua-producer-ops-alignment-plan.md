# Gazua Producer Ops-Alignment Plan

> **For Hermes/Papercompany:** Use this plan to align Papercompany workflow dispatch and telemetry with Alpha-Prime's Gazua KR/US producer split. Do not implement generator logic in Papercompany.

**Status:** draft execution plan  
**Prepared:** 2026-05-06 KST  
**Primary owner boundary:** Papercompany owns workflow/dispatch/telemetry; Alpha-Prime owns canonical generator code, data, reports, validation, and artifact indexes.

**Goal:** Make Papercompany execute and supervise Gazua data generation separately for KR and US without turning Papercompany or `papercompany-operations` into a second source of truth.

**Architecture:** Papercompany dispatches canonical Alpha-Prime commands with explicit market scope, records runtime IDs as telemetry, and verifies canonical artifact receipts. Gazua reads Alpha-Prime canonical artifacts and handoff/index files; it must not depend on Papercompany runtime DB rows for normal rendering.

**Tech Stack:** Papercompany runtime 3200, Papercompany workflow/tool-config records, Alpha-Prime Python scripts, canonical JSON/Markdown artifacts, local shell/curl verification.

---

## 0. Current verified state

Verified locally on 2026-05-06 11:51 KST:

- Papercompany runtime health endpoint responds on `http://127.0.0.1:3200/api/health` with `status: ok`.
- Runtime company list includes `가즈아` with company id `9045933e-40ca-4a08-8dad-38a8a054bdf3`.
- No separate Papercompany Gazua producer ops-alignment plan existed before this document.
- Existing operations mirrors already contain canonical-looking artifacts and must be treated as path-drift baseline, not new source of truth:
  - `papercompany-operations/scripts/alpha-prime-personal/data`: 384 files observed.
  - `papercompany-operations/scripts/alpha-prime-personal/reports`: 50 files observed.
  - `papercompany-operations/scripts/data`: 120 files observed.
  - `papercompany-operations/scripts/reports`: 6 files observed.
- Alpha-Prime Phase 4 plan exists at:
  - `/Users/kwak/Projects/ai/alpha-prime-personal/docs/planning/gazua-producer-us-kr-separation-phase4.md`

## 1. Non-goals and hard boundaries

- Do not add Papercompany workflow/issue DB schema columns merely to carry `market`.
- Do not make Gazua dashboard call Papercompany workflow/issue/plugin-job tables as its primary data source.
- Do not copy Alpha-Prime `data/` or `reports/` artifacts into Papercompany as normal output.
- Do not let `papercompany-operations/scripts/alpha-prime-personal` become a forked generator/data tree.
- Do not run destructive Oracle sync as part of producer split until the sync safety gate in this plan passes.
- Do not mark a workflow as done only because the workflow step returned HTTP 200 or issue status moved forward.

## 2. Required inventory before implementation

### Inventory extraction status

**Extracted:** 2026-05-06 KST from Papercompany runtime DB/plugin entities.

**Artifact:** `docs/planning/artifacts/gazua-producer-inventory-20260506.json`

**Important DB finding:** `tool_definitions` has `0` Gazua rows, while active Papercompany tool configs live in `plugin_entities.entity_type = 'tool-config'` under the `insightflo.tool-registry` plugin. Workflow run/step telemetry used by the workflow engine also lives in `plugin_entities`, so do not rely on `workflow_runs` alone for operational status.

### Task 1: Workflow inventory

**Objective:** Identify the exact Papercompany workflows that dispatch Gazua producer work.

| Field | Current value |
| --- | --- |
| company id/name | `9045933e-40ca-4a08-8dad-38a8a054bdf3` / `가즈아` |
| KR morning workflow slug/id | `gazua-morning` / `ea2484dc-1c74-42f7-8417-f94f7cc9ef4b` |
| US evening workflow slug/id | `gazua-evening` / `edb855d2-2911-42f8-9bfe-90792e90e8e5` |
| watchlist refresh workflow slug/id | `gazua-watchlist-refresh` / `ec74f12b-46b0-4c91-89c9-42dd8e52dde5` |
| watchlist lifecycle workflow slug/id | `gazua-watchlist-lifecycle` / `28bd8669-26c0-44b5-933f-7603060e33e2` |
| Oracle sync workflow slug/id | `gazua-oracle-data-sync-draft` / `3709de75-bc6c-4967-8be3-525be286136e` |
| active sync step present in workflows | step id `gazua-oracle-data-sync`, tool `gazua.oracle-data-sync`, `onFailure=skip`, observed in `gazua-macro-sentinel` and other workflows |
| schedule/trigger source | observed workflow telemetry uses `triggerSource = schedule` for scheduled runs; per-workflow cron source still TODO |
| current status semantics | Papercompany `workflow-run`/`workflow-step-run` status means dispatch/runtime state only. Canonical artifact validity must be read from Alpha-Prime artifact index + validation, then Gazua API smoke. |

**Other Gazua workflows currently present:**

| Workflow | ID | Notes |
| --- | --- | --- |
| `gazua-macro-sentinel` | `1e9b5430-ac14-450e-b31c-9725e432946c` | Scheduled; runs `collect-macro`; observed active/in-progress/completed telemetry. |
| `gazua-closing-bet-followup` | `565eb6ae-990b-495e-940d-fbc7d751bd6e` | Scheduled shadow follow-up; appends Oracle sync step. |
| `gazua-closing-bet` | `d236b6b6-33bb-4805-a2c1-4fcde8bcffe6` | Shadow recommendation only. |
| `gazua-weekly` | `96edb53c-4491-4f6f-8e3d-2fddaa09b157` | Weekly collection/publishing. |
| `gazua-data-archive` | `ae903718-16fc-4173-b818-c4725e0127bd` | Destructive cleanup; keep out of producer split. |
| Draft QA/automation workflows | see inventory artifact | Keep as draft-only unless separately approved. |

**Acceptance criteria:**

- KR/US producer workflows are identified by stable slug/id. **Current status: done.**
- Any missing workflow is recorded as `missing_workflow_definition`, not guessed. **Current status: none missing for KR/US producer dispatch.**
- Status semantics distinguish dispatch state, runtime state, canonical data state, and Gazua consumption state. **Current status: documented above; still needs implementation in telemetry.**

### Task 2: Tool-config inventory

**Objective:** Identify every tool-config/step command that currently calls Alpha-Prime or Gazua scripts.

#### Producer-adjacent active tool configs

| Workflow/step | Tool-config | Current command | workingDirectory | Boundary status |
| --- | --- | --- | --- | --- |
| `gazua-morning` / `collect-market` | `collect-morning` | `python3 /Users/kwak/Projects/ai/alpha-prime-personal/scripts/automation/paperclip_run.py collect --mode morning` | `/Users/kwak/Projects/ai/alpha-prime-personal` | canonical cwd OK; not yet market-param aware |
| `gazua-morning` / `collect-signals` | `collect-signals` | `python3 /Users/kwak/Projects/ai/alpha-prime-personal/scripts/automation/paperclip_run.py collect --mode signals` | `/Users/kwak/Projects/ai/alpha-prime-personal` | canonical cwd OK; must become KR-aware or call new `run_market_signals.py --market KR` |
| `gazua-evening` / `collect-us-market` | `collect-evening` | `python3 /Users/kwak/Projects/ai/alpha-prime-personal/scripts/automation/paperclip_run.py collect --mode evening` | `/Users/kwak/Projects/ai/alpha-prime-personal` | canonical cwd OK; not yet market-param aware |
| `gazua-evening` / `collect-us-signals` | `collect-signals` | same as above | `/Users/kwak/Projects/ai/alpha-prime-personal` | canonical cwd OK; must become US-aware or call new `run_market_signals.py --market US` |
| multiple workflows / `gazua-oracle-data-sync` | `gazua.oracle-data-sync` | `/Users/kwak/Projects/ai/papercompany/papercompany-operations/scripts/paperclip-addon/gazua_oracle_data_sync.sh` | `/Users/kwak/Projects/ai/papercompany/papercompany-operations` | non-canonical legacy addon path; safety gate required before destructive sync |

#### Related but not primary producer split targets

| Tool-config | Current command | workingDirectory | Notes |
| --- | --- | --- | --- |
| `collect-macro` | `python3 /Users/kwak/Projects/ai/alpha-prime-personal/scripts/automation/paperclip_run.py collect --mode macro` | Alpha canonical | Observed scheduled every ~30m via `gazua-macro-sentinel`; writes macro/regime artifacts. |
| `watchlist-lifecycle` | `python3 /Users/kwak/Projects/ai/alpha-prime-personal/scripts/automation/paperclip_run.py watchlist --mode lifecycle` | Alpha canonical | Apply-only watchlist writer; do not overload as producer. |
| `publish-*`, `closing-bet-*`, `screen-stocks`, `archive-old-data`, `sync-portfolio` | See inventory artifact/tool registry | Mostly Alpha canonical cwd; keep out of KR/US signal producer split unless their outputs need market-tagging later. |

**Current high-risk path findings:**

- Active producer-adjacent configs mostly already use `/Users/kwak/Projects/ai/alpha-prime-personal` as `workingDirectory`.
- `gazua.oracle-data-sync` still uses legacy `/Users/kwak/Projects/ai/papercompany/papercompany-operations` script/cwd and is therefore the main Papercompany-side risk.
- Existing sync telemetry shows `papercompany_overlay data/market_signals`, `papercompany_overlay data/macro`, and `papercompany_overlay reports/blog`, confirming operations/addon overlay still participates in staging.
- No active tool-config currently calls `scripts/run_market_signals.py --market ...`; this must be added only after the Alpha-Prime canonical script supports the market contract.

**Acceptance criteria:**

- Every producer-related command has explicit `command`, `workingDirectory`, and `env` recorded. **Current status: command/cwd recorded; env not exposed in tool-config data and remains TODO.**
- Commands that currently point at operations mirror are flagged for conversion or wrapper hardening. **Current status: sync/addon path flagged; producer tools are canonical cwd but market split missing.**

## 3. Execution-boundary decision

### Preferred decision: direct canonical execution

Use this by default unless a Papercompany runtime limitation blocks it.

```text
workingDirectory = /Users/kwak/Projects/ai/alpha-prime-personal
command = ./venv/bin/python scripts/run_market_signals.py --market KR
command = ./venv/bin/python scripts/run_market_signals.py --market US
```

Benefits:

- avoids operations mirror fork;
- makes relative paths resolve to canonical `data/`, `reports/`, and `portfolio/`;
- makes Gazua backend and artifact index consume the same tree that generated the data.

### Acceptable fallback: thin wrapper only

Use wrappers only if Papercompany cannot directly dispatch from the Alpha-Prime cwd. Wrapper requirements:

```bash
export ALPHA_PRIME_SOURCE_ROOT=/Users/kwak/Projects/ai/alpha-prime-personal
cd "$ALPHA_PRIME_SOURCE_ROOT"
./venv/bin/python scripts/run_market_signals.py --market KR
```

Wrapper must record:

- `resolved_runtime_root`;
- `command_cwd`;
- `canonical_output_dir`;
- `ALPHA_PRIME_SOURCE_ROOT`;
- forbidden operations mirror paths checked.

Wrapper must fail or mark `partial_with_path_drift` if new canonical-looking outputs appear under the operations mirror.

## 4. Market dispatch contract

### KR morning producer run

**Command target:**

```bash
cd /Users/kwak/Projects/ai/alpha-prime-personal
./venv/bin/python scripts/run_market_signals.py --market KR
```

**Expected canonical outputs:**

```text
data/market_signals/KR/*_YYYY-MM-DD.json
reports/.meta/delta_tracker.json  # with regime.by_market.KR and market_signals.by_market.KR
data/gazua_handoff/KR_latest.json
reports/.meta/gazua_producer_runs/YYYYMMDD/<run_id>.json
```

**KR unsupported rules:**

- US-only FTD/market_top/theme must not appear as normal KR output.
- If KR generator/source is missing, record `unsupported` or `skipped_with_reason` in the artifact index and handoff.
- US macro/context may be used only as `external_context` or proxy, not as KR source identity.

### US evening producer run

**Command target:**

```bash
cd /Users/kwak/Projects/ai/alpha-prime-personal
./venv/bin/python scripts/run_market_signals.py --market US
```

**Expected canonical outputs:**

```text
data/market_signals/US/*_YYYY-MM-DD.json
reports/.meta/delta_tracker.json  # with regime.by_market.US and market_signals.by_market.US
data/gazua_handoff/US_latest.json
reports/.meta/gazua_producer_runs/YYYYMMDD/<run_id>.json
```

### Legacy ALL run

`--market ALL` remains a backward-compatible fallback. It must not be the normal Papercompany KR/US workflow target after Phase 4 rollout.

## 5. Telemetry and handoff contract

Papercompany IDs are telemetry, not primary dashboard data.

Papercompany may pass these environment variables or step metadata into Alpha-Prime:

```text
GAZUA_RUN_ID=YYYYMMDDTHHMMSS-kr-morning
GAZUA_MARKET=KR|US
PAPERCOMPANY_COMPANY_ID=9045933e-40ca-4a08-8dad-38a8a054bdf3
PAPERCOMPANY_WORKFLOW_SLUG=<slug>
PAPERCOMPANY_WORKFLOW_RUN_ID=<runtime-id-if-available>
PAPERCOMPANY_STEP_RUN_ID=<runtime-id-if-available>
PAPERCOMPANY_PLUGIN_JOB_RUN_ID=<runtime-id-if-available>
```

Canonical Alpha-Prime outputs:

```text
data/gazua_handoff/KR_latest.json
data/gazua_handoff/US_latest.json
reports/.meta/gazua_artifact_index.json
reports/.meta/gazua_producer_runs/YYYYMMDD/<run_id>.json
```

Minimum run receipt fields:

```json
{
  "schema_version": "gazua_artifact_index.v1",
  "run_id": "20260506T090500-kr-morning",
  "market": "KR",
  "workflow_name": "kr-morning",
  "command": "./venv/bin/python scripts/run_market_signals.py --market KR",
  "command_cwd": "/Users/kwak/Projects/ai/alpha-prime-personal",
  "resolved_runtime_root": "/Users/kwak/Projects/ai/alpha-prime-personal",
  "canonical_output_dir": "/Users/kwak/Projects/ai/alpha-prime-personal",
  "produced_artifacts": [],
  "consumed_sources": [],
  "validation": [],
  "path_drift_check": {
    "passed": true,
    "unexpected_artifacts": []
  },
  "unsupported": [],
  "status": "success|partial|failed"
}
```

## 6. Path-drift baseline and policy

### Baseline paths

Treat these existing counts as baseline until a more detailed manifest is generated:

| Path | Existing observed file count | Policy |
| --- | ---: | --- |
| `papercompany-operations/scripts/alpha-prime-personal/data` | 384 | Baseline only; no new canonical outputs allowed. |
| `papercompany-operations/scripts/alpha-prime-personal/reports` | 50 | Baseline only; no new canonical outputs allowed. |
| `papercompany-operations/scripts/data` | 120 | Baseline only; no new canonical outputs allowed. |
| `papercompany-operations/scripts/reports` | 6 | Baseline only; no new canonical outputs allowed. |

### Required baseline manifest

Before the first Papercompany-dispatched producer run, write a manifest:

```text
reports/.meta/gazua_path_drift_baseline_YYYYMMDD.json
```

Minimum fields:

```json
{
  "created_at": "2026-05-06T11:51:20+09:00",
  "paths": [
    {
      "path": "/Users/kwak/Projects/ai/papercompany/papercompany-operations/scripts/alpha-prime-personal/data",
      "file_count": 384,
      "sample_files": []
    }
  ]
}
```

### Run-time drift check

After each Papercompany producer run:

1. Compare operations mirror files against baseline.
2. If new `data/market_signals`, `data/regime`, `reports/blog`, `reports/deep_dive`, `reports/strategy`, or `reports/.meta` artifacts appear under operations mirror, mark the run:
   - `failed` if canonical output is missing or conflicting;
   - `partial_with_path_drift` if canonical output exists but mirror also received new artifacts.
3. Record the path list in the canonical run receipt.

## 7. Oracle sync safety gate

Producer split and Oracle sync are separate. Do not run destructive sync until all checks below exist.

Required before destructive sync:

```text
sync_gazua_oracle_data.sh --dry-run --manifest <path>
delete default deny
us-stockflow preservation test
explicit allowlist of paths to upload/delete
post-sync backend API smoke
```

Known risk:

- `us-stockflow` deletion behavior has been flagged as fragile. Treat it as blocked until a preservation test proves safety.

## 8. Acceptance checks

A Papercompany Gazua producer run is accepted only when all applicable checks pass:

```bash
# runtime health
curl -fsS http://127.0.0.1:3200/api/health

# canonical run commands, dispatched by Papercompany or manually for smoke
cd /Users/kwak/Projects/ai/alpha-prime-personal
./venv/bin/python scripts/run_market_signals.py --market KR
./venv/bin/python scripts/run_market_signals.py --market US

# canonical validation
./venv/bin/python scripts/portfolio/watchlist_sync.py --validate
python -m json.tool data/gazua_handoff/KR_latest.json
python -m json.tool data/gazua_handoff/US_latest.json
python -m json.tool reports/.meta/gazua_artifact_index.json

# dashboard consumption
curl -fsS 'http://127.0.0.1:8011/api/overview?market=KR' | python -m json.tool
curl -fsS 'http://127.0.0.1:8011/api/overview?market=US' | python -m json.tool
curl -fsS 'http://127.0.0.1:8011/api/signals?market=KR' | python -m json.tool
curl -fsS 'http://127.0.0.1:8011/api/signals?market=US' | python -m json.tool
curl -fsS 'http://127.0.0.1:8011/api/reports?market=KR' | python -m json.tool
curl -fsS 'http://127.0.0.1:8011/api/reports?market=US' | python -m json.tool
```

Completion criteria:

- Papercompany workflow/tool-config shows explicit `--market KR` or `--market US` args.
- Output lands under `/Users/kwak/Projects/ai/alpha-prime-personal`.
- Canonical handoff/index exists, or absence is explicitly reported as `partial`.
- Validation entries pass.
- Path drift check passes or reports explicit `partial_with_path_drift`.
- Gazua dashboard can render from canonical artifacts even if Papercompany runtime telemetry is unavailable.
- Workflow result report separates config state, runtime state, canonical data state, and Gazua consumption state.

## 9. Implementation tasks

### Task A: Materialize inventory

- Query runtime/DB/API for Gazua workflows and tool-configs.
- Fill sections 2.1 and 2.2 tables.
- Save raw inventory as a timestamped JSON artifact under an appropriate Papercompany docs/artifact location.

### Task B: Choose execution boundary

- Prefer direct canonical execution.
- If blocked, document the exact blocker and use the thin wrapper requirements in section 3.

### Task C: Add telemetry wiring

- Pass market/run IDs into Alpha-Prime as env or step input metadata.
- Keep IDs out of Gazua primary data path.

### Task D: Add path-drift baseline/check

- Generate baseline manifest.
- Add run-time comparison and receipt fields.

### Task E: Split workflow dispatch

- Update KR morning workflow/tool-config to use `--market KR`.
- Update US evening workflow/tool-config to use `--market US`.
- Keep `ALL` only as manual fallback.

### Task F: Verify end-to-end

- Run KR and US dispatches in both orders.
- Confirm `delta_tracker.regime.by_market.KR` and `.US` survive both runs.
- Confirm Gazua market APIs return 200 with market-specific or explicit unsupported/fallback diagnostics.

## 10. Open decisions

- Exact workflow slugs/ids for KR morning, US evening, and sync/deploy.
- Exact Papercompany API/DB query to list tool-config records in this environment.
- Whether any wrapper is truly required, or direct canonical cwd can be used everywhere.
- Whether Alpha-Prime will use `watchlist_v2.preview.json` or migrate `watchlist.json` as market source of truth.
- Whether reports use filename prefixes or market directories.
- Where the canonical artifact index writer lands inside Alpha-Prime.

