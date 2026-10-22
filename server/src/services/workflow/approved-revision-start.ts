import { and, eq, isNotNull } from "drizzle-orm";
import { missions, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import { loadRevisionBoardWait } from "../missions/revision-board-wait.js";
import { workflowService } from "./engine.js";
import { hasResolvedRevisionApproval } from "./revision-run-admission.js";

export interface ApprovedRevisionStartResult {
  started: boolean;
  runId?: string;
  reason?: "not_waiting" | "no_approval" | "already_started" | "reapproval_required";
}

const ALREADY_STARTED = new Set(["workflow_revision_board_start_not_ready", "workflow_revision_already_started"]);

/** 사람이 "승인"한 수정 미션의 대기 중 실행을 시작한다(보드 버튼과 같은 trigger 경로).
 *  대기 객체가 없거나(이미 시작됨 포함) 승인 기록이 없으면 아무것도 하지 않는다(멱등). */
export async function startApprovedRevisionRun(db: Db, input: {
  companyId: string; missionId: string;
}): Promise<ApprovedRevisionStartResult> {
  const waiting = await loadRevisionBoardWait(db, input.companyId, input.missionId);
  if (!waiting) return { started: false, reason: "not_waiting" };
  if (!await hasResolvedRevisionApproval(db, input.companyId, input.missionId)) {
    return { started: false, reason: "no_approval" };
  }
  try {
    const result = await workflowService.trigger(db, {
      companyId: input.companyId,
      workflowId: waiting.workflowDefinitionId,
      missionId: input.missionId,
      triggeredBy: "operator_decision_approval",
    }, { actor: { type: "none" } });
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "system:operator-decision-approval",
      action: "workflow_run.created",
      entityType: "workflow_run",
      entityId: result.runId,
      details: { workflowId: waiting.workflowDefinitionId, missionId: input.missionId,
        trigger: "operator_decision_approval" },
    });
    return { started: true, runId: result.runId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 잠금 후 재검사에서 진 동시 시작은 이미 시작된 것과 같다(기존 이중 시작 보호 계약).
    if (ALREADY_STARTED.has(message)) return { started: false, reason: "already_started" };
    if (message === "workflow_revision_base_definition_changed") {
      logger.warn({ companyId: input.companyId, missionId: input.missionId },
        "approved revision start skipped: base definition changed, reapproval required");
      return { started: false, reason: "reapproval_required" };
    }
    throw err;
  }
}

/** 이미 승인됐지만 실행이 시작되지 않은 수정 미션을 소급 시작한다(모니터 주기 호출, 실패 격리). */
export async function sweepApprovedRevisionStarts(db: Db): Promise<number> {
  const rows = await db.select({ id: missions.id, companyId: missions.companyId }).from(missions)
    .where(and(eq(missions.status, "active"), isNotNull(missions.sourceMissionId)));
  let started = 0;
  for (const row of rows) {
    try {
      if ((await startApprovedRevisionRun(db, { companyId: row.companyId, missionId: row.id })).started) started += 1;
    } catch (err) {
      logger.warn({ err, missionId: row.id }, "approved revision start sweep failed for mission");
    }
  }
  return started;
}
