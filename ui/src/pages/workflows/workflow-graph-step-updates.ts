// Immutable updates for step metadata, graph groups and containers.
// Split out of workflow-graph.ts (pure move, function bodies unchanged).

import type { WorkflowGraphStep } from "./workflow-graph-types-core.js";
import type { WorkflowGraphContainerType } from "./workflow-graph-types-model.js";
import { normalizeApprovalTimeoutAction, normalizeRetryBackoff, parseRecipientList, parseReferenceList, readBooleanSetting } from "./workflow-graph-step-metadata.js";
import { normalizeGraphContainerMode } from "./workflow-graph-step-runtime.js";

export function updateStepAdvancedMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: {
    onFailure?: string;
    maxRetries?: number;
    retryDelaySeconds?: number;
    retryBackoff?: string;
    retryJitter?: boolean;
    timeoutSeconds?: number;
    sleepSeconds?: number;
    suspendUntil?: string;
    suspendTimeoutSeconds?: number;
    suspendTimeoutAction?: string;
    earlyReturn?: boolean;
    earlyReturnContentType?: string;
    earlyReturnSchema?: string;
    errorHandler?: boolean;
    errorHandlerScope?: string;
    errorHandlerInput?: string;
    restartBoundary?: boolean;
    restartStrategy?: string;
    restartInput?: string;
    earlyStopCondition?: string;
    earlyStopLabelSkipped?: boolean;
  },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    const hasOnFailure = Object.hasOwn(patch, "onFailure");
    const hasMaxRetries = Object.hasOwn(patch, "maxRetries");
    const hasRetryDelaySeconds = Object.hasOwn(patch, "retryDelaySeconds");
    const hasRetryBackoff = Object.hasOwn(patch, "retryBackoff");
    const hasRetryJitter = Object.hasOwn(patch, "retryJitter");
    const hasTimeoutSeconds = Object.hasOwn(patch, "timeoutSeconds");
    const hasSleepSeconds = Object.hasOwn(patch, "sleepSeconds");
    const hasSuspendUntil = Object.hasOwn(patch, "suspendUntil");
    const hasSuspendTimeoutSeconds = Object.hasOwn(patch, "suspendTimeoutSeconds");
    const hasSuspendTimeoutAction = Object.hasOwn(patch, "suspendTimeoutAction");
    const hasEarlyReturn = Object.hasOwn(patch, "earlyReturn");
    const hasEarlyReturnContentType = Object.hasOwn(patch, "earlyReturnContentType");
    const hasEarlyReturnSchema = Object.hasOwn(patch, "earlyReturnSchema");
    const hasErrorHandler = Object.hasOwn(patch, "errorHandler");
    const hasErrorHandlerScope = Object.hasOwn(patch, "errorHandlerScope");
    const hasErrorHandlerInput = Object.hasOwn(patch, "errorHandlerInput");
    const hasRestartBoundary = Object.hasOwn(patch, "restartBoundary");
    const hasRestartStrategy = Object.hasOwn(patch, "restartStrategy");
    const hasRestartInput = Object.hasOwn(patch, "restartInput");
    const hasEarlyStopCondition = Object.hasOwn(patch, "earlyStopCondition");
    const hasEarlyStopLabelSkipped = Object.hasOwn(patch, "earlyStopLabelSkipped");
    const onFailure = hasOnFailure ? (patch.onFailure ?? "").trim() : undefined;
    const maxRetries = hasMaxRetries && patch.maxRetries !== undefined && Number.isFinite(patch.maxRetries) && patch.maxRetries >= 0
      ? Math.floor(patch.maxRetries)
      : undefined;
    const retryDelaySeconds = hasRetryDelaySeconds && patch.retryDelaySeconds !== undefined && Number.isFinite(patch.retryDelaySeconds) && patch.retryDelaySeconds >= 0
      ? Math.floor(patch.retryDelaySeconds)
      : undefined;
    const retryBackoff = hasRetryBackoff ? normalizeRetryBackoff(patch.retryBackoff) : undefined;
    const timeoutSeconds = hasTimeoutSeconds && patch.timeoutSeconds !== undefined && Number.isFinite(patch.timeoutSeconds) && patch.timeoutSeconds > 0
      ? Math.floor(patch.timeoutSeconds)
      : undefined;
    const sleepSeconds = hasSleepSeconds && patch.sleepSeconds !== undefined && Number.isFinite(patch.sleepSeconds) && patch.sleepSeconds > 0
      ? Math.floor(patch.sleepSeconds)
      : undefined;
    const suspendUntil = hasSuspendUntil ? (patch.suspendUntil ?? "").trim() : undefined;
    const suspendTimeoutSeconds = hasSuspendTimeoutSeconds && patch.suspendTimeoutSeconds !== undefined && Number.isFinite(patch.suspendTimeoutSeconds) && patch.suspendTimeoutSeconds > 0
      ? Math.floor(patch.suspendTimeoutSeconds)
      : undefined;
    const suspendTimeoutAction = hasSuspendTimeoutAction ? normalizeApprovalTimeoutAction(patch.suspendTimeoutAction) : undefined;
    const earlyReturnContentType = hasEarlyReturnContentType
      ? (patch.earlyReturnContentType ?? "").trim()
      : undefined;
    const earlyReturnSchema = hasEarlyReturnSchema
      ? (patch.earlyReturnSchema ?? "").trim()
      : undefined;
    const errorHandlerScope = hasErrorHandlerScope
      ? (patch.errorHandlerScope ?? "").trim()
      : undefined;
    const errorHandlerInput = hasErrorHandlerInput
      ? (patch.errorHandlerInput ?? "").trim()
      : undefined;
    const restartStrategy = hasRestartStrategy
      ? (patch.restartStrategy ?? "").trim()
      : undefined;
    const restartInput = hasRestartInput
      ? (patch.restartInput ?? "").trim()
      : undefined;
    const earlyStopCondition = hasEarlyStopCondition
      ? (patch.earlyStopCondition ?? "").trim()
      : undefined;
    return {
      ...step,
      ...(hasOnFailure ? { onFailure: onFailure || undefined } : {}),
      ...(hasMaxRetries ? { maxRetries } : {}),
      ...(hasRetryDelaySeconds ? { graphRetryDelaySeconds: retryDelaySeconds } : {}),
      ...(hasRetryBackoff ? { graphRetryBackoff: retryBackoff || undefined } : {}),
      ...(hasRetryJitter ? { graphRetryJitter: patch.retryJitter ? true : undefined } : {}),
      ...(hasTimeoutSeconds ? { timeoutSeconds } : {}),
      ...(hasSleepSeconds ? { graphSleepSeconds: sleepSeconds } : {}),
      ...(hasSuspendUntil ? { graphSuspendUntil: suspendUntil || undefined } : {}),
      ...(hasSuspendTimeoutSeconds ? { graphSuspendTimeoutSeconds: suspendTimeoutSeconds } : {}),
      ...(hasSuspendTimeoutAction ? { graphSuspendTimeoutAction: suspendTimeoutAction || undefined } : {}),
      ...(hasEarlyReturn ? { graphEarlyReturn: patch.earlyReturn ? true : undefined } : {}),
      ...(hasEarlyReturnContentType ? { graphEarlyReturnContentType: earlyReturnContentType || undefined } : {}),
      ...(hasEarlyReturnSchema ? { graphEarlyReturnSchema: earlyReturnSchema || undefined } : {}),
      ...(hasErrorHandler ? { graphErrorHandler: patch.errorHandler ? true : undefined } : {}),
      ...(hasErrorHandlerScope ? { graphErrorHandlerScope: errorHandlerScope || undefined } : {}),
      ...(hasErrorHandlerInput ? { graphErrorHandlerInput: errorHandlerInput || undefined } : {}),
      ...(hasRestartBoundary ? { graphRestartBoundary: patch.restartBoundary ? true : undefined } : {}),
      ...(hasRestartStrategy ? { graphRestartStrategy: restartStrategy || undefined } : {}),
      ...(hasRestartInput ? { graphRestartInput: restartInput || undefined } : {}),
      ...(hasEarlyStopCondition ? { graphEarlyStopCondition: earlyStopCondition || undefined } : {}),
      ...(hasEarlyStopLabelSkipped ? { graphEarlyStopLabelSkipped: patch.earlyStopLabelSkipped ? true : undefined } : {}),
    };
  });
  return changed ? next : steps;
}

