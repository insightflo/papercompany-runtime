import { and, eq } from "drizzle-orm";
import { missions, workflowDefinitions, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { assertAgentReplacementRequired, type TriggerActor } from "./replacement-admission.js";
import { createWorkflowRun } from "./workflow-store.js";
import { assertSeedActor, createSeededWorkflowRun } from "./workflow-seed-admission.js";
import type { CreateWorkflowRunInput } from "./types.js";

export async function createAdmittedWorkflowRun(db: Db, input: CreateWorkflowRunInput, actor?: TriggerActor) {
  assertSeedActor(input, actor);
  if (input.metadata && ("replacementAuthorityId" in input.metadata || "executionDefinitionVersion" in input.metadata)) throw conflict("workflow_reserved_metadata");
  if (input.seedFromRun) return createSeededWorkflowRun(db, input, actor);
  if (input.missionId && actor?.type !== "board") {
    const [revision] = await db.select({ sourceMissionId: missions.sourceMissionId }).from(missions)
      .innerJoin(workflowDefinitions, eq(workflowDefinitions.missionId, missions.id))
      .where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId),
        eq(workflowDefinitions.id, input.workflowId), eq(workflowDefinitions.sourceKind, "paqo")));
    if (revision?.sourceMissionId) throw conflict("workflow_revision_board_start_required");
  }
  if (actor?.type !== "agent" || !input.missionId) return createWorkflowRun(db, input);
  return db.transaction(async (tx) => {
    const [mission] = await tx.select().from(missions).where(and(eq(missions.id, input.missionId!), eq(missions.companyId, input.companyId))).for("update");
    if (!mission || mission.status === "cancelled") throw conflict("workflow_mission_cancelled");
    await assertAgentReplacementRequired(tx as unknown as Db, input, actor);
    return createWorkflowRun(tx as unknown as Db, input);
  });
}
