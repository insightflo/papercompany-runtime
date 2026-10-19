/**
 * Existing run convergence and final writes; flag reads and post-finalization hooks stay in the DAG.
 * Branch order and terminal-effect ownership must remain unchanged when extending this boundary.
 */
import { eq } from "drizzle-orm";
import { workflowRuns, type Db, type workflowStepRuns } from "@paperclipai/db";
import type { WorkflowExecutionContext } from "./dag-engine.js";
import { isDynamicOwnerPlanWorkflowDefinition, type WorkflowDefinitionExecutionShape } from "./execution-steps.js";
import { executeTerminalEffectIntents, finalizeRunTerminal } from "./run-terminal-boundary.js";
import {
  logWorkflowRunFinalizationRefused,
  resolveWorkflowRunFinalizationGate,
} from "./workflow-cancel-bridge.js";
import { applyLinkedWorkflowRunFinalization, reloadWorkflowRunForFinalization } from "./workflow-child-native-finalization.js";
import { stopMissionRuntimesForMission, TERMINAL_WORKFLOW_STATUSES } from "../missions/mission-runtime-manager.js";
import { logActivity } from "../activity-log.js";

const WORKFLOW_STEP_TERMINAL_STATUSES = new Set(["completed", "failed", "skipped"]);

interface WorkflowRunFinalizationHooks {
  normalizeRecord(value: unknown): Record<string, unknown>;
  getDynamicLaunchStepIds(context: WorkflowExecutionContext): Set<string> | undefined;
  buildWorkflowDefinitionExecutionShape(context: WorkflowExecutionContext): WorkflowDefinitionExecutionShape;
}

