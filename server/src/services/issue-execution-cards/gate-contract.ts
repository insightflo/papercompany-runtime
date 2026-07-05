import type { IssueExecutionCardRow } from "./store.js";
import { extractProseIssueContract } from "./prose-markers.js";

export type WorkProductRequirementSource = "card" | "step_metadata" | "prose" | "none";

export type WorkProductRequirementDecision = {
  required: boolean;
  source: WorkProductRequirementSource;
  stepId: string | null;
  cardHash: string | null;
};

type StepRunForRequirement = {
  stepId: string;
  metadata: Record<string, unknown>;
};

function stepRunRequiresWorkProduct(stepRun: StepRunForRequirement): boolean {
  return stepRun.metadata.graphWorkProductRequired === true ||
    stepRun.metadata.workProductRequired === true ||
    stepRun.metadata.requiresWorkProduct === true;
}

export function resolveWorkProductRequirement(input: {
  card: IssueExecutionCardRow | null;
  linkedStepRuns: StepRunForRequirement[];
  issueDescription: string | null | undefined;
}): WorkProductRequirementDecision {
  if (input.card) {
    const required = input.card.cardJson.requiredOutputs.workProduct.required;
    return {
      required,
      source: "card",
      stepId: input.card.cardJson.workflow?.stepId ?? input.linkedStepRuns[0]?.stepId ?? null,
      cardHash: input.card.contentHash,
    };
  }

  const requiredStepRun = input.linkedStepRuns.find(stepRunRequiresWorkProduct);
  if (requiredStepRun) {
    return {
      required: true,
      source: "step_metadata",
      stepId: requiredStepRun.stepId,
      cardHash: null,
    };
  }

  const prose = extractProseIssueContract(input.issueDescription);
  if (prose.workProductRequired) {
    return {
      required: true,
      source: "prose",
      stepId: input.linkedStepRuns[0]?.stepId ?? null,
      cardHash: null,
    };
  }

  return {
    required: false,
    source: "none",
    stepId: input.linkedStepRuns[0]?.stepId ?? null,
    cardHash: null,
  };
}
