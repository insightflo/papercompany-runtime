import { and, eq } from "drizzle-orm";
import { missions, workflowDefinitions, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { loadRevisionBoardWait } from "../missions/revision-board-wait.js";
import type { CreateWorkflowRunInput } from "./types.js";
import type { TriggerActor } from "./replacement-admission.js";

export async function assertRevisionBoardStart(db: Db, input: CreateWorkflowRunInput, actor?: TriggerActor) {
  if (!input.missionId) return;
  const [revision] = await db.select({ sourceMissionId: missions.sourceMissionId }).from(missions)
    .innerJoin(workflowDefinitions, eq(workflowDefinitions.missionId, missions.id))
    .where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId),
      eq(workflowDefinitions.id, input.workflowId), eq(workflowDefinitions.sourceKind, "paqo")));
  if (!revision?.sourceMissionId) return;
  if (actor?.type !== "board") throw conflict("workflow_revision_board_start_required");
  const waiting = await loadRevisionBoardWait(db, input.companyId, input.missionId);
  if (waiting?.workflowDefinitionId !== input.workflowId) throw conflict("workflow_revision_board_start_not_ready");
}
