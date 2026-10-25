import { and, eq, isNull } from "drizzle-orm";
import { activityLog, issues, workflowRuns, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { workflowService } from "../workflow/engine.js";

/** 보드가 구조화된 재시작 선택지를 승인한 경우에만 새 최상위 실행을 시작한다.
 *  sourceContext의 실행 ID가 권위 원본이며 카드 설명·댓글·nextAction은 읽지 않는다. */
export async function startWorkflowRestartFromOperatorDecision(db: Db, input: {
  companyId: string;
  missionId: string;
  sourceWorkflowRunId: string;
  operatorDecisionId: string;
  resolvedByUserId: string;
  issueId: string | null;
}) {
  const [source] = await db.select().from(workflowRuns).where(and(
    eq(workflowRuns.id, input.sourceWorkflowRunId),
    eq(workflowRuns.companyId, input.companyId),
    eq(workflowRuns.missionId, input.missionId),
    isNull(workflowRuns.parentRunId),
  )).limit(1);
  if (!source || source.status !== "failed") {
    throw conflict("workflow_restart_source_not_failed");
  }

  if (input.issueId) {
    await db.update(issues).set({
      status: "todo",
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(issues.id, input.issueId),
      eq(issues.companyId, input.companyId),
      eq(issues.missionId, input.missionId),
      eq(issues.status, "blocked"),
    ));
  }

  const result = await workflowService.trigger(db, {
    companyId: input.companyId,
    workflowId: source.workflowId,
    missionId: input.missionId,
    runDate: source.runDate,
    triggeredBy: "operator_decision_approval",
    triggerSource: "operator_decision",
    metadata: {
      operatorDecisionRestart: {
        schemaVersion: 1,
        operatorDecisionId: input.operatorDecisionId,
        sourceWorkflowRunId: source.id,
      },
    },
  }, { actor: { type: "none" } });

  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "user",
    actorId: input.resolvedByUserId,
    action: "workflow_run.created",
    entityType: "workflow_run",
    entityId: result.runId,
    details: {
      workflowId: source.workflowId,
      missionId: input.missionId,
      sourceWorkflowRunId: source.id,
      operatorDecisionId: input.operatorDecisionId,
      trigger: "operator_decision_restart_from_start",
    },
  });
  return result;
}
