# Board-approved revision output reuse

Audience: board operators. Purpose: reuse registered successful outputs without
rerunning their producer. This API path is available before a dedicated UI picker.

## Start a revision

1. Create a revision mission with `sourceMissionId` and `sourceWorkflowRunId`.
2. Wait for structured PLAN-QA approval. Revision PLAN creates its immutable PAQO
   definition but leaves execution to the board. The active plan's
   `refs.paqoWorkflow` contains `workflowDefinitionId`, `stepIds`, and
   `awaitingBoardStart: true`; `workflowRunId` is null until explicit start.
3. Inspect the source run using `GET /api/workflow-runs/:runId/detail` and the
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

Omit `seedFromRun` to deliberately run fresh. Do not send it inside `metadata`.
`triggeredBy: "board"` does not grant authority to an agent. The plugin native
`start-workflow` bridge forwards the same seed option and actual request actor.

## Supported seeds and refusal

- Same-company linked source mission/run; identical source/target step IDs and
  complete canonical execution configurations from historical snapshots.
- Ordinary agent producer steps only, with successful original heartbeat evidence.
- Ancestor-closed success DAG: selecting a child requires every forward ancestor.
- Registered local work products with stored SHA-256 matching current file bytes,
  inside the source mission output root; 32 MiB maximum per product.
- Tool consumers use explicit `workProductSelectors`. Agent input descriptions and
  execution-card evidence contain verified original product paths. QA stages copy
  source bytes into the new mission's request directory.

Errors return HTTP 422 with a `workflow_seed_*` code, or HTTP 403 for non-board
approval. No run/approval survives admission rejection. Later file mutation or
source retry refuses materialization/selection rather than adopting another file.
No source issue is attached to a completed target seed. The source is not changed.
Source run/step deletion is blocked by provenance foreign keys while referenced;
remove dependent target runs first if administratively deleting history.

## Current limitations / follow-up

Mission-generated PAQO step IDs include the mission ID. Task2 does **not** infer a
mapping from names/titles, nor weaken configuration equality. Such generated plans
cannot reuse steps until Task3 supplies explicit source-step identity and a
compatible canonical mapping. The board can still start them fresh. Static
revision definitions retaining source IDs can reuse outputs now.

No automatic reuse, no tool/QA/control-node seeds, no legacy snapshot fallback,
and no cross-company reuse. The repeat-failure guard is separate Task3 work.
After board start, the native workflow run is authoritative; an older plan display
marker is not execution authority. This change does not guarantee every existing
supervision display/reconciliation path treats board waiting as an operator wait.
