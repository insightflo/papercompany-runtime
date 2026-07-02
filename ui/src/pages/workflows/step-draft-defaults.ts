import type { StepDraft } from "./step-draft-types.js";

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