export function updateStepApprovalMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: {
    required?: boolean;
    prompt?: string;
    recipients?: string | string[];
    timeoutSeconds?: number;
    timeoutAction?: string;
  },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    const hasRequired = Object.hasOwn(patch, "required");
    const hasPrompt = Object.hasOwn(patch, "prompt");
    const hasRecipients = Object.hasOwn(patch, "recipients");
    const hasTimeoutSeconds = Object.hasOwn(patch, "timeoutSeconds");
    const hasTimeoutAction = Object.hasOwn(patch, "timeoutAction");
    const required = hasRequired ? patch.required === true : readBooleanSetting(step.graphApprovalRequired) === true;
    const prompt = hasPrompt ? (patch.prompt ?? "").trim() : undefined;
    const recipients = hasRecipients ? parseRecipientList(patch.recipients).join(", ") : undefined;
    const timeoutSeconds = hasTimeoutSeconds && patch.timeoutSeconds !== undefined && Number.isFinite(patch.timeoutSeconds) && patch.timeoutSeconds > 0
      ? Math.floor(patch.timeoutSeconds)
      : undefined;
    const timeoutAction = hasTimeoutAction ? normalizeApprovalTimeoutAction(patch.timeoutAction) : undefined;
    return {
      ...step,
      ...(hasRequired ? { graphApprovalRequired: required ? true : undefined } : {}),
      ...(hasPrompt ? { graphApprovalPrompt: prompt || undefined } : {}),
      ...(hasRecipients ? { graphApprovalRecipients: recipients || undefined } : {}),
      ...(hasTimeoutSeconds ? { graphApprovalTimeoutSeconds: timeoutSeconds } : {}),
      ...(hasTimeoutAction ? { graphApprovalTimeoutAction: timeoutAction || undefined } : {}),
      ...(!required && hasRequired ? {
        graphApprovalPrompt: undefined,
        graphApprovalRecipients: undefined,
        graphApprovalTimeoutSeconds: undefined,
        graphApprovalTimeoutAction: undefined,
      } : {}),
    };
  });
  return changed ? next : steps;
}

