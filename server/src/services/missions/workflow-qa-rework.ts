import type { ConditionalEdge } from "../workflow/control-flow/types.js";
import { isQaLikeStep } from "../workflow-step-role.js";

export type DagStepLike = {
  readonly id: string;
  readonly dependencies?: string[];
  readonly dependsOn?: string[];
  readonly name?: string;
  readonly title?: string;
  readonly type?: string;
  readonly description?: string;
  readonly qaType?: string;
  readonly toolName?: string;
  readonly toolNames?: readonly string[];
};

export type BackEdgeCapableStep = DagStepLike & {
  readonly conditionalDependencies?: ConditionalEdge[];
};

export const QA_REWORK_DEFAULT_MAX_ITERATIONS = 2;

export type QaReworkBackEdgeOptions = {
  allowCapAcceptance?: boolean;
};

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

function resolveManualOnboardingReplayStepIds(qaStepId: string, steps: readonly DagStepLike[]): string[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const isAncestorOf = (candidateId: string, stepId: string, visited = new Set<string>()): boolean => {
    if (visited.has(stepId)) return false;
    visited.add(stepId);
    const dependencies = byId.get(stepId)?.dependencies ?? byId.get(stepId)?.dependsOn ?? [];
    return dependencies.some((dependencyId) =>
      dependencyId === candidateId || isAncestorOf(candidateId, dependencyId, new Set(visited)));
  };
  const toolNames = (step: DagStepLike) => [
    ...(step.toolName ? [step.toolName] : []),
    ...(step.toolNames ?? []),
  ];
  const publishers = steps.filter((step) =>
    toolNames(step).includes("manual-onboarding-publish") && isAncestorOf(step.id, qaStepId));
  const verifiers = steps.filter((step) =>
    toolNames(step).includes("manual-onboarding-verify") && isAncestorOf(step.id, qaStepId));
  const connectedPublishers = publishers.filter((publisher) =>
    verifiers.some((verifier) => isAncestorOf(publisher.id, verifier.id)));
  const connectedVerifiers = verifiers.filter((verifier) =>
    connectedPublishers.some((publisher) => isAncestorOf(publisher.id, verifier.id)));
  const replayIds = new Set<string>();
  for (const publisher of connectedPublishers) {
    for (const verifier of connectedVerifiers) {
      if (!isAncestorOf(publisher.id, verifier.id)) continue;
      for (const step of steps) {
        if (step.id === publisher.id || step.id === verifier.id
          || (isAncestorOf(publisher.id, step.id) && isAncestorOf(step.id, verifier.id))) {
          replayIds.add(step.id);
        }
      }
    }
  }
  return steps.filter((step) => replayIds.has(step.id)).map((step) => step.id);
}

export function synthesizeQaReworkBackEdge<T extends BackEdgeCapableStep>(
  steps: T[],
  qaStepId: string,
  maxIterations: number = QA_REWORK_DEFAULT_MAX_ITERATIONS,
  options: QaReworkBackEdgeOptions = {},
): T[] {
  if (!qaStepId || steps.length === 0) return steps;
  const effectiveMaxIterations = maxIterations >= 1 ? Math.floor(maxIterations) : QA_REWORK_DEFAULT_MAX_ITERATIONS;
  const deliveryReplayIds = resolveManualOnboardingReplayStepIds(qaStepId, steps);
  const producerId = resolveProducerStepIdFromDag(qaStepId, steps);
  const targetIds = deliveryReplayIds.length > 0 ? deliveryReplayIds : producerId ? [producerId] : [];
  if (targetIds.length === 0) return steps;
  const targetIdSet = new Set(targetIds);
  const backEdge: ConditionalEdge = {
    stepId: qaStepId,
    when: "qa_request_changes",
    isBackEdge: true,
    maxIterations: effectiveMaxIterations,
    ...(options.allowCapAcceptance === true ? { allowCapAcceptance: true } : {}),
  };
  let changed = false;
  const next = steps.map((step) => {
    if (!targetIdSet.has(step.id)) return step;
    const existing = step.conditionalDependencies ?? [];
    const alreadyHasBackEdge = existing.some(
      (edge) => edge.stepId === qaStepId && edge.when === "qa_request_changes" && edge.isBackEdge === true,
    );
    if (alreadyHasBackEdge) return step;
    changed = true;
    return { ...step, conditionalDependencies: [...existing, backEdge] };
  });
  return changed ? next : steps;
}

const REWORK_TARGET_IN_NEXT_ACTION =
  /\b(?:revise|redo|rework|update|fix|correct|re-open|reopen)\s+(?:the\s+|issue\s+)?([A-Z][A-Z0-9_]*-\d+)\b/i;

export function parseReworkTargetRefFromNextAction(nextAction: string | undefined | null): string | null {
  if (!nextAction) return null;
  return nextAction.match(REWORK_TARGET_IN_NEXT_ACTION)?.[1] ?? null;
}

export { isQaLikeStep } from "../workflow-step-role.js";
