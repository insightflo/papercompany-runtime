# Board-approved revision output reuse

Audience: board operators. Purpose: reuse registered successful outputs without
rerunning their producer. Use the mission's Workflow tab to select completed source
results and start, or deliberately choose **재사용 없이 새로 시작**. Candidates are
advisory; the server verifies scope, configuration, original attempt and bytes again.

## Start a revision

1. Create a revision mission with `sourceMissionId` and `sourceWorkflowRunId`.
2. Wait for structured PLAN-QA approval. Revision PLAN creates its immutable PAQO
   definition but leaves execution to the board. The active plan's
   `refs.paqoWorkflow` contains `workflowDefinitionId`, `stepIds`, and
   `awaitingBoardStart: true`; `workflowRunId` is null until explicit start.
3. The Workflow tab offers candidates from `GET /api/missions/:id/revision-start`.
   For API operation, inspect the source run using `GET /api/workflow-runs/:runId/detail` and the
   target definition using `GET /api/workflows/:workflowId`.
4. Using board authentication, submit the target definition and revision mission:

```http
POST /api/workflows/<target-definition-id>/runs
Content-Type: application/json

{
  "missionId": "<revision-mission-id>",
  "seedFromRun": {
    "sourceWorkflowRunId": "<pinned-source-run-id>",
    "stepIds": ["write"]
  }
}
```

Omit `seedFromRun` to deliberately run fresh. Do not omit or substitute `missionId`:
revision PAQO definitions belong to their revision mission; mismatch returns HTTP 409
before mission/run creation. Do not send seed options inside `metadata`.
`triggeredBy: "board"` does not grant authority to an agent. The plugin native
`start-workflow` bridge forwards the same seed option and actual request actor.

## Supported seeds and refusal

- Same-company pinned source mission/run. Structured plan units must name their
  exact `sourceStepId`; generated target IDs are mapped explicitly, never by title.
  Existing IDs remain valid for static definitions. Source mappings must be unique
  and exist in the historical snapshot.
- Version 2 canonical configuration excludes presentation fields and maps dependency
  IDs/native machine references. Output contracts still must match for reuse.
- Ordinary agent producer steps only, with successful original heartbeat evidence.
- Ancestor-closed success DAG: selecting a child requires every forward ancestor.
- Registered local work products with stored SHA-256 matching current file bytes,
  inside the source mission output root; 32 MiB maximum per product.
- Tool consumers use explicit `workProductSelectors`. Agent input descriptions and
  execution-card evidence contain verified original product paths. QA stages copy
  source bytes into the new mission's request directory.

Errors return HTTP 422 with a `workflow_seed_*` or `mission_revision_*` code, or HTTP 403 for non-board
approval. No run/approval survives admission rejection. Later file mutation or
source retry refuses materialization/selection rather than adopting another file.
No source issue is attached to a completed target seed. The source is not changed.
Source run/step deletion is blocked by provenance foreign keys while referenced;
remove dependent target runs first if administratively deleting history.

## Repeat-failure policy and limits

A failed source step must remain explicitly mapped. Unchanged executable settings
are rejected before PLAN-QA/materialization and again atomically at run creation,
even with no seeds, a different target ID, a renamed title or changed prose.
Diagnostics contain the scoped heartbeat `errorCode`, source step/run and versioned
configuration hash. Missing historical snapshots or failed-step heartbeat evidence
fail closed. Change executable settings (agent/tools/arguments/dependencies/etc.),
not just promises in descriptions. Current revision planning requires every selected
unit to map to one existing source step: adding/removing failed units is not supported.

No automatic reuse, no tool/QA/control-node seeds, no legacy snapshot fallback,
and no cross-company reuse. Successful PAQO producer back-edges do not prevent
initial seeding; forward dependencies must still be selected. Native QA rework/retry
retires initial seed authority when the target attempt advances. Consumers then require
an officially admitted, current-attempt same-run product through an explicit selector;
missing new evidence never falls back to the original seed. The seed row remains audit
history, and active initial seeds still revalidate immutable source evidence.
For a second revision, configuration comparisons use the immediate source run's step
IDs, not that source run's older `sourceStepId` links. PAQO materialization validates
and preserves selectors/artifact contracts and remaps unit or source IDs together
with tool arguments.

Board waiting is derived from the scoped immutable definition, current structured
PLAN-QA approval and absence of a run, not `awaitingBoardStart` prose/metadata.
Supervision suppresses missing-materialization redispatch while this holds. Native
board admission rechecks readiness under the mission lock and rejects duplicate
starts. After start, the native run is authoritative; plan display refs may lag.
Task2 pre-release seed records without `stepConfigHashVersion: 2` fail closed; no
historical seed backfill is performed.