export function updateStepTestingMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: {
    mockEnabled?: boolean;
    mockResult?: string;
    pinnedResultRunId?: string;
  },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    const hasMockEnabled = Object.hasOwn(patch, "mockEnabled");
    const hasMockResult = Object.hasOwn(patch, "mockResult");
    const hasPinnedResultRunId = Object.hasOwn(patch, "pinnedResultRunId");
    const mockEnabled = hasMockEnabled ? patch.mockEnabled === true : readBooleanSetting(step.graphMockEnabled) === true;
    const mockResult = hasMockResult ? (patch.mockResult ?? "").trim() : undefined;
    const pinnedResultRunId = hasPinnedResultRunId ? (patch.pinnedResultRunId ?? "").trim() : undefined;
    return {
      ...step,
      ...(hasMockEnabled ? { graphMockEnabled: mockEnabled ? true : undefined } : {}),
      ...(hasMockResult ? { graphMockResult: mockResult || undefined } : {}),
      ...(hasPinnedResultRunId ? { graphPinnedResultRunId: pinnedResultRunId || undefined } : {}),
      ...(!mockEnabled && hasMockEnabled ? {
        graphMockResult: undefined,
      } : {}),
    };
  });
  return changed ? next : steps;
}

export function updateStepExecutionMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: {
    concurrencyKey?: string;
    concurrencyLimit?: number;
    priority?: string;
    cacheEnabled?: boolean;
    cacheTtlSeconds?: number;
    deleteAfterUse?: boolean;
  },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    const hasConcurrencyKey = Object.hasOwn(patch, "concurrencyKey");
    const hasConcurrencyLimit = Object.hasOwn(patch, "concurrencyLimit");
    const hasPriority = Object.hasOwn(patch, "priority");
    const hasCacheEnabled = Object.hasOwn(patch, "cacheEnabled");
    const hasCacheTtlSeconds = Object.hasOwn(patch, "cacheTtlSeconds");
    const hasDeleteAfterUse = Object.hasOwn(patch, "deleteAfterUse");
    const concurrencyKey = hasConcurrencyKey ? (patch.concurrencyKey ?? "").trim() : undefined;
    const concurrencyLimit = hasConcurrencyLimit && patch.concurrencyLimit !== undefined && Number.isFinite(patch.concurrencyLimit) && patch.concurrencyLimit > 0
      ? Math.floor(patch.concurrencyLimit)
      : undefined;
    const priority = hasPriority ? (patch.priority ?? "").trim().toLowerCase() : undefined;
    const cacheEnabled = hasCacheEnabled ? patch.cacheEnabled === true : readBooleanSetting(step.graphCacheEnabled) === true;
    const cacheTtlSeconds = hasCacheTtlSeconds && patch.cacheTtlSeconds !== undefined && Number.isFinite(patch.cacheTtlSeconds) && patch.cacheTtlSeconds > 0
      ? Math.floor(patch.cacheTtlSeconds)
      : undefined;
    return {
      ...step,
      ...(hasConcurrencyKey ? { graphConcurrencyKey: concurrencyKey || undefined } : {}),
      ...(hasConcurrencyLimit ? { graphConcurrencyLimit: concurrencyLimit } : {}),
      ...(hasPriority ? { graphPriority: priority || undefined } : {}),
      ...(hasCacheEnabled ? { graphCacheEnabled: cacheEnabled ? true : undefined } : {}),
      ...(hasCacheTtlSeconds ? { graphCacheTtlSeconds: cacheTtlSeconds } : {}),
      ...(hasDeleteAfterUse ? { graphDeleteAfterUse: patch.deleteAfterUse ? true : undefined } : {}),
      ...(!cacheEnabled && hasCacheEnabled ? {
        graphCacheTtlSeconds: undefined,
      } : {}),
    };
  });
  return changed ? next : steps;
}

