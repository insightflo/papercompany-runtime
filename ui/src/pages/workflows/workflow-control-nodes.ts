import {
  workflowConditionGroupSchema,
  type WorkflowConditionGroup,
} from "@paperclipai/shared";
import type { StepDraft } from "./step-draft-types.js";

export type WorkflowControlNodeType = "if" | "complete";
export type WorkflowConnectionWhen = "success" | "condition_true" | "condition_false";

export type PendingWorkflowConnection = {
  sourceStepId: string;
  when: WorkflowConnectionWhen;
};

type ConditionalDependency = Record<string, unknown> & {
  stepId?: unknown;
  when?: unknown;
};

export const defaultIfConditionGroup: WorkflowConditionGroup = {
  combinator: "all",
  conditions: [{
    source: { kind: "work_product_json", stepId: "", title: "", path: "$" },
    dataType: "string",
    operator: "equals",
    rightValue: "",
  }],
};

export function cloneWorkflowConditionGroup(value: unknown): WorkflowConditionGroup {
  const parsed = workflowConditionGroupSchema.safeParse(value);
  const source = parsed.success ? parsed.data : defaultIfConditionGroup;
  return {
    combinator: source.combinator,
    conditions: source.conditions.map((condition) => ({
      ...condition,
      source: { ...condition.source },
    })),
  };
}

function dependencies(step: StepDraft): string[] {
  return step.dependsOn.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function conditionalDependencies(step: StepDraft): ConditionalDependency[] {
  const value = step.extra.conditionalDependencies;
  return Array.isArray(value)
    ? value.filter((edge): edge is ConditionalDependency => Boolean(edge) && typeof edge === "object" && !Array.isArray(edge))
    : [];
}

function replaceConditionalDependencies(step: StepDraft, edges: ConditionalDependency[]): StepDraft {
  const extra = { ...step.extra };
  if (edges.length > 0) extra.conditionalDependencies = edges;
  else delete extra.conditionalDependencies;
  return { ...step, extra };
}

export function connectWorkflowSteps(
  steps: StepDraft[],
  connection: PendingWorkflowConnection,
  targetStepId: string,
): StepDraft[] {
  const sourceId = connection.sourceStepId.trim();
  const targetId = targetStepId.trim();
  const source = steps.find((step) => step.id === sourceId);
  const target = steps.find((step) => step.id === targetId);
  if (!source || !target) throw new Error("Both workflow steps must exist before connecting them.");
  if (sourceId === targetId) throw new Error("A workflow step cannot depend on itself.");
  if (source.type === "complete") throw new Error("Complete nodes cannot have outgoing connections.");

  if (source.type === "if") {
    if (connection.when !== "condition_true" && connection.when !== "condition_false") {
      throw new Error("IF outputs must use condition_true or condition_false.");
    }
    return steps.map((step) => {
      if (step.id !== targetId) return step;
      const edges = conditionalDependencies(step);
      const duplicate = edges.some((edge) => edge.stepId === sourceId && edge.when === connection.when);
      const next = {
        ...step,
        dependsOn: dependencies(step).filter((dependency) => dependency !== sourceId).join(", "),
      };
      return duplicate
        ? next
        : replaceConditionalDependencies(next, [...edges, { stepId: sourceId, when: connection.when }]);
    });
  }

  if (connection.when !== "success") {
    throw new Error("Ordinary workflow nodes use the success output.");
  }
  return steps.map((step) => step.id !== targetId || dependencies(step).includes(sourceId)
    ? step
    : { ...step, dependsOn: [...dependencies(step), sourceId].join(", ") });
}

export function disconnectWorkflowSteps(
  steps: StepDraft[],
  sourceStepId: string,
  targetStepId: string,
  when?: string,
): StepDraft[] {
  const sourceId = sourceStepId.trim();
  const targetId = targetStepId.trim();
  return steps.map((step) => {
    if (step.id !== targetId) return step;
    const nextEdges = conditionalDependencies(step).filter((edge) => (
      edge.stepId !== sourceId || (when !== undefined && edge.when !== when)
    ));
    const next = {
      ...step,
      dependsOn: when && when !== "success"
        ? step.dependsOn
        : dependencies(step).filter((dependency) => dependency !== sourceId).join(", "),
    };
    return replaceConditionalDependencies(next, nextEdges);
  });
}

function renameConditionSources(group: WorkflowConditionGroup, currentId: string, nextId: string): WorkflowConditionGroup {
  return {
    ...group,
    conditions: group.conditions.map((condition) => condition.source.stepId === currentId
      ? { ...condition, source: { ...condition.source, stepId: nextId } }
      : condition),
  };
}

export function renameWorkflowControlNodeReferences(
  steps: StepDraft[],
  currentStepId: string,
  nextStepId: string,
): StepDraft[] {
  const currentId = currentStepId.trim();
  const nextId = nextStepId.trim();
  if (!currentId || !nextId || currentId === nextId) return steps;
  return steps.map((step) => {
    const renamedDeps = dependencies(step).map((dependency) => dependency === currentId ? nextId : dependency);
    const renamedEdges = conditionalDependencies(step).map((edge) => edge.stepId === currentId
      ? { ...edge, stepId: nextId }
      : edge);
    const next = replaceConditionalDependencies({
      ...step,
      dependsOn: renamedDeps.join(", "),
      conditionGroup: renameConditionSources(step.conditionGroup, currentId, nextId),
    }, renamedEdges);
    return next;
  });
}

export function removeWorkflowControlNodeReferences(steps: StepDraft[], removedStepId: string): StepDraft[] {
  const removedId = removedStepId.trim();
  if (!removedId) return steps;
  return steps.map((step) => {
    const next = replaceConditionalDependencies({
      ...step,
      dependsOn: dependencies(step).filter((dependency) => dependency !== removedId).join(", "),
      conditionGroup: renameConditionSources(step.conditionGroup, removedId, ""),
    }, conditionalDependencies(step).filter((edge) => edge.stepId !== removedId));
    return next;
  });
}
