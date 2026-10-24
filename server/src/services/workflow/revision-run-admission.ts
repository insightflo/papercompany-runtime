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
  const waiting = await loadRevisionBoardWait(db, input.companyId, revision.id);
  // [승인=시작 묶음 2026-10-22] 보드 클릭이 정본이다. 보드 외 액터는 “현재 대기 중 수정안의 해시와
  //   일치하는 승인”만으로 시작할 수 있다 — moi 카드 create 시점에 서버가 sourceContext.planDecisionHash
  //   로 찍은 값이 현재 board-wait 해시와 같아야 한다(revision-board-wait). 과거 수정안에 대한 승인·해시
  //   없는 구형 카드 승인은 인정하지 않는다: 수정안이 바뀌면 해시가 바뀌어 새 사람 승인이 필요하다.
  if (actor?.type !== "board") {
    const authorized = waiting !== null && waiting.workflowDefinitionId === input.workflowId
      && await hasResolvedRevisionApproval(db, input.companyId, revision.id, waiting.decisionHash);
    if (!authorized) throw conflict("workflow_revision_board_start_required");
  }
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

/** 이 수정 미션에 대해 사람이 운영자 결정을 "승인"(outcome approve)으로 resolve 했고, 그 카드가
 *  생성 시점에 서버가 찍은 활성 계획 해시(planDecisionHash)가 현재 대기 해시와 일치하는지.
 *  시작 권한의 근거이며, 일치하지 않으면(과거 수정안 승인·해시 없는 구형 카드) 보드 외 시작은 거절된다. */
export async function hasResolvedRevisionApproval(db: Db, companyId: string, missionId: string,
  planDecisionHash: string): Promise<boolean> {
  const [row] = await db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, companyId),
    eq(operatorDecisions.status, "resolved"),
    eq(operatorDecisions.sourceType, MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE),
    sql`${operatorDecisions.sourceContext}->>'missionId' = ${missionId}`,
    sql`${operatorDecisions.sourceContext}->>'planDecisionHash' = ${planDecisionHash}`,
    sql`${operatorDecisions.result}->>'outcome' = 'approve'`,
  )).limit(1);
  return Boolean(row);
}