export function updateStepDataFlowMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: {
    inputExpression?: string;
    outputSchema?: string;
    workProductRequired?: boolean;
    workProductPattern?: string;
  },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    const hasInputExpression = Object.hasOwn(patch, "inputExpression");
    const hasOutputSchema = Object.hasOwn(patch, "outputSchema");
    const hasWorkProductRequired = Object.hasOwn(patch, "workProductRequired");
    const hasWorkProductPattern = Object.hasOwn(patch, "workProductPattern");
    const inputExpression = hasInputExpression ? (patch.inputExpression ?? "").trim() : undefined;
    const outputSchema = hasOutputSchema ? (patch.outputSchema ?? "").trim() : undefined;
    const workProductRequired = hasWorkProductRequired ? patch.workProductRequired === true : readBooleanSetting(step.graphWorkProductRequired) === true;
    const workProductPattern = hasWorkProductPattern ? (patch.workProductPattern ?? "").trim() : undefined;
    return {
      ...step,
      ...(hasInputExpression ? { graphInputExpression: inputExpression || undefined } : {}),
      ...(hasOutputSchema ? { graphOutputSchema: outputSchema || undefined } : {}),
      ...(hasWorkProductRequired ? { graphWorkProductRequired: workProductRequired ? true : undefined } : {}),
      ...(hasWorkProductPattern ? { graphWorkProductPattern: workProductPattern || undefined } : {}),
      ...(!workProductRequired && hasWorkProductRequired ? {
        graphWorkProductPattern: undefined,
      } : {}),
    };
  });
  return changed ? next : steps;
}

