import type { ConditionalEdge } from "../workflow/control-flow/types.js";
import { isQaLikeStep } from "../workflow-step-role.js";

export type DagStepLike = {
  readonly id: string;
  readonly dependencies?: string[];
  readonly dependsOn?: string[];
  readonly name?: string;
  readonly title?: string;
  readonly type?: string;
};

export type BackEdgeCapableStep = DagStepLike & {
  readonly conditionalDependencies?: ConditionalEdge[];
};

export const QA_REWORK_DEFAULT_MAX_ITERATIONS = 2;

export function resolveProducerStepIdFromDag(qaStepId: string | null, steps: readonly DagStepLike[]): string | null {
  if (!qaStepId) return null;
  const byId = new Map(steps.map((step) => [step.id, step]));

  const pickDeepest = (candidates: readonly DagStepLike[]): DagStepLike | null => {
    if (candidates.length === 0) return null;
    return [...candidates].sort(
      (left, right) =>
        (right.dependencies?.length ?? right.dependsOn?.length ?? 0) -
        (left.dependencies?.length ?? left.dependsOn?.length ?? 0),
    )[0] ?? null;
  };

  const resolve = (stepId: string, visited: ReadonlySet<string>): DagStepLike | null => {
    if (visited.has(stepId)) return null;
    const nextVisited = new Set(visited).add(stepId);
    const qaStep = byId.get(stepId);
    if (!qaStep || !isQaLikeStep(qaStep)) return null;
    const dependencies = (qaStep.dependencies ?? qaStep.dependsOn ?? [])
      .map((dependencyId) => byId.get(dependencyId))
      .filter((step): step is DagStepLike => Boolean(step));
    const nestedProducers = dependencies
      .filter(isQaLikeStep)
      .map((dependency) => resolve(dependency.id, nextVisited))
      .filter((step): step is DagStepLike => Boolean(step));
    return pickDeepest(nestedProducers) ?? pickDeepest(dependencies.filter((dependency) => !isQaLikeStep(dependency)));
  };

  return resolve(qaStepId, new Set())?.id ?? null;
}

export function synthesizeQaReworkBackEdge<T extends BackEdgeCapableStep>(
  steps: T[],
  qaStepId: string,
  maxIterations: number = QA_REWORK_DEFAULT_MAX_ITERATIONS,
): T[] {
  if (!qaStepId || steps.length === 0) return steps;
  const effectiveMaxIterations = maxIterations >= 1 ? Math.floor(maxIterations) : QA_REWORK_DEFAULT_MAX_ITERATIONS;
  const producerId = resolveProducerStepIdFromDag(qaStepId, steps);
  if (!producerId) return steps;
  const producer = steps.find((step) => step.id === producerId);
  if (!producer) return steps;
  const existing = producer.conditionalDependencies ?? [];
  const alreadyHasBackEdge = existing.some(
    (edge) => edge.stepId === qaStepId && edge.when === "qa_request_changes" && edge.isBackEdge === true,
  );
  if (alreadyHasBackEdge) return steps;
  const backEdge: ConditionalEdge = {
    stepId: qaStepId,
    when: "qa_request_changes",
    isBackEdge: true,
    maxIterations: effectiveMaxIterations,
  };
  return steps.map((step) => step.id === producerId
    ? { ...step, conditionalDependencies: [...existing, backEdge] }
    : step);
}

const REWORK_TARGET_IN_NEXT_ACTION =
  /\b(?:revise|redo|rework|update|fix|correct|re-open|reopen)\s+(?:the\s+|issue\s+)?([A-Z][A-Z0-9_]*-\d+)\b/i;

export function parseReworkTargetRefFromNextAction(nextAction: string | undefined | null): string | null {
  if (!nextAction) return null;
  return nextAction.match(REWORK_TARGET_IN_NEXT_ACTION)?.[1] ?? null;
}

export { isQaLikeStep } from "../workflow-step-role.js";
