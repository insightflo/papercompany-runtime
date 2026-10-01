import { and, eq } from "drizzle-orm";
import { missions, workflowDefinitions, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { loadRevisionBoardWait } from "../missions/revision-board-wait.js";
import type { CreateWorkflowRunInput } from "./types.js";
import type { TriggerActor } from "./replacement-admission.js";

export async function assertRevisionBoardStart(db: Db, input: CreateWorkflowRunInput, actor?: TriggerActor) {
  const [revision] = await db.select({ id: missions.id, sourceMissionId: missions.sourceMissionId }).from(workflowDefinitions)
    .innerJoin(missions, eq(workflowDefinitions.missionId, missions.id))
    .where(and(eq(missions.companyId, input.companyId), eq(workflowDefinitions.companyId, input.companyId),
      eq(workflowDefinitions.id, input.workflowId), eq(workflowDefinitions.sourceKind, "paqo")));
  if (!revision?.sourceMissionId) return;
  if (input.missionId !== revision.id) throw conflict("workflow_revision_mission_mismatch");
  if (actor?.type !== "board") throw conflict("workflow_revision_board_start_required");
  const waiting = await loadRevisionBoardWait(db, input.companyId, revision.id);
  if (waiting?.workflowDefinitionId !== input.workflowId) throw conflict("workflow_revision_board_start_not_ready");
}
