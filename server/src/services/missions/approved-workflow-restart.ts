import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { activityLog, issues, operatorDecisions, workflowRuns, type Db } from "@paperclipai/db";
import type { OperatorDecisionResult } from "@paperclipai/shared/types/operator-decision";
import { conflict } from "../../errors.js";
import {
  evaluateRecoveryAdviceIdentity,
  loadRecoveryAdviceIdentityFacts,
  recoveryAdviceStoredInput,
  type RecoveryAdviceDecision,
} from "../operator-decision-recovery-advice.js";
import { sameOperatorDecisionResult, validateOperatorDecisionResult } from "../operator-decision-result.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID, WORKFLOW_RESTART_FROM_START_SCOPE } from "./workflow-restart-option.js";
import { workflowService } from "../workflow/engine.js";

const heldMessage = "이미 수행한 작업을 보존하기 위해 재시작하지 않았습니다. 현재 결정은 전체 수집 또는 처음부터 재시작할 권한과 근거를 확인해 주지 못합니다.";
export const holdUnprovenRestart = (operatorDecisionId: string): never => {
  throw conflict(heldMessage, { code: "recovery_restart_scope_unproven", operatorDecisionId });
};

export function assertExactBoardWorkflowRestartPolicy(
  decision: RecoveryAdviceDecision,
  result: OperatorDecisionResult,
  input: { companyId: string; missionId: string; sourceWorkflowRunId: string },
): void {
  const original = recoveryAdviceStoredInput(decision);
  if (!original || decision.companyId !== input.companyId || decision.sourceType !== "workflow_restart_request_v1"
    || decision.requestedByAgentId !== null || decision.requestedByUserId === null
    || decision.qualityActionId !== null || decision.qualityBinding !== null
    || decision.sourceId !== input.sourceWorkflowRunId
    || original.sourceContext.missionId !== input.missionId
    || original.sourceContext.workflowRunId !== input.sourceWorkflowRunId
    || !original.definition.approvedScope.includes(WORKFLOW_RESTART_FROM_START_SCOPE)
    || !["approve", "submit"].includes(result.outcome)
    || !result.selectedOptionIds.includes(WORKFLOW_RESTART_FROM_START_OPTION_ID)) {
    holdUnprovenRestart(decision.id);
  }
}

function assertRecoveryRestartAdvice(decision: RecoveryAdviceDecision, facts: Awaited<ReturnType<typeof loadRecoveryAdviceIdentityFacts>>): void {
  const advice = facts
    ? evaluateRecoveryAdviceIdentity({ card: decision, ...facts })
    : evaluateRecoveryAdviceIdentity({ kind: "outside_default_scope", card: decision });
  if (advice.disposition !== "outside_default_scope") holdUnprovenRestart(decision.id);
}

/** 보드가 구조화된 재시작 선택지를 승인한 경우에만 새 최상위 실행을 시작한다.
 *  sourceContext의 실행 ID가 권위 원본이며 카드 설명·댓글·nextAction은 읽지 않는다. */
export async function startWorkflowRestartFromOperatorDecision(db: Db, input: {
  companyId: string;
  missionId: string;
  sourceWorkflowRunId: string;
  operatorDecisionId: string;
  resolvedByUserId: string;
  issueId: string | null;
  decisionRequestHash?: string;
  decisionResult?: OperatorDecisionResult;
}) {
  const [decision] = await db.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.id, input.operatorDecisionId), eq(operatorDecisions.companyId, input.companyId),
  ));
  if (!decision) throw conflict("재시작 요청과 저장된 운영자 결정을 확인할 수 없습니다. 재시작은 수행되지 않았습니다.", {
    code: "workflow_restart_decision_binding_invalid", operatorDecisionId: input.operatorDecisionId,
  });
  let persistedResult: OperatorDecisionResult;
  try {
    if (!input.decisionResult || !input.decisionRequestHash
      || decision.status !== "resolved" || decision.resolvedByUserId !== input.resolvedByUserId
      || decision.issueId !== input.issueId || decision.requestHash !== input.decisionRequestHash
      || decision.result === null || !sameOperatorDecisionResult(decision.result, input.decisionResult)
      || decision.sourceContext.missionId !== input.missionId
      || decision.sourceContext.workflowRunId !== input.sourceWorkflowRunId) {
      throw new Error("restart decision binding mismatch");
    }
    const savedResultInput = {
      actionId: decision.result.actionId,
      selectedOptionIds: decision.result.selectedOptionIds,
      comment: decision.result.comment,
    };
    persistedResult = validateOperatorDecisionResult(decision.definition, savedResultInput);
    if (!sameOperatorDecisionResult(persistedResult, decision.result)
      || !sameOperatorDecisionResult(persistedResult, input.decisionResult)
      || !persistedResult.selectedOptionIds.includes(WORKFLOW_RESTART_FROM_START_OPTION_ID)) {
      throw new Error("restart result mismatch");
    }
  } catch {
    throw conflict("재시작 요청과 저장된 운영자 결정이 일치하지 않습니다. 재시작을 수행하지 않았으며 기존 작업은 보존됩니다.", {
      code: "workflow_restart_decision_binding_invalid", operatorDecisionId: input.operatorDecisionId,
    });
  }

  const facts = await loadRecoveryAdviceIdentityFacts(db, decision);
  assertRecoveryRestartAdvice(decision, facts);
  assertExactBoardWorkflowRestartPolicy(decision, persistedResult, input);

  const [source] = await db.select().from(workflowRuns).where(and(
    eq(workflowRuns.id, input.sourceWorkflowRunId),
    eq(workflowRuns.companyId, input.companyId),
    eq(workflowRuns.missionId, input.missionId),
    isNull(workflowRuns.parentRunId),
  )).limit(1).for("update");
  if (!source || source.status !== "failed") {
    throw conflict("workflow_restart_source_not_failed");
  }
  const [activeReplacement] = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
    eq(workflowRuns.companyId, input.companyId),
    eq(workflowRuns.missionId, input.missionId),
    eq(workflowRuns.workflowId, source.workflowId),
    isNull(workflowRuns.parentRunId),
    ne(workflowRuns.id, source.id),
    or(
      inArray(workflowRuns.status, ["pending", "running"]),
      sql`${workflowRuns.metadata}->'operatorDecisionRestart'->>'sourceWorkflowRunId' = ${source.id}`,
    ),
  )).limit(1);
  if (activeReplacement) {
    throw conflict("workflow_restart_active_replacement_exists", { workflowRunId: activeReplacement.id });
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
