import { workflowControlNodeResultSchema } from "@paperclipai/shared";
import type { WorkflowStep } from "./dag-engine.js";
import type { ConditionalStepObservation } from "./conditional-skip-settlement.js";
import type { workflowStepRuns } from "@paperclipai/db";

export function buildStepRunMap(
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Map<string, typeof workflowStepRuns.$inferSelect> {
  return new Map(stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
}

export function toConditionalStepObservation(row: typeof workflowStepRuns.$inferSelect): ConditionalStepObservation {
  return {
    id: row.id,
    workflowRunId: row.workflowRunId,
    stepId: row.stepId,
    status: row.status,
    issueId: row.issueId,
    startedAt: row.startedAt,
    lastDispatchAttemptAt: row.lastDispatchAttemptAt,
    dispatchReadyAt: row.dispatchReadyAt,
    executionGeneration: row.executionGeneration,
    metadata: row.metadata,
  };
}

/**
 * [목적] completed 된 IF step 의 persisted controlNodeResult 에서 outcome 만 안전하게 유도.
 *   agent/tool step 이나 누락/잘못된 metadata 에선 빈 객체를 반환해 condition_true/false edge 가
 *   양쪽 모두 비활성(fail-closed) 되게 한다. metadata 는 검증된 스키마로만 통과.
 */
export function deriveIfControlOutcome(
  step: WorkflowStep,
  run: typeof workflowStepRuns.$inferSelect | undefined,
): { controlOutcome?: "condition_true" | "condition_false" } {
  if (!run || run.status !== "completed") return {};
  if (typeof step.type !== "string" || step.type !== "if") return {};
  const raw = run.metadata?.controlNodeResult;
  if (!raw || typeof raw !== "object") return {};
  const parsed = workflowControlNodeResultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.nodeType !== "if") return {};
  return { controlOutcome: parsed.data.outcome };
}
