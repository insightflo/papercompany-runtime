import type { Db } from "@paperclipai/db";
import { buildMissionPlanningDescription, type MissionPlanningDescriptionInput } from "./mission-planning-description.js";
import { buildMissionRevisionContext } from "./mission-revision-context.js";

/** Used for both initial planning and bounded plan-submission revision. */
export async function buildRevisionMissionPlanningDescription(db: Pick<Db, "select">,
  input: MissionPlanningDescriptionInput & { companyId: string }) {
  const revisionContext = await buildMissionRevisionContext(db, input);
  return buildMissionPlanningDescription({ ...input, sourceRevisionContext: revisionContext });
}