export function updateStepResourceMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: {
    resourceRefs?: string | string[];
    secretRefs?: string | string[];
  },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    const hasResourceRefs = Object.hasOwn(patch, "resourceRefs");
    const hasSecretRefs = Object.hasOwn(patch, "secretRefs");
    const resourceRefs = hasResourceRefs ? parseReferenceList(patch.resourceRefs) : undefined;
    const secretRefs = hasSecretRefs ? parseReferenceList(patch.secretRefs) : undefined;
    return {
      ...step,
      ...(hasResourceRefs ? { graphResourceRefs: resourceRefs && resourceRefs.length > 0 ? resourceRefs : undefined } : {}),
      ...(hasSecretRefs ? { graphSecretRefs: secretRefs && secretRefs.length > 0 ? secretRefs : undefined } : {}),
    };
  });
  return changed ? next : steps;
}

export function updateGraphGroupMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  groupId: string,
  patch: { title?: string; color?: string; collapsedByDefault?: boolean },
): TStep[] {
  const id = groupId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.graphGroupId !== id) return step;
    changed = true;
    return {
      ...step,
      ...(patch.title !== undefined ? { graphGroupTitle: patch.title.trim() || id } : {}),
      ...(patch.color !== undefined ? { graphGroupColor: patch.color.trim() || "#64748b" } : {}),
      ...(patch.collapsedByDefault !== undefined ? { graphGroupCollapsedByDefault: patch.collapsedByDefault ? true : undefined } : {}),
      ...(patch.collapsedByDefault === true && readBooleanSetting(step.graphGroupCollapsed) === undefined
        ? { graphGroupCollapsed: undefined }
        : {}),
    };
  });
  return changed ? next : steps;
}

export function assignStepsToGroup<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepIds: string[],
  group: { id: string; title?: string; color?: string },
): TStep[] {
  const id = group.id.trim();
  const title = group.title?.trim() || id;
  const color = group.color?.trim() || "#64748b";
  if (!id) return steps;
  const selectedIds = new Set(stepIds.map((stepId) => stepId.trim()).filter(Boolean));
  if (selectedIds.size === 0) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (!selectedIds.has(step.id)) return step;
    changed = true;
    return {
      ...step,
      graphGroupId: id,
      graphGroupTitle: title,
      graphGroupColor: color,
    };
  });
  return changed ? next : steps;
}

export function clearStepsGroup<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepIds: string[],
): TStep[] {
  const selectedIds = new Set(stepIds.map((stepId) => stepId.trim()).filter(Boolean));
  if (selectedIds.size === 0) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (!selectedIds.has(step.id)) return step;
    changed = true;
    return {
      ...step,
      graphGroupId: undefined,
      graphGroupTitle: undefined,
      graphGroupColor: undefined,
      graphGroupCollapsed: undefined,
      graphGroupCollapsedByDefault: undefined,
    };
  });
  return changed ? next : steps;
}

export function setGraphGroupCollapsed<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  groupId: string,
  collapsed: boolean,
): TStep[] {
  const id = groupId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.graphGroupId !== id) return step;
    changed = true;
    return {
      ...step,
      graphGroupCollapsed: collapsed,
    };
  });
  return changed ? next : steps;
}

export function updateStepNote<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  note: string,
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  const graphNote = note.trim() || undefined;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    return { ...step, graphNote };
  });
  return changed ? next : steps;
}

