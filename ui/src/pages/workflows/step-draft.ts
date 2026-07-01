import {
  normalizeGraphRunStatus,
  parseDependencies,
  type WorkflowGraphContainerType,
  type WorkflowGraphEdgeMetadataRecord,
  type WorkflowGraphRunStatus,
  type WorkflowGraphWorkProduct,
} from "./workflow-graph.js";

export type StepDraft = {
  id: string;
  title: string;
  description: string;
  type: "agent" | "tool";
  toolName: string;
  toolArgs: string;
  agentId: string;
  agentName: string;
  tools: string;
  dependsOn: string;
  onFailure: string;
  maxRetries: string | number;
  graphRetryDelaySeconds: string | number;
  graphRetryBackoff: string;
  graphRetryJitter: boolean;
  timeoutSeconds: string | number;
  graphSleepSeconds: string | number;
  graphSuspendUntil: string;
  graphSuspendTimeoutSeconds: string | number;
  graphSuspendTimeoutAction: string;
  graphEarlyReturn: boolean;
  graphEarlyReturnContentType: string;
  graphEarlyReturnSchema: string;
  graphErrorHandler: boolean;
  graphErrorHandlerScope: string;
  graphErrorHandlerInput: string;
  graphRestartBoundary: boolean;
  graphRestartStrategy: string;
  graphRestartInput: string;
  graphEarlyStopCondition: string;
  graphEarlyStopLabelSkipped: boolean;
  graphApprovalRequired: boolean;
  graphApprovalPrompt: string;
  graphApprovalRecipients: string;
  graphApprovalTimeoutSeconds: string | number;
  graphApprovalTimeoutAction: string;
  graphMockEnabled: boolean;
  graphMockResult: string;
  graphPinnedResultRunId: string;
  graphConcurrencyKey: string;
  graphConcurrencyLimit: string | number;
  graphPriority: string;
  graphCacheEnabled: boolean;
  graphCacheTtlSeconds: string | number;
  graphDeleteAfterUse: boolean;
  graphInputExpression: string;
  graphOutputSchema: string;
  graphWorkProductRequired: boolean;
  graphWorkProductPattern: string;
  graphResourceRefs: string;
  graphSecretRefs: string;
  graphPositionX: string | number;
  graphPositionY: string | number;
  graphGroupId: string;
  graphGroupTitle: string;
  graphGroupColor: string;
  graphGroupCollapsed?: boolean;
  graphGroupCollapsedByDefault: boolean;
  graphContainerId: string;
  graphContainerType: WorkflowGraphContainerType;
  graphContainerTitle: string;
  graphContainerDescription: string;
  graphContainerMode: string;
  graphContainerCondition: string;
  graphContainerIterator: string;
  graphContainerSkipFailure: boolean;
  graphContainerRunInParallel: boolean;
  graphContainerParallelism: string | number;
  graphRunStatus: WorkflowGraphRunStatus;
  graphRunStepRunId?: string;
  graphRunIssueId?: string;
  graphRunIssueIdentifier: string;
  graphRunUpdatedAt: string;
  graphRunSummary: string;
  graphRunStartedAt?: string;
  graphRunCompletedAt?: string;
  graphRunLastDispatchAttemptAt?: string;
  graphRunLastDispatchAcceptedAt?: string;
  graphRunLastDispatchErrorAt?: string;
  graphRunLastDispatchErrorSummary?: string;
  graphRunLastDispatchRequestId?: string;
  graphRunResultPreview?: string;
  graphRunLogPreview?: string;
  graphRunWorkProducts?: WorkflowGraphWorkProduct[];
  graphNote: string;
  graphEdgeMetadata: WorkflowGraphEdgeMetadataRecord;
  extra: Record<string, unknown>;
};

export type WorkflowStepDraftInput = Array<{
  id: string;
  title: string;
  type?: string;
  toolName?: string;
  agentName?: string;
  dependsOn?: string[];
  [key: string]: unknown;
}>;

export function parseOptionalNonNegativeInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseOptionalPositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalGraphPosition(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

export function emptyStep(): StepDraft {
  return {
    id: "",
    title: "",
    description: "",
    type: "agent",
    toolName: "",
    toolArgs: "{}",
    agentId: "",
    agentName: "",
    tools: "",
    dependsOn: "",
    onFailure: "",
    maxRetries: "",
    graphRetryDelaySeconds: "",
    graphRetryBackoff: "",
    graphRetryJitter: false,
    timeoutSeconds: "",
    graphSleepSeconds: "",
    graphSuspendUntil: "",
    graphSuspendTimeoutSeconds: "",
    graphSuspendTimeoutAction: "",
    graphEarlyReturn: false,
    graphEarlyReturnContentType: "",
    graphEarlyReturnSchema: "",
    graphErrorHandler: false,
    graphErrorHandlerScope: "",
    graphErrorHandlerInput: "",
    graphRestartBoundary: false,
    graphRestartStrategy: "",
    graphRestartInput: "",
    graphEarlyStopCondition: "",
    graphEarlyStopLabelSkipped: false,
    graphApprovalRequired: false,
    graphApprovalPrompt: "",
    graphApprovalRecipients: "",
    graphApprovalTimeoutSeconds: "",
    graphApprovalTimeoutAction: "",
    graphMockEnabled: false,
    graphMockResult: "",
    graphPinnedResultRunId: "",
    graphConcurrencyKey: "",
    graphConcurrencyLimit: "",
    graphPriority: "",
    graphCacheEnabled: false,
    graphCacheTtlSeconds: "",
    graphDeleteAfterUse: false,
    graphInputExpression: "",
    graphOutputSchema: "",
    graphWorkProductRequired: false,
    graphWorkProductPattern: "",
    graphResourceRefs: "",
    graphSecretRefs: "",
    graphPositionX: "",
    graphPositionY: "",
    graphGroupId: "",
    graphGroupTitle: "",
    graphGroupColor: "#64748b",
    graphGroupCollapsed: undefined,
    graphGroupCollapsedByDefault: false,
    graphContainerId: "",
    graphContainerType: "branch",
    graphContainerTitle: "",
    graphContainerDescription: "",
    graphContainerMode: "branch-one",
    graphContainerCondition: "",
    graphContainerIterator: "",
    graphContainerSkipFailure: false,
    graphContainerRunInParallel: false,
    graphContainerParallelism: "",
    graphRunStatus: "planned",
    graphRunIssueIdentifier: "",
    graphRunUpdatedAt: "",
    graphRunSummary: "",
    graphNote: "",
    graphEdgeMetadata: {},
    extra: {},
  };
}

export function withStepDraftDefaults(steps: StepDraft[]): StepDraft[] {
  return steps.map((step) => {
    const next = { ...emptyStep() };
    for (const [key, value] of Object.entries(step) as Array<[keyof StepDraft, StepDraft[keyof StepDraft]]>) {
      if (value !== undefined) {
        next[key] = value as never;
      }
    }
    return next;
  });
}

export function stepsToJson(drafts: StepDraft[]): unknown[] {
  const safeText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const safeCsv = (value: unknown): string[] => safeText(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  return drafts.map((d) => {
    const step: Record<string, unknown> = {
      ...d.extra,
      id: safeText(d.id),
      title: safeText(d.title),
      description: safeText(d.description) || undefined,
      type: d.type,
      dependsOn: safeCsv(d.dependsOn),
    };
    if (d.type === "tool") {
      step.toolName = safeText(d.toolName);
      try { step.toolArgs = JSON.parse(d.toolArgs || "{}"); } catch { step.toolArgs = {}; }
    } else {
      // Stale agentId from the generic `extra` bag must never survive an agent
      // change. Persist a consistent agentId+agentName pair; clear both when no
      // agent is set so the server falls back to name-only resolution.
      delete step.agentId;
      if (safeText(d.agentName)) {
        step.agentName = safeText(d.agentName);
        if (safeText(d.agentId)) step.agentId = safeText(d.agentId);
      }
      const toolsList = safeCsv(d.tools);
      if (toolsList.length > 0) step.tools = toolsList;
    }
    if (d.onFailure) step.onFailure = d.onFailure;
    const maxRetries = parseOptionalNonNegativeInteger(String(d.maxRetries ?? ""));
    if (maxRetries !== undefined) step.maxRetries = maxRetries;
    const graphRetryDelaySeconds = parseOptionalPositiveInteger(String(d.graphRetryDelaySeconds ?? ""));
    if (graphRetryDelaySeconds !== undefined) step.graphRetryDelaySeconds = graphRetryDelaySeconds;
    if (safeText(d.graphRetryBackoff)) step.graphRetryBackoff = safeText(d.graphRetryBackoff);
    if (d.graphRetryJitter) step.graphRetryJitter = true;
    const timeoutSeconds = parseOptionalPositiveInteger(String(d.timeoutSeconds ?? ""));
    if (timeoutSeconds !== undefined) step.timeoutSeconds = timeoutSeconds;
    const graphSleepSeconds = parseOptionalPositiveInteger(String(d.graphSleepSeconds ?? ""));
    if (graphSleepSeconds !== undefined) step.graphSleepSeconds = graphSleepSeconds;
    if (safeText(d.graphSuspendUntil)) step.graphSuspendUntil = safeText(d.graphSuspendUntil);
    const graphSuspendTimeoutSeconds = parseOptionalPositiveInteger(String(d.graphSuspendTimeoutSeconds ?? ""));
    if (graphSuspendTimeoutSeconds !== undefined) step.graphSuspendTimeoutSeconds = graphSuspendTimeoutSeconds;
    if (safeText(d.graphSuspendTimeoutAction)) step.graphSuspendTimeoutAction = safeText(d.graphSuspendTimeoutAction);
    if (d.graphEarlyReturn) step.graphEarlyReturn = true;
    if (safeText(d.graphEarlyReturnContentType)) step.graphEarlyReturnContentType = safeText(d.graphEarlyReturnContentType);
    if (safeText(d.graphEarlyReturnSchema)) step.graphEarlyReturnSchema = safeText(d.graphEarlyReturnSchema);
    if (d.graphErrorHandler) step.graphErrorHandler = true;
    if (safeText(d.graphErrorHandlerScope)) step.graphErrorHandlerScope = safeText(d.graphErrorHandlerScope);
    if (safeText(d.graphErrorHandlerInput)) step.graphErrorHandlerInput = safeText(d.graphErrorHandlerInput);
    if (d.graphRestartBoundary) step.graphRestartBoundary = true;
    if (safeText(d.graphRestartStrategy)) step.graphRestartStrategy = safeText(d.graphRestartStrategy);
    if (safeText(d.graphRestartInput)) step.graphRestartInput = safeText(d.graphRestartInput);
    if (safeText(d.graphEarlyStopCondition)) step.graphEarlyStopCondition = safeText(d.graphEarlyStopCondition);
    if (d.graphEarlyStopLabelSkipped) step.graphEarlyStopLabelSkipped = true;
    if (d.graphApprovalRequired) step.graphApprovalRequired = true;
    if (safeText(d.graphApprovalPrompt)) step.graphApprovalPrompt = safeText(d.graphApprovalPrompt);
    if (safeText(d.graphApprovalRecipients)) step.graphApprovalRecipients = safeText(d.graphApprovalRecipients);
    const graphApprovalTimeoutSeconds = parseOptionalPositiveInteger(String(d.graphApprovalTimeoutSeconds ?? ""));
    if (graphApprovalTimeoutSeconds !== undefined) step.graphApprovalTimeoutSeconds = graphApprovalTimeoutSeconds;
    if (safeText(d.graphApprovalTimeoutAction)) step.graphApprovalTimeoutAction = safeText(d.graphApprovalTimeoutAction);
    if (d.graphMockEnabled) step.graphMockEnabled = true;
    if (safeText(d.graphMockResult)) step.graphMockResult = safeText(d.graphMockResult);
    if (safeText(d.graphPinnedResultRunId)) step.graphPinnedResultRunId = safeText(d.graphPinnedResultRunId);
    if (safeText(d.graphConcurrencyKey)) step.graphConcurrencyKey = safeText(d.graphConcurrencyKey);
    const graphConcurrencyLimit = parseOptionalPositiveInteger(String(d.graphConcurrencyLimit ?? ""));
    if (graphConcurrencyLimit !== undefined) step.graphConcurrencyLimit = graphConcurrencyLimit;
    if (safeText(d.graphPriority)) step.graphPriority = safeText(d.graphPriority);
    if (d.graphCacheEnabled) step.graphCacheEnabled = true;
    const graphCacheTtlSeconds = parseOptionalPositiveInteger(String(d.graphCacheTtlSeconds ?? ""));
    if (graphCacheTtlSeconds !== undefined) step.graphCacheTtlSeconds = graphCacheTtlSeconds;
    if (d.graphDeleteAfterUse) step.graphDeleteAfterUse = true;
    if (safeText(d.graphInputExpression)) step.graphInputExpression = safeText(d.graphInputExpression);
    if (safeText(d.graphOutputSchema)) step.graphOutputSchema = safeText(d.graphOutputSchema);
    if (d.graphWorkProductRequired) step.graphWorkProductRequired = true;
    if (safeText(d.graphWorkProductPattern)) step.graphWorkProductPattern = safeText(d.graphWorkProductPattern);
    const graphResourceRefs = safeCsv(d.graphResourceRefs);
    if (graphResourceRefs.length > 0) step.graphResourceRefs = Array.from(new Set(graphResourceRefs));
    const graphSecretRefs = safeCsv(d.graphSecretRefs);
    if (graphSecretRefs.length > 0) step.graphSecretRefs = Array.from(new Set(graphSecretRefs));
    const graphPositionX = parseOptionalGraphPosition(d.graphPositionX);
    const graphPositionY = parseOptionalGraphPosition(d.graphPositionY);
    if (graphPositionX !== undefined) step.graphPositionX = graphPositionX;
    if (graphPositionY !== undefined) step.graphPositionY = graphPositionY;
    if (safeText(d.graphGroupId)) step.graphGroupId = safeText(d.graphGroupId);
    if (safeText(d.graphGroupTitle)) step.graphGroupTitle = safeText(d.graphGroupTitle);
    if (safeText(d.graphGroupColor)) step.graphGroupColor = safeText(d.graphGroupColor);
    if (d.graphGroupCollapsed) step.graphGroupCollapsed = true;
    if (d.graphGroupCollapsedByDefault) step.graphGroupCollapsedByDefault = true;
    if (safeText(d.graphContainerId)) step.graphContainerId = safeText(d.graphContainerId);
    if (safeText(d.graphContainerType)) step.graphContainerType = safeText(d.graphContainerType);
    if (safeText(d.graphContainerTitle)) step.graphContainerTitle = safeText(d.graphContainerTitle);
    if (safeText(d.graphContainerDescription)) step.graphContainerDescription = safeText(d.graphContainerDescription);
    if (safeText(d.graphContainerMode)) step.graphContainerMode = safeText(d.graphContainerMode);
    if (safeText(d.graphContainerCondition)) step.graphContainerCondition = safeText(d.graphContainerCondition);
    if (safeText(d.graphContainerIterator)) step.graphContainerIterator = safeText(d.graphContainerIterator);
    if (d.graphContainerSkipFailure) step.graphContainerSkipFailure = true;
    if (d.graphContainerRunInParallel) step.graphContainerRunInParallel = true;
    const graphContainerParallelism = parseOptionalPositiveInteger(String(d.graphContainerParallelism ?? ""));
    if (graphContainerParallelism !== undefined) step.graphContainerParallelism = graphContainerParallelism;
    if (safeText(d.graphRunStatus) && d.graphRunStatus !== "planned") step.graphRunStatus = safeText(d.graphRunStatus);
    if (safeText(d.graphRunIssueIdentifier)) step.graphRunIssueIdentifier = safeText(d.graphRunIssueIdentifier);
    if (safeText(d.graphRunUpdatedAt)) step.graphRunUpdatedAt = safeText(d.graphRunUpdatedAt);
    if (safeText(d.graphRunSummary)) step.graphRunSummary = safeText(d.graphRunSummary);
    if (safeText(d.graphNote)) step.graphNote = safeText(d.graphNote);
    const graphEdgeMetadata = d.graphEdgeMetadata ?? {};
    if (Object.keys(graphEdgeMetadata).length > 0) step.graphEdgeMetadata = graphEdgeMetadata;
    return step;
  });
}

export function jsonToSteps(steps: WorkflowStepDraftInput): StepDraft[] {
  return steps.map((s) => {
    const raw = s as Record<string, unknown>;
    const rawToolArgs = raw.toolArgs;
    const extra = { ...raw };
    for (const key of [
      "id",
      "title",
      "name",
      "description",
      "type",
      "toolName",
      "toolArgs",
      "agentId",
      "agentName",
      "tools",
      "toolNames",
      "dependsOn",
      "dependencies",
      "onFailure",
      "maxRetries",
      "graphRetryDelaySeconds",
      "graphRetryBackoff",
      "graphRetryJitter",
      "timeoutSeconds",
      "graphSleepSeconds",
      "graphSuspendUntil",
      "graphSuspendTimeoutSeconds",
      "graphSuspendTimeoutAction",
      "graphEarlyReturn",
      "graphEarlyReturnContentType",
      "graphEarlyReturnSchema",
      "graphErrorHandler",
      "graphErrorHandlerScope",
      "graphErrorHandlerInput",
      "graphRestartBoundary",
      "graphRestartStrategy",
      "graphRestartInput",
      "graphEarlyStopCondition",
      "graphEarlyStopLabelSkipped",
      "graphApprovalRequired",
      "graphApprovalPrompt",
      "graphApprovalRecipients",
      "graphApprovalTimeoutSeconds",
      "graphApprovalTimeoutAction",
      "graphMockEnabled",
      "graphMockResult",
      "graphPinnedResultRunId",
      "graphConcurrencyKey",
      "graphConcurrencyLimit",
      "graphPriority",
      "graphCacheEnabled",
      "graphCacheTtlSeconds",
      "graphDeleteAfterUse",
      "graphInputExpression",
      "graphOutputSchema",
      "graphWorkProductRequired",
      "graphWorkProductPattern",
      "graphResourceRefs",
      "graphSecretRefs",
      "graphPositionX",
      "graphPositionY",
      "graphGroupId",
      "graphGroupTitle",
      "graphGroupColor",
      "graphGroupCollapsed",
      "graphGroupCollapsedByDefault",
      "graphContainerId",
      "graphContainerType",
      "graphContainerTitle",
      "graphContainerDescription",
      "graphContainerMode",
      "graphContainerCondition",
      "graphContainerIterator",
      "graphContainerSkipFailure",
      "graphContainerRunInParallel",
      "graphContainerParallelism",
      "graphRunStatus",
      "graphRunIssueIdentifier",
      "graphRunUpdatedAt",
      "graphRunSummary",
      "graphNote",
      "graphEdgeMetadata",
    ]) {
      delete extra[key];
    }
    const rawGraphEdgeMetadata = raw.graphEdgeMetadata && typeof raw.graphEdgeMetadata === "object" && !Array.isArray(raw.graphEdgeMetadata)
      ? raw.graphEdgeMetadata as WorkflowGraphEdgeMetadataRecord
      : {};
    return {
      id: s.id,
      title: s.title,
      description: raw.description as string || "",
      type: (s.type as "agent" | "tool") || "agent",
      toolName: s.toolName || "",
      toolArgs: JSON.stringify(
        rawToolArgs && typeof rawToolArgs === "object" ? rawToolArgs : {},
        null,
        2,
      ),
      agentId: typeof raw.agentId === "string" ? raw.agentId : "",
      agentName: s.agentName || "",
      tools: Array.isArray(raw.tools)
        ? (raw.tools as string[]).join(", ")
        : Array.isArray(raw.toolNames)
          ? (raw.toolNames as string[]).join(", ")
          : "",
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.join(", ") : parseDependencies(raw.dependencies).join(", "),
      onFailure: typeof raw.onFailure === "string" ? raw.onFailure : "",
      maxRetries: typeof raw.maxRetries === "number" || typeof raw.maxRetries === "string" ? String(raw.maxRetries) : "",
      graphRetryDelaySeconds: typeof raw.graphRetryDelaySeconds === "number" || typeof raw.graphRetryDelaySeconds === "string" ? String(raw.graphRetryDelaySeconds) : "",
      graphRetryBackoff: typeof raw.graphRetryBackoff === "string" ? raw.graphRetryBackoff : "",
      graphRetryJitter: raw.graphRetryJitter === true || raw.graphRetryJitter === "true",
      timeoutSeconds: typeof raw.timeoutSeconds === "number" || typeof raw.timeoutSeconds === "string" ? String(raw.timeoutSeconds) : "",
      graphSleepSeconds: typeof raw.graphSleepSeconds === "number" || typeof raw.graphSleepSeconds === "string" ? String(raw.graphSleepSeconds) : "",
      graphSuspendUntil: typeof raw.graphSuspendUntil === "string" ? raw.graphSuspendUntil : "",
      graphSuspendTimeoutSeconds: typeof raw.graphSuspendTimeoutSeconds === "number" || typeof raw.graphSuspendTimeoutSeconds === "string" ? String(raw.graphSuspendTimeoutSeconds) : "",
      graphSuspendTimeoutAction: typeof raw.graphSuspendTimeoutAction === "string" ? raw.graphSuspendTimeoutAction : "",
      graphEarlyReturn: raw.graphEarlyReturn === true || raw.graphEarlyReturn === "true",
      graphEarlyReturnContentType: typeof raw.graphEarlyReturnContentType === "string" ? raw.graphEarlyReturnContentType : "",
      graphEarlyReturnSchema: typeof raw.graphEarlyReturnSchema === "string" ? raw.graphEarlyReturnSchema : "",
      graphErrorHandler: raw.graphErrorHandler === true || raw.graphErrorHandler === "true",
      graphErrorHandlerScope: typeof raw.graphErrorHandlerScope === "string" ? raw.graphErrorHandlerScope : "",
      graphErrorHandlerInput: typeof raw.graphErrorHandlerInput === "string" ? raw.graphErrorHandlerInput : "",
      graphRestartBoundary: raw.graphRestartBoundary === true || raw.graphRestartBoundary === "true",
      graphRestartStrategy: typeof raw.graphRestartStrategy === "string" ? raw.graphRestartStrategy : "",
      graphRestartInput: typeof raw.graphRestartInput === "string" ? raw.graphRestartInput : "",
      graphEarlyStopCondition: typeof raw.graphEarlyStopCondition === "string" ? raw.graphEarlyStopCondition : "",
      graphEarlyStopLabelSkipped: raw.graphEarlyStopLabelSkipped === true || raw.graphEarlyStopLabelSkipped === "true",
      graphApprovalRequired: raw.graphApprovalRequired === true || raw.graphApprovalRequired === "true",
      graphApprovalPrompt: typeof raw.graphApprovalPrompt === "string" ? raw.graphApprovalPrompt : "",
      graphApprovalRecipients: Array.isArray(raw.graphApprovalRecipients)
        ? (raw.graphApprovalRecipients as string[]).join(", ")
        : typeof raw.graphApprovalRecipients === "string"
          ? raw.graphApprovalRecipients
          : "",
      graphApprovalTimeoutSeconds: typeof raw.graphApprovalTimeoutSeconds === "number" || typeof raw.graphApprovalTimeoutSeconds === "string" ? String(raw.graphApprovalTimeoutSeconds) : "",
      graphApprovalTimeoutAction: typeof raw.graphApprovalTimeoutAction === "string" ? raw.graphApprovalTimeoutAction : "",
      graphMockEnabled: raw.graphMockEnabled === true || raw.graphMockEnabled === "true",
      graphMockResult: typeof raw.graphMockResult === "string" ? raw.graphMockResult : "",
      graphPinnedResultRunId: typeof raw.graphPinnedResultRunId === "string" ? raw.graphPinnedResultRunId : "",
      graphConcurrencyKey: typeof raw.graphConcurrencyKey === "string" ? raw.graphConcurrencyKey : "",
      graphConcurrencyLimit: typeof raw.graphConcurrencyLimit === "number" || typeof raw.graphConcurrencyLimit === "string" ? String(raw.graphConcurrencyLimit) : "",
      graphPriority: typeof raw.graphPriority === "string" ? raw.graphPriority : "",
      graphCacheEnabled: raw.graphCacheEnabled === true || raw.graphCacheEnabled === "true",
      graphCacheTtlSeconds: typeof raw.graphCacheTtlSeconds === "number" || typeof raw.graphCacheTtlSeconds === "string" ? String(raw.graphCacheTtlSeconds) : "",
      graphDeleteAfterUse: raw.graphDeleteAfterUse === true || raw.graphDeleteAfterUse === "true",
      graphInputExpression: typeof raw.graphInputExpression === "string" ? raw.graphInputExpression : "",
      graphOutputSchema: typeof raw.graphOutputSchema === "string" ? raw.graphOutputSchema : "",
      graphWorkProductRequired: raw.graphWorkProductRequired === true || raw.graphWorkProductRequired === "true",
      graphWorkProductPattern: typeof raw.graphWorkProductPattern === "string" ? raw.graphWorkProductPattern : "",
      graphResourceRefs: Array.isArray(raw.graphResourceRefs)
        ? (raw.graphResourceRefs as string[]).join(", ")
        : typeof raw.graphResourceRefs === "string"
          ? raw.graphResourceRefs
          : "",
      graphSecretRefs: Array.isArray(raw.graphSecretRefs)
        ? (raw.graphSecretRefs as string[]).join(", ")
        : typeof raw.graphSecretRefs === "string"
          ? raw.graphSecretRefs
          : "",
      graphPositionX: typeof raw.graphPositionX === "number" || typeof raw.graphPositionX === "string" ? String(raw.graphPositionX) : "",
      graphPositionY: typeof raw.graphPositionY === "number" || typeof raw.graphPositionY === "string" ? String(raw.graphPositionY) : "",
      graphGroupId: typeof raw.graphGroupId === "string" ? raw.graphGroupId : "",
      graphGroupTitle: typeof raw.graphGroupTitle === "string" ? raw.graphGroupTitle : "",
      graphGroupColor: typeof raw.graphGroupColor === "string" && raw.graphGroupColor.trim() ? raw.graphGroupColor : "#64748b",
      graphGroupCollapsed: raw.graphGroupCollapsed === true || raw.graphGroupCollapsed === "true"
        ? true
        : raw.graphGroupCollapsed === false || raw.graphGroupCollapsed === "false"
          ? false
          : undefined,
      graphGroupCollapsedByDefault: raw.graphGroupCollapsedByDefault === true || raw.graphGroupCollapsedByDefault === "true",
      graphContainerId: typeof raw.graphContainerId === "string" ? raw.graphContainerId : "",
      graphContainerType: raw.graphContainerType === "loop" ? "loop" : "branch",
      graphContainerTitle: typeof raw.graphContainerTitle === "string" ? raw.graphContainerTitle : "",
      graphContainerDescription: typeof raw.graphContainerDescription === "string" ? raw.graphContainerDescription : "",
      graphContainerMode: typeof raw.graphContainerMode === "string"
        ? raw.graphContainerMode
        : raw.graphContainerType === "loop"
          ? "for-each"
          : "branch-one",
      graphContainerCondition: typeof raw.graphContainerCondition === "string" ? raw.graphContainerCondition : "",
      graphContainerIterator: typeof raw.graphContainerIterator === "string" ? raw.graphContainerIterator : "",
      graphContainerSkipFailure: raw.graphContainerSkipFailure === true || raw.graphContainerSkipFailure === "true",
      graphContainerRunInParallel: raw.graphContainerRunInParallel === true || raw.graphContainerRunInParallel === "true",
      graphContainerParallelism: typeof raw.graphContainerParallelism === "number" || typeof raw.graphContainerParallelism === "string" ? String(raw.graphContainerParallelism) : "",
      graphRunStatus: normalizeGraphRunStatus(raw.graphRunStatus),
      graphRunIssueIdentifier: typeof raw.graphRunIssueIdentifier === "string" ? raw.graphRunIssueIdentifier : "",
      graphRunUpdatedAt: typeof raw.graphRunUpdatedAt === "string" ? raw.graphRunUpdatedAt : "",
      graphRunSummary: typeof raw.graphRunSummary === "string" ? raw.graphRunSummary : "",
      graphNote: typeof raw.graphNote === "string" ? raw.graphNote : "",
      graphEdgeMetadata: rawGraphEdgeMetadata,
      extra,
    };
  });
}
