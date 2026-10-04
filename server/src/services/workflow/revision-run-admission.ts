import { and, eq } from "drizzle-orm";
import { missions, workflowDefinitions, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { loadRevisionBoardWait, verifyRevisionDeltaBaseAtStart } from "../missions/revision-board-wait.js";
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
  // [Q7 시작시점 기준 재확인] 승인 뒤 기준 정의가 바뀌었으면 조용히 시작하지 않고 재승인을 요구한다.
  //   기존 이중 시작/승인 경쟁 보호(미션 행 잠금·PLAN-QA 권위 잠금·board-wait 현재-승인/기존 실행 검사)와
  //   함께 동작하며 대체하지 않는다. 이 함수는 사전 검사와 잠금 후 검사 양쪽에서 다시 호출되므로
  //   시작 순간의 기준 정의까지 같은 규칙(computePaqoDefinitionHash)으로 재확인된다.
  const base = await verifyRevisionDeltaBaseAtStart(db, input.companyId, revision.id);
  if (!base.ok) throw conflict(base.code, { workflowDefinitionId: base.workflowDefinitionId,
    approvedSnapshotHash: base.approvedSnapshotHash, currentSnapshotHash: base.currentSnapshotHash,
    requiresReapproval: true });
}