export function assignStepsToContainer<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepIds: string[],
  container: {
    id: string;
    type: WorkflowGraphContainerType;
    title?: string;
    description?: string;
    mode?: string;
    condition?: string;
    iterator?: string;
    skipFailure?: boolean;
    runInParallel?: boolean;
    parallelism?: number;
  },
): TStep[] {
  const id = container.id.trim();
  if (!id) return steps;
  const selectedIds = new Set(stepIds.map((stepId) => stepId.trim()).filter(Boolean));
  if (selectedIds.size === 0) return steps;
  const title = container.title?.trim() || id;
  const description = container.description?.trim() || "";
  const mode = normalizeGraphContainerMode(container.type, container.mode);
  const condition = container.condition?.trim() || "";
  const iterator = container.iterator?.trim() || "";
  const parallelism = container.parallelism !== undefined && Number.isFinite(container.parallelism) && container.parallelism > 0
    ? Math.floor(container.parallelism)
    : undefined;
  let changed = false;
  const next = steps.map((step) => {
    if (!selectedIds.has(step.id)) return step;
    changed = true;
    return {
      ...step,
      graphContainerId: id,
      graphContainerType: container.type,
      graphContainerTitle: title,
      graphContainerDescription: description,
      graphContainerMode: mode,
      graphContainerCondition: condition || undefined,
      graphContainerIterator: iterator || undefined,
      graphContainerSkipFailure: container.skipFailure ? true : undefined,
      graphContainerRunInParallel: container.runInParallel ? true : undefined,
      graphContainerParallelism: parallelism,
    };
  });
  return changed ? next : steps;
}

export function clearStepsContainer<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepIds: string[],
): TStep[] {
  const selectedIds = new Set(stepIds.map((stepId) => stepId.trim()).filter(Boolean));
  if (selectedIds.size === 0) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (!selectedIds.has(step.id)) return step;
    changed = true;
    return {
      ...step,
      graphContainerId: undefined,
      graphContainerType: undefined,
      graphContainerTitle: undefined,
      graphContainerDescription: undefined,
      graphContainerMode: undefined,
      graphContainerCondition: undefined,
      graphContainerIterator: undefined,
      graphContainerSkipFailure: undefined,
      graphContainerRunInParallel: undefined,
      graphContainerParallelism: undefined,
    };
  });
  return changed ? next : steps;
}

export function clearWorkflowContainer<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  containerId: string,
): TStep[] {
  const id = containerId.trim();
  if (!id) return steps;
  const stepIds = steps
    .filter((step) => typeof step.graphContainerId === "string" && step.graphContainerId.trim() === id)
    .map((step) => step.id);
  return stepIds.length > 0 ? clearStepsContainer(steps, stepIds) : steps;
}

export function updateContainerMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  containerId: string,
  patch: {
    type?: WorkflowGraphContainerType;
    title?: string;
    description?: string;
    mode?: string;
    condition?: string;
    iterator?: string;
    skipFailure?: boolean;
    runInParallel?: boolean;
    parallelism?: number;
  },
): TStep[] {
  const id = containerId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.graphContainerId !== id) return step;
    changed = true;
    const type = patch.type ?? (step.graphContainerType === "loop" ? "loop" : "branch");
    const hasMode = Object.hasOwn(patch, "mode");
    const hasCondition = Object.hasOwn(patch, "condition");
    const hasIterator = Object.hasOwn(patch, "iterator");
    const hasSkipFailure = Object.hasOwn(patch, "skipFailure");
    const hasRunInParallel = Object.hasOwn(patch, "runInParallel");
    const hasParallelism = Object.hasOwn(patch, "parallelism");
    const parallelism = hasParallelism && patch.parallelism !== undefined && Number.isFinite(patch.parallelism) && patch.parallelism > 0
      ? Math.floor(patch.parallelism)
      : undefined;
    return {
      ...step,
      ...(patch.type ? { graphContainerType: patch.type } : {}),
      ...(patch.title !== undefined ? { graphContainerTitle: patch.title.trim() || id } : {}),
      ...(patch.description !== undefined ? { graphContainerDescription: patch.description.trim() } : {}),
      ...(hasMode ? { graphContainerMode: normalizeGraphContainerMode(type, patch.mode) } : {}),
      ...(hasCondition ? { graphContainerCondition: patch.condition?.trim() || undefined } : {}),
      ...(hasIterator ? { graphContainerIterator: patch.iterator?.trim() || undefined } : {}),
      ...(hasSkipFailure ? { graphContainerSkipFailure: patch.skipFailure ? true : undefined } : {}),
      ...(hasRunInParallel ? { graphContainerRunInParallel: patch.runInParallel ? true : undefined } : {}),
      ...(hasParallelism ? { graphContainerParallelism: parallelism } : {}),
    };
  });
  return changed ? next : steps;
}
