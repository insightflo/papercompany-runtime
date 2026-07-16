import type { StepDraft } from "./step-draft.js";

type ConditionalEdgeRecord = Record<string, unknown>;

/**
 * QA rework loop policy for a selected step (the QA reviewer).
 *
 * `enabled` describes whether a unique `qa_request_changes` back-edge already
 * exists for this step. When disabled, the policy still resolves so the UI can
 * offer to create the loop; the producer is derived from the step's upstream
 * dependencies. Multiple existing back-edges are surfaced (not overwritten).
 */
export type QaCapAcceptancePolicy =
  | {
      available: true;
      enabled: true;
      allowCapAcceptance: boolean;
      maxIterations: number;
      producerStepId: string;
    }
  | {
      available: true;
      enabled: false;
      /** Auto-selected when exactly one candidate; otherwise null. */
      producerStepId: string | null;
      /** Upstream producers the loop could rework. */
      producerCandidates: string[];
      /** True when more than one candidate requires an explicit choice. */
      requiresProducerSelection: boolean;
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

/** Default rework attempts when a new loop is created. */
const DEFAULT_QA_REWORK_MAX_ITERATIONS = 2;

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

/** Distinct existing step ids the QA step depends on (its upstream producers). */
function upstreamProducerCandidates(steps: StepDraft[], qaStepId: string): string[] {
  const qaStep = steps.find((step) => step.id === qaStepId);
  if (!qaStep) return [];
  const known = new Set(steps.map((step) => step.id));
  const ids = String(qaStep.dependsOn ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(ids.filter((id) => known.has(id))));
}

function addQaBackEdge(steps: StepDraft[], producerStepId: string, qaStepId: string): StepDraft[] {
  return steps.map((step) => {
    if (step.id !== producerStepId) return step;
    const edges = conditionalEdges(step);
    const newEdge: ConditionalEdgeRecord = {
      stepId: qaStepId,
      when: "qa_request_changes",
      isBackEdge: true,
      maxIterations: DEFAULT_QA_REWORK_MAX_ITERATIONS,
    };
    return {
      ...step,
      extra: {
        ...step.extra,
        conditionalDependencies: [...edges, newEdge],
      },
    };
  });
}

function removeMatchedEdge(steps: StepDraft[], match: QaBackEdgeMatch): StepDraft[] {
  return steps.map((step, producerIndex) => {
    if (producerIndex !== match.producerIndex) return step;
    const edges = conditionalEdges(step);
    return {
      ...step,
      extra: {
        ...step.extra,
        conditionalDependencies: edges.filter((_, edgeIndex) => edgeIndex !== match.edgeIndex),
      },
    };
  });
}

export function resolveQaCapAcceptancePolicy(steps: StepDraft[], qaStepId: string): QaCapAcceptancePolicy {
  const normalizedQaStepId = qaStepId.trim();
  const matches = findQaBackEdges(steps, normalizedQaStepId);
  if (matches.length > 1) {
    return { available: false, reason: "Multiple bounded QA rework edges target this step." };
  }
  if (matches.length === 1) {
    const match = matches[0]!;
    return {
      available: true,
      enabled: true,
      allowCapAcceptance: match.edge.allowCapAcceptance === true,
      maxIterations: match.edge.maxIterations as number,
      producerStepId: steps[match.producerIndex]!.id,
    };
  }

  const candidates = upstreamProducerCandidates(steps, normalizedQaStepId);
  return {
    available: true,
    enabled: false,
    producerStepId: candidates.length === 1 ? candidates[0]! : null,
    producerCandidates: candidates,
    requiresProducerSelection: candidates.length > 1,
  };
}

/**
 * Enable/disable the QA rework loop (the `qa_request_changes` back-edge).
 *
 * Enabling creates the edge on the resolved or explicitly chosen producer; it is
 * a no-op when an edge already exists (never overwrites) or no producer can be
 * resolved. Disabling removes only the unique matched edge; it is a no-op when
 * the configuration is ambiguous so existing producers are never guessed.
 */
export function setQaLoopEnabled(
  steps: StepDraft[],
  qaStepId: string,
  enabled: boolean,
  producerStepId?: string,
): StepDraft[] {
  const normalizedQaStepId = qaStepId.trim();
  const matches = findQaBackEdges(steps, normalizedQaStepId);

  if (enabled) {
    if (matches.length !== 0) return steps;
    const candidates = upstreamProducerCandidates(steps, normalizedQaStepId);
    const requested = (producerStepId ?? "").trim();
    // Never guess a producer. An explicit choice must be a real upstream candidate;
    // only the single unambiguous candidate is auto-selected when none is given.
    if (requested) {
      if (!candidates.includes(requested)) return steps;
      return addQaBackEdge(steps, requested, normalizedQaStepId);
    }
    if (candidates.length === 1) return addQaBackEdge(steps, candidates[0]!, normalizedQaStepId);
    return steps;
  }

  if (matches.length !== 1) return steps;
  return removeMatchedEdge(steps, matches[0]!);
}

/** Toggle the `allowCapAcceptance` flag on the unique bounded QA rework edge. */
export function setQaCapAcceptance(steps: StepDraft[], qaStepId: string, value: boolean): StepDraft[] {
  const match = resolveMatch(steps, qaStepId);
  if (!match) return steps;
  return updateMatchedEdge(steps, match, (edge) => {
    if (value) return { ...edge, allowCapAcceptance: true };
    const { allowCapAcceptance: _removed, ...rest } = edge;
    return rest;
  });
}

/** Set the QA rework attempt count (must be a positive integer). */
export function setQaReworkMaxIterations(steps: StepDraft[], qaStepId: string, value: number): StepDraft[] {
  if (!Number.isInteger(value) || value < 1) return steps;
  const match = resolveMatch(steps, qaStepId);
  if (!match) return steps;
  return updateMatchedEdge(steps, match, (edge) => ({ ...edge, maxIterations: value }));
}
