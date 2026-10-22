import { and, eq, sql } from "drizzle-orm";
import { missions, operatorDecisions, workflowDefinitions, type Db } from "@paperclipai/db";
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
  // [승인=시작 2026-10-22] 보드 클릭이 정본이지만, 사람이 운영자 결정에서 "승인"(outcome approve)한
  //   기록이 있으면 그 승인이 시작 권한을 대신한다(승인 카드의 "오너가 다음 단계를 진행" 문구와 일치).
  //   승인 기록이 없으면 기존대로 거절해 보드 대기 우회는 불가능하다.
  if (actor?.type !== "board" && !await hasResolvedRevisionApproval(db, input.companyId, revision.id)) {
    throw conflict("workflow_revision_board_start_required");
  }
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

// missions/mission-owner-human-input-card.ts 가 생산하는 소스 타입과 같은 값(순환 import 회피로 복제).
const MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE = "mission_owner_human_input";

/** 이 수정 미션에 대해 사람이 운영자 결정을 "승인"(outcome approve)으로 resolve 한 기록이 있는지.
 *  시작 권한의 근거이며, 승인 없이는 보드 외 액터의 수정 런 시작이 거절된다. */
export async function hasResolvedRevisionApproval(db: Db, companyId: string, missionId: string): Promise<boolean> {
  const [row] = await db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, companyId),
    eq(operatorDecisions.status, "resolved"),
    eq(operatorDecisions.sourceType, MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE),
    sql`${operatorDecisions.sourceContext}->>'missionId' = ${missionId}`,
    sql`${operatorDecisions.result}->>'outcome' = 'approve'`,
  )).limit(1);
  return Boolean(row);
}