export async function finalizeWorkflowRunState(
  db: Db,
  context: WorkflowExecutionContext,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
  boundaryEnabled: boolean,
  reopenGuardEnabled: boolean,
  hooks: WorkflowRunFinalizationHooks,
): Promise<typeof workflowRuns.$inferSelect> {
  const { normalizeRecord, getDynamicLaunchStepIds, buildWorkflowDefinitionExecutionShape } = hooks;
  // [run-terminal-boundary v1] failureCascadeSkipped 는 reconciler cascade 로 죽은 관측이다 —
  //   완료 스텝이 하나도 없는 런이 completed 로 재수렴하는 것을 항상 차단한다(플래그 무관).
  //   완료 스텝이 하나라도 있으면 실제 산출이 존재하므로 기존 수렴을 유지한다
  //   (workflow-failure-cascade-skip-sticky 계약 — sentinel 스텝은 종말 정산을 방해하지 않는다).
  //   아래 cancelled 분기 우선순위는 그대로 유지된다.
  const hasCascadeKill = stepRuns.some((stepRun) => normalizeRecord(stepRun.metadata).failureCascadeSkipped === true);
  const hasCompletedStep = stepRuns.some((stepRun) => stepRun.status === "completed");
  const hasFailedStep = stepRuns.some((stepRun) => stepRun.status === "failed")
    || (hasCascadeKill && !hasCompletedStep);
  const hasActiveStep = stepRuns.some((stepRun) => !WORKFLOW_STEP_TERMINAL_STATUSES.has(stepRun.status));
  const dynamicLaunchStepIds = getDynamicLaunchStepIds(context);
  const executableStepRuns = dynamicLaunchStepIds
    ? stepRuns.filter((stepRun) => dynamicLaunchStepIds.has(stepRun.stepId))
    : stepRuns;
  const executableHasActiveStep = executableStepRuns.some((stepRun) => !WORKFLOW_STEP_TERMINAL_STATUSES.has(stepRun.status));
  const allStepsTerminal = dynamicLaunchStepIds
    ? executableStepRuns.length === dynamicLaunchStepIds.size && !executableHasActiveStep
    : stepRuns.length === context.steps.length && !hasActiveStep;
  const nextStatus =
    context.run.status === "cancelled"
      ? "cancelled"
      : hasFailedStep && allStepsTerminal
        ? "failed"
        : !hasFailedStep && allStepsTerminal
          ? "completed"
          : "running";
  const patch: Partial<typeof workflowRuns.$inferInsert> = {
    status: nextStatus,
    startedAt: context.run.startedAt ?? new Date(),
    completedAt: nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled" ? new Date() : null,
  };

  const dynamicOwnerPlan = isDynamicOwnerPlanWorkflowDefinition(buildWorkflowDefinitionExecutionShape(context));
  // [descope D5][r9 §1] 링크 자식 최종 변이는 유한 writer(잠금 하 P→I→S→C + 대상 재평가)로만 — 0행/경합은 실패닫힌 관찰(내구 행 재적재).
  const gate = await resolveWorkflowRunFinalizationGate(db, { runId: context.run.id, companyId: context.run.companyId, nextStatus });
  let finalRun: typeof workflowRuns.$inferSelect;
  // 경계 분기가 최종화를 소유하면 legacy 미션 전역 stop 은 하지 않는다(스코프 대상만 효과로 실행).
  let boundaryHandledFinalization = false;
  if (gate.kind === "refused-invalid") {
    await logWorkflowRunFinalizationRefused(db, { companyId: context.run.companyId, runId: context.run.id, reason: gate.reason });
    finalRun = await reloadWorkflowRunForFinalization(db, { runId: context.run.id, companyId: context.run.companyId });
  } else if (gate.kind === "linked") {
    const result = await applyLinkedWorkflowRunFinalization(db, {
      bound: gate.bound, companyId: context.run.companyId, nextStatus,
      patch: { startedAt: patch.startedAt, completedAt: patch.completedAt }, boundWhere: gate.boundWhere,
    });
    if (result.outcome !== "updated" && nextStatus === "completed") {
      // 동일 종말 반복은 오염이 아니다 — 상실 사유만 구조화 감사에 남는다(실행/재시도 권위 없음 — 규칙 9).
      await logWorkflowRunFinalizationRefused(db, {
        companyId: context.run.companyId, runId: context.run.id,
        reason: `linked finalization gate lost (${result.outcome}: identity/status/receipt)`,
      });
    }
    finalRun = result.outcome === "updated"
      ? result.run
      : await reloadWorkflowRunForFinalization(db, { runId: context.run.id, companyId: context.run.companyId });
  } else if (boundaryEnabled && (nextStatus === "failed" || nextStatus === "completed" || nextStatus === "cancelled")) {
    // [run-terminal-boundary v1] plain 종결을 경계로 우회한다 — CAS/원인 스탬프/스코프 정지 대상
    //   캡처는 코어 계약(run-terminal-boundary.ts)이 소유한다. 유예(deferred)면 run 은 비종말로,
    //   stale/이미 종결이면 기존 상태로 남고 그 외 어떤 행도 건드리지 않는다.
    const boundary = await finalizeRunTerminal(db, {
      runId: context.run.id,
      companyId: context.run.companyId,
      expectedAuthorityVersion: context.run.dispatchAuthorityVersion,
      decision: nextStatus,
      cause: { policy: "outcome_convergence", discovery: "engine_recompute", origin: "dag_engine" },
      gatePolicy: nextStatus === "failed" ? "defer_on_open_recovery" : "immediate",
      now: new Date(),
      stepRuns,
      dynamicOwnerPlanCompleted: dynamicOwnerPlan && nextStatus === "completed",
    });
    finalRun = boundary.run;
    // [봇 지적 교정] legacy 종결 행(결정 기록 없음)의 already_finalized 는 대체 kill 인텐트도
    //   원결정의 효과도 없다 — legacy 와 동일하게 미션 스톱을 계속 맡기게 한다. 결정 기록이 있는
    //   already_finalized/finalized 만 경계가 부작용을 소유한다(스윕이 재처리).
    boundaryHandledFinalization = boundary.kind === "finalized"
      || (boundary.kind === "already_finalized" && boundary.existingDecision !== null);
    if (boundary.kind !== "finalized" && boundary.kind !== "already_finalized") {
      // [관측 계약] deferred/stale_authority 는 조용히 유실되지 않는다 — 구조화 감사로 남긴다.
      await logActivity(db, {
        companyId: context.run.companyId,
        actorType: "system",
        actorId: "dag-engine",
        action: "workflow_run.terminal_boundary_not_finalized",
        entityType: "workflow_run",
        entityId: context.run.id,
        details: {
          boundaryKind: boundary.kind,
          expectedAuthorityVersion: context.run.dispatchAuthorityVersion,
          currentAuthorityVersion: boundary.kind === "stale_authority" ? boundary.currentAuthorityVersion : undefined,
          gateKind: boundary.kind === "deferred" ? boundary.gateKind : undefined,
          computedDecision: nextStatus,
        },
      });
    }
    if (boundary.kind === "finalized") {
      try {
        await executeTerminalEffectIntents(db, boundary.decisionId);
      } catch (error) {
        // [규칙 8] 부작용 실행 실패는 관측일 뿐 권위가 아니다 — pending 인텐트는 reconciler sweep 이 재처리한다.
        await logActivity(db, {
          companyId: context.run.companyId,
          actorType: "system",
          actorId: "dag-engine",
          action: "workflow_run.terminal_effect_execution_failed",
          entityType: "workflow_run",
          entityId: context.run.id,
          details: {
            decisionId: boundary.decisionId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  } else if (
    // [run-reopen-guard v1] 재계산 부활 차단 — 종결 권위(completed/cancelled/aborted/failed/timed-out)는
    //   비종결 스텝 재계산 같은 관측 사실만으로 running 으로 부활하지 않는다. 쓰기 없이 종결 상태를
    //   유지하고 거부 사유만 구조화 감사에 남긴다(실행 권위 없음 — 규칙 8/9). 공식 재개는 회복 경로의
    //   소관이며, cancelled 분기는 위 nextStatus 우선순위가 이미 cancelled 로 수렴하므로 여기서 유지된다.
    reopenGuardEnabled
    && nextStatus === "running"
    && TERMINAL_WORKFLOW_STATUSES.has(context.run.status)
  ) {
    await logWorkflowRunFinalizationRefused(db, {
      companyId: context.run.companyId,
      runId: context.run.id,
      reason: "recompute revive refused — terminal authority stands (reopen requires the official recovery path)",
    });
    finalRun = await reloadWorkflowRunForFinalization(db, { runId: context.run.id, companyId: context.run.companyId });
  } else {
    const [updatedRun] = await db.update(workflowRuns).set(patch)
      .where(eq(workflowRuns.id, context.run.id)).returning();
    finalRun = updatedRun ?? { ...context.run, ...patch } as typeof workflowRuns.$inferSelect;
  }
  const missionId = finalRun.missionId;
  const shouldStopMissionRuntimes = !boundaryHandledFinalization
    && missionId !== null
    && TERMINAL_WORKFLOW_STATUSES.has(finalRun.status)
    && !(dynamicOwnerPlan && finalRun.status === "completed");
  if (shouldStopMissionRuntimes) {
    await stopMissionRuntimesForMission(db, {
      companyId: finalRun.companyId,
      missionId,
      reason: `workflow ${finalRun.id} ${finalRun.status}`,
    });
  }

  return finalRun;
}
