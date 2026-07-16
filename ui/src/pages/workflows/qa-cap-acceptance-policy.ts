import type { StepDraft } from "./step-draft.js";

type ConditionalEdgeRecord = Record<string, unknown>;

export type QaCapAcceptancePolicy =
  | {
      available: true;
      enabled: boolean;
      maxIterations: number;
      producerStepId: string;
    }
  | {
      available: false;
      reason: string;
    };

type QaBackEdgeMatch = {
  producerIndex: number;
  edgeIndex: number;
  edge: ConditionalEdgeRecord;
};

function conditionalEdges(step: StepDraft): ConditionalEdgeRecord[] {
  const value = step.extra.conditionalDependencies;
  return Array.isArray(value)
    ? value.filter((edge): edge is ConditionalEdgeRecord => Boolean(edge) && typeof edge === "object" && !Array.isArray(edge))
    : [];
}

function findQaBackEdges(steps: StepDraft[], qaStepId: string): QaBackEdgeMatch[] {
  const normalizedQaStepId = qaStepId.trim();
  if (!normalizedQaStepId || !steps.some((step) => step.id === normalizedQaStepId)) return [];

  return steps.flatMap((step, producerIndex) => conditionalEdges(step).flatMap((edge, edgeIndex) => {
    const maxIterations = edge.maxIterations;
    return edge.stepId === normalizedQaStepId
      && edge.when === "qa_request_changes"
      && edge.isBackEdge === true
      && typeof maxIterations === "number"
      && Number.isInteger(maxIterations)
      && maxIterations >= 1
      ? [{ producerIndex, edgeIndex, edge }]
      : [];
  }));
}

function resolveMatch(steps: StepDraft[], qaStepId: string): QaBackEdgeMatch | null {
  const matches = findQaBackEdges(steps, qaStepId);
  return matches.length === 1 ? matches[0]! : null;
}

function updateMatchedEdge(
  steps: StepDraft[],
  match: QaBackEdgeMatch,
  update: (edge: ConditionalEdgeRecord) => ConditionalEdgeRecord,
): StepDraft[] {
  return steps.map((step, producerIndex) => {
    if (producerIndex !== match.producerIndex) return step;
    const edges = conditionalEdges(step);
    return {
      ...step,
      extra: {
        ...step.extra,
        conditionalDependencies: edges.map((edge, edgeIndex) => edgeIndex === match.edgeIndex ? update(edge) : edge),
      },
    };
  });
}

export function resolveQaCapAcceptancePolicy(steps: StepDraft[], qaStepId: string): QaCapAcceptancePolicy {
  const matches = findQaBackEdges(steps, qaStepId);
  if (matches.length === 0) {
    return { available: false, reason: "No bounded QA rework edge is configured for this step." };
  }
  if (matches.length > 1) {
    return { available: false, reason: "Multiple bounded QA rework edges target this step." };
  }
  const match = matches[0]!;
  return {
    available: true,
    enabled: match.edge.allowCapAcceptance === true,
    maxIterations: match.edge.maxIterations as number,
    producerStepId: steps[match.producerIndex]!.id,
  };
}

export function setQaCapAcceptancePolicy(steps: StepDraft[], qaStepId: string, enabled: boolean): StepDraft[] {
  const match = resolveMatch(steps, qaStepId);
  if (!match) return steps;
  return updateMatchedEdge(steps, match, (edge) => {
    if (enabled) return { ...edge, allowCapAcceptance: true };
    const { allowCapAcceptance: _removed, ...rest } = edge;
    return rest;
  });
}

export function setQaReworkMaxIterations(steps: StepDraft[], qaStepId: string, value: number): StepDraft[] {
  if (!Number.isInteger(value) || value < 1) return steps;
  const match = resolveMatch(steps, qaStepId);
  if (!match) return steps;
  return updateMatchedEdge(steps, match, (edge) => ({ ...edge, maxIterations: value }));
}
