export interface WorkflowStep {
  id: string;
  title: string;
  dependsOn: string[];
  type?: "agent" | "tool";
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  tools?: string[];
  sessionMode?: "fresh" | "reuse";
  onFailure?: "retry" | "skip" | "abort_workflow" | "escalate";
  escalateTo?: string;
  maxRetries?: number;
  triggerOn?: "normal" | "escalation";
  timeoutSeconds?: number;
  /**
   * Marks a root planning step as the bootstrap for an owner-led dynamic
   * mission. The workflow engine launches this step only; the plan issue owns
   * the concrete child issues instead of the static DAG activating them again.
   */
  dynamicChildren?: boolean;
  ownerPlanBootstrapOnly?: boolean;
  bootstrapOnly?: boolean;
}

export type WorkflowExecutionMode = "static_dag" | "dynamic_owner_plan";

export interface WorkflowExecutionOptions {
  dynamicOwnerPlan?: boolean;
  launchedStepIds?: Set<string>;
}

export interface WorkflowDefinitionExecutionShape {
  name?: unknown;
  executionMode?: unknown;
  dynamicPlanBootstrapOnly?: unknown;
  workflowMode?: unknown;
  steps?: WorkflowStep[];
}

export interface DagValidationResult {
  valid: boolean;
  errors: string[];
  topologicalOrder: string[];
}

export interface NextStepsResult {
  readyStepIds: string[];
  isWorkflowComplete: boolean;
}

export interface WorkflowLaunchabilityResult {
  valid: boolean;
  errors: string[];
}

function getNormalTriggerSteps(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.filter((step) => step.triggerOn !== "escalation");
}

