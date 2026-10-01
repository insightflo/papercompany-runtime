import type { Db } from "@paperclipai/db";
import { buildMissionPlanningDescription, type MissionPlanningDescriptionInput } from "./mission-planning-description.js";
import { buildMissionRevisionContext } from "./mission-revision-context.js";

/** Used for both initial planning and bounded plan-submission revision. */
export async function buildRevisionMissionPlanningDescription(db: Pick<Db, "select">,
  input: MissionPlanningDescriptionInput & { companyId: string }) {
  const revisionContext = await buildMissionRevisionContext(db, input);
  const description = buildMissionPlanningDescription({ ...input, sourceRevisionContext: revisionContext });
  return revisionContext?.sourceWorkflowRunId ? `${description}\n\nRevision identity contract: every selectedExecutionUnits entry must include sourceStepId naming its exact source execution step. References must be unique and exist in the source run. Do not rename a step to evade failed configuration checks. Change structured execution configuration for failed steps; prose-only changes do not qualify. New unmapped plan units are not supported in this revision mode. The board chooses successful outputs to reuse after PLAN-QA; do not auto-start or self-seed.` : description;
}
