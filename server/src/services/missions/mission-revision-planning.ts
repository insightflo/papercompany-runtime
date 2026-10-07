import type { Db } from "@paperclipai/db";
import { MISSION_REVISION_DELTA_SCHEMA_VERSION, type MissionRevisionDelta } from "@paperclipai/shared/validators/mission-revision";
import { buildMissionPlanningDescription, type MissionPlanningDescriptionInput } from "./mission-planning-description.js";
import { buildMissionRevisionContext } from "./mission-revision-context.js";

/** Used for both initial planning and bounded plan-submission revision.
 *  [Q5] 매핑 규칙 안내는 실제 계약과 일치해야 한다 — sourceStepId 는 원본 단계 재사용/재실행/수정에만
 *  필요하고 새 unmapped 단위(예: 새 수집 대상)는 허용된다. 예전 '새 unmapped 단계 금지' 문구는 새 수집
 *  계획과 모순되어 제거했다. */
export async function buildRevisionMissionPlanningDescription(db: Pick<Db, "select">,
  input: MissionPlanningDescriptionInput & { companyId: string }) {
  const revisionContext = await buildMissionRevisionContext(db, input);
  const description = buildMissionPlanningDescription({ ...input, sourceRevisionContext: revisionContext });
  if (!revisionContext?.sourceWorkflowRunId) return description;
  const revisionDeltaExample = {
    schemaVersion: MISSION_REVISION_DELTA_SCHEMA_VERSION,
    sourceWorkflowRunId: revisionContext.sourceWorkflowRunId,
    base: { workflowDefinitionId: "<selected-current-template-definition-uuid>", snapshotHash: "<actual-frozen-definition-sha256>" },
    units: [{ unitId: "<exact-source-step-id>", operation: "reuse", sourceStepId: "<exact-source-step-id>" }],
  } satisfies MissionRevisionDelta;
  const deltaGuidance = [
    "## Optional revision change declaration",
    "For declared revision reuse/change semantics, emit optional top-level revisionDelta on decision (alongside selectedExecutionUnits, not inside a unit). Legacy decisions without revisionDelta remain accepted; sourceStepId alone does not request snapshot copying. Never invent a delta or base provenance.",
    `Use schemaVersion \"${MISSION_REVISION_DELTA_SCHEMA_VERSION}\", sourceWorkflowRunId from this revision context, base: {workflowDefinitionId, snapshotHash}, and a nonempty units array.`,
    "base must name the explicitly selected CURRENT same-company template definition and its actual frozen-definition SHA-256 hash, not a guessed historical/source definition. Replace documentation placeholders only with verified provenance before submission.",
    "Each delta unit uses unitId matching selectedExecutionUnits.id, operation: reuse | rerun | modify | add | clone | blocked. Reuse is exactly {unitId, operation: reuse, sourceStepId} with unitId === sourceStepId; its selected entry is separately exactly {id, sourceStepId}. Do not author configuration for copied A or closure ancestors.",
    "For B units, existing optional fields are templateStepId (current-template material, not source provenance/approval), sourceStepId, instructions, interpretedInputs, requiredInputs: [{fromUnitId, selector}], collectionScope: oneShot | permanentChange. Optional root capabilityRequirements: [{unitId, requiredOutcomeId, toolName, capability}]. Declare only actual changes and inputs using this existing contract.",
    "Example optional top-level declaration to merge into decision; placeholders are documentation, not usable evidence:",
    "```json", JSON.stringify({ revisionDelta: revisionDeltaExample }, null, 2), "```",
  ].join("\n");
  return `${description}\n\n${deltaGuidance}\n\nRevision identity contract: entries that reuse, rerun or modify an original execution step must include sourceStepId naming its exact source execution step. References must be unique and exist in the source run. New unmapped plan units (work absent from the original run, e.g. a new collection target) are allowed and carry no sourceStepId. Verbatim reuse (operation "reuse") is identity-only: the selectedExecutionUnits entry carries exactly {id, sourceStepId} with id === sourceStepId (no instructions, description, reason, contract, assignee, toolArgs, interpretedInputs or dependencies) — the server copies the step's configuration from the source run's historical snapshot, adds its dependency-closure ancestors as server-owned units, and the board later chooses which copied outputs to seed. Fresh/changed units must be authored as B (modify/rerun/add/clone) and consume A through explicit dependencies, workProductSelectors and exact {$steps.<id>.<field>} tokens. A fresh QA unit that must inherit a historical QA step id referenced by copied A back-edges declares that id as its sourceStepId; the mission-final QA may inherit the one remaining unambiguous id. The server adds the reuse root's dependency-closure ancestors as copied A too: do not author any plan/delta entry (modify/rerun/add or otherwise) for those ancestors — such conflicting entries are rejected, and copied targets are identity-only. Declare collection-target additions (add/clone units) with collectionScope: "oneShot" (collect once in this run only — the periodic definition and its collection watermark stay unchanged) or "permanentChange" (permanent periodic-definition change request — recorded as a separate-scope request, never silently applied). Do not rename a step to evade failed configuration checks. Change structured execution configuration for failed steps; prose-only changes do not qualify. The board chooses successful outputs to reuse after PLAN-QA; do not auto-start or self-seed.`;
}
