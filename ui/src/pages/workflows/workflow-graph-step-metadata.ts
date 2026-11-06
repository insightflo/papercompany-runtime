// Tolerant readers for persisted workflow-step metadata, settings and policy records.
// Split out of workflow-graph.ts (pure move, function bodies unchanged).

import type { WorkflowGraphApprovalTimeoutAction, WorkflowGraphStep, WorkflowGraphStepAdvanced, WorkflowGraphStepApproval, WorkflowGraphStepDataFlow, WorkflowGraphStepExecution, WorkflowGraphStepTesting } from "./workflow-graph-types-core.js";
import type { WorkflowGraphStepResources } from "./workflow-graph-types-model.js";

function readBooleanSetting(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number.parseInt(value.trim(), 10)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number.parseInt(value.trim(), 10)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  return normalized >= 0 ? normalized : null;
}

function parseRecipientList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.flatMap((entry) => parseRecipientList(entry))));
  }
  if (typeof value !== "string") return [];
  return Array.from(new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean)));
}

function parseReferenceList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.flatMap((entry) => parseReferenceList(entry))));
  }
  if (typeof value !== "string") return [];
  return Array.from(new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean)));
}

function normalizeApprovalTimeoutAction(value: unknown): WorkflowGraphApprovalTimeoutAction {
  const action = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (action === "resume" || action === "cancel") return action;
  return "";
}

function formatApprovalTimeoutAction(action: WorkflowGraphApprovalTimeoutAction): string {
  if (action === "resume") return "Resume on timeout";
  if (action === "cancel") return "Cancel on timeout";
  return "";
}

function normalizeRetryBackoff(value: unknown): string {
  const backoff = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (backoff === "fixed" || backoff === "linear" || backoff === "exponential") return backoff;
  return "";
}

function readStepApproval(step: WorkflowGraphStep): WorkflowGraphStepApproval {
  const required = readBooleanSetting(step.graphApprovalRequired) === true;
  const prompt = typeof step.graphApprovalPrompt === "string" ? step.graphApprovalPrompt.trim() : "";
  const recipients = parseRecipientList(step.graphApprovalRecipients);
  const timeoutSeconds = readPositiveInteger(step.graphApprovalTimeoutSeconds);
  const timeoutAction = normalizeApprovalTimeoutAction(step.graphApprovalTimeoutAction);
  const badges: string[] = [];
  if (required) badges.push("Approval gate");
  if (recipients.length > 0) badges.push(`Approvers ${recipients.length}`);
  if (timeoutSeconds !== null) badges.push(`Timeout ${timeoutSeconds}s`);
  const timeoutActionLabel = formatApprovalTimeoutAction(timeoutAction);
  if (timeoutActionLabel) badges.push(timeoutActionLabel);
  return {
    required,
    prompt,
    recipients,
    timeoutSeconds,
    timeoutAction,
    badges,
  };
}

function readStepTesting(step: WorkflowGraphStep): WorkflowGraphStepTesting {
  const mockEnabled = readBooleanSetting(step.graphMockEnabled) === true;
  const mockResult = typeof step.graphMockResult === "string" ? step.graphMockResult.trim() : "";
  const pinnedResultRunId = typeof step.graphPinnedResultRunId === "string" ? step.graphPinnedResultRunId.trim() : "";
  const badges: string[] = [];
  if (mockEnabled) badges.push("Mocked");
  if (pinnedResultRunId) badges.push("Pinned result");
  return {
    mockEnabled,
    mockResult,
    pinnedResultRunId,
    badges,
  };
}

function readStepExecution(step: WorkflowGraphStep): WorkflowGraphStepExecution {
  const concurrencyKey = typeof step.graphConcurrencyKey === "string" ? step.graphConcurrencyKey.trim() : "";
  const concurrencyLimit = readPositiveInteger(step.graphConcurrencyLimit);
  const priority = typeof step.graphPriority === "string" ? step.graphPriority.trim().toLowerCase() : "";
  const cacheEnabled = readBooleanSetting(step.graphCacheEnabled) === true;
  const cacheTtlSeconds = readPositiveInteger(step.graphCacheTtlSeconds);
  const deleteAfterUse = readBooleanSetting(step.graphDeleteAfterUse) === true;
  const badges: string[] = [];
  if (concurrencyLimit !== null) badges.push(`Concurrency x${concurrencyLimit}`);
  if (priority) badges.push(`Priority ${priority}`);
  if (cacheEnabled) badges.push(cacheTtlSeconds !== null ? `Cache ${cacheTtlSeconds}s` : "Cache");
  if (deleteAfterUse) badges.push("Delete after use");
  return {
    concurrencyKey,
    concurrencyLimit,
    priority,
    cacheEnabled,
    cacheTtlSeconds,
    deleteAfterUse,
    badges,
  };
}

function readStepDataFlow(step: WorkflowGraphStep): WorkflowGraphStepDataFlow {
  const inputExpression = typeof step.graphInputExpression === "string" ? step.graphInputExpression.trim() : "";
  const outputSchema = typeof step.graphOutputSchema === "string" ? step.graphOutputSchema.trim() : "";
  const workProductRequired = readBooleanSetting(step.graphWorkProductRequired) === true;
  const workProductPattern = typeof step.graphWorkProductPattern === "string" ? step.graphWorkProductPattern.trim() : "";
  const badges: string[] = [];
  if (inputExpression) badges.push("Input map");
  if (outputSchema) badges.push("Output schema");
  if (workProductRequired) badges.push("Requires output");
  if (workProductPattern) badges.push("Output pattern");
  return {
    inputExpression,
    outputSchema,
    workProductRequired,
    workProductPattern,
    badges,
  };
}