function isTruthyBooleanMarker(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function isDynamicOwnerPlanStep(step: WorkflowStep): boolean {
  const meta = step as WorkflowStep & { executionMode?: unknown; workflowMode?: unknown };
  return isTruthyBooleanMarker(step.dynamicChildren)
    || isTruthyBooleanMarker(step.ownerPlanBootstrapOnly)
    || isTruthyBooleanMarker(step.bootstrapOnly)
    || meta.executionMode === "dynamic_owner_plan"
    || meta.workflowMode === "dynamic_owner_plan";
}

function hasRootPlanningStep(steps: WorkflowStep[]): boolean {
  return steps.some((step) => {
    if (step.triggerOn === "escalation" || step.dependsOn.length > 0) {
      return false;
    }

    const id = step.id.toLowerCase();
    const title = step.title.toLowerCase();
    return id === "plan" || id.endsWith("-plan") || title.includes("plan");
  });
}

function isLegacyResearchDailyWorkflowName(name: unknown): boolean {
  if (typeof name !== "string") {
    return false;
  }

  const normalized = name.trim().toLowerCase();
  return normalized === "tech-scout"
    || normalized === "tech-ai-news"
    || normalized === "daily-tech-scout"
    || normalized === "daily-tech-ai-news";
}

export function isDynamicOwnerPlanWorkflowDefinition(
  definition: WorkflowDefinitionExecutionShape,
): boolean {
  if (definition.executionMode === "static_dag" || definition.workflowMode === "static_dag") {
    return false;
  }

  if (
    definition.executionMode === "dynamic_owner_plan"
    || definition.workflowMode === "dynamic_owner_plan"
    || isTruthyBooleanMarker(definition.dynamicPlanBootstrapOnly)
  ) {
    return true;
  }

  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  if (steps.some(isDynamicOwnerPlanStep)) {
    return true;
  }

  return isLegacyResearchDailyWorkflowName(definition.name) && hasRootPlanningStep(steps);
}

export function getWorkflowLaunchSteps(
  steps: WorkflowStep[],
  options: WorkflowExecutionOptions = {},
): WorkflowStep[] {
  if (!options.dynamicOwnerPlan) {
    return steps;
  }

  return steps.filter((step) => step.triggerOn !== "escalation" && step.dependsOn.length === 0);
}

export function validateWorkflowLaunchability(
  definition: WorkflowDefinitionExecutionShape,
): WorkflowLaunchabilityResult {
  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  const dagValidation = validateDag(steps);
  const errors = [...dagValidation.errors];
  const normalSteps = getNormalTriggerSteps(steps);

  if (normalSteps.length === 0) {
    errors.push("Workflow has no normal steps to launch.");
  }

  const dynamicOwnerPlan = isDynamicOwnerPlanWorkflowDefinition(definition);
  const launchSteps = getWorkflowLaunchSteps(steps, { dynamicOwnerPlan })
    .filter((step) => step.triggerOn !== "escalation" && step.dependsOn.length === 0);

  if (normalSteps.length > 0 && launchSteps.length === 0) {
    errors.push("Workflow has no activatable root step. At least one normal step must have no dependencies.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateDag(steps: WorkflowStep[]): DagValidationResult {
  const errors: string[] = [];
  const duplicateIds = new Set<string>();
  const stepById = new Map<string, WorkflowStep>();

  for (const step of steps) {
    if (stepById.has(step.id)) {
      duplicateIds.add(step.id);
      continue;
    }

    stepById.set(step.id, step);
  }

  for (const duplicateId of duplicateIds) {
    errors.push(`Duplicate step ID found: "${duplicateId}".`);
  }

  for (const step of steps) {
    if (duplicateIds.has(step.id)) {
      continue;
    }

    for (const dependencyId of step.dependsOn) {
      if (!stepById.has(dependencyId)) {
        errors.push(
          `Step "${step.id}" depends on missing step "${dependencyId}".`,
        );
      }
    }

    if (step.escalateTo !== undefined && !stepById.has(step.escalateTo)) {
      errors.push(
        `Step "${step.id}" escalates to missing step "${step.escalateTo}".`,
      );
    }
  }

  const uniqueSteps = steps.filter((step) => !duplicateIds.has(step.id));
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const step of uniqueSteps) {
    indegree.set(step.id, 0);
    adjacency.set(step.id, []);
  }

  for (const step of uniqueSteps) {
    for (const dependencyId of step.dependsOn) {
      if (!stepById.has(dependencyId) || duplicateIds.has(dependencyId)) {
        continue;
      }

      adjacency.get(dependencyId)?.push(step.id);
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const step of uniqueSteps) {
    if ((indegree.get(step.id) ?? 0) === 0) {
      queue.push(step.id);
    }
  }

  const topologicalOrder: string[] = [];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const currentId = queue[queueIndex];
    queueIndex += 1;
    topologicalOrder.push(currentId);

    const neighbors = adjacency.get(currentId) ?? [];
    for (const neighborId of neighbors) {
      const nextIndegree = (indegree.get(neighborId) ?? 0) - 1;
      indegree.set(neighborId, nextIndegree);

      if (nextIndegree === 0) {
        queue.push(neighborId);
      }
    }
  }

  if (topologicalOrder.length < uniqueSteps.length) {
    errors.push("Cycle detected in workflow steps.");
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      topologicalOrder: [],
    };
  }

  return {
    valid: true,
    errors: [],
    topologicalOrder,
  };
}

export function getNextSteps(
  steps: WorkflowStep[],
  completedStepIds: Set<string>,
  failedStepIds: Set<string>,
  skippedStepIds: Set<string>,
  options: WorkflowExecutionOptions = {},
): NextStepsResult {
  const launchedStepIds = options.dynamicOwnerPlan ? options.launchedStepIds : undefined;
  const executableSteps = launchedStepIds
    ? steps.filter((step) => launchedStepIds.has(step.id))
    : steps;

  const readyStepIds = executableSteps
    .filter((step) => step.triggerOn !== "escalation")
    .filter((step) => !completedStepIds.has(step.id))
    .filter((step) => !failedStepIds.has(step.id))
    .filter((step) => !skippedStepIds.has(step.id))
    .filter((step) =>
      step.dependsOn.every(
        (dependencyId) =>
          completedStepIds.has(dependencyId) || skippedStepIds.has(dependencyId),
      ),
    )
    .map((step) => step.id);

  const isWorkflowComplete = getNormalTriggerSteps(executableSteps).every(
    (step) =>
      completedStepIds.has(step.id) ||
      skippedStepIds.has(step.id) ||
      failedStepIds.has(step.id),
  );

  return {
    readyStepIds,
    isWorkflowComplete,
  };
}

export function getEscalationTarget(
  steps: WorkflowStep[],
  failedStepId: string,
): string | null {
  const failedStep = steps.find((step) => step.id === failedStepId);

  if (failedStep?.onFailure !== "escalate") {
    return null;
  }

  return failedStep.escalateTo ?? null;
}

export function getRetryInfo(
  steps: WorkflowStep[],
  stepId: string,
): { shouldRetry: boolean; maxRetries: number } {
  const step = steps.find((candidate) => candidate.id === stepId);

  if (step?.onFailure !== "retry") {
    return {
      shouldRetry: false,
      maxRetries: 0,
    };
  }

  return {
    shouldRetry: true,
    maxRetries: step.maxRetries ?? 2,
  };
}
