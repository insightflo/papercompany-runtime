import type { WorkflowGraphRestartPreview } from "./workflow-graph-types-test.js";

export type WorkflowGraphStep = {
  id: string;
  title?: string;
  type?: string;
  dependsOn?: string | string[];
  onFailure?: string;
  maxRetries?: number | string;
  graphRetryDelaySeconds?: number | string;
  graphRetryBackoff?: string;
  graphRetryJitter?: boolean | string;
  timeoutSeconds?: number | string;
  graphSleepSeconds?: number | string;
  graphSuspendUntil?: string;
  graphSuspendTimeoutSeconds?: number | string;
  graphSuspendTimeoutAction?: string;
  graphEarlyReturn?: boolean | string;
  graphEarlyReturnContentType?: string;
  graphEarlyReturnSchema?: string;
  graphErrorHandler?: boolean | string;
  graphErrorHandlerScope?: string;
  graphErrorHandlerInput?: string;
  graphRestartBoundary?: boolean | string;
  graphRestartStrategy?: string;
  graphRestartInput?: string;
  graphEarlyStopCondition?: string;
  graphEarlyStopLabelSkipped?: boolean | string;
  graphApprovalRequired?: boolean | string;
  graphApprovalPrompt?: string;
  graphApprovalRecipients?: string | string[];
  graphApprovalTimeoutSeconds?: number | string;
  graphApprovalTimeoutAction?: string;
  graphMockEnabled?: boolean | string;
  graphMockResult?: string;
  graphPinnedResultRunId?: string;
  graphConcurrencyKey?: string;
  graphConcurrencyLimit?: number | string;
  graphPriority?: string;
  graphCacheEnabled?: boolean | string;
  graphCacheTtlSeconds?: number | string;
  graphDeleteAfterUse?: boolean | string;
  graphInputExpression?: string;
  graphOutputSchema?: string;
  graphWorkProductRequired?: boolean | string;
  graphWorkProductPattern?: string;
  graphResourceRefs?: string | string[];
  graphSecretRefs?: string | string[];
  graphPositionX?: number | string;
  graphPositionY?: number | string;
  graphGroupId?: string;
  graphGroupTitle?: string;
  graphGroupColor?: string;
  graphGroupCollapsed?: boolean | string;
  graphGroupCollapsedByDefault?: boolean | string;
  graphContainerId?: string;
  graphContainerType?: string;
  graphContainerTitle?: string;
  graphContainerDescription?: string;
  graphContainerMode?: string;
  graphContainerCondition?: string;
  graphContainerIterator?: string;
  graphContainerSkipFailure?: boolean | string;
  graphContainerRunInParallel?: boolean | string;
  graphContainerParallelism?: number | string;
  graphRunStatus?: string;
  graphRunIssueIdentifier?: string;
  graphRunUpdatedAt?: string;
  graphRunSummary?: string;
  graphRunResultPreview?: string;
  graphRunLogPreview?: string;
  graphRunControlOutcome?: string;
  graphRunRetryCount?: number;
  graphRunRetryMaxRetries?: number;
  graphRunRetryState?: string;
  graphRunRetryNextEligibleAt?: string;
  graphNote?: string;
  graphEdgeMetadata?: WorkflowGraphEdgeMetadataRecord;
  conditionalDependencies?: Array<{
    stepId?: unknown;
    when?: unknown;
    isBackEdge?: unknown;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type WorkflowGraphRunStatus = "planned" | "running" | "succeeded" | "failed" | "skipped" | "paused";

export type WorkflowGraphEdgeKind = "normal" | "conditional" | "failure" | "early-stop";

export type WorkflowGraphEdgeMetadataInput = {
  kind?: string;
  label?: string;
  condition?: string;
};

export type WorkflowGraphEdgeMetadata = {
  kind: WorkflowGraphEdgeKind;
  label: string;
  condition: string;
};

export type WorkflowGraphEdgeMetadataRecord = Record<string, WorkflowGraphEdgeMetadataInput>;

export type WorkflowGraphStepRunStatus = {
  status: WorkflowGraphRunStatus;
  stepRunId: string;
  issueId: string;
  issueIdentifier: string;
  updatedAt: string;
  summary: string;
  startedAt: string;
  completedAt: string;
  lastDispatchAttemptAt: string;
  lastDispatchAcceptedAt: string;
  lastDispatchErrorAt: string;
  lastDispatchErrorSummary: string;
  lastDispatchRequestId: string;
  resultPreview: string;
  logPreview: string;
  workProducts: WorkflowGraphWorkProduct[];
  concurrencyBlocked?: WorkflowGraphConcurrencyBlocked;
  retentionDeleted?: WorkflowGraphRetentionDeleted;
  runtimeBadges: string[];
  controlOutcome: string;
  retryCount: number;
  retryMaxRetries: number;
  retryState: string;
  retryNextEligibleAt: string;
};

export type WorkflowGraphWorkProduct = {
  id: string;
  title: string;
  type?: string;
  url?: string | null;
  status?: string;
  summary?: string | null;
  isPrimary?: boolean;
};

export type WorkflowGraphConcurrencyBlocked = {
  concurrencyKey: string;
  concurrencyLimit: number | null;
  runningCount: number | null;
  checkedAt: string;
};

export type WorkflowGraphRetentionDeleted = {
  deleteAfterUse: boolean;
  toolName: string;
  success: boolean | null;
  exitCode: number | null;
  deletedAt: string;
};

export type WorkflowGraphStepRunInput = {
  id?: string;
  stepId: string;
  status?: string;
  issueId?: string;
  issueIdentifier?: string;
  agentName?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  lastDispatchAcceptedAt?: string | null;
  lastDispatchAttemptAt?: string | null;
  lastDispatchErrorAt?: string | null;
  lastDispatchErrorSummary?: string | null;
  lastDispatchRequestId?: string | null;
  workProducts?: WorkflowGraphWorkProduct[] | null;
  retryCount?: number;
  metadata?: Record<string, unknown> | null;
};

export type WorkflowGraphRunDebugTileTone = "success" | "warning" | "danger" | "info" | "neutral";

export type WorkflowGraphRunDebugTile = {
  id: "completed" | "failure" | "restart" | "evidence";
  title: string;
  status: string;
  tone: WorkflowGraphRunDebugTileTone;
  summary: string;
  badges: string[];
};

export type WorkflowGraphRunDebugSummary = {
  available: boolean;
  focusStepId: string;
  title: string;
  summary: string;
  tone: WorkflowGraphRunDebugTileTone;
  badges: string[];
  counts: {
    total: number;
    planned: number;
    running: number;
    succeeded: number;
    failed: number;
    skipped: number;
    paused: number;
    issues: number;
    workProducts: number;
  };
  restartPreview: WorkflowGraphRestartPreview;
  tiles: WorkflowGraphRunDebugTile[];
};

export type WorkflowGraphRunDebugInput<TStep extends WorkflowGraphStep = WorkflowGraphStep> = {
  steps: TStep[];
  stepRuns?: WorkflowGraphStepRunInput[] | null;
  selectedStepId?: string;
};

export type WorkflowGraphStepAdvanced = {
  onFailure: string;
  maxRetries: number | null;
  retryDelaySeconds: number | null;
  retryBackoff: string;
  retryJitter: boolean;
  timeoutSeconds: number | null;
  sleepSeconds: number | null;
  suspendUntil: string;
  suspendTimeoutSeconds: number | null;
  suspendTimeoutAction: WorkflowGraphApprovalTimeoutAction;
  earlyReturn: boolean;
  earlyReturnContentType: string;
  earlyReturnSchema: string;
  errorHandler: boolean;
  errorHandlerScope: string;
  errorHandlerInput: string;
  restartBoundary: boolean;
  restartStrategy: string;
  restartInput: string;
  earlyStopCondition: string;
  earlyStopLabelSkipped: boolean;
  approval: WorkflowGraphStepApproval;
  badges: string[];
};

export type WorkflowGraphApprovalTimeoutAction = "" | "resume" | "cancel";

export type WorkflowGraphStepApproval = {
  required: boolean;
  prompt: string;
  recipients: string[];
  timeoutSeconds: number | null;
  timeoutAction: WorkflowGraphApprovalTimeoutAction;
  badges: string[];
};

export type WorkflowGraphStepTesting = {
  mockEnabled: boolean;
  mockResult: string;
  pinnedResultRunId: string;
  badges: string[];
};

export type WorkflowGraphStepExecution = {
  concurrencyKey: string;
  concurrencyLimit: number | null;
  priority: string;
  cacheEnabled: boolean;
  cacheTtlSeconds: number | null;
  deleteAfterUse: boolean;
  badges: string[];
};

export type WorkflowGraphStepDataFlow = {
  inputExpression: string;
  outputSchema: string;
  workProductRequired: boolean;
  workProductPattern: string;
  badges: string[];
};