function readStepResources(step: WorkflowGraphStep): WorkflowGraphStepResources {
  const resourceRefs = parseReferenceList(step.graphResourceRefs);
  const secretRefs = parseReferenceList(step.graphSecretRefs);
  const badges: string[] = [];
  if (resourceRefs.length > 0) badges.push(`Resources ${resourceRefs.length}`);
  if (secretRefs.length > 0) badges.push(`Secrets ${secretRefs.length}`);
  return {
    resourceRefs,
    secretRefs,
    badges,
  };
}

function readStepAdvanced(step: WorkflowGraphStep): WorkflowGraphStepAdvanced {
  const onFailure = typeof step.onFailure === "string" ? step.onFailure.trim() : "";
  const maxRetries = readNonNegativeInteger(step.maxRetries);
  const retryDelaySeconds = readNonNegativeInteger(step.graphRetryDelaySeconds);
  const retryBackoff = normalizeRetryBackoff(step.graphRetryBackoff);
  const retryJitter = readBooleanSetting(step.graphRetryJitter) === true;
  const timeoutSeconds = readPositiveInteger(step.timeoutSeconds);
  const sleepSeconds = readPositiveInteger(step.graphSleepSeconds);
  const suspendUntil = typeof step.graphSuspendUntil === "string" ? step.graphSuspendUntil.trim() : "";
  const suspendTimeoutSeconds = readPositiveInteger(step.graphSuspendTimeoutSeconds);
  const suspendTimeoutAction = normalizeApprovalTimeoutAction(step.graphSuspendTimeoutAction);
  const earlyReturn = readBooleanSetting(step.graphEarlyReturn) === true;
  const earlyReturnContentType = typeof step.graphEarlyReturnContentType === "string" ? step.graphEarlyReturnContentType.trim() : "";
  const earlyReturnSchema = typeof step.graphEarlyReturnSchema === "string" ? step.graphEarlyReturnSchema.trim() : "";
  const errorHandler = readBooleanSetting(step.graphErrorHandler) === true;
  const errorHandlerScope = typeof step.graphErrorHandlerScope === "string" ? step.graphErrorHandlerScope.trim() : "";
  const errorHandlerInput = typeof step.graphErrorHandlerInput === "string" ? step.graphErrorHandlerInput.trim() : "";
  const restartBoundary = readBooleanSetting(step.graphRestartBoundary) === true;
  const restartStrategy = typeof step.graphRestartStrategy === "string" ? step.graphRestartStrategy.trim() : "";
  const restartInput = typeof step.graphRestartInput === "string" ? step.graphRestartInput.trim() : "";
  const earlyStopCondition = typeof step.graphEarlyStopCondition === "string" ? step.graphEarlyStopCondition.trim() : "";
  const earlyStopLabelSkipped = readBooleanSetting(step.graphEarlyStopLabelSkipped) === true;
  const approval = readStepApproval(step);
  const badges: string[] = [];
  if (onFailure === "retry") {
    badges.push(`Retry x${maxRetries ?? 2}`);
    if (retryDelaySeconds !== null) badges.push(`Retry delay ${retryDelaySeconds}s`);
    if (retryBackoff) badges.push(`Backoff ${retryBackoff}`);
    if (retryJitter) badges.push("Jitter");
  } else if (onFailure === "skip") {
    badges.push("Skip on failure");
  } else if (onFailure === "escalate") {
    badges.push("Escalate on failure");
  } else if (onFailure === "abort_workflow") {
    badges.push("Abort on failure");
  } else if (onFailure === "handler") {
    badges.push("Route failure");
  }
  if (timeoutSeconds !== null) badges.push(`Timeout ${timeoutSeconds}s`);
  if (sleepSeconds !== null) badges.push(`Sleep ${sleepSeconds}s`);
  if (suspendUntil) badges.push("Suspend");
  if (suspendTimeoutSeconds !== null) badges.push(`Suspend timeout ${suspendTimeoutSeconds}s`);
  const suspendTimeoutActionLabel = formatApprovalTimeoutAction(suspendTimeoutAction);
  if (suspendTimeoutActionLabel) badges.push(suspendTimeoutActionLabel);
  if (earlyReturn) badges.push("Early return");
  if (earlyReturnContentType) badges.push(`Return ${earlyReturnContentType}`);
  if (earlyReturnSchema) badges.push("Return schema");
  if (errorHandler) badges.push("Error handler");
  if (errorHandlerScope) badges.push(`Scope ${errorHandlerScope}`);
  if (errorHandlerInput) badges.push("Error input");
  if (restartBoundary) badges.push("Restart boundary");
  if (restartStrategy) badges.push(`Restart ${restartStrategy}`);
  if (restartInput) badges.push("Restart input");
  if (earlyStopCondition) badges.push("Early stop");
  badges.push(...approval.badges);
  return {
    onFailure,
    maxRetries,
    retryDelaySeconds,
    retryBackoff,
    retryJitter,
    timeoutSeconds,
    sleepSeconds,
    suspendUntil,
    suspendTimeoutSeconds,
    suspendTimeoutAction,
    earlyReturn,
    earlyReturnContentType,
    earlyReturnSchema,
    errorHandler,
    errorHandlerScope,
    errorHandlerInput,
    restartBoundary,
    restartStrategy,
    restartInput,
    earlyStopCondition,
    earlyStopLabelSkipped,
    approval,
    badges,
  };
}

export {
  readBooleanSetting,
  readPositiveInteger,
  readNonNegativeInteger,
  parseRecipientList,
  parseReferenceList,
  normalizeApprovalTimeoutAction,
  formatApprovalTimeoutAction,
  normalizeRetryBackoff,
  readStepApproval,
  readStepTesting,
  readStepExecution,
  readStepDataFlow,
  readStepResources,
  readStepAdvanced,
};
