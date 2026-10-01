import { and, eq } from "drizzle-orm";
import { missions, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { assertAgentReplacementRequired, type TriggerActor } from "./replacement-admission.js";
import { createWorkflowRun } from "./workflow-store.js";
import { assertSeedActor, createSeededWorkflowRun } from "./workflow-seed-admission.js";
import type { CreateWorkflowRunInput } from "./types.js";
import { assertRevisionBoardStart } from "./revision-run-admission.js";
import { lockMissionPlanQaAuthority } from "../missions/plan-qa-admission-lock.js";

export async function createAdmittedWorkflowRun(db: Db, input: CreateWorkflowRunInput, actor?: TriggerActor) {
  assertSeedActor(input, actor);
  await assertRevisionBoardStart(db, input, actor);
  if (input.metadata && ("replacementAuthorityId" in input.metadata || "executionDefinitionVersion" in input.metadata)) throw conflict("workflow_reserved_metadata");
  if (input.missionId) return db.transaction(async tx => {
    const t = tx as unknown as Db;
    const [mission] = await tx.select().from(missions).where(and(eq(missions.id, input.missionId!), eq(missions.companyId, input.companyId))).for("update");
    if ((actor?.type === "agent" || mission?.sourceMissionId) && (!mission || mission.status === "cancelled")) throw conflict("workflow_mission_cancelled");
    if (mission?.sourceMissionId) await lockMissionPlanQaAuthority(t, input.companyId, mission.id);
    await assertRevisionBoardStart(t, input, actor);
    if (input.seedFromRun) return createSeededWorkflowRun(t, input, actor);
    if (actor?.type === "agent") await assertAgentReplacementRequired(t, input, actor);
    return createWorkflowRun(t, input);
  });
  if (input.seedFromRun) return createSeededWorkflowRun(db, input, actor);
  return createWorkflowRun(db, input);
}
