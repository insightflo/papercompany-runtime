import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { buildStepRunMap, toConditionalStepObservation } from "./dag-step-observation.js";
import { buildPredFactsMap, type ValidationVerdictObservation } from "./dag-readiness-facts.js";
import { findSkippableSteps, resolveEdges, workflowHasConditionalEdges } from "./control-flow/edge-condition.js";
import { settleConditionalSkip } from "./conditional-skip-settlement.js";
import { reloadWorkflowStepRunsForSameRun } from "./workproduct-dependency-gate.js";
import { isStructuralGateStep } from "./control-flow/structural-gate.js";
import type { WorkflowStep, WorkflowExecutionContext } from "./dag-engine.js";
import { buildWorkflowStepRunMetadata } from "./workflow-step-run-maintenance.js";

function hasRecoverableQaRequestChangesDependency(
  step: WorkflowStep,
  steps: WorkflowStep[],
  stepRunMap: Map<string, typeof workflowStepRuns.$inferSelect>,
  validationVerdictsByIssueId: Map<string, ValidationVerdictObservation>,
): boolean {
  const predsByStepId = buildPredFactsMap(steps, stepRunMap, validationVerdictsByIssueId);
  const incomingEdges = resolveEdges(step).filter((edge) => edge.isBackEdge !== true);
  for (const edge of incomingEdges) {
    const pred = predsByStepId.get(edge.stepId);
    if (
      pred?.status !== "failed"
      || pred.isQaGate !== true
      || pred.verdict !== "request_changes"
      || (edge.when ?? "success") !== "success"
    ) {
      continue;
    }

    const hasRemainingBackEdgeRework = steps.some((candidate) => {
      const candidateRun = stepRunMap.get(candidate.id);
      if (!candidateRun) return false;
      return resolveEdges(candidate).some((candidateEdge) => {
        if (
          candidateEdge.isBackEdge !== true
          || candidateEdge.stepId !== edge.stepId
          || candidateEdge.when !== "qa_request_changes"
          || typeof candidateEdge.maxIterations !== "number"
        ) {
          return false;
        }
        return (candidateRun.iterationIndex ?? 0) < candidateEdge.maxIterations;
      });
    });
    if (hasRemainingBackEdgeRework) return true;
  }
  return false;
}

export async function applyConditionalSkipPropagation(input: {
  db: Db;
  context: WorkflowExecutionContext;
  stepRuns: (typeof workflowStepRuns.$inferSelect)[];
  dynamicLaunchStepIds?: Set<string>;
  validationVerdictsByIssueId: Map<string, ValidationVerdictObservation>;
  // [B2 사실망 통일] launch(findRunnableSteps)와 동일한 v1 enforcement 정책 스냅샷. 같은 sync 평가에서
  //   세 경로가 같은 사실망(dispatch_ready_at 포함)을 소비하게 한다 — 평가 중 재계산/혼합 금지.
  v1EnforcementEnabled: boolean;
  // [B2 좁은 회복 채널] 실패 선행의 연결 이슈 상태 스냅샷 — v1 대기 규칙을 failed 선행에 좁게
  //   적용하기 위한 최소 사실 전달. 미공급 시 fail-closed 로 open 취급(기존 대기 유지).
  issueStatusByIssueId?: Map<string, string>;
}): Promise<{ stepRuns: (typeof workflowStepRuns.$inferSelect)[]; cancelled: boolean }> {
  if (input.context.run.status === "cancelled" || !workflowHasConditionalEdges(input.context.steps)) {
    return { stepRuns: input.stepRuns, cancelled: false };
  }
  let stepRuns = input.stepRuns;
  for (;;) {
    const skipRunMap = buildStepRunMap(stepRuns);
    const skipPredsByStepId = buildPredFactsMap(
      input.context.steps,
      skipRunMap,
      input.validationVerdictsByIssueId,
      input.v1EnforcementEnabled,
      input.issueStatusByIssueId,
    );
    const skippableSteps = findSkippableSteps(input.context.steps, skipPredsByStepId, {
      launchedStepIds: input.dynamicLaunchStepIds,
      isStepEligible: (step) => {
        const run = skipRunMap.get(step.id);
        if (!run || run.status !== "pending" || run.issueId != null) return false;
        if (step.dependencies.some((depId) => {
          const depStep = input.context.steps.find((candidate) => candidate.id === depId);
          return isStructuralGateStep(depStep);
        })) return false;
        return !hasRecoverableQaRequestChangesDependency(
          step,
          input.context.steps,
          skipRunMap,
          input.validationVerdictsByIssueId,
        );
      },
    });
    if (skippableSteps.length === 0) return { stepRuns, cancelled: false };

    let settledAny = false;
    for (const step of skippableSteps) {
      const stepRun = skipRunMap.get(step.id);
      if (!stepRun) continue;
      const nextMetadata = {
        ...buildWorkflowStepRunMetadata(step, stepRun.metadata),
        controlFlowSkipped: true,
      };
      const result = await settleConditionalSkip(input.db, {
        observedRun: input.context.run,
        target: stepRun,
        nextMetadata,
        observedPredecessors: stepRuns
          .filter((predecessor) => predecessor.id !== stepRun.id)
          .map(toConditionalStepObservation),
      });
      if (result.kind === "cancelled") return { stepRuns, cancelled: true };
      if (result.kind !== "settled") {
        stepRuns = await reloadWorkflowStepRunsForSameRun(input.db, stepRuns);
        return { stepRuns, cancelled: false };
      }
      settledAny = true;
      stepRun.status = "skipped";
      stepRun.metadata = nextMetadata;
      stepRun.completedAt = result.completedAt;
      stepRun.dispatchReadyAt = result.dispatchReadyAt;
    }
    if (!settledAny) return { stepRuns, cancelled: false };
    stepRuns = await reloadWorkflowStepRunsForSameRun(input.db, stepRuns);
  }
}
