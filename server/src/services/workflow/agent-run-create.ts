import { and, eq } from "drizzle-orm";
import { missions, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { assertAgentReplacementRequired, type TriggerActor } from "./replacement-admission.js";
import { createWorkflowRun } from "./workflow-store.js";
import type { CreateWorkflowRunInput } from "./types.js";

export async function createAdmittedWorkflowRun(db: Db, input: CreateWorkflowRunInput, actor?: TriggerActor) {
  if (input.metadata && ("replacementAuthorityId" in input.metadata || "executionDefinitionVersion" in input.metadata)) throw conflict("workflow_reserved_metadata");
  if (actor?.type !== "agent" || !input.missionId) return createWorkflowRun(db, input);
  return db.transaction(async (tx) => {
    const [mission] = await tx.select().from(missions).where(and(eq(missions.id, input.missionId!), eq(missions.companyId, input.companyId))).for("update");
    if (!mission || mission.status === "cancelled") throw conflict("workflow_mission_cancelled");
    await assertAgentReplacementRequired(tx as unknown as Db, input, actor);
    return createWorkflowRun(tx as unknown as Db, input);
  });
}
