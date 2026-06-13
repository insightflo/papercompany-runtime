import { parse as parseYaml } from "yaml";

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
  graphNote?: string;
  graphEdgeMetadata?: WorkflowGraphEdgeMetadataRecord;
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

export type WorkflowGraphStepResources = {
  resourceRefs: string[];
  secretRefs: string[];
  badges: string[];
};

export type WorkflowGraphDataFlowResultRef = {
  stepId: string;
  path: string;
  available: boolean;
};

export type WorkflowGraphDataFlowMap = {
  stepId: string;
  title: string;
  inputExpression: string;
  flowInputRefs: string[];
  resultRefs: WorkflowGraphDataFlowResultRef[];
  upstreamStepIds: string[];
  missingStepIds: string[];
  resourceRefs: string[];
  secretRefs: string[];
  outputContractBadges: string[];
  blocked: boolean;
  badges: string[];
  summary: string;
};

export type WorkflowGraphNode<TStep extends WorkflowGraphStep = WorkflowGraphStep> = {
  id: string;
  label: string;
  kind: string;
  layer: number;
  order: number;
  x: number;
  y: number;
  step: TStep;
  runStatus: WorkflowGraphStepRunStatus;
  advanced: WorkflowGraphStepAdvanced;
  testing: WorkflowGraphStepTesting;
  execution: WorkflowGraphStepExecution;
  dataFlow: WorkflowGraphStepDataFlow;
  resources: WorkflowGraphStepResources;
};

export type WorkflowGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: WorkflowGraphEdgeKind;
  label: string;
  condition: string;
};

export type WorkflowGraphChangedStep = {
  id: string;
  fields: string[];
};

export type WorkflowGraphDraftDiff = {
  hasChanges: boolean;
  addedSteps: string[];
  removedSteps: string[];
  changedSteps: WorkflowGraphChangedStep[];
  addedEdges: string[];
  removedEdges: string[];
  changedEdges: string[];
  summary: string[];
};

export type WorkflowGraphGroup = {
  id: string;
  title: string;
  color: string;
  collapsed: boolean;
  collapsedByDefault: boolean;
  stepIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkflowGraphContainerType = "branch" | "loop";

export type WorkflowGraphContainer = {
  id: string;
  type: WorkflowGraphContainerType;
  title: string;
  description: string;
  mode: string;
  condition: string;
  iterator: string;
  skipFailure: boolean;
  runInParallel: boolean;
  parallelism: number | null;
  badges: string[];
  stepIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkflowGraphContainerSummary = {
  id: string;
  type: WorkflowGraphContainerType;
  title: string;
  description: string;
  mode: string;
  stepIds: string[];
  entryStepIds: string[];
  terminalStepIds: string[];
  inboundStepIds: string[];
  outboundStepIds: string[];
  badges: string[];
  blocked: boolean;
  summary: string;
};

export type WorkflowGraphSelectionMode = "self" | "upstream" | "downstream" | "connected";

export type WorkflowGraphSelectionSummary = {
  stepIds: string[];
  entryStepIds: string[];
  terminalStepIds: string[];
  inboundStepIds: string[];
  outboundStepIds: string[];
  badges: string[];
  blocked: boolean;
  summary: string;
};

export type WorkflowGraphFailureRouteOptions = {
  label?: string;
  condition?: string;
  handlerScope?: string;
  handlerInput?: string;
};

export type WorkflowGraphFailureRouteSummary = {
  sourceStepIds: string[];
  handlerStepId: string;
  label: string;
  condition: string;
  badges: string[];
  blocked: boolean;
  summary: string;
};

export type WorkflowGraphIssueSeverity = "error" | "warning" | "info";

export type WorkflowGraphIssue = {
  id: string;
  severity: WorkflowGraphIssueSeverity;
  code: string;
  message: string;
  stepId?: string;
  sourceId?: string;
  targetId?: string;
};

export type WorkflowGraphDiagnostics = {
  entryStepIds: string[];
  terminalStepIds: string[];
  issueCountBySeverity: Record<WorkflowGraphIssueSeverity, number>;
  issues: WorkflowGraphIssue[];
};

export type WorkflowGraphRepairAction =
  | "connect-or-remove-dependency"
  | "assign-step-id"
  | "disconnect-cycle-edge"
  | "inspect-diagnostic";

export type WorkflowGraphRepairItem = {
  id: string;
  severity: WorkflowGraphIssueSeverity;
  issueCode: string;
  action: WorkflowGraphRepairAction;
  title: string;
  description: string;
  focusStepId: string;
  sourceStepId?: string;
  targetStepId?: string;
  badges: string[];
};

export type WorkflowGraphRepairPlan = {
  items: WorkflowGraphRepairItem[];
  badges: string[];
  blocked: boolean;
  summary: string;
};

export type WorkflowGraphInspectorMode = "overview" | "edit" | "policy" | "raw";

export type WorkflowGraphInspectorSection = {
  mode: WorkflowGraphInspectorMode;
  title: string;
  badges: string[];
  summary: string;
};

export type WorkflowGraphInspectorSummary = {
  defaultMode: WorkflowGraphInspectorMode;
  selectedStepId: string;
  sections: WorkflowGraphInspectorSection[];
};

export type WorkflowGraphFocusLensTone = "success" | "warning" | "danger" | "info" | "neutral";

export type WorkflowGraphFocusLensMetric = {
  id: "step" | "path" | "controls" | "runtime";
  label: string;
  value: string;
  tone: WorkflowGraphFocusLensTone;
  detail: string;
};

export type WorkflowGraphFocusLensAction = {
  id: "edit" | "test" | "evidence" | "policy" | "raw" | "add-after" | "diagnostics";
  label: string;
  disabled?: boolean;
};

export type WorkflowGraphFocusLensSummary = {
  selectedStepId: string;
  title: string;
  description: string;
  tone: WorkflowGraphFocusLensTone;
  badges: string[];
  metrics: WorkflowGraphFocusLensMetric[];
  actions: WorkflowGraphFocusLensAction[];
  detailsHiddenByDefault: boolean;
};

export type WorkflowGraphTestDrawerMode = {
  id: "test-flow" | "test-step" | "restart" | "iteration" | "inputs";
  title: string;
  tone: WorkflowGraphFocusLensTone;
  badges: string[];
  summary: string;
};

export type WorkflowGraphTestDrawerSummary = {
  selectedStepId: string;
  title: string;
  tone: WorkflowGraphFocusLensTone;
  summary: string;
  badges: string[];
  modes: WorkflowGraphTestDrawerMode[];
};

export type WorkflowGraphStructurePaletteActionId =
  | "agent"
  | "tool"
  | "branch"
  | "loop"
  | "approval"
  | "failure-handler"
  | "group"
  | "branch-wrap"
  | "loop-wrap"
  | "route-failure";

export type WorkflowGraphStructurePaletteAction = {
  id: WorkflowGraphStructurePaletteActionId;
  label: string;
  description: string;
  tone: WorkflowGraphFocusLensTone;
  disabled?: boolean;
};

export type WorkflowGraphStructurePaletteSummary = {
  selectedStepId: string;
  title: string;
  tone: WorkflowGraphFocusLensTone;
  summary: string;
  badges: string[];
  addActions: WorkflowGraphStructurePaletteAction[];
  transformActions: WorkflowGraphStructurePaletteAction[];
};

export type WorkflowGraphExecutionEvidenceMetric = {
  id: "status" | "issue" | "dispatch" | "outputs";
  label: string;
  value: string;
  tone: WorkflowGraphFocusLensTone;
  detail: string;
};

export type WorkflowGraphExecutionEvidenceSummary = {
  selectedStepId: string;
  title: string;
  tone: WorkflowGraphFocusLensTone;
  available: boolean;
  summary: string;
  badges: string[];
  metrics: WorkflowGraphExecutionEvidenceMetric[];
  resultPreview: string;
  logPreview: string;
  workProducts: WorkflowGraphWorkProduct[];
};

export type WorkflowGraphWorkbenchAction = {
  id: string;
  label: string;
  disabled?: boolean;
};

export type WorkflowGraphWorkbenchCommandGroup = {
  id: string;
  label: string;
  actions: WorkflowGraphWorkbenchAction[];
};

export type WorkflowGraphWorkbenchSummary = {
  selectedStepId: string;
  commandGroups: WorkflowGraphWorkbenchCommandGroup[];
  statusBadges: string[];
  pathSummary: string;
  detailsHiddenByDefault: boolean;
};

export type WorkflowGraphModel<TStep extends WorkflowGraphStep = WorkflowGraphStep> = {
  nodes: Array<WorkflowGraphNode<TStep>>;
  edges: WorkflowGraphEdge[];
  groups: WorkflowGraphGroup[];
  containers: WorkflowGraphContainer[];
  warnings: string[];
  diagnostics: WorkflowGraphDiagnostics;
};

export type WorkflowGraphTestPlan = {
  targetStepId: string;
  stepIds: string[];
  excludedStepIds: string[];
  missingDependencyIds: string[];
  blocked: boolean;
  badges: string[];
  summary: string;
};

export type WorkflowGraphTestExecutionMode = "will-run" | "mocked" | "pinned" | "skipped" | "blocked";

export type WorkflowGraphTestExecutionStep = {
  stepId: string;
  title: string;
  kind: string;
  mode: WorkflowGraphTestExecutionMode;
  reason: string;
  badges: string[];
};

export type WorkflowGraphTestExecutionPreview = {
  targetStepId: string;
  steps: WorkflowGraphTestExecutionStep[];
  badges: string[];
  summary: string;
};

export type WorkflowGraphIterationTestPreview = {
  containerId: string;
  title: string;
  iterationIndex: number;
  iterationValue: unknown;
  iteratorExpression: string;
  stepIds: string[];
  skippedStepIds: string[];
  parallelism: number | null;
  skipFailure: boolean;
  runInParallel: boolean;
  blocked: boolean;
  badges: string[];
  summary: string;
  requestJson: string;
};

export type WorkflowGraphSingleStepTestContextMode = "mocked" | "pinned" | "unavailable";

export type WorkflowGraphSingleStepTestContextResult = {
  stepId: string;
  title: string;
  kind: string;
  mode: WorkflowGraphSingleStepTestContextMode;
  badges: string[];
  value?: unknown;
  pinnedResultRunId?: string;
};

export type WorkflowGraphSingleStepTestPreview = {
  stepId: string;
  title: string;
  kind: string;
  flowArguments: Record<string, unknown>;
  stepArguments: Record<string, unknown>;
  inputExpression: string;
  upstreamContextStepIds: string[];
  downstreamStepIds: string[];
  missingDependencyIds: string[];
  contextResults: WorkflowGraphSingleStepTestContextResult[];
  blocked: boolean;
  badges: string[];
  summary: string;
  requestJson: string;
};

export type WorkflowGraphRestartMode = "reused" | "rerun" | "blocked";

export type WorkflowGraphRestartStep = {
  stepId: string;
  title: string;
  kind: string;
  mode: WorkflowGraphRestartMode;
  reason: string;
  badges: string[];
};

export type WorkflowGraphRestartPreview = {
  restartStepId: string;
  reusedStepIds: string[];
  rerunStepIds: string[];
  blockedStepIds: string[];
  blocked: boolean;
  steps: WorkflowGraphRestartStep[];
  badges: string[];
  summary: string;
};

export type WorkflowGraphTestRequestPreview = {
  arguments: Record<string, unknown>;
  envPreview: Record<string, unknown>;
  requiredInputNames: string[];
  badges: string[];
  requestJson: string;
};

export type WorkflowGraphRequestFillPreview = {
  arguments: Record<string, unknown>;
  matchedInputNames: string[];
  extraArgumentNames: string[];
  missingRequiredInputNames: string[];
  badges: string[];
  requestJson: string;
  error?: string;
};

export type WorkflowGraphTestInputPreset = {
  name: string;
  args: Record<string, unknown>;
  requestJson: string;
};

export type WorkflowGraphTestInputLibrarySummary = {
  presets: WorkflowGraphTestInputPreset[];
  badges: string[];
};

export type WorkflowGraphManagementRunInput = {
  workflowId?: string;
  status?: string;
  triggerSource?: string;
  startedAt?: string;
  completedAt?: string;
  runLabel?: string;
};

export type WorkflowGraphManagementTileTone = "neutral" | "success" | "warning" | "danger" | "info";

export type WorkflowGraphManagementTile = {
  id: "draft" | "test" | "runs" | "history";
  title: string;
  status: string;
  tone: WorkflowGraphManagementTileTone;
  summary: string;
  badges: string[];
  actionLabel: string;
};

export type WorkflowGraphManagementSummary = {
  tiles: WorkflowGraphManagementTile[];
  badges: string[];
  hasBlockingIssue: boolean;
};

export type WorkflowGraphManagementSummaryInput<TStep extends WorkflowGraphStep = WorkflowGraphStep> = {
  workflowId?: string;
  savedSteps?: TStep[];
  draftSteps: TStep[];
  selectedStepId?: string;
  activeRuns?: WorkflowGraphManagementRunInput[];
  recentRuns?: WorkflowGraphManagementRunInput[];
  interfaceInput?: WorkflowGraphInterfaceInput;
};

export type WorkflowGraphReleaseReviewTone = "success" | "warning" | "danger" | "info" | "neutral";

export type WorkflowGraphReleaseReviewStage = {
  id: "local-edit" | "test-gate" | "saved-definition" | "run-history";
  title: string;
  status: string;
  tone: WorkflowGraphReleaseReviewTone;
  summary: string;
  badges: string[];
};

export type WorkflowGraphReleaseReviewSummary = {
  decision: "synced" | "ready-to-save" | "blocked" | "risky-history";
  title: string;
  summary: string;
  tone: WorkflowGraphReleaseReviewTone;
  primaryAction: string;
  badges: string[];
  stages: WorkflowGraphReleaseReviewStage[];
  hasBlockingIssue: boolean;
};

export type WorkflowGraphReleaseReviewInput<TStep extends WorkflowGraphStep = WorkflowGraphStep> = {
  workflowId?: string;
  savedSteps?: TStep[];
  draftSteps: TStep[];
  selectedStepId?: string;
  activeRuns?: WorkflowGraphManagementRunInput[];
  recentRuns?: WorkflowGraphManagementRunInput[];
};

export type WorkflowGraphNavigatorFilter = "all" | "active" | "scheduled" | "problems" | "archived";

export type WorkflowGraphDefinitionNavigatorWorkflowInput<TStep extends WorkflowGraphStep = WorkflowGraphStep> = {
  id?: string;
  name?: string;
  description?: string;
  status?: string;
  schedule?: string;
  timezone?: string;
  triggerLabels?: unknown;
  lastScheduledRunAt?: string;
  lastScheduleError?: string;
  lastScheduleErrorAt?: string;
  createParentIssuePolicy?: string;
  steps?: TStep[];
};

export type WorkflowGraphDefinitionNavigatorItem = {
  id: string;
  name: string;
  description: string;
  status: string;
  stepCount: number;
  miniSteps: Array<{ id: string; title: string; type: string }>;
  trigger: WorkflowGraphTriggerSummary;
  activeRunCount: number;
  recentRunCount: number;
  failedRunCount: number;
  hasProblem: boolean;
  isScheduled: boolean;
  isArchived: boolean;
  badges: string[];
  matchText: string;
};

export type WorkflowGraphDefinitionNavigatorSummary = {
  items: WorkflowGraphDefinitionNavigatorItem[];
  visibleItems: WorkflowGraphDefinitionNavigatorItem[];
  stats: {
    total: number;
    visible: number;
    active: number;
    scheduled: number;
    activeRuns: number;
    needsReview: number;
    paused: number;
    archived: number;
  };
  filters: Array<{ id: WorkflowGraphNavigatorFilter; label: string; count: number }>;
  badges: string[];
};

export type WorkflowGraphDefinitionNavigatorInput<TStep extends WorkflowGraphStep = WorkflowGraphStep> = {
  workflows: Array<WorkflowGraphDefinitionNavigatorWorkflowInput<TStep>>;
  activeRuns?: WorkflowGraphManagementRunInput[];
  recentRuns?: WorkflowGraphManagementRunInput[];
  search?: string;
  filter?: WorkflowGraphNavigatorFilter;
};

export type WorkflowGraphTriggerInput = {
  schedule?: unknown;
  timezone?: unknown;
  triggerLabels?: unknown;
  lastScheduledRunAt?: unknown;
  lastScheduleError?: unknown;
  lastScheduleErrorAt?: unknown;
};

export type WorkflowGraphTriggerSummary = {
  enabled: boolean;
  status: "manual" | "active" | "error";
  schedule: {
    cron: string;
    timezone: string;
    lastRunAt: string;
    error: string;
    errorAt: string;
  };
  labels: string[];
  badges: string[];
  description: string;
};

export type WorkflowGraphFlowInput = {
  name: string;
  type: string;
  required: boolean;
  defaultValue: string;
  description: string;
};

export type WorkflowGraphFlowEnvVariable = {
  name: string;
  type: string;
  value: string;
  secret: boolean;
};

export type WorkflowGraphInterfaceInput = {
  graphFlowInputs?: unknown;
  graphFlowEnvVariables?: unknown;
  graphFlowEnv?: unknown;
  flowInputs?: unknown;
  flowEnvVariables?: unknown;
  graphTestInputPresets?: unknown;
  testInputPresets?: unknown;
  legacyMetadata?: unknown;
};

export type WorkflowGraphInterfaceSummary = {
  inputs: WorkflowGraphFlowInput[];
  envVariables: WorkflowGraphFlowEnvVariable[];
  badges: string[];
};

export type WorkflowGraphExportInput = WorkflowGraphInterfaceInput & {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  status?: unknown;
  schedule?: unknown;
  timezone?: unknown;
  triggerLabels?: unknown;
  steps?: WorkflowGraphStep[];
};

export type WorkflowGraphExportSnapshot = {
  formatVersion: 1;
  metadata: {
    id: string;
    name: string;
    description: string;
    status: string;
  };
  settings: {
    schedule: string;
    timezone: string;
    triggerLabels: string[];
  };
  flowInterface: {
    inputs: WorkflowGraphFlowInput[];
    envVariables: WorkflowGraphFlowEnvVariable[];
  };
  steps: WorkflowGraphStep[];
};

export type WorkflowGraphExportFormat = "json" | "yaml";

export type WorkflowGraphYamlDraftParseResult = {
  snapshot: WorkflowGraphExportSnapshot;
  error: string;
};

export type WorkflowGraphStepContext = {
  stepId: string;
  directDependencyIds: string[];
  directDependentIds: string[];
  upstreamStepIds: string[];
  downstreamStepIds: string[];
  missingDependencyIds: string[];
};

export type WorkflowGraphEdgeImpactAction = "connect" | "disconnect";

export type WorkflowGraphEdgeImpactPreview = {
  action: WorkflowGraphEdgeImpactAction;
  sourceStepId: string;
  targetStepId: string;
  impactedStepIds: string[];
  downstreamStepIds: string[];
  badges: string[];
  blocked: boolean;
  summary: string;
};

export type WorkflowGraphSearchResult = {
  nodeId: string;
  stepId: string;
  label: string;
  kind: string;
  matchFields: string[];
  matchText: string;
};

export type WorkflowGraphPaletteNodeKind = "agent" | "tool" | "branch" | "loop" | "failure-handler" | "approval";

export function parseDependencies(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function formatDependencies(dependencies: string[]): string {
  return dependencies.join(", ");
}

function buildStepMap<TStep extends WorkflowGraphStep>(steps: TStep[]): Map<string, TStep> {
  return new Map(steps.filter((step) => step.id.trim()).map((step) => [step.id.trim(), step]));
}

function nextUniqueStepId<TStep extends WorkflowGraphStep>(steps: TStep[], baseId: string): string {
  const existingIds = new Set(steps.map((step) => step.id.trim()).filter(Boolean));
  const normalizedBaseId = baseId.trim() || "step";
  let candidate = normalizedBaseId;
  let index = 2;
  while (existingIds.has(candidate)) {
    candidate = `${normalizedBaseId}-${index}`;
    index += 1;
  }
  return candidate;
}

function clearGraphRunOverlay<TStep extends WorkflowGraphStep>(step: TStep): Record<string, unknown> {
  const next = { ...step } as Record<string, unknown>;
  for (const key of [
    "graphRunStatus",
    "graphRunStepRunId",
    "graphRunIssueId",
    "graphRunIssueIdentifier",
    "graphRunUpdatedAt",
    "graphRunSummary",
    "graphRunStartedAt",
    "graphRunCompletedAt",
    "graphRunLastDispatchAttemptAt",
    "graphRunLastDispatchAcceptedAt",
    "graphRunLastDispatchErrorAt",
    "graphRunLastDispatchErrorSummary",
    "graphRunLastDispatchRequestId",
    "graphRunResultPreview",
    "graphRunLogPreview",
    "graphRunWorkProducts",
  ]) {
    delete next[key];
  }
  return next;
}

export function normalizeGraphRunStatus(value: unknown): WorkflowGraphRunStatus {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (status === "running" || status === "succeeded" || status === "failed" || status === "skipped" || status === "paused") {
    return status;
  }
  if (status === "in_progress" || status === "active") {
    return "running";
  }
  if (status === "success" || status === "completed" || status === "done") {
    return "succeeded";
  }
  if (status === "escalated" || status === "blocked" || status === "error" || status === "aborted" || status === "timed-out") {
    return "failed";
  }
  if (status === "cancelled" || status === "canceled") {
    return "skipped";
  }
  return "planned";
}

function readStepRunStatus(step: WorkflowGraphStep): WorkflowGraphStepRunStatus {
  const concurrencyBlocked = readConcurrencyBlocked(step.graphRunConcurrencyBlocked);
  const retentionDeleted = readRetentionDeleted(step.graphRunRetentionDeleted);
  return {
    status: normalizeGraphRunStatus(step.graphRunStatus),
    stepRunId: typeof step.graphRunStepRunId === "string" ? step.graphRunStepRunId.trim() : "",
    issueId: typeof step.graphRunIssueId === "string" ? step.graphRunIssueId.trim() : "",
    issueIdentifier: typeof step.graphRunIssueIdentifier === "string" ? step.graphRunIssueIdentifier.trim() : "",
    updatedAt: typeof step.graphRunUpdatedAt === "string" ? step.graphRunUpdatedAt.trim() : "",
    summary: typeof step.graphRunSummary === "string" ? step.graphRunSummary.trim() : "",
    startedAt: typeof step.graphRunStartedAt === "string" ? step.graphRunStartedAt.trim() : "",
    completedAt: typeof step.graphRunCompletedAt === "string" ? step.graphRunCompletedAt.trim() : "",
    lastDispatchAttemptAt: typeof step.graphRunLastDispatchAttemptAt === "string" ? step.graphRunLastDispatchAttemptAt.trim() : "",
    lastDispatchAcceptedAt: typeof step.graphRunLastDispatchAcceptedAt === "string" ? step.graphRunLastDispatchAcceptedAt.trim() : "",
    lastDispatchErrorAt: typeof step.graphRunLastDispatchErrorAt === "string" ? step.graphRunLastDispatchErrorAt.trim() : "",
    lastDispatchErrorSummary: typeof step.graphRunLastDispatchErrorSummary === "string" ? step.graphRunLastDispatchErrorSummary.trim() : "",
    lastDispatchRequestId: typeof step.graphRunLastDispatchRequestId === "string" ? step.graphRunLastDispatchRequestId.trim() : "",
    resultPreview: typeof step.graphRunResultPreview === "string" ? step.graphRunResultPreview.trim() : "",
    logPreview: typeof step.graphRunLogPreview === "string" ? step.graphRunLogPreview.trim() : "",
    workProducts: Array.isArray(step.graphRunWorkProducts) ? normalizeWorkProducts(step.graphRunWorkProducts) : [],
    concurrencyBlocked,
    retentionDeleted,
    runtimeBadges: buildRuntimeBadges({
      concurrencyBlocked,
      retentionDeleted,
      resultPreview: typeof step.graphRunResultPreview === "string" ? step.graphRunResultPreview.trim() : "",
      logPreview: typeof step.graphRunLogPreview === "string" ? step.graphRunLogPreview.trim() : "",
    }),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function readOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function readConcurrencyBlocked(value: unknown): WorkflowGraphConcurrencyBlocked | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const concurrencyKey = readString(record.concurrencyKey);
  if (!concurrencyKey) return undefined;
  return {
    concurrencyKey,
    concurrencyLimit: readOptionalNumber(record.concurrencyLimit),
    runningCount: readOptionalNumber(record.runningCount),
    checkedAt: readString(record.checkedAt),
  };
}

function readRetentionDeleted(value: unknown): WorkflowGraphRetentionDeleted | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const deleteAfterUse = readOptionalBoolean(record.deleteAfterUse) ?? false;
  const toolName = readString(record.toolName);
  const deletedAt = readString(record.deletedAt);
  if (!deleteAfterUse && !toolName && !deletedAt) return undefined;
  return {
    deleteAfterUse,
    toolName,
    success: readOptionalBoolean(record.success),
    exitCode: readOptionalNumber(record.exitCode),
    deletedAt,
  };
}

function buildRuntimeBadges(input: {
  concurrencyBlocked?: WorkflowGraphConcurrencyBlocked;
  retentionDeleted?: WorkflowGraphRetentionDeleted;
  resultPreview?: string;
  logPreview?: string;
}): string[] {
  const badges: string[] = [];
  if (input.resultPreview) badges.push("Result preview");
  if (input.logPreview) badges.push("Log preview");
  if (input.concurrencyBlocked) badges.push(`Concurrency blocked: ${input.concurrencyBlocked.concurrencyKey}`);
  if (input.retentionDeleted?.deleteAfterUse) badges.push("Deleted after use");
  return badges;
}

function normalizeWorkProducts(value: unknown): WorkflowGraphWorkProduct[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!id || !title) return [];
    const product: WorkflowGraphWorkProduct = {
      id,
      title,
      type: typeof record.type === "string" ? record.type.trim() : undefined,
      url: typeof record.url === "string" ? record.url.trim() : null,
      status: typeof record.status === "string" ? record.status.trim() : undefined,
      summary: typeof record.summary === "string" ? record.summary.trim() : null,
    };
    if (typeof record.isPrimary === "boolean") {
      product.isPrimary = record.isPrimary;
    }
    return [product];
  });
}

export function normalizeGraphEdgeKind(value: unknown): WorkflowGraphEdgeKind {
  const kind = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (kind === "conditional" || kind === "failure" || kind === "early-stop") return kind;
  return "normal";
}

function readGraphEdgeMetadata(step: WorkflowGraphStep, sourceId: string): WorkflowGraphEdgeMetadata {
  const record = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
    ? step.graphEdgeMetadata[sourceId]
    : undefined;
  return {
    kind: normalizeGraphEdgeKind(record?.kind),
    label: typeof record?.label === "string" ? record.label.trim() : "",
    condition: typeof record?.condition === "string" ? record.condition.trim() : "",
  };
}

function readGraphPositionValue(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : undefined;
}

function compactGraphEdgeMetadata(metadata: WorkflowGraphEdgeMetadataRecord): WorkflowGraphEdgeMetadataRecord | undefined {
  const entries = Object.entries(metadata)
    .map(([sourceId, value]) => {
      const source = sourceId.trim();
      if (!source) return null;
      const kind = normalizeGraphEdgeKind(value?.kind);
      const label = typeof value?.label === "string" ? value.label.trim() : "";
      const condition = typeof value?.condition === "string" ? value.condition.trim() : "";
      if (kind === "normal" && !label && !condition) return null;
      return [source, { kind, label, condition }] as const;
    })
    .filter((entry): entry is readonly [string, WorkflowGraphEdgeMetadata] => Boolean(entry));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

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

function parseTriggerLabels(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.flatMap((entry) => parseTriggerLabels(entry))));
  }
  if (typeof value !== "string") return [];
  return Array.from(new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean)));
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readArrayLike(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const text = value.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
  const retryDelaySeconds = readPositiveInteger(step.graphRetryDelaySeconds);
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

export function summarizeWorkflowGraphTriggers(input: WorkflowGraphTriggerInput): WorkflowGraphTriggerSummary {
  const cron = readTrimmedString(input.schedule);
  const timezone = readTrimmedString(input.timezone);
  const labels = parseTriggerLabels(input.triggerLabels);
  const lastRunAt = readTrimmedString(input.lastScheduledRunAt);
  const error = readTrimmedString(input.lastScheduleError);
  const errorAt = readTrimmedString(input.lastScheduleErrorAt);
  const hasSchedule = Boolean(cron);
  const hasLabels = labels.length > 0;
  const enabled = hasSchedule || hasLabels;
  const badges: string[] = [];
  if (hasSchedule) badges.push("Cron");
  if (timezone) badges.push(timezone);
  if (hasLabels) badges.push(`${labels.length} label${labels.length === 1 ? "" : "s"}`);
  if (error) badges.push("Schedule error");
  if (badges.length === 0) badges.push("Manual");
  const descriptionParts: string[] = [];
  if (hasSchedule) descriptionParts.push(`Cron ${cron}`);
  if (hasLabels) descriptionParts.push(`Labels ${labels.join(", ")}`);
  return {
    enabled,
    status: error ? "error" : enabled ? "active" : "manual",
    schedule: {
      cron,
      timezone,
      lastRunAt,
      error,
      errorAt,
    },
    labels,
    badges,
    description: descriptionParts.join(" · ") || "Manual run only",
  };
}

function normalizeFlowInputs(value: unknown): WorkflowGraphFlowInput[] {
  const seen = new Set<string>();
  const inputs: WorkflowGraphFlowInput[] = [];
  for (const entry of readArrayLike(value)) {
    const record = readPlainObject(entry);
    const name = readTrimmedString(record.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    inputs.push({
      name,
      type: readTrimmedString(record.type) || "string",
      required: readBooleanSetting(record.required) === true,
      defaultValue: readTrimmedString(record.defaultValue ?? record.default),
      description: readTrimmedString(record.description),
    });
  }
  return inputs;
}

function normalizeFlowEnvVariables(value: unknown): WorkflowGraphFlowEnvVariable[] {
  const seen = new Set<string>();
  const envVariables: WorkflowGraphFlowEnvVariable[] = [];
  for (const entry of readArrayLike(value)) {
    const record = readPlainObject(entry);
    const name = readTrimmedString(record.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const type = readTrimmedString(record.type) || "string";
    envVariables.push({
      name,
      type,
      value: readTrimmedString(record.value),
      secret: readBooleanSetting(record.secret) === true || type.toLowerCase() === "secret",
    });
  }
  return envVariables;
}

export function summarizeWorkflowGraphInterface(input: WorkflowGraphInterfaceInput): WorkflowGraphInterfaceSummary {
  const legacyMetadata = readPlainObject(input.legacyMetadata);
  const inputs = normalizeFlowInputs(
    input.graphFlowInputs
      ?? input.flowInputs
      ?? legacyMetadata.graphFlowInputs
      ?? legacyMetadata.flowInputs,
  );
  const envVariables = normalizeFlowEnvVariables(
    input.graphFlowEnvVariables
      ?? input.graphFlowEnv
      ?? input.flowEnvVariables
      ?? legacyMetadata.graphFlowEnvVariables
      ?? legacyMetadata.graphFlowEnv
      ?? legacyMetadata.flowEnvVariables,
  );
  const requiredInputCount = inputs.filter((flowInput) => flowInput.required).length;
  const secretEnvCount = envVariables.filter((envVariable) => envVariable.secret).length;
  const badges: string[] = [];
  if (inputs.length > 0) badges.push(`${inputs.length} input${inputs.length === 1 ? "" : "s"}`);
  if (requiredInputCount > 0) badges.push(`${requiredInputCount} required input${requiredInputCount === 1 ? "" : "s"}`);
  if (envVariables.length > 0) badges.push(`${envVariables.length} env var${envVariables.length === 1 ? "" : "s"}`);
  if (secretEnvCount > 0) badges.push(`${secretEnvCount} secret env`);
  if (badges.length === 0) badges.push("No flow interface");
  return { inputs, envVariables, badges };
}

function parseFlowInputDefaultValue(flowInput: WorkflowGraphFlowInput): unknown {
  const rawValue = flowInput.defaultValue;
  const normalizedType = flowInput.type.trim().toLowerCase();
  if (!rawValue) {
    if (normalizedType === "number" || normalizedType === "integer") return 0;
    if (normalizedType === "boolean") return false;
    if (normalizedType === "json" || normalizedType === "object" || normalizedType === "array") return {};
    return "";
  }
  if (normalizedType === "number" || normalizedType === "integer") {
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : rawValue;
  }
  if (normalizedType === "boolean") {
    const lowered = rawValue.trim().toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
    return Boolean(rawValue);
  }
  if (normalizedType === "json" || normalizedType === "object" || normalizedType === "array") {
    try {
      return JSON.parse(rawValue) as unknown;
    } catch {
      return rawValue;
    }
  }
  return rawValue;
}

function readPresetArgs(value: unknown): Record<string, unknown> {
  const record = readPlainObject(value);
  const request = readPlainObject(record.request);
  const args = readPlainObject(record.args ?? request.args);
  return { ...args };
}

function extractRequestFillArguments(value: unknown): Record<string, unknown> {
  const record = readPlainObject(value);
  const explicitArgs = readPlainObject(record.args);
  if (Object.keys(explicitArgs).length > 0) return { ...explicitArgs };
  const body = readPlainObject(record.body);
  const query = readPlainObject(record.query);
  if (Object.keys(body).length > 0 || Object.keys(query).length > 0) {
    return { ...body, ...query };
  }
  const request = readPlainObject(record.request);
  const requestArgs = readPlainObject(request.args);
  if (Object.keys(requestArgs).length > 0) return { ...requestArgs };
  return { ...record };
}

export function buildWorkflowGraphRequestFillPreview(
  input: WorkflowGraphInterfaceInput,
  requestText: string,
): WorkflowGraphRequestFillPreview {
  const flowInterface = summarizeWorkflowGraphInterface(input);
  const defaults = Object.fromEntries(
    flowInterface.inputs.map((flowInput) => [flowInput.name, parseFlowInputDefaultValue(flowInput)]),
  );
  const normalizedText = requestText.trim();
  let parsedArguments: Record<string, unknown> = {};
  let error: string | undefined;

  if (normalizedText) {
    try {
      parsedArguments = extractRequestFillArguments(JSON.parse(normalizedText) as unknown);
    } catch (parseError) {
      error = `JSON 파싱 실패: ${parseError instanceof Error ? parseError.message : String(parseError)}`;
    }
  }

  const inputNames = new Set(flowInterface.inputs.map((flowInput) => flowInput.name));
  const matchedInputNames = flowInterface.inputs
    .map((flowInput) => flowInput.name)
    .filter((name) => Object.prototype.hasOwnProperty.call(parsedArguments, name));
  const extraArgumentNames = Object.keys(parsedArguments).filter((name) => !inputNames.has(name)).sort();
  const filledArguments = { ...defaults };
  for (const name of matchedInputNames) {
    filledArguments[name] = parsedArguments[name];
  }
  const missingRequiredInputNames = flowInterface.inputs
    .filter((flowInput) => flowInput.required && !Object.prototype.hasOwnProperty.call(parsedArguments, flowInput.name))
    .map((flowInput) => flowInput.name);
  const badges: string[] = [];
  if (error) badges.push("Invalid request JSON");
  if (!error && matchedInputNames.length > 0) badges.push(`${matchedInputNames.length} matched`);
  if (!error && matchedInputNames.length === 0) badges.push(normalizedText ? "No matching args" : "Paste request JSON");
  if (extraArgumentNames.length > 0) badges.push(`${extraArgumentNames.length} extra ignored`);
  if (missingRequiredInputNames.length > 0) badges.push(`${missingRequiredInputNames.length} missing required`);
  return {
    arguments: filledArguments,
    matchedInputNames,
    extraArgumentNames,
    missingRequiredInputNames,
    badges,
    requestJson: `${JSON.stringify({ args: filledArguments }, null, 2)}\n`,
    error,
  };
}

export function summarizeWorkflowGraphTestInputLibrary(
  input: WorkflowGraphInterfaceInput,
): WorkflowGraphTestInputLibrarySummary {
  const legacyMetadata = readPlainObject(input.legacyMetadata);
  const rawPresets = readArrayLike(
    input.graphTestInputPresets
      ?? input.testInputPresets
      ?? legacyMetadata.graphTestInputPresets
      ?? legacyMetadata.testInputPresets,
  );
  const seen = new Set<string>();
  const presets: WorkflowGraphTestInputPreset[] = [];
  for (const entry of rawPresets) {
    const record = readPlainObject(entry);
    const name = readTrimmedString(record.name ?? record.title ?? record.id);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const args = readPresetArgs(record);
    presets.push({
      name,
      args,
      requestJson: `${JSON.stringify({ args }, null, 2)}\n`,
    });
  }
  return {
    presets,
    badges: presets.length > 0
      ? [`${presets.length} saved input${presets.length === 1 ? "" : "s"}`]
      : ["No saved inputs"],
  };
}

export function buildWorkflowGraphTestRequestPreview(
  input: WorkflowGraphInterfaceInput,
  selectedPresetName = "",
  fillArguments?: Record<string, unknown>,
): WorkflowGraphTestRequestPreview {
  const flowInterface = summarizeWorkflowGraphInterface(input);
  const baseArgs = Object.fromEntries(
    flowInterface.inputs.map((flowInput) => [flowInput.name, parseFlowInputDefaultValue(flowInput)]),
  );
  const inputLibrary = summarizeWorkflowGraphTestInputLibrary(input);
  const selectedPreset = inputLibrary.presets.find((preset) => preset.name === selectedPresetName.trim());
  const args = { ...baseArgs, ...(selectedPreset ? selectedPreset.args : {}), ...(fillArguments ?? {}) };
  const envPreview = Object.fromEntries(
    flowInterface.envVariables.map((envVariable) => [
      envVariable.name,
      envVariable.secret ? "<secret>" : envVariable.value,
    ]),
  );
  const requiredInputNames = flowInterface.inputs.filter((flowInput) => flowInput.required).map((flowInput) => flowInput.name);
  const secretEnvCount = flowInterface.envVariables.filter((envVariable) => envVariable.secret).length;
  const badges: string[] = [];
  if (flowInterface.inputs.length > 0) badges.push(`${flowInterface.inputs.length} arg${flowInterface.inputs.length === 1 ? "" : "s"}`);
  if (requiredInputNames.length > 0) badges.push(`${requiredInputNames.length} required`);
  if (flowInterface.envVariables.length > 0) badges.push(`${flowInterface.envVariables.length} env var${flowInterface.envVariables.length === 1 ? "" : "s"}`);
  if (secretEnvCount > 0) badges.push(`${secretEnvCount} secret`);
  if (selectedPreset) badges.push(`Preset ${selectedPreset.name}`);
  if (badges.length === 0) badges.push("No test inputs");
  return {
    arguments: args,
    envPreview,
    requiredInputNames,
    badges,
    requestJson: `${JSON.stringify({ args, env: envPreview }, null, 2)}\n`,
  };
}

export function buildWorkflowGraphIterationTestPreview<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  containerId: string,
  iterationIndex = 0,
  iterationValue: unknown = {},
): WorkflowGraphIterationTestPreview {
  const graph = buildWorkflowGraphModel(steps);
  const normalizedContainerId = containerId.trim();
  const container = graph.containers.find((candidate) => candidate.id === normalizedContainerId && candidate.type === "loop");
  const normalizedIterationIndex = Number.isInteger(iterationIndex) && iterationIndex >= 0 ? iterationIndex : 0;
  const allStepIds = graph.nodes.map((node) => node.id).filter(Boolean);

  if (!container) {
    return {
      containerId: normalizedContainerId,
      title: normalizedContainerId,
      iterationIndex: normalizedIterationIndex,
      iterationValue,
      iteratorExpression: "",
      stepIds: [],
      skippedStepIds: allStepIds,
      parallelism: null,
      skipFailure: false,
      runInParallel: false,
      blocked: true,
      badges: ["No loop container", "Blocked"],
      summary: "Choose a loop container before testing an iteration.",
      requestJson: `${JSON.stringify({
        loop: normalizedContainerId,
        iteration: normalizedIterationIndex,
        item: iterationValue,
        steps: [],
      }, null, 2)}\n`,
    };
  }

  const loopStepIds = container.stepIds.filter((stepId) => allStepIds.includes(stepId));
  const skippedStepIds = allStepIds.filter((stepId) => !loopStepIds.includes(stepId));
  const badges = [
    `Iteration ${normalizedIterationIndex}`,
    `${loopStepIds.length} loop step${loopStepIds.length === 1 ? "" : "s"}`,
  ];
  if (container.iterator) badges.push(`Iterator ${container.iterator}`);
  if (container.runInParallel && container.parallelism !== null) badges.push(`Parallel x${container.parallelism}`);
  else if (container.runInParallel) badges.push("Parallel");
  if (container.skipFailure) badges.push("Skip failure");
  const blocked = loopStepIds.length === 0;
  if (blocked) badges.push("Blocked");
  return {
    containerId: container.id,
    title: container.title,
    iterationIndex: normalizedIterationIndex,
    iterationValue,
    iteratorExpression: container.iterator,
    stepIds: loopStepIds,
    skippedStepIds,
    parallelism: container.parallelism,
    skipFailure: container.skipFailure,
    runInParallel: container.runInParallel,
    blocked,
    badges,
    summary: `Test iteration ${normalizedIterationIndex} of ${container.title} will run ${loopStepIds.length} loop step${loopStepIds.length === 1 ? "" : "s"}.`,
    requestJson: `${JSON.stringify({
      loop: container.id,
      iteration: normalizedIterationIndex,
      iterator: container.iterator,
      item: iterationValue,
      steps: loopStepIds,
      skipped_steps: skippedStepIds,
      parallelism: container.parallelism,
      skip_failure: container.skipFailure,
    }, null, 2)}\n`,
  };
}

function collectExpressionRefs(expression: string, prefixes: string[]): string[] {
  const values: string[] = [];
  for (const prefix of prefixes) {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = new RegExp(`\\b${escapedPrefix}\\.([A-Za-z0-9_-]+)`, "g");
    for (const match of expression.matchAll(matcher)) {
      const value = (match[1] ?? "").trim();
      if (value) values.push(value);
    }
  }
  return Array.from(new Set(values));
}

function collectResultRefs(expression: string, availableStepIds: Set<string>): WorkflowGraphDataFlowResultRef[] {
  const refs: WorkflowGraphDataFlowResultRef[] = [];
  const seen = new Set<string>();
  for (const match of expression.matchAll(/\b([A-Za-z0-9_-]+)\.result(?:\.([A-Za-z0-9_.-]+))?/g)) {
    const stepId = (match[1] ?? "").trim();
    if (!stepId) continue;
    const path = (match[2] ?? "").trim();
    const key = `${stepId}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      stepId,
      path,
      available: availableStepIds.has(stepId),
    });
  }
  return refs;
}

function countBadge(count: number, label: string): string | null {
  if (count <= 0) return null;
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

export function buildWorkflowGraphDataFlowMap<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
): WorkflowGraphDataFlowMap {
  const normalizedStepId = stepId.trim();
  const graph = buildWorkflowGraphModel(steps);
  const node = graph.nodes.find((candidate) => candidate.id === normalizedStepId);
  if (!node) {
    return {
      stepId: normalizedStepId,
      title: normalizedStepId,
      inputExpression: "",
      flowInputRefs: [],
      resultRefs: [],
      upstreamStepIds: [],
      missingStepIds: [],
      resourceRefs: [],
      secretRefs: [],
      outputContractBadges: [],
      blocked: true,
      badges: ["Missing step", "Blocked"],
      summary: "Choose an existing step to inspect its input transform.",
    };
  }

  const availableStepIds = new Set(graph.nodes.map((candidate) => candidate.id).filter((id) => id && id !== node.id));
  const inputExpression = node.dataFlow.inputExpression;
  const resultRefs = collectResultRefs(inputExpression, availableStepIds);
  const upstreamStepIds = Array.from(new Set(resultRefs.filter((ref) => ref.available).map((ref) => ref.stepId)));
  const missingStepIds = Array.from(new Set(resultRefs.filter((ref) => !ref.available).map((ref) => ref.stepId)));
  const flowInputRefs = collectExpressionRefs(inputExpression, ["flow_input", "flowInput", "inputs", "args"]);
  const resourceRefs = Array.from(new Set([
    ...node.resources.resourceRefs,
    ...collectExpressionRefs(inputExpression, ["resources", "resource"]),
  ]));
  const secretRefs = Array.from(new Set([
    ...node.resources.secretRefs,
    ...collectExpressionRefs(inputExpression, ["secrets", "secret", "vars"]),
  ]));
  const outputContractBadges = node.dataFlow.badges.filter((badge) => badge !== "Input map");
  const badges = [
    countBadge(flowInputRefs.length, "flow input"),
    countBadge(upstreamStepIds.length, "upstream result"),
    countBadge(resourceRefs.length, "resource"),
    countBadge(secretRefs.length, "secret"),
    countBadge(missingStepIds.length, "missing step"),
  ].filter((badge): badge is string => Boolean(badge));
  const blocked = missingStepIds.length > 0;
  if (blocked) badges.push("Blocked");
  if (badges.length === 0) badges.push("No input transform");
  const sourceParts = [
    countBadge(flowInputRefs.length, "flow input"),
    countBadge(upstreamStepIds.length, "upstream result"),
    countBadge(resourceRefs.length, "resource"),
    countBadge(secretRefs.length, "secret"),
  ].filter((part): part is string => Boolean(part));
  const summary = sourceParts.length > 0
    ? `${node.id} maps ${sourceParts.slice(0, -1).join(", ")}${sourceParts.length > 1 ? ", and " : ""}${sourceParts.at(-1)} into its step input${blocked ? `, but ${missingStepIds.length} referenced step${missingStepIds.length === 1 ? "" : "s"} are missing` : ""}.`
    : `${node.id} does not declare an input transform.`;

  return {
    stepId: node.id,
    title: node.label,
    inputExpression,
    flowInputRefs,
    resultRefs,
    upstreamStepIds,
    missingStepIds,
    resourceRefs,
    secretRefs,
    outputContractBadges,
    blocked,
    badges,
    summary,
  };
}

export function buildWorkflowGraphContainerSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  containerId: string,
): WorkflowGraphContainerSummary {
  const normalizedContainerId = containerId.trim();
  const graph = buildWorkflowGraphModel(steps);
  const container = graph.containers.find((candidate) => candidate.id === normalizedContainerId);
  if (!container) {
    return {
      id: normalizedContainerId,
      type: "branch",
      title: normalizedContainerId,
      description: "",
      mode: "",
      stepIds: [],
      entryStepIds: [],
      terminalStepIds: [],
      inboundStepIds: [],
      outboundStepIds: [],
      badges: ["Missing container", "Blocked"],
      blocked: true,
      summary: "Choose an existing branch or loop container to inspect its graph boundary.",
    };
  }

  const stepIdSet = new Set(container.stepIds);
  const incomingByStepId = new Map<string, string[]>();
  const outgoingByStepId = new Map<string, string[]>();
  const inboundStepIds: string[] = [];
  const outboundStepIds: string[] = [];
  for (const edge of graph.edges) {
    const sourceInside = stepIdSet.has(edge.source);
    const targetInside = stepIdSet.has(edge.target);
    if (sourceInside && targetInside) {
      const outgoing = outgoingByStepId.get(edge.source) ?? [];
      outgoing.push(edge.target);
      outgoingByStepId.set(edge.source, outgoing);
      const incoming = incomingByStepId.get(edge.target) ?? [];
      incoming.push(edge.source);
      incomingByStepId.set(edge.target, incoming);
    } else if (!sourceInside && targetInside) {
      inboundStepIds.push(edge.source);
    } else if (sourceInside && !targetInside) {
      outboundStepIds.push(edge.target);
    }
  }

  const entryStepIds = container.stepIds.filter((stepId) => !incomingByStepId.has(stepId));
  const terminalStepIds = container.stepIds.filter((stepId) => !outgoingByStepId.has(stepId));
  const uniqueInboundStepIds = Array.from(new Set(inboundStepIds));
  const uniqueOutboundStepIds = Array.from(new Set(outboundStepIds));
  const badges = [
    ...container.badges,
    countBadge(container.stepIds.length, "step"),
    countBadge(uniqueInboundStepIds.length, "inbound"),
    countBadge(uniqueOutboundStepIds.length, "outbound"),
  ].filter((badge): badge is string => Boolean(badge));
  const entryText = entryStepIds.length > 0 ? entryStepIds.join(", ") : "no internal entry";
  const terminalText = terminalStepIds.length > 0 ? terminalStepIds.join(", ") : "no internal terminal";
  const summary = `${container.title} contains ${container.stepIds.length} step${container.stepIds.length === 1 ? "" : "s"} from ${entryText} to ${terminalText}, receives ${uniqueInboundStepIds.length} inbound step${uniqueInboundStepIds.length === 1 ? "" : "s"}, and hands off to ${uniqueOutboundStepIds.length} outbound step${uniqueOutboundStepIds.length === 1 ? "" : "s"}.`;

  return {
    id: container.id,
    type: container.type,
    title: container.title,
    description: container.description,
    mode: container.mode,
    stepIds: container.stepIds,
    entryStepIds,
    terminalStepIds,
    inboundStepIds: uniqueInboundStepIds,
    outboundStepIds: uniqueOutboundStepIds,
    badges,
    blocked: false,
    summary,
  };
}

export function expandWorkflowGraphSelection<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  seedStepIds: string[],
  mode: WorkflowGraphSelectionMode,
): string[] {
  const graph = buildWorkflowGraphModel(steps);
  const graphStepIds = new Set(graph.nodes.map((node) => node.id).filter(Boolean));
  const selectedStepIds = new Set(seedStepIds.map((stepId) => stepId.trim()).filter((stepId) => graphStepIds.has(stepId)));
  if (selectedStepIds.size === 0) return [];

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  const visit = (frontier: string[], adjacency: Map<string, string[]>): void => {
    const queue = [...frontier];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      for (const next of adjacency.get(current) ?? []) {
        if (selectedStepIds.has(next)) continue;
        selectedStepIds.add(next);
        queue.push(next);
      }
    }
  };

  const seeds = Array.from(selectedStepIds);
  if (mode === "upstream" || mode === "connected") visit(seeds, incoming);
  if (mode === "downstream" || mode === "connected") visit(seeds, outgoing);

  return graph.nodes.map((node) => node.id).filter((stepId) => selectedStepIds.has(stepId));
}

export function buildWorkflowGraphSelectionSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepIds: string[],
): WorkflowGraphSelectionSummary {
  const graph = buildWorkflowGraphModel(steps);
  const selectedStepIdSet = new Set(selectedStepIds.map((stepId) => stepId.trim()).filter(Boolean));
  const stepIds = graph.nodes.map((node) => node.id).filter((stepId) => selectedStepIdSet.has(stepId));
  if (stepIds.length === 0) {
    return {
      stepIds: [],
      entryStepIds: [],
      terminalStepIds: [],
      inboundStepIds: [],
      outboundStepIds: [],
      badges: ["No selection", "Blocked"],
      blocked: true,
      summary: "Select one or more graph steps to inspect bulk action boundaries.",
    };
  }

  const stepIdSet = new Set(stepIds);
  const incomingByStepId = new Map<string, string[]>();
  const outgoingByStepId = new Map<string, string[]>();
  const inboundStepIds: string[] = [];
  const outboundStepIds: string[] = [];
  for (const edge of graph.edges) {
    const sourceInside = stepIdSet.has(edge.source);
    const targetInside = stepIdSet.has(edge.target);
    if (sourceInside && targetInside) {
      outgoingByStepId.set(edge.source, [...(outgoingByStepId.get(edge.source) ?? []), edge.target]);
      incomingByStepId.set(edge.target, [...(incomingByStepId.get(edge.target) ?? []), edge.source]);
    } else if (!sourceInside && targetInside) {
      inboundStepIds.push(edge.source);
    } else if (sourceInside && !targetInside) {
      outboundStepIds.push(edge.target);
    }
  }

  const entryStepIds = stepIds.filter((stepId) => !incomingByStepId.has(stepId));
  const terminalStepIds = stepIds.filter((stepId) => !outgoingByStepId.has(stepId));
  const uniqueInboundStepIds = Array.from(new Set(inboundStepIds));
  const uniqueOutboundStepIds = Array.from(new Set(outboundStepIds));
  const badges = [
    stepIds.length > 0 ? `${stepIds.length} selected` : undefined,
    countBadge(uniqueInboundStepIds.length, "inbound"),
    countBadge(uniqueOutboundStepIds.length, "outbound"),
  ].filter((badge): badge is string => Boolean(badge));
  const entryText = entryStepIds.length > 0 ? entryStepIds.join(", ") : "no internal entry";
  const terminalText = terminalStepIds.length > 0 ? terminalStepIds.join(", ") : "no internal terminal";
  const summary = `Selection contains ${stepIds.length} step${stepIds.length === 1 ? "" : "s"} from ${entryText} to ${terminalText}, receives ${uniqueInboundStepIds.length} inbound step${uniqueInboundStepIds.length === 1 ? "" : "s"}, and hands off to ${uniqueOutboundStepIds.length} outbound step${uniqueOutboundStepIds.length === 1 ? "" : "s"}.`;

  return {
    stepIds,
    entryStepIds,
    terminalStepIds,
    inboundStepIds: uniqueInboundStepIds,
    outboundStepIds: uniqueOutboundStepIds,
    badges,
    blocked: false,
    summary,
  };
}

export function buildWorkflowGraphFailureRouteSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  sourceStepIds: string[],
  handlerStepId: string,
  options: WorkflowGraphFailureRouteOptions = {},
): WorkflowGraphFailureRouteSummary {
  const stepMap = buildStepMap(steps);
  const handler = handlerStepId.trim();
  const label = options.label?.trim() || "Failure route";
  const condition = options.condition?.trim() || "upstream step failed";
  const normalizedSourceSet = new Set(sourceStepIds.map((stepId) => stepId.trim()).filter(Boolean));
  const sourceIds = steps
    .map((step) => step.id.trim())
    .filter((stepId) => normalizedSourceSet.has(stepId) && stepId !== handler);

  if (!handler || !stepMap.has(handler)) {
    return {
      sourceStepIds: sourceIds,
      handlerStepId: handler,
      label,
      condition,
      badges: ["Missing handler", "Blocked"],
      blocked: true,
      summary: "Choose an existing handler step before routing failures.",
    };
  }

  if (normalizedSourceSet.has(handler)) {
    return {
      sourceStepIds: sourceIds,
      handlerStepId: handler,
      label,
      condition,
      badges: ["Handler in selection", "Blocked"],
      blocked: true,
      summary: "The failure handler must sit outside the selected path.",
    };
  }

  if (sourceIds.length === 0) {
    return {
      sourceStepIds: [],
      handlerStepId: handler,
      label,
      condition,
      badges: ["No failure sources", "Blocked"],
      blocked: true,
      summary: "Select at least one source step before routing failures.",
    };
  }

  const cycleSource = sourceIds.find((sourceId) => hasPath(steps, handler, sourceId));
  if (cycleSource) {
    return {
      sourceStepIds: sourceIds,
      handlerStepId: handler,
      label,
      condition,
      badges: ["Cycle risk", "Blocked"],
      blocked: true,
      summary: `Routing ${cycleSource} to ${handler} would create a dependency cycle.`,
    };
  }

  return {
    sourceStepIds: sourceIds,
    handlerStepId: handler,
    label,
    condition,
    badges: [`${sourceIds.length} failure source${sourceIds.length === 1 ? "" : "s"}`, `handler ${handler}`, label],
    blocked: false,
    summary: `${sourceIds.length} selected step${sourceIds.length === 1 ? "" : "s"} will route failures to ${handler}.`,
  };
}

function parseJsonPreviewValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function parseStepArguments(step: WorkflowGraphStep | undefined): Record<string, unknown> {
  if (!step || typeof step.toolArgs !== "string") return {};
  const parsed = parseJsonPreviewValue(step.toolArgs);
  return readPlainObject(parsed);
}

export function buildWorkflowGraphSingleStepTestPreview<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  input: WorkflowGraphInterfaceInput,
  fillArguments?: Record<string, unknown>,
): WorkflowGraphSingleStepTestPreview {
  const graph = buildWorkflowGraphModel(steps);
  const normalizedStepId = stepId.trim();
  const node = graph.nodes.find((candidate) => candidate.id === normalizedStepId);
  const context = node
    ? getWorkflowGraphStepContext(steps, normalizedStepId)
    : {
      stepId: normalizedStepId,
      directDependencyIds: [],
      directDependentIds: [],
      upstreamStepIds: [],
      downstreamStepIds: [],
      missingDependencyIds: [],
    };
  const nodeById = new Map(graph.nodes.map((graphNode) => [graphNode.id, graphNode]));
  const contextResults = context.upstreamStepIds.flatMap((upstreamStepId): WorkflowGraphSingleStepTestContextResult[] => {
    const upstreamNode = nodeById.get(upstreamStepId);
    if (!upstreamNode) return [];
    if (upstreamNode.testing.mockEnabled) {
      const badges = ["Mocked"];
      if (upstreamNode.testing.mockResult) badges.push("Mock result");
      return [{
        stepId: upstreamNode.id,
        title: upstreamNode.label,
        kind: upstreamNode.kind,
        mode: "mocked",
        badges,
        value: parseJsonPreviewValue(upstreamNode.testing.mockResult),
      }];
    }
    if (upstreamNode.testing.pinnedResultRunId) {
      return [{
        stepId: upstreamNode.id,
        title: upstreamNode.label,
        kind: upstreamNode.kind,
        mode: "pinned",
        badges: ["Pinned result", upstreamNode.testing.pinnedResultRunId],
        pinnedResultRunId: upstreamNode.testing.pinnedResultRunId,
      }];
    }
    return [{
      stepId: upstreamNode.id,
      title: upstreamNode.label,
      kind: upstreamNode.kind,
      mode: "unavailable",
      badges: ["Needs prior result"],
    }];
  });
  const flowArguments = buildWorkflowGraphTestRequestPreview(input, "", fillArguments).arguments;
  const stepArguments = parseStepArguments(node?.step);
  const blocked = !node || context.missingDependencyIds.length > 0;
  const mockedCount = contextResults.filter((result) => result.mode === "mocked").length;
  const pinnedCount = contextResults.filter((result) => result.mode === "pinned").length;
  const unavailableCount = contextResults.filter((result) => result.mode === "unavailable").length;
  const badges = [node ? `Test step ${normalizedStepId}` : "No target step"];
  if (context.upstreamStepIds.length > 0) badges.push(`${context.upstreamStepIds.length} upstream context`);
  if (mockedCount > 0) badges.push(`${mockedCount} mocked upstream`);
  if (pinnedCount > 0) badges.push(`${pinnedCount} pinned upstream`);
  if (unavailableCount > 0) badges.push(`${unavailableCount} missing prior result`);
  if (context.downstreamStepIds.length > 0) badges.push(`${context.downstreamStepIds.length} downstream skipped`);
  if (context.missingDependencyIds.length > 0) badges.push(`${context.missingDependencyIds.length} missing dependenc${context.missingDependencyIds.length === 1 ? "y" : "ies"}`);
  if (blocked) badges.push("Blocked");
  const results = Object.fromEntries(contextResults.map((result) => [
    result.stepId,
    result.mode === "mocked"
      ? result.value
      : result.mode === "pinned"
        ? { pinnedResultRunId: result.pinnedResultRunId }
        : { unavailable: true },
  ]));
  return {
    stepId: normalizedStepId,
    title: node?.label ?? normalizedStepId,
    kind: node?.kind ?? "",
    flowArguments,
    stepArguments,
    inputExpression: node?.dataFlow.inputExpression ?? "",
    upstreamContextStepIds: context.upstreamStepIds,
    downstreamStepIds: context.downstreamStepIds,
    missingDependencyIds: context.missingDependencyIds,
    contextResults,
    blocked,
    badges,
    summary: node
      ? `Test this step will run only ${normalizedStepId} with ${context.upstreamStepIds.length} upstream context step${context.upstreamStepIds.length === 1 ? "" : "s"}.`
      : "Choose an existing step before testing a single step.",
    requestJson: `${JSON.stringify({
      flow_input: flowArguments,
      step_input: stepArguments,
      input_expression: node?.dataFlow.inputExpression ?? "",
      results,
    }, null, 2)}\n`,
  };
}

export function buildWorkflowGraphExportSnapshot(input: WorkflowGraphExportInput): WorkflowGraphExportSnapshot {
  const flowInterface = summarizeWorkflowGraphInterface(input);
  return {
    formatVersion: 1,
    metadata: {
      id: readTrimmedString(input.id),
      name: readTrimmedString(input.name),
      description: readTrimmedString(input.description),
      status: readTrimmedString(input.status) || "active",
    },
    settings: {
      schedule: readTrimmedString(input.schedule),
      timezone: readTrimmedString(input.timezone),
      triggerLabels: parseTriggerLabels(input.triggerLabels),
    },
    flowInterface: {
      inputs: flowInterface.inputs,
      envVariables: flowInterface.envVariables,
    },
    steps: Array.isArray(input.steps) ? input.steps : [],
  };
}

function formatYamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (!text) return '""';
  if (/^[A-Za-z0-9_./*@ -]+$/.test(text) && !/^\s|\s$/.test(text)) return text;
  return JSON.stringify(text);
}

function formatYamlValue(value: unknown, indent = 0): string {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((entry) => {
      if (entry && typeof entry === "object") {
        return `${prefix}- ${formatYamlValue(entry, indent + 2).trimStart()}`;
      }
      return `${prefix}- ${formatYamlScalar(entry)}`;
    }).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries.map(([key, entry]) => {
      if (Array.isArray(entry) || (entry && typeof entry === "object")) {
        return `${prefix}${key}: ${formatYamlValue(entry, indent + 2) === "[]" || formatYamlValue(entry, indent + 2) === "{}" ? formatYamlValue(entry, indent + 2) : `\n${formatYamlValue(entry, indent + 2)}`}`;
      }
      return `${prefix}${key}: ${formatYamlScalar(entry)}`;
    }).join("\n");
  }
  return formatYamlScalar(value);
}

export function serializeWorkflowGraphExportSnapshot(
  snapshot: WorkflowGraphExportSnapshot,
  format: WorkflowGraphExportFormat,
): string {
  if (format === "yaml") {
    return `${formatYamlValue(snapshot)}\n`;
  }
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function normalizeSnapshotSteps(value: unknown): WorkflowGraphStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = readPlainObject(entry);
    const id = readTrimmedString(record.id);
    if (!id) return [];
    return [{
      ...record,
      id,
      title: readTrimmedString(record.title),
      type: readTrimmedString(record.type),
      dependsOn: parseDependencies(record.dependsOn),
    } as WorkflowGraphStep];
  });
}

function normalizeExportSnapshot(value: unknown): WorkflowGraphExportSnapshot {
  const record = readPlainObject(value);
  const metadata = readPlainObject(record.metadata);
  const settings = readPlainObject(record.settings);
  const flowInterface = readPlainObject(record.flowInterface);
  return {
    formatVersion: 1,
    metadata: {
      id: readTrimmedString(metadata.id),
      name: readTrimmedString(metadata.name),
      description: readTrimmedString(metadata.description),
      status: readTrimmedString(metadata.status) || "active",
    },
    settings: {
      schedule: readTrimmedString(settings.schedule),
      timezone: readTrimmedString(settings.timezone),
      triggerLabels: parseTriggerLabels(settings.triggerLabels),
    },
    flowInterface: {
      inputs: normalizeFlowInputs(flowInterface.inputs),
      envVariables: normalizeFlowEnvVariables(flowInterface.envVariables),
    },
    steps: normalizeSnapshotSteps(record.steps),
  };
}

export function parseWorkflowGraphYamlDraft(yamlText: string): WorkflowGraphYamlDraftParseResult {
  try {
    return {
      snapshot: normalizeExportSnapshot(parseYaml(yamlText)),
      error: "",
    };
  } catch (error) {
    return {
      snapshot: normalizeExportSnapshot({}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeGraphContainerMode(type: WorkflowGraphContainerType, value: unknown): string {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (type === "loop") {
    return mode === "while" ? "while" : "for-each";
  }
  return mode === "branch-all" ? "branch-all" : "branch-one";
}

function buildContainerBadges(input: {
  type: WorkflowGraphContainerType;
  mode: string;
  condition: string;
  iterator: string;
  skipFailure: boolean;
  runInParallel: boolean;
  parallelism: number | null;
}): string[] {
  const badges: string[] = [];
  if (input.type === "branch") {
    badges.push(input.mode === "branch-all" ? "Branch all" : "Branch one");
    if (input.condition) badges.push("Conditional");
    return badges;
  }
  badges.push(input.mode === "while" ? "While" : "For each");
  if (input.runInParallel) badges.push(`Parallel x${input.parallelism ?? 0}`);
  if (input.skipFailure) badges.push("Skip failure");
  return badges;
}

function hasPath<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  fromId: string,
  toId: string,
  visited = new Set<string>(),
): boolean {
  if (fromId === toId) return true;
  if (visited.has(fromId)) return false;
  visited.add(fromId);

  const children = steps.filter((step) => parseDependencies(step.dependsOn).includes(fromId));
  return children.some((child) => hasPath(steps, child.id, toId, visited));
}

export function getWorkflowGraphStepContext<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
): WorkflowGraphStepContext {
  const id = stepId.trim();
  const stepMap = buildStepMap(steps);
  const orderedStepIds = steps.map((step) => step.id.trim()).filter(Boolean);
  const selectedStep = id ? stepMap.get(id) : undefined;
  const directDependencyCandidates = selectedStep ? parseDependencies(selectedStep.dependsOn) : [];
  const directDependencyIds = Array.from(new Set(directDependencyCandidates.filter((dependencyId) => stepMap.has(dependencyId))));
  const missingDependencyIds = Array.from(new Set(directDependencyCandidates.filter((dependencyId) => !stepMap.has(dependencyId))));
  const directDependentIds = orderedStepIds.filter((candidateId) => {
    const candidateStep = stepMap.get(candidateId);
    return Boolean(candidateStep && parseDependencies(candidateStep.dependsOn).includes(id));
  });

  const upstreamSet = new Set<string>();
  const downstreamSet = new Set<string>();

  function collectUpstream(currentId: string, visiting = new Set<string>()): void {
    if (visiting.has(currentId)) return;
    visiting.add(currentId);
    const currentStep = stepMap.get(currentId);
    if (!currentStep) return;
    for (const dependencyId of parseDependencies(currentStep.dependsOn)) {
      if (!stepMap.has(dependencyId)) continue;
      upstreamSet.add(dependencyId);
      collectUpstream(dependencyId, visiting);
    }
  }

  function collectDownstream(currentId: string, visiting = new Set<string>()): void {
    if (visiting.has(currentId)) return;
    visiting.add(currentId);
    for (const candidateId of orderedStepIds) {
      const candidateStep = stepMap.get(candidateId);
      if (!candidateStep || !parseDependencies(candidateStep.dependsOn).includes(currentId)) continue;
      downstreamSet.add(candidateId);
      collectDownstream(candidateId, visiting);
    }
  }

  if (id && stepMap.has(id)) {
    collectUpstream(id);
    collectDownstream(id);
  }

  return {
    stepId: id,
    directDependencyIds,
    directDependentIds,
    upstreamStepIds: orderedStepIds.filter((candidateId) => candidateId !== id && upstreamSet.has(candidateId)),
    downstreamStepIds: orderedStepIds.filter((candidateId) => candidateId !== id && downstreamSet.has(candidateId)),
    missingDependencyIds,
  };
}

function invariantCountBadge(count: number, label: string): string {
  return `${count} ${label}`;
}

function countConfiguredStepPolicies<TStep extends WorkflowGraphStep>(node: WorkflowGraphNode<TStep> | undefined): number {
  if (!node) return 0;
  const { step, advanced, testing, execution, dataFlow, resources } = node;
  let count = 0;

  if (advanced.onFailure) count += 1;
  if (advanced.maxRetries !== null) count += 1;
  if (advanced.retryDelaySeconds !== null) count += 1;
  if (advanced.retryBackoff) count += 1;
  if (advanced.retryJitter) count += 1;
  if (advanced.timeoutSeconds !== null) count += 1;
  if (advanced.sleepSeconds !== null) count += 1;
  if (advanced.suspendUntil) count += 1;
  if (advanced.suspendTimeoutSeconds !== null) count += 1;
  if (advanced.suspendTimeoutAction) count += 1;
  if (advanced.earlyReturn) count += 1;
  if (advanced.earlyReturnContentType) count += 1;
  if (advanced.earlyReturnSchema) count += 1;
  if (advanced.errorHandler) count += 1;
  if (advanced.errorHandlerScope) count += 1;
  if (advanced.errorHandlerInput) count += 1;
  if (advanced.restartBoundary) count += 1;
  if (advanced.restartStrategy) count += 1;
  if (advanced.restartInput) count += 1;
  if (advanced.earlyStopCondition) count += 1;
  if (advanced.earlyStopLabelSkipped) count += 1;
  if (advanced.approval.required) count += 1;
  if (advanced.approval.prompt) count += 1;
  if (advanced.approval.recipients.length > 0) count += 1;
  if (advanced.approval.timeoutSeconds !== null) count += 1;
  if (advanced.approval.timeoutAction) count += 1;
  if (testing.mockEnabled) count += 1;
  if (testing.mockResult) count += 1;
  if (testing.pinnedResultRunId) count += 1;
  if (execution.concurrencyKey) count += 1;
  if (execution.concurrencyLimit !== null) count += 1;
  if (execution.priority) count += 1;
  if (execution.cacheEnabled) count += 1;
  if (execution.cacheTtlSeconds !== null) count += 1;
  if (execution.deleteAfterUse) count += 1;
  if (dataFlow.inputExpression) count += 1;
  if (dataFlow.outputSchema) count += 1;
  if (dataFlow.workProductRequired) count += 1;
  if (dataFlow.workProductPattern) count += 1;
  if (resources.resourceRefs.length > 0) count += 1;
  if (resources.secretRefs.length > 0) count += 1;
  if (readTrimmedString(step.graphGroupId)) count += 1;
  if (readTrimmedString(step.graphContainerId)) count += 1;
  if (readTrimmedString(step.graphNote)) count += 1;
  return count;
}

export function buildWorkflowGraphInspectorSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepId: string,
  selectedPathStepIds: string[] = selectedStepId ? [selectedStepId] : [],
): WorkflowGraphInspectorSummary {
  const graph = buildWorkflowGraphModel(steps);
  const stepId = selectedStepId.trim();
  const node = graph.nodes.find((candidate) => candidate.id === stepId);
  const context = getWorkflowGraphStepContext(steps, stepId);
  const repairPlan = buildWorkflowGraphRepairPlan(steps);
  const selection = buildWorkflowGraphSelectionSummary(steps, selectedPathStepIds);
  const policyCount = countConfiguredStepPolicies(node);
  const selectedLabel = stepId || "No selected step";
  const overviewBadges = [
    repairPlan.items.length === 0 ? "No repairs" : `${repairPlan.items.length} repair${repairPlan.items.length === 1 ? "" : "s"}`,
    selection.blocked ? "No selection" : `${selection.stepIds.length} selected`,
  ];
  const editBadges = [
    invariantCountBadge(context.directDependencyIds.length, "upstream"),
    invariantCountBadge(context.directDependentIds.length, "downstream"),
  ];
  const policyBadge = policyCount === 0 ? "No policies" : `${policyCount} ${policyCount === 1 ? "policy" : "policies"}`;

  return {
    defaultMode: "overview",
    selectedStepId: stepId,
    sections: [
      {
        mode: "overview",
        title: "Overview",
        badges: overviewBadges,
        summary: repairPlan.blocked
          ? `${repairPlan.summary} ${selection.summary}`
          : `Graph is structurally clear. ${selection.summary}`,
      },
      {
        mode: "edit",
        title: "Edit",
        badges: editBadges,
        summary: `${selectedLabel} has ${context.directDependencyIds.length} upstream and ${context.directDependentIds.length} downstream.`,
      },
      {
        mode: "policy",
        title: "Policy",
        badges: [policyBadge],
        summary: policyCount === 0
          ? `${selectedLabel} has no advanced controls configured.`
          : `${selectedLabel} has ${policyCount} advanced controls configured.`,
      },
      {
        mode: "raw",
        title: "Raw",
        badges: ["JSON", selectedLabel],
        summary: `Raw step JSON for ${selectedLabel} stays available without leaving the graph.`,
      },
    ],
  };
}

export function buildWorkflowGraphFocusLensSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepId: string,
  selectedPathStepIds: string[] = selectedStepId ? [selectedStepId] : [],
): WorkflowGraphFocusLensSummary {
  const graph = buildWorkflowGraphModel(steps);
  const stepId = selectedStepId.trim() || graph.nodes[0]?.id || "";
  const node = graph.nodes.find((candidate) => candidate.id === stepId);
  const context = getWorkflowGraphStepContext(steps, stepId);
  const repairPlan = buildWorkflowGraphRepairPlan(steps);
  const selection = buildWorkflowGraphSelectionSummary(steps, selectedPathStepIds);
  const policyCount = countConfiguredStepPolicies(node);
  const runStatus = node?.runStatus.status ?? "planned";
  const outputCount = node?.runStatus.workProducts.length ?? 0;
  const issueLabel = node?.runStatus.issueIdentifier || node?.runStatus.issueId || "";
  const hasErrors = graph.diagnostics.issueCountBySeverity.error > 0 || repairPlan.blocked;
  const hasRuntimeFailure = runStatus === "failed";
  const title = node?.label || stepId || "No step selected";
  const kind = node?.kind || "step";
  const tone: WorkflowGraphFocusLensTone = hasRuntimeFailure || hasErrors
    ? "danger"
    : runStatus === "running"
      ? "info"
      : policyCount > 0
        ? "warning"
        : node ? "success" : "neutral";
  const pathValue = `${context.directDependencyIds.length} upstream / ${context.directDependentIds.length} next`;
  const runtimeValue = hasRuntimeFailure
    ? "failed"
    : runStatus === "succeeded"
      ? outputCount > 0 ? `${outputCount} outputs` : "succeeded"
      : runStatus;
  const description = !node
    ? "Select a graph node to inspect its path, policies, runtime evidence, and next actions."
    : hasErrors
      ? `${title} is selected. Resolve structural diagnostics before trusting this graph.`
      : `${title} is selected with ${pathValue}. Details stay available without making the graph secondary.`;

  return {
    selectedStepId: stepId,
    title,
    description,
    tone,
    badges: [
      node ? kind : "no selection",
      repairPlan.items.length === 0 ? "No repairs" : `${repairPlan.items.length} repairs`,
      selection.blocked ? "No path" : `${selection.stepIds.length} path nodes`,
      issueLabel ? `issue ${issueLabel}` : "no issue",
    ],
    metrics: [
      {
        id: "step",
        label: "Step",
        value: kind,
        tone: node ? (kind === "tool" ? "info" : "success") : "neutral",
        detail: node?.id || "No selected node",
      },
      {
        id: "path",
        label: "Path",
        value: pathValue,
        tone: context.missingDependencyIds.length > 0 ? "danger" : "info",
        detail: context.missingDependencyIds.length > 0
          ? `${context.missingDependencyIds.length} missing dependencies`
          : `${context.upstreamStepIds.length} total upstream, ${context.downstreamStepIds.length} total downstream`,
      },
      {
        id: "controls",
        label: "Controls",
        value: policyCount === 0 ? "No policies" : `${policyCount} policies`,
        tone: policyCount > 0 ? "warning" : "neutral",
        detail: policyCount > 0 ? "Advanced controls are configured for this node." : "No advanced controls configured.",
      },
      {
        id: "runtime",
        label: "Runtime",
        value: runtimeValue,
        tone: hasRuntimeFailure ? "danger" : runStatus === "running" ? "info" : runStatus === "succeeded" ? "success" : "neutral",
        detail: issueLabel
          ? `Linked issue ${issueLabel}${outputCount > 0 ? ` with ${outputCount} work products` : ""}.`
          : outputCount > 0
            ? `${outputCount} work products are registered.`
            : "No linked runtime evidence for this selected step.",
      },
    ],
    actions: [
      { id: "edit", label: "Edit", disabled: !node },
      { id: "test", label: "Test", disabled: !node },
      { id: "evidence", label: "Evidence", disabled: !node },
      { id: "policy", label: "Policy", disabled: !node },
      { id: "raw", label: "Raw", disabled: !node },
      { id: "add-after", label: "Add after", disabled: !node },
      { id: "diagnostics", label: graph.diagnostics.issues.length > 0 ? "Diagnostics" : "Health" },
    ],
    detailsHiddenByDefault: true,
  };
}

export function buildWorkflowGraphExecutionEvidenceSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepId: string,
): WorkflowGraphExecutionEvidenceSummary {
  const graph = buildWorkflowGraphModel(steps);
  const stepId = selectedStepId.trim() || graph.nodes[0]?.id || "";
  const node = graph.nodes.find((candidate) => candidate.id === stepId);
  const runStatus = node?.runStatus;
  const title = node?.label || stepId || "No step selected";
  const status = runStatus?.status ?? "planned";
  const hasEvidence = Boolean(runStatus && (
    runStatus.stepRunId
    || runStatus.issueIdentifier
    || runStatus.updatedAt
    || runStatus.summary
    || runStatus.resultPreview
    || runStatus.logPreview
    || runStatus.workProducts.length > 0
    || status !== "planned"
  ));
  const hasDispatchError = Boolean(runStatus?.lastDispatchErrorAt || runStatus?.lastDispatchErrorSummary);
  const tone: WorkflowGraphFocusLensTone = !node
    ? "neutral"
    : hasDispatchError || status === "failed"
      ? "danger"
      : status === "succeeded" || (runStatus?.workProducts.length ?? 0) > 0
        ? "success"
        : status === "running"
          ? "info"
          : hasEvidence ? "info" : "neutral";
  const dispatchValue = hasDispatchError
    ? "error"
    : runStatus?.lastDispatchAcceptedAt
      ? "accepted"
      : runStatus?.lastDispatchAttemptAt
        ? "attempted"
        : "none";
  const outputCount = runStatus?.workProducts.length ?? 0;

  return {
    selectedStepId: stepId,
    title,
    tone,
    available: hasEvidence,
    summary: !node
      ? "Select a graph node to inspect run evidence."
      : hasEvidence
        ? `${title} has ${status} run evidence attached to the graph.`
        : `${title} has no run evidence yet. Run or inspect a workflow execution to populate this drawer.`,
    badges: [
      status,
      runStatus?.stepRunId ? `step run ${runStatus.stepRunId}` : "no step run",
      runStatus?.issueIdentifier ? `issue ${runStatus.issueIdentifier}` : "no issue",
      outputCount > 0 ? `${outputCount} output${outputCount === 1 ? "" : "s"}` : "no outputs",
      runStatus?.resultPreview ? "result" : runStatus?.logPreview ? "logs" : "no preview",
    ],
    metrics: [
      {
        id: "status",
        label: "Status",
        value: status,
        tone,
        detail: runStatus?.summary || "No run summary.",
      },
      {
        id: "issue",
        label: "Issue",
        value: runStatus?.issueIdentifier || "none",
        tone: runStatus?.issueIdentifier ? "info" : "neutral",
        detail: runStatus?.issueId || "No linked execution issue.",
      },
      {
        id: "dispatch",
        label: "Dispatch",
        value: dispatchValue,
        tone: hasDispatchError ? "danger" : runStatus?.lastDispatchAcceptedAt ? "success" : "neutral",
        detail: hasDispatchError
          ? runStatus?.lastDispatchErrorSummary || runStatus?.lastDispatchErrorAt || "Dispatch failed."
          : runStatus?.lastDispatchRequestId || "No dispatch request recorded.",
      },
      {
        id: "outputs",
        label: "Outputs",
        value: String(outputCount),
        tone: outputCount > 0 ? "success" : "neutral",
        detail: outputCount > 0 ? `${outputCount} work product${outputCount === 1 ? "" : "s"} registered.` : "No registered outputs.",
      },
    ],
    resultPreview: runStatus?.resultPreview ?? "",
    logPreview: runStatus?.logPreview ?? "",
    workProducts: runStatus?.workProducts ?? [],
  };
}

export function buildWorkflowGraphTestDrawerSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepId: string,
  interfaceInput: WorkflowGraphInterfaceInput = {},
): WorkflowGraphTestDrawerSummary {
  const graph = buildWorkflowGraphModel(steps);
  const stepId = selectedStepId.trim() || graph.nodes[0]?.id || "";
  const node = graph.nodes.find((candidate) => candidate.id === stepId);
  const targetId = node?.id ?? stepId;
  const testPlan = buildWorkflowGraphTestPlan(steps, targetId);
  const singleStep = buildWorkflowGraphSingleStepTestPreview(steps, targetId, interfaceInput);
  const restart = buildWorkflowGraphRestartPreview(steps, targetId);
  const loopContainer = graph.containers.find((container) => container.type === "loop");
  const iteration = buildWorkflowGraphIterationTestPreview(steps, loopContainer?.id ?? "", 0, {});
  const inputLibrary = summarizeWorkflowGraphTestInputLibrary(interfaceInput);
  const blocked = !node || testPlan.blocked || singleStep.blocked || restart.blocked;
  const title = node?.label || targetId || "No step selected";

  return {
    selectedStepId: targetId,
    title,
    tone: blocked ? "warning" : "info",
    summary: !node
      ? "Select a graph node before opening execution tests."
      : `Test drawer is ready for ${title}. Run this step, test up to it, or restart from it while keeping the graph visible.`,
    badges: [
      node ? node.kind : "no selection",
      testPlan.blocked ? "test blocked" : "test ready",
      restart.blocked ? "restart blocked" : "restartable",
      ...inputLibrary.badges.slice(0, 1),
    ],
    modes: [
      {
        id: "test-flow",
        title: "Test up to selected step",
        tone: testPlan.blocked ? "danger" : "success",
        badges: testPlan.badges,
        summary: testPlan.summary,
      },
      {
        id: "test-step",
        title: "Test this step",
        tone: singleStep.blocked ? "danger" : "info",
        badges: singleStep.badges,
        summary: singleStep.summary,
      },
      {
        id: "restart",
        title: "Restart from selected step",
        tone: restart.blocked ? "danger" : "warning",
        badges: restart.badges,
        summary: restart.summary,
      },
      {
        id: "iteration",
        title: "Test iteration",
        tone: iteration.blocked ? "neutral" : "info",
        badges: iteration.badges,
        summary: iteration.summary,
      },
      {
        id: "inputs",
        title: "Saved inputs",
        tone: inputLibrary.presets.length > 0 ? "success" : "neutral",
        badges: inputLibrary.badges,
        summary: inputLibrary.presets.length > 0
          ? `${inputLibrary.presets.length} saved input preset${inputLibrary.presets.length === 1 ? "" : "s"} can seed this test run.`
          : "No saved input presets are configured for this workflow.",
      },
    ],
  };
}

export function buildWorkflowGraphStructurePaletteSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepId: string,
  selectedPathStepIds: string[] = selectedStepId ? [selectedStepId] : [],
  failureRouteBlocked = false,
): WorkflowGraphStructurePaletteSummary {
  const graph = buildWorkflowGraphModel(steps);
  const stepId = selectedStepId.trim() || graph.nodes[0]?.id || "";
  const node = graph.nodes.find((candidate) => candidate.id === stepId);
  const selection = buildWorkflowGraphSelectionSummary(steps, selectedPathStepIds);
  const hasSelection = !selection.blocked && selection.stepIds.length > 0;
  const canInsertAfterSelection = Boolean(node || graph.nodes.length === 0);
  const title = node?.label || stepId || "No step selected";
  const blockedTransformDescription = selection.blocked
    ? "Select a graph node or path before using path transforms."
    : `${selection.stepIds.length} selected step${selection.stepIds.length === 1 ? "" : "s"} can be transformed.`;

  return {
    selectedStepId: stepId,
    title,
    tone: node ? "info" : graph.nodes.length === 0 ? "warning" : "neutral",
    summary: node
      ? `Add a node after ${title}, wrap the selected path, or route failures without leaving the graph.`
      : graph.nodes.length === 0
        ? "Start this workflow by adding an agent or tool node."
        : "Select a graph node to add adjacent steps and transform paths.",
    badges: [
      node ? node.kind : graph.nodes.length === 0 ? "empty graph" : "no selection",
      hasSelection ? `${selection.stepIds.length} selected` : "no path",
      selection.inboundStepIds.length > 0 ? `${selection.inboundStepIds.length} inbound` : "no inbound",
      selection.outboundStepIds.length > 0 ? `${selection.outboundStepIds.length} outbound` : "no outbound",
    ],
    addActions: [
      {
        id: "agent",
        label: "Agent",
        description: node ? "Add a company worker step after this node." : "Add the first company worker step.",
        tone: "success",
        disabled: !canInsertAfterSelection,
      },
      {
        id: "tool",
        label: "Tool",
        description: node ? "Add a system or integration action after this node." : "Add the first system or integration action.",
        tone: "info",
        disabled: !canInsertAfterSelection,
      },
      {
        id: "branch",
        label: "Branch",
        description: "Insert a condition split for alternative paths.",
        tone: "warning",
        disabled: !canInsertAfterSelection,
      },
      {
        id: "loop",
        label: "Loop",
        description: "Insert an iteration block for repeated work.",
        tone: "warning",
        disabled: !canInsertAfterSelection,
      },
      {
        id: "approval",
        label: "Approval",
        description: "Suspend execution for governed human review.",
        tone: "neutral",
        disabled: !canInsertAfterSelection,
      },
      {
        id: "failure-handler",
        label: "Failure",
        description: "Add a handler step for recovery paths.",
        tone: "danger",
        disabled: !canInsertAfterSelection,
      },
    ],
    transformActions: [
      {
        id: "group",
        label: "Group",
        description: hasSelection ? "Cluster selected steps as one navigable flow group." : blockedTransformDescription,
        tone: "neutral",
        disabled: !hasSelection,
      },
      {
        id: "branch-wrap",
        label: "Wrap branch",
        description: hasSelection ? "Turn the selected path into a conditional branch container." : blockedTransformDescription,
        tone: "warning",
        disabled: !hasSelection,
      },
      {
        id: "loop-wrap",
        label: "Wrap loop",
        description: hasSelection ? "Turn the selected path into an iteration container." : blockedTransformDescription,
        tone: "warning",
        disabled: !hasSelection,
      },
      {
        id: "route-failure",
        label: "Route failure",
        description: failureRouteBlocked
          ? "Choose or add a failure handler before routing this path."
          : "Route selected step failures to the configured handler.",
        tone: failureRouteBlocked ? "neutral" : "danger",
        disabled: !hasSelection || failureRouteBlocked,
      },
    ],
  };
}

export function buildWorkflowGraphWorkbenchSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepId: string,
  selectedPathStepIds: string[] = selectedStepId ? [selectedStepId] : [],
): WorkflowGraphWorkbenchSummary {
  const graph = buildWorkflowGraphModel(steps);
  const diagnostics = graph.diagnostics;
  const selection = buildWorkflowGraphSelectionSummary(steps, selectedPathStepIds);
  return {
    selectedStepId: selectedStepId.trim(),
    commandGroups: [
      {
        id: "canvas",
        label: "Canvas",
        actions: [
          { id: "fit-canvas", label: "Fit" },
          { id: "actual-size", label: "100%" },
          { id: "center-selected", label: "Center", disabled: !selectedStepId.trim() },
          { id: "diagnostics", label: "Diagnostics" },
        ],
      },
      {
        id: "add",
        label: "Add",
        actions: [
          { id: "agent", label: "+ Agent" },
          { id: "tool", label: "+ Tool" },
          { id: "branch", label: "Branch" },
          { id: "loop", label: "Loop" },
          { id: "approval", label: "Approval" },
          { id: "failure-handler", label: "Failure" },
        ],
      },
      {
        id: "path",
        label: "Path",
        actions: [
          { id: "upstream", label: "Upstream", disabled: !selectedStepId.trim() },
          { id: "downstream", label: "Downstream", disabled: !selectedStepId.trim() },
          { id: "connected", label: "Connected", disabled: !selectedStepId.trim() },
          { id: "group", label: "Group", disabled: selection.blocked },
          { id: "branch-wrap", label: "Branch", disabled: selection.blocked },
          { id: "loop-wrap", label: "Loop", disabled: selection.blocked },
          { id: "route-failure", label: "Route failure", disabled: selection.blocked },
        ],
      },
    ],
    statusBadges: [
      `${diagnostics.issueCountBySeverity.error} error${diagnostics.issueCountBySeverity.error === 1 ? "" : "s"}`,
      `${diagnostics.entryStepIds.length} entr${diagnostics.entryStepIds.length === 1 ? "y" : "ies"}`,
      `${diagnostics.terminalStepIds.length} terminal${diagnostics.terminalStepIds.length === 1 ? "" : "s"}`,
      selection.blocked ? "0 selected" : `${selection.stepIds.length} selected`,
    ],
    pathSummary: selection.summary,
    detailsHiddenByDefault: true,
  };
}

export function buildWorkflowGraphEdgeImpactPreview<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  sourceStepId: string,
  targetStepId: string,
  action: WorkflowGraphEdgeImpactAction,
): WorkflowGraphEdgeImpactPreview {
  const source = sourceStepId.trim();
  const target = targetStepId.trim();
  const stepMap = buildStepMap(steps);
  const normalizedAction: WorkflowGraphEdgeImpactAction = action === "disconnect" ? "disconnect" : "connect";
  const base = {
    action: normalizedAction,
    sourceStepId: source,
    targetStepId: target,
    impactedStepIds: [],
    downstreamStepIds: [],
  };

  if (!source || !target || !stepMap.has(source) || !stepMap.has(target)) {
    return {
      ...base,
      badges: ["Missing step", "Blocked"],
      blocked: true,
      summary: "Choose existing source and target steps before previewing edge impact.",
    };
  }
  if (source === target) {
    return {
      ...base,
      badges: ["Self edge", "Blocked"],
      blocked: true,
      summary: "A workflow step cannot depend on itself.",
    };
  }

  const targetDependencies = parseDependencies(stepMap.get(target)?.dependsOn);
  const edgeExists = targetDependencies.includes(source);
  if (normalizedAction === "connect" && !edgeExists && hasPath(steps, target, source)) {
    return {
      ...base,
      badges: ["Cycle risk", "Blocked"],
      blocked: true,
      summary: `Connecting ${source} -> ${target} would create a dependency cycle.`,
    };
  }
  if (normalizedAction === "disconnect" && !edgeExists) {
    return {
      ...base,
      badges: ["No edge", "Blocked"],
      blocked: true,
      summary: `No existing edge connects ${source} -> ${target}.`,
    };
  }

  const context = getWorkflowGraphStepContext(steps, target);
  const downstreamStepIds = context.downstreamStepIds;
  const impactedStepIds = [target, ...downstreamStepIds];
  const actionLabel = normalizedAction === "connect" ? "Connect edge" : "Remove edge";
  const alreadyConnectedBadge = normalizedAction === "connect" && edgeExists ? "Existing edge" : undefined;
  const badges = [
    actionLabel,
    `${impactedStepIds.length} impacted`,
    alreadyConnectedBadge,
  ].filter((badge): badge is string => Boolean(badge));
  return {
    ...base,
    impactedStepIds,
    downstreamStepIds,
    badges,
    blocked: false,
    summary: `${normalizedAction === "connect" ? "Connecting" : "Removing"} ${source} -> ${target} will affect ${impactedStepIds.join(", ")}.`,
  };
}

export function buildWorkflowGraphTestPlan<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  targetStepId: string,
): WorkflowGraphTestPlan {
  const graph = buildWorkflowGraphModel(steps);
  const normalizedTargetStepId = targetStepId.trim();
  const nodeIds = graph.nodes.map((node) => node.id).filter(Boolean);
  const targetExists = normalizedTargetStepId ? nodeIds.includes(normalizedTargetStepId) : false;
  const context = targetExists
    ? getWorkflowGraphStepContext(steps, normalizedTargetStepId)
    : {
      stepId: normalizedTargetStepId,
      directDependencyIds: [],
      directDependentIds: [],
      upstreamStepIds: [],
      downstreamStepIds: [],
      missingDependencyIds: [],
    };
  const includedIds = new Set<string>(targetExists ? [...context.upstreamStepIds, normalizedTargetStepId] : []);
  const stepIds = nodeIds.filter((stepId) => includedIds.has(stepId));
  const excludedStepIds = nodeIds.filter((stepId) => !includedIds.has(stepId));
  const includedDiagnostics = graph.diagnostics.issues.filter((issue) => {
    const relatedStepId = issue.stepId ?? issue.targetId ?? "";
    return relatedStepId ? includedIds.has(relatedStepId) : issue.severity === "error";
  });
  const blocked = !targetExists
    || context.missingDependencyIds.length > 0
    || includedDiagnostics.some((issue) => issue.severity === "error");
  const badges = [
    `Test ${stepIds.length} step${stepIds.length === 1 ? "" : "s"}`,
    targetExists ? `Stop at ${normalizedTargetStepId}` : "No target step",
  ];
  if (excludedStepIds.length > 0) {
    badges.push(`Skip ${excludedStepIds.length} downstream`);
  }
  if (blocked) {
    badges.push("Blocked");
  }

  let summary = targetExists
    ? `Test will run ${stepIds.length} step${stepIds.length === 1 ? "" : "s"} through ${normalizedTargetStepId}`
    : "Choose an existing step before testing this flow";
  if (targetExists && excludedStepIds.length > 0) {
    summary += ` and skip ${excludedStepIds.length} downstream step${excludedStepIds.length === 1 ? "" : "s"}`;
  }
  summary += ".";

  return {
    targetStepId: normalizedTargetStepId,
    stepIds,
    excludedStepIds,
    missingDependencyIds: context.missingDependencyIds,
    blocked,
    badges,
    summary,
  };
}

export function buildWorkflowGraphTestExecutionPreview<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  targetStepId: string,
): WorkflowGraphTestExecutionPreview {
  const graph = buildWorkflowGraphModel(steps);
  const plan = buildWorkflowGraphTestPlan(steps, targetStepId);
  const includedIds = new Set(plan.stepIds);
  const issuesByStepId = new Map<string, WorkflowGraphIssue[]>();
  for (const issue of graph.diagnostics.issues) {
    const stepId = issue.stepId ?? issue.targetId ?? "";
    if (!stepId) continue;
    const issues = issuesByStepId.get(stepId) ?? [];
    issues.push(issue);
    issuesByStepId.set(stepId, issues);
  }

  const previewSteps = graph.nodes.map((node): WorkflowGraphTestExecutionStep => {
    const issues = issuesByStepId.get(node.id) ?? [];
    const hasBlockingIssue = issues.some((issue) => issue.severity === "error");
    if (hasBlockingIssue && !includedIds.has(node.id)) {
      return {
        stepId: node.id,
        title: node.label,
        kind: node.kind,
        mode: "blocked",
        reason: issues.map((issue) => issue.message).join("; "),
        badges: ["Missing dependency"],
      };
    }
    if (!includedIds.has(node.id)) {
      return {
        stepId: node.id,
        title: node.label,
        kind: node.kind,
        mode: "skipped",
        reason: "Downstream of the selected test target.",
        badges: ["Skipped downstream"],
      };
    }
    if (node.testing.mockEnabled) {
      const badges = ["Mocked"];
      if (node.testing.mockResult) badges.push("Mock result");
      return {
        stepId: node.id,
        title: node.label,
        kind: node.kind,
        mode: "mocked",
        reason: "Uses the configured mock result instead of dispatching the step.",
        badges,
      };
    }
    if (node.testing.pinnedResultRunId) {
      return {
        stepId: node.id,
        title: node.label,
        kind: node.kind,
        mode: "pinned",
        reason: "Replays a pinned run or step result for this test.",
        badges: ["Pinned result", node.testing.pinnedResultRunId],
      };
    }
    return {
      stepId: node.id,
      title: node.label,
      kind: node.kind,
      mode: "will-run",
      reason: "Dispatches during this test preview.",
      badges: ["Runs in test"],
    };
  });

  const mockCount = previewSteps.filter((step) => step.mode === "mocked").length;
  const pinnedCount = previewSteps.filter((step) => step.mode === "pinned").length;
  const skippedCount = previewSteps.filter((step) => step.mode === "skipped").length;
  const blockedCount = previewSteps.filter((step) => step.mode === "blocked").length;
  const badges = [`${plan.stepIds.length} included`];
  if (mockCount > 0) badges.push(`${mockCount} mock${mockCount === 1 ? "" : "s"}`);
  if (pinnedCount > 0) badges.push(`${pinnedCount} pinned`);
  if (skippedCount > 0) badges.push(`${skippedCount} skipped`);
  if (blockedCount > 0) badges.push(`${blockedCount} blocked`);

  const summaryParts = [`Test preview includes ${plan.stepIds.length} step${plan.stepIds.length === 1 ? "" : "s"}`];
  if (mockCount > 0) summaryParts.push(`uses ${mockCount} mock${mockCount === 1 ? "" : "s"}`);
  if (pinnedCount > 0) summaryParts.push(`replays ${pinnedCount} pinned result${pinnedCount === 1 ? "" : "s"}`);
  if (skippedCount > 0) summaryParts.push(`skips ${skippedCount} downstream step${skippedCount === 1 ? "" : "s"}`);
  if (blockedCount > 0) summaryParts.push(`blocks ${blockedCount} step${blockedCount === 1 ? "" : "s"} with missing dependencies`);

  const summary = summaryParts.length === 1
    ? `${summaryParts[0]}.`
    : `${summaryParts.slice(0, -1).join(", ")}, and ${summaryParts.at(-1)}.`;

  return {
    targetStepId: plan.targetStepId,
    steps: previewSteps,
    badges,
    summary,
  };
}

export function buildWorkflowGraphRestartPreview<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  restartStepId: string,
): WorkflowGraphRestartPreview {
  const graph = buildWorkflowGraphModel(steps);
  const normalizedRestartStepId = restartStepId.trim();
  const nodeIds = graph.nodes.map((node) => node.id).filter(Boolean);
  const restartExists = normalizedRestartStepId ? nodeIds.includes(normalizedRestartStepId) : false;
  if (!restartExists) {
    return {
      restartStepId: normalizedRestartStepId,
      reusedStepIds: [],
      rerunStepIds: [],
      blockedStepIds: [],
      blocked: true,
      steps: [],
      badges: ["No restart step", "Blocked"],
      summary: "Choose an existing step before previewing restart.",
    };
  }

  const context = getWorkflowGraphStepContext(steps, normalizedRestartStepId);
  const reusedSet = new Set(context.upstreamStepIds);
  const rerunSet = new Set([normalizedRestartStepId, ...context.downstreamStepIds]);
  const issuesByStepId = new Map<string, WorkflowGraphIssue[]>();
  for (const issue of graph.diagnostics.issues) {
    const stepId = issue.stepId ?? issue.targetId ?? "";
    if (!stepId) continue;
    const issues = issuesByStepId.get(stepId) ?? [];
    issues.push(issue);
    issuesByStepId.set(stepId, issues);
  }

  const previewSteps = graph.nodes.map((node): WorkflowGraphRestartStep => {
    const issues = issuesByStepId.get(node.id) ?? [];
    const hasBlockingIssue = issues.some((issue) => issue.severity === "error");
    if (hasBlockingIssue && !reusedSet.has(node.id) && !rerunSet.has(node.id)) {
      return {
        stepId: node.id,
        title: node.label,
        kind: node.kind,
        mode: "blocked",
        reason: issues.map((issue) => issue.message).join("; "),
        badges: ["Missing dependency"],
      };
    }
    if (reusedSet.has(node.id)) {
      return {
        stepId: node.id,
        title: node.label,
        kind: node.kind,
        mode: "reused",
        reason: "Previous result can be reused when restarting from the selected step.",
        badges: ["Reuse previous result"],
      };
    }
    return {
      stepId: node.id,
      title: node.label,
      kind: node.kind,
      mode: "rerun",
      reason: node.id === normalizedRestartStepId
        ? "This is the selected restart boundary."
        : "Downstream of the restart boundary and will run again.",
      badges: [node.id === normalizedRestartStepId ? "Restart here" : "Rerun downstream"],
    };
  });

  const reusedStepIds = nodeIds.filter((stepId) => reusedSet.has(stepId));
  const rerunStepIds = nodeIds.filter((stepId) => rerunSet.has(stepId));
  const blockedStepIds = previewSteps.filter((step) => step.mode === "blocked").map((step) => step.stepId);
  const badges = [
    `Reuse ${reusedStepIds.length} previous`,
    `Rerun ${rerunStepIds.length} step${rerunStepIds.length === 1 ? "" : "s"}`,
  ];
  if (blockedStepIds.length > 0) {
    badges.push(`${blockedStepIds.length} blocked outside restart`);
  }

  return {
    restartStepId: normalizedRestartStepId,
    reusedStepIds,
    rerunStepIds,
    blockedStepIds,
    blocked: false,
    steps: previewSteps,
    badges,
    summary: `Restart from ${normalizedRestartStepId} will reuse ${reusedStepIds.length} previous step${reusedStepIds.length === 1 ? "" : "s"} and rerun ${rerunStepIds.length} step${rerunStepIds.length === 1 ? "" : "s"}.`,
  };
}

export function buildWorkflowGraphRunDebugSummary<TStep extends WorkflowGraphStep>(
  input: WorkflowGraphRunDebugInput<TStep>,
): WorkflowGraphRunDebugSummary {
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const stepRuns = Array.isArray(input.stepRuns) ? input.stepRuns : [];
  const runByStepId = new Map<string, WorkflowGraphStepRunInput>();
  for (const run of stepRuns) {
    const stepId = readTrimmedString(run.stepId);
    if (stepId) runByStepId.set(stepId, run);
  }
  const counts = {
    total: steps.length,
    planned: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    paused: 0,
    issues: 0,
    workProducts: 0,
  };
  const statusByStepId = new Map<string, WorkflowGraphRunStatus>();
  for (const step of steps) {
    const stepId = readTrimmedString(step.id);
    const run = runByStepId.get(stepId);
    const status = run ? normalizeGraphRunStatus(run.status) : "planned";
    statusByStepId.set(stepId, status);
    counts[status] += 1;
    if (run?.issueId || run?.issueIdentifier) counts.issues += 1;
    counts.workProducts += normalizeWorkProducts(run?.workProducts).length;
  }

  const failedStep = steps.find((step) => statusByStepId.get(readTrimmedString(step.id)) === "failed");
  const runningStep = steps.find((step) => statusByStepId.get(readTrimmedString(step.id)) === "running");
  const selectedStepId = readTrimmedString(input.selectedStepId);
  const selectedStep = selectedStepId ? steps.find((step) => readTrimmedString(step.id) === selectedStepId) : undefined;
  const succeededSteps = steps.filter((step) => statusByStepId.get(readTrimmedString(step.id)) === "succeeded");
  const focusStep = failedStep ?? runningStep ?? selectedStep ?? succeededSteps.at(-1) ?? steps[0];
  const focusStepId = readTrimmedString(focusStep?.id);
  const restartPreview = buildWorkflowGraphRestartPreview(steps, focusStepId);
  const focusRun = focusStepId ? runByStepId.get(focusStepId) : undefined;
  const focusStatus = focusStepId ? statusByStepId.get(focusStepId) ?? "planned" : "planned";
  const focusTitle = readTrimmedString(focusStep?.title) || focusStepId || "No step selected";
  const available = steps.length > 0 && stepRuns.length > 0;
  const tone: WorkflowGraphRunDebugTileTone = counts.failed > 0
    ? "danger"
    : counts.running > 0
      ? "info"
      : counts.succeeded > 0
        ? "success"
        : available ? "neutral" : "warning";
  const title = !available
    ? "Run detail unavailable"
    : counts.failed > 0
      ? "Focus failed step"
      : counts.running > 0
        ? "Follow running step"
        : "Run overlay ready";
  const focusSummary = readTrimmedString(focusRun?.lastDispatchErrorSummary)
    || readTrimmedString(focusRun?.metadata?.summary)
    || readTrimmedString(focusRun?.agentName)
    || `${focusTitle} is ${focusStatus}.`;
  const summary = !available
    ? "Select a run with loaded step details to inspect graph execution."
    : `${focusTitle} is ${focusStatus}; ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.running} running.`;
  const failedLabel = failedStep ? readTrimmedString(failedStep.title) || readTrimmedString(failedStep.id) : "None";

  return {
    available,
    focusStepId,
    title,
    summary,
    tone,
    badges: [
      `${counts.succeeded} succeeded`,
      `${counts.failed} failed`,
      `${counts.running} running`,
      focusStepId ? `focus ${focusStepId}` : "no focus",
    ],
    counts,
    restartPreview,
    tiles: [
      {
        id: "completed",
        title: "Completed",
        status: `${counts.succeeded} steps`,
        tone: counts.succeeded > 0 ? "success" : "neutral",
        summary: counts.succeeded > 0
          ? `${counts.succeeded} upstream or completed step${counts.succeeded === 1 ? "" : "s"} can provide context.`
          : "No completed steps are available in this run detail.",
        badges: [`${counts.succeeded} succeeded`, `${counts.skipped} skipped`],
      },
      {
        id: "failure",
        title: "Failure point",
        status: counts.failed > 0 ? failedLabel : focusStatus,
        tone: counts.failed > 0 ? "danger" : counts.running > 0 ? "info" : "success",
        summary: counts.failed > 0 ? focusSummary : `${focusTitle} is the current run focus.`,
        badges: [`${counts.failed} failed`, focusStepId ? focusStepId : "no focus"],
      },
      {
        id: "restart",
        title: "Restart plan",
        status: restartPreview.blocked ? "blocked" : `rerun ${restartPreview.rerunStepIds.length}`,
        tone: restartPreview.blocked ? "danger" : "warning",
        summary: restartPreview.summary,
        badges: restartPreview.badges,
      },
      {
        id: "evidence",
        title: "Evidence",
        status: `${counts.issues} issues`,
        tone: counts.workProducts > 0 ? "success" : counts.issues > 0 ? "info" : "neutral",
        summary: `${counts.issues} linked issue${counts.issues === 1 ? "" : "s"} and ${counts.workProducts} work product${counts.workProducts === 1 ? "" : "s"} are attached to this run.`,
        badges: [`${counts.issues} issues`, `${counts.workProducts} work products`],
      },
    ],
  };
}

export function buildWorkflowGraphModel<TStep extends WorkflowGraphStep>(
  steps: TStep[],
): WorkflowGraphModel<TStep> {
  const stepMap = buildStepMap(steps);
  const issuesById = new Map<string, WorkflowGraphIssue>();
  const layerMemo = new Map<string, number>();
  const visiting = new Set<string>();

  function addIssue(issue: WorkflowGraphIssue): void {
    if (!issuesById.has(issue.id)) issuesById.set(issue.id, issue);
  }

  const edges: WorkflowGraphEdge[] = [];
  for (const step of steps) {
    const target = step.id.trim();
    if (!target) {
      addIssue({
        id: `missing-step-id:${steps.indexOf(step)}`,
        severity: "error",
        code: "missing-step-id",
        message: "A step is missing an id.",
      });
      continue;
    }
    for (const source of parseDependencies(step.dependsOn)) {
      if (!stepMap.has(source)) {
        addIssue({
          id: `missing-dependency:${source}->${target}`,
          severity: "error",
          code: "missing-dependency",
          message: `Step "${target}" depends on missing step "${source}".`,
          stepId: target,
          sourceId: source,
          targetId: target,
        });
        continue;
      }
      edges.push({
        id: `${source}->${target}`,
        source,
        target,
        ...readGraphEdgeMetadata(step, source),
      });
    }
  }

  function computeLayer(stepId: string): number {
    const cached = layerMemo.get(stepId);
    if (cached !== undefined) return cached;
    if (visiting.has(stepId)) {
      addIssue({
        id: `cycle:${stepId}`,
        severity: "error",
        code: "cycle",
        message: `Cycle detected near step "${stepId}".`,
        stepId,
      });
      return 0;
    }
    visiting.add(stepId);
    const step = stepMap.get(stepId);
    const dependencies = step ? parseDependencies(step.dependsOn).filter((dependency) => stepMap.has(dependency)) : [];
    const layer = dependencies.length === 0
      ? 0
      : Math.max(...dependencies.map((dependency) => computeLayer(dependency))) + 1;
    visiting.delete(stepId);
    layerMemo.set(stepId, layer);
    return layer;
  }

  const layerCounts = new Map<number, number>();
  const nodes = steps.map((step, order) => {
    const id = step.id.trim();
    const layer = id ? computeLayer(id) : 0;
    const layerOrder = layerCounts.get(layer) ?? 0;
    layerCounts.set(layer, layerOrder + 1);
    const defaultX = 48 + layer * 230;
    const defaultY = 44 + layerOrder * 132;
    return {
      id,
      label: (typeof step.title === "string" && step.title.trim()) ? step.title.trim() : id || "Untitled step",
      kind: typeof step.type === "string" && step.type.trim() ? step.type.trim() : "agent",
      layer,
      order,
      x: readGraphPositionValue(step.graphPositionX) ?? defaultX,
      y: readGraphPositionValue(step.graphPositionY) ?? defaultY,
      step,
      runStatus: readStepRunStatus(step),
      advanced: readStepAdvanced(step),
      testing: readStepTesting(step),
      execution: readStepExecution(step),
      dataFlow: readStepDataFlow(step),
      resources: readStepResources(step),
    };
  });

  const incomingStepIds = new Set(edges.map((edge) => edge.target));
  const outgoingStepIds = new Set(edges.map((edge) => edge.source));
  const entryStepIds = nodes.map((node) => node.id).filter((id) => id && !incomingStepIds.has(id));
  const terminalStepIds = nodes.map((node) => node.id).filter((id) => id && !outgoingStepIds.has(id));
  const issues = Array.from(issuesById.values());
  const diagnostics: WorkflowGraphDiagnostics = {
    entryStepIds,
    terminalStepIds,
    issueCountBySeverity: {
      error: issues.filter((issue) => issue.severity === "error").length,
      warning: issues.filter((issue) => issue.severity === "warning").length,
      info: issues.filter((issue) => issue.severity === "info").length,
    },
    issues,
  };
  const warnings = diagnostics.issues.map((issue) => issue.message);

  const groupsById = new Map<string, Array<WorkflowGraphNode<TStep>>>();
  for (const node of nodes) {
    const groupId = typeof node.step.graphGroupId === "string" ? node.step.graphGroupId.trim() : "";
    if (!groupId) continue;
    const groupNodes = groupsById.get(groupId) ?? [];
    groupNodes.push(node);
    groupsById.set(groupId, groupNodes);
  }

  const groups = Array.from(groupsById.entries()).map(([id, groupNodes]) => {
    const firstStep = groupNodes[0]?.step;
    const minX = Math.min(...groupNodes.map((node) => node.x));
    const minY = Math.min(...groupNodes.map((node) => node.y));
    const maxX = Math.max(...groupNodes.map((node) => node.x + 172));
    const maxY = Math.max(...groupNodes.map((node) => node.y + 76));
    const title = typeof firstStep?.graphGroupTitle === "string" && firstStep.graphGroupTitle.trim()
      ? firstStep.graphGroupTitle.trim()
      : id;
    const color = typeof firstStep?.graphGroupColor === "string" && firstStep.graphGroupColor.trim()
      ? firstStep.graphGroupColor.trim()
      : "#64748b";
    const collapsedByDefault = groupNodes.some((node) => readBooleanSetting(node.step.graphGroupCollapsedByDefault) === true);
    const collapsedOverride = groupNodes
      .map((node) => readBooleanSetting(node.step.graphGroupCollapsed))
      .find((value): value is boolean => value !== undefined);
    const collapsed = collapsedOverride ?? collapsedByDefault;
    return {
      id,
      title,
      color,
      collapsed,
      collapsedByDefault,
      stepIds: groupNodes.map((node) => node.id),
      x: minX - 18,
      y: minY - 32,
      width: maxX - minX + 36,
      height: maxY - minY + 54,
    };
  });

  const containersById = new Map<string, Array<WorkflowGraphNode<TStep>>>();
  for (const node of nodes) {
    const containerId = typeof node.step.graphContainerId === "string" ? node.step.graphContainerId.trim() : "";
    if (!containerId) continue;
    const containerNodes = containersById.get(containerId) ?? [];
    containerNodes.push(node);
    containersById.set(containerId, containerNodes);
  }

  const containers = Array.from(containersById.entries()).map(([id, containerNodes]) => {
    const firstStep = containerNodes[0]?.step;
    const rawType = typeof firstStep?.graphContainerType === "string" ? firstStep.graphContainerType.trim() : "";
    const type: WorkflowGraphContainerType = rawType === "loop" ? "loop" : "branch";
    const minX = Math.min(...containerNodes.map((node) => node.x));
    const minY = Math.min(...containerNodes.map((node) => node.y));
    const maxX = Math.max(...containerNodes.map((node) => node.x + 172));
    const maxY = Math.max(...containerNodes.map((node) => node.y + 76));
    const title = typeof firstStep?.graphContainerTitle === "string" && firstStep.graphContainerTitle.trim()
      ? firstStep.graphContainerTitle.trim()
      : id;
    const description = typeof firstStep?.graphContainerDescription === "string"
      ? firstStep.graphContainerDescription.trim()
      : "";
    const mode = normalizeGraphContainerMode(type, firstStep?.graphContainerMode);
    const condition = typeof firstStep?.graphContainerCondition === "string"
      ? firstStep.graphContainerCondition.trim()
      : "";
    const iterator = typeof firstStep?.graphContainerIterator === "string"
      ? firstStep.graphContainerIterator.trim()
      : "";
    const skipFailure = readBooleanSetting(firstStep?.graphContainerSkipFailure) === true;
    const runInParallel = readBooleanSetting(firstStep?.graphContainerRunInParallel) === true;
    const parallelism = readPositiveInteger(firstStep?.graphContainerParallelism);
    return {
      id,
      type,
      title,
      description,
      mode,
      condition,
      iterator,
      skipFailure,
      runInParallel,
      parallelism,
      badges: buildContainerBadges({
        type,
        mode,
        condition,
        iterator,
        skipFailure,
        runInParallel,
        parallelism,
      }),
      stepIds: containerNodes.map((node) => node.id),
      x: minX - 32,
      y: minY - 54,
      width: maxX - minX + 64,
      height: maxY - minY + 86,
    };
  });

  const collapsedGroupByStepId = new Map<string, WorkflowGraphGroup>();
  for (const group of groups) {
    if (!group.collapsed) continue;
    for (const stepId of group.stepIds) collapsedGroupByStepId.set(stepId, group);
  }

  if (collapsedGroupByStepId.size === 0) {
    return { nodes, edges, groups, containers, warnings: Array.from(new Set(warnings)), diagnostics };
  }

  const visibleNodes: Array<WorkflowGraphNode<TStep>> = [];
  const emittedCollapsedGroups = new Set<string>();
  for (const node of nodes) {
    const collapsedGroup = collapsedGroupByStepId.get(node.id);
    if (!collapsedGroup) {
      visibleNodes.push(node);
      continue;
    }
    if (emittedCollapsedGroups.has(collapsedGroup.id)) continue;
    emittedCollapsedGroups.add(collapsedGroup.id);
    visibleNodes.push({
      id: `group:${collapsedGroup.id}`,
      label: collapsedGroup.title,
      kind: "group",
      layer: node.layer,
      order: node.order,
      x: collapsedGroup.x + 18,
      y: collapsedGroup.y + 32,
      step: node.step,
      runStatus: readStepRunStatus(node.step),
      advanced: readStepAdvanced(node.step),
      testing: readStepTesting(node.step),
      execution: readStepExecution(node.step),
      dataFlow: readStepDataFlow(node.step),
      resources: readStepResources(node.step),
    });
  }

  const visibleEdgesById = new Map<string, WorkflowGraphEdge>();
  for (const edge of edges) {
    const sourceGroup = collapsedGroupByStepId.get(edge.source);
    const targetGroup = collapsedGroupByStepId.get(edge.target);
    const source = sourceGroup ? `group:${sourceGroup.id}` : edge.source;
    const target = targetGroup ? `group:${targetGroup.id}` : edge.target;
    if (source === target) continue;
    const id = `${source}->${target}`;
    if (visibleEdgesById.has(id)) continue;
    visibleEdgesById.set(id, { ...edge, id, source, target });
  }

  return {
    nodes: visibleNodes,
    edges: Array.from(visibleEdgesById.values()),
    groups,
    containers,
    warnings: Array.from(new Set(warnings)),
    diagnostics,
  };
}

export function buildWorkflowGraphRepairPlan<TStep extends WorkflowGraphStep>(
  steps: TStep[],
): WorkflowGraphRepairPlan {
  const graph = buildWorkflowGraphModel(steps);
  const items = graph.diagnostics.issues.map((issue): WorkflowGraphRepairItem => {
    if (issue.code === "missing-dependency") {
      const source = issue.sourceId ?? "";
      const target = issue.targetId ?? issue.stepId ?? "";
      return {
        id: issue.id,
        severity: issue.severity,
        issueCode: issue.code,
        action: "connect-or-remove-dependency",
        title: "Resolve missing upstream",
        description: source && target
          ? `Step "${target}" references missing upstream "${source}". Connect it to an existing step or remove that dependency.`
          : issue.message,
        focusStepId: target,
        sourceStepId: source,
        targetStepId: target,
        badges: ["Missing upstream", "Blocks run"],
      };
    }
    if (issue.code === "missing-step-id") {
      return {
        id: issue.id,
        severity: issue.severity,
        issueCode: issue.code,
        action: "assign-step-id",
        title: "Assign step id",
        description: "One graph node has no step id. Give it a stable id before it can be connected or executed.",
        focusStepId: issue.stepId ?? "",
        badges: ["Invalid step", "Blocks run"],
      };
    }
    if (issue.code === "cycle") {
      const target = issue.stepId ?? issue.targetId ?? "";
      return {
        id: issue.id,
        severity: issue.severity,
        issueCode: issue.code,
        action: "disconnect-cycle-edge",
        title: "Break dependency cycle",
        description: target
          ? `Step "${target}" is part of a dependency cycle. Disconnect one cyclic edge before running this workflow.`
          : issue.message,
        focusStepId: target,
        targetStepId: target,
        badges: ["Cycle", "Blocks run"],
      };
    }
    const focus = issue.stepId ?? issue.targetId ?? "";
    return {
      id: issue.id,
      severity: issue.severity,
      issueCode: issue.code,
      action: "inspect-diagnostic",
      title: "Inspect diagnostic",
      description: issue.message,
      focusStepId: focus,
      sourceStepId: issue.sourceId,
      targetStepId: issue.targetId,
      badges: [issue.severity === "error" ? "Blocks run" : issue.severity],
    };
  });

  const blockingCount = items.filter((item) => item.severity === "error").length;
  if (items.length === 0) {
    return {
      items: [],
      badges: ["No repairs"],
      blocked: false,
      summary: "No graph repairs are needed before running this workflow.",
    };
  }

  const badges = [`${items.length} repair${items.length === 1 ? "" : "s"}`];
  if (blockingCount > 0) badges.push(`${blockingCount} blocking`);
  return {
    items,
    badges,
    blocked: blockingCount > 0,
    summary: `${items.length} graph repair${items.length === 1 ? "" : "s"} needed before this workflow can run; ${blockingCount} block execution.`,
  };
}

function stableDraftValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableDraftValue);
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableDraftValue(entry)]),
  );
}

function stableDraftString(value: unknown): string {
  return JSON.stringify(stableDraftValue(value));
}

function normalizeStepForDraftDiff(step: WorkflowGraphStep): Record<string, unknown> {
  const cleared = clearGraphRunOverlay(step);
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cleared).sort(([left], [right]) => left.localeCompare(right))) {
    if (key.startsWith("graphRun")) continue;
    if (key === "dependsOn") {
      normalized[key] = parseDependencies(value).sort();
      continue;
    }
    normalized[key] = stableDraftValue(value);
  }
  return normalized;
}

function diffStepFields(before: WorkflowGraphStep, after: WorkflowGraphStep): string[] {
  const beforeStep = normalizeStepForDraftDiff(before);
  const afterStep = normalizeStepForDraftDiff(after);
  const fields = new Set([...Object.keys(beforeStep), ...Object.keys(afterStep)]);
  return Array.from(fields)
    .sort((left, right) => left.localeCompare(right))
    .filter((field) => stableDraftString(beforeStep[field]) !== stableDraftString(afterStep[field]));
}

function edgeDraftSignature(edge: WorkflowGraphEdge): string {
  return stableDraftString({
    kind: edge.kind,
    label: edge.label,
    condition: edge.condition,
  });
}

function pluralizeDiff(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function summarizeWorkflowGraphDraftDiff(
  savedSteps: WorkflowGraphStep[],
  draftSteps: WorkflowGraphStep[],
): WorkflowGraphDraftDiff {
  const savedById = buildStepMap(savedSteps);
  const draftById = buildStepMap(draftSteps);
  const addedSteps = draftSteps.map((step) => step.id.trim()).filter((id) => id && !savedById.has(id));
  const removedSteps = savedSteps.map((step) => step.id.trim()).filter((id) => id && !draftById.has(id));
  const changedSteps = draftSteps.flatMap((step) => {
    const id = step.id.trim();
    if (!id || !savedById.has(id)) return [];
    const fields = diffStepFields(savedById.get(id)!, step);
    return fields.length > 0 ? [{ id, fields }] : [];
  });

  const savedEdges = buildWorkflowGraphModel(savedSteps).edges;
  const draftEdges = buildWorkflowGraphModel(draftSteps).edges;
  const savedEdgeById = new Map(savedEdges.map((edge) => [edge.id, edge]));
  const draftEdgeById = new Map(draftEdges.map((edge) => [edge.id, edge]));
  const addedEdges = draftEdges.map((edge) => edge.id).filter((id) => !savedEdgeById.has(id));
  const removedEdges = savedEdges.map((edge) => edge.id).filter((id) => !draftEdgeById.has(id));
  const changedEdges = draftEdges
    .filter((edge) => savedEdgeById.has(edge.id) && edgeDraftSignature(savedEdgeById.get(edge.id)!) !== edgeDraftSignature(edge))
    .map((edge) => edge.id);

  const summary: string[] = [];
  if (addedSteps.length > 0) summary.push(`${pluralizeDiff(addedSteps.length, "added step")}`);
  if (removedSteps.length > 0) summary.push(`${pluralizeDiff(removedSteps.length, "removed step")}`);
  if (changedSteps.length > 0) summary.push(`${pluralizeDiff(changedSteps.length, "changed step")}`);
  if (addedEdges.length > 0) summary.push(`${pluralizeDiff(addedEdges.length, "added edge")}`);
  if (removedEdges.length > 0) summary.push(`${pluralizeDiff(removedEdges.length, "removed edge")}`);
  if (changedEdges.length > 0) summary.push(`${pluralizeDiff(changedEdges.length, "changed edge")}`);

  const hasChanges = addedSteps.length > 0
    || removedSteps.length > 0
    || changedSteps.length > 0
    || addedEdges.length > 0
    || removedEdges.length > 0
    || changedEdges.length > 0;

  return {
    hasChanges,
    addedSteps,
    removedSteps,
    changedSteps,
    addedEdges,
    removedEdges,
    changedEdges,
    summary: hasChanges ? summary : ["No draft changes"],
  };
}

function statusBucket(status: unknown): "running" | "succeeded" | "failed" | "cancelled" | "other" {
  const normalized = readTrimmedString(status).toLowerCase();
  if (normalized === "running" || normalized === "queued" || normalized === "in_progress") return "running";
  if (normalized === "succeeded" || normalized === "completed" || normalized === "done" || normalized === "success") return "succeeded";
  if (normalized === "failed" || normalized === "error" || normalized === "timed_out") return "failed";
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "aborted") return "cancelled";
  return "other";
}

function countRunsByBucket(runs: WorkflowGraphManagementRunInput[]): Record<ReturnType<typeof statusBucket>, number> {
  return runs.reduce<Record<ReturnType<typeof statusBucket>, number>>((counts, run) => {
    counts[statusBucket(run.status)] += 1;
    return counts;
  }, { running: 0, succeeded: 0, failed: 0, cancelled: 0, other: 0 });
}

function scopedManagementRuns(
  runs: WorkflowGraphManagementRunInput[] | undefined,
  workflowId: string,
): WorkflowGraphManagementRunInput[] {
  const list = Array.isArray(runs) ? runs : [];
  const id = workflowId.trim();
  if (!id) return list;
  return list.filter((run) => !run.workflowId || run.workflowId === id);
}

export function buildWorkflowGraphManagementSummary<TStep extends WorkflowGraphStep>(
  input: WorkflowGraphManagementSummaryInput<TStep>,
): WorkflowGraphManagementSummary {
  const savedSteps = Array.isArray(input.savedSteps) ? input.savedSteps : [];
  const draftSteps = Array.isArray(input.draftSteps) ? input.draftSteps : [];
  const draftDiff = savedSteps.length > 0
    ? summarizeWorkflowGraphDraftDiff(savedSteps, draftSteps)
    : summarizeWorkflowGraphDraftDiff(draftSteps, draftSteps);
  const targetStepId = readTrimmedString(input.selectedStepId) || draftSteps[0]?.id || "";
  const testPlan = buildWorkflowGraphTestPlan(draftSteps, targetStepId);
  const testLibrary = summarizeWorkflowGraphTestInputLibrary(input.interfaceInput ?? {});
  const activeRuns = scopedManagementRuns(input.activeRuns, readTrimmedString(input.workflowId));
  const recentRuns = scopedManagementRuns(input.recentRuns, readTrimmedString(input.workflowId));
  const activeBuckets = countRunsByBucket(activeRuns);
  const recentBuckets = countRunsByBucket(recentRuns);
  const latestRecentRun = recentRuns[0];
  const latestRecentBucket = latestRecentRun ? statusBucket(latestRecentRun.status) : "other";
  const draftChangeCount = draftDiff.addedSteps.length
    + draftDiff.removedSteps.length
    + draftDiff.changedSteps.length
    + draftDiff.addedEdges.length
    + draftDiff.removedEdges.length
    + draftDiff.changedEdges.length;

  const draftTile: WorkflowGraphManagementTile = {
    id: "draft",
    title: "Draft",
    status: draftDiff.hasChanges ? "changed" : "clean",
    tone: draftDiff.hasChanges ? "warning" : "success",
    summary: draftDiff.hasChanges
      ? `${draftChangeCount} draft change${draftChangeCount === 1 ? "" : "s"} waiting to be saved.`
      : "Draft matches the saved workflow definition.",
    badges: draftDiff.hasChanges ? draftDiff.summary : ["No draft changes"],
    actionLabel: draftDiff.hasChanges ? "Review diff" : "No diff",
  };

  const testTile: WorkflowGraphManagementTile = {
    id: "test",
    title: "Test",
    status: testPlan.blocked ? "blocked" : "ready",
    tone: testPlan.blocked ? "danger" : "info",
    summary: testPlan.summary,
    badges: [...testPlan.badges, ...testLibrary.badges].slice(0, 5),
    actionLabel: "Preview test",
  };

  const runsTile: WorkflowGraphManagementTile = {
    id: "runs",
    title: "Runs",
    status: activeRuns.length > 0 ? `${activeRuns.length} active` : "idle",
    tone: activeBuckets.failed > 0 ? "danger" : activeRuns.length > 0 ? "success" : "neutral",
    summary: activeRuns.length > 0
      ? `${activeRuns.length} active run${activeRuns.length === 1 ? "" : "s"} for this workflow.`
      : "No active runs for this workflow.",
    badges: [
      `${activeBuckets.running} running`,
      `${activeBuckets.failed} failed`,
      `${activeBuckets.other} other`,
    ],
    actionLabel: activeRuns.length > 0 ? "View active" : "Run workflow",
  };

  const historyTile: WorkflowGraphManagementTile = {
    id: "history",
    title: "History",
    status: recentRuns.length > 0 ? `${recentRuns.length} recent` : "empty",
    tone: latestRecentBucket === "failed" ? "danger" : recentRuns.length > 0 ? "info" : "neutral",
    summary: latestRecentRun
      ? `Latest recent run is ${readTrimmedString(latestRecentRun.status) || "unknown"}.`
      : "No recent run history for this workflow.",
    badges: [
      `${recentBuckets.succeeded} succeeded`,
      `${recentBuckets.failed} failed`,
      `${recentBuckets.cancelled} cancelled`,
    ],
    actionLabel: recentRuns.length > 0 ? "View history" : "No history",
  };

  return {
    tiles: [draftTile, testTile, runsTile, historyTile],
    badges: [
      draftDiff.hasChanges ? `${draftChangeCount} changes` : "clean draft",
      testPlan.blocked ? "test blocked" : "test ready",
      `${activeRuns.length} active runs`,
      `${recentRuns.length} recent runs`,
    ],
    hasBlockingIssue: testPlan.blocked || activeBuckets.failed > 0 || latestRecentBucket === "failed",
  };
}

export function buildWorkflowGraphReleaseReview<TStep extends WorkflowGraphStep>(
  input: WorkflowGraphReleaseReviewInput<TStep>,
): WorkflowGraphReleaseReviewSummary {
  const savedSteps = Array.isArray(input.savedSteps) ? input.savedSteps : [];
  const draftSteps = Array.isArray(input.draftSteps) ? input.draftSteps : [];
  const draftDiff = savedSteps.length > 0
    ? summarizeWorkflowGraphDraftDiff(savedSteps, draftSteps)
    : summarizeWorkflowGraphDraftDiff(draftSteps, draftSteps);
  const targetStepId = readTrimmedString(input.selectedStepId) || draftSteps[0]?.id || "";
  const testPlan = buildWorkflowGraphTestPlan(draftSteps, targetStepId);
  const activeRuns = scopedManagementRuns(input.activeRuns, readTrimmedString(input.workflowId));
  const recentRuns = scopedManagementRuns(input.recentRuns, readTrimmedString(input.workflowId));
  const activeBuckets = countRunsByBucket(activeRuns);
  const recentBuckets = countRunsByBucket(recentRuns);
  const latestRecentRun = recentRuns[0];
  const latestRecentBucket = latestRecentRun ? statusBucket(latestRecentRun.status) : "other";
  const draftChangeCount = draftDiff.addedSteps.length
    + draftDiff.removedSteps.length
    + draftDiff.changedSteps.length
    + draftDiff.addedEdges.length
    + draftDiff.removedEdges.length
    + draftDiff.changedEdges.length;
  const runHistoryRisk = activeBuckets.failed > 0 || latestRecentBucket === "failed" || recentBuckets.failed > 0;
  const blocked = testPlan.blocked;
  const decision: WorkflowGraphReleaseReviewSummary["decision"] = blocked
    ? "blocked"
    : draftDiff.hasChanges
      ? runHistoryRisk ? "risky-history" : "ready-to-save"
      : runHistoryRisk ? "risky-history" : "synced";
  const tone: WorkflowGraphReleaseReviewTone = decision === "blocked"
    ? "danger"
    : decision === "risky-history"
      ? "warning"
      : decision === "ready-to-save"
        ? "info"
        : "success";
  const title = decision === "blocked"
    ? "Release blocked"
    : decision === "ready-to-save"
      ? "Ready to save"
      : decision === "risky-history"
        ? "Review run history"
        : "Saved definition synced";
  const summary = decision === "blocked"
    ? "Resolve graph test blockers before saving this workflow definition."
    : decision === "ready-to-save"
      ? `${draftChangeCount} staged change${draftChangeCount === 1 ? "" : "s"} can update the saved runnable baseline.`
      : decision === "risky-history"
        ? "Recent failures exist; inspect run history before relying on the saved workflow."
        : "The graph matches the saved workflow definition.";
  const primaryAction = decision === "blocked"
    ? "Fix graph"
    : decision === "ready-to-save"
      ? "Save changes"
      : decision === "risky-history"
        ? "Inspect history"
        : "Run workflow";

  const localStage: WorkflowGraphReleaseReviewStage = {
    id: "local-edit",
    title: "Local edit",
    status: draftDiff.hasChanges ? "changed" : "clean",
    tone: draftDiff.hasChanges ? "warning" : "success",
    summary: draftDiff.hasChanges
      ? `${draftChangeCount} graph change${draftChangeCount === 1 ? "" : "s"} staged locally.`
      : "Local graph matches the saved baseline.",
    badges: draftDiff.hasChanges ? draftDiff.summary.slice(0, 4) : ["No local changes"],
  };

  const testStage: WorkflowGraphReleaseReviewStage = {
    id: "test-gate",
    title: "Test gate",
    status: testPlan.blocked ? "blocked" : "ready",
    tone: testPlan.blocked ? "danger" : "info",
    summary: testPlan.summary,
    badges: testPlan.badges.slice(0, 4),
  };

  const savedStage: WorkflowGraphReleaseReviewStage = {
    id: "saved-definition",
    title: "Saved definition",
    status: blocked ? "blocked" : draftDiff.hasChanges ? "pending save" : "synced",
    tone: blocked ? "danger" : draftDiff.hasChanges ? "warning" : "success",
    summary: blocked
      ? "Saved runnable baseline should not be updated until blockers are resolved."
      : draftDiff.hasChanges
        ? "Saving will update the workflow used by manual, schedule, label, and API runs."
        : "Manual, schedule, label, and API runs use this saved definition.",
    badges: [
      draftDiff.hasChanges ? `${draftChangeCount} staged` : "baseline current",
      savedSteps.length > 0 ? `${savedSteps.length} saved steps` : "new baseline",
    ],
  };

  const historyStage: WorkflowGraphReleaseReviewStage = {
    id: "run-history",
    title: "Run history",
    status: activeRuns.length > 0 ? `${activeRuns.length} active` : recentRuns.length > 0 ? `${recentRuns.length} recent` : "empty",
    tone: runHistoryRisk ? "danger" : activeRuns.length > 0 ? "success" : recentRuns.length > 0 ? "info" : "neutral",
    summary: runHistoryRisk
      ? `${recentBuckets.failed + activeBuckets.failed} failed run${recentBuckets.failed + activeBuckets.failed === 1 ? "" : "s"} need review.`
      : activeRuns.length > 0
        ? `${activeRuns.length} run${activeRuns.length === 1 ? "" : "s"} currently active for this workflow.`
        : recentRuns.length > 0
          ? `Latest recent run is ${readTrimmedString(latestRecentRun?.status) || "unknown"}.`
          : "No run history for this workflow yet.",
    badges: [
      `${activeRuns.length} active`,
      `${recentBuckets.succeeded} succeeded`,
      `${recentBuckets.failed + activeBuckets.failed} failed`,
    ],
  };

  return {
    decision,
    title,
    summary,
    tone,
    primaryAction,
    badges: [
      draftDiff.hasChanges ? `${draftChangeCount} changes` : "clean draft",
      testPlan.blocked ? "test blocked" : "test ready",
      `${activeRuns.length} active runs`,
      `${recentRuns.length} recent runs`,
    ],
    stages: [localStage, testStage, savedStage, historyStage],
    hasBlockingIssue: blocked,
  };
}

export function buildWorkflowGraphDefinitionNavigator<TStep extends WorkflowGraphStep>(
  input: WorkflowGraphDefinitionNavigatorInput<TStep>,
): WorkflowGraphDefinitionNavigatorSummary {
  const workflows = Array.isArray(input.workflows) ? input.workflows : [];
  const search = readTrimmedString(input.search).toLowerCase();
  const filter = input.filter ?? "all";
  const activeRuns = Array.isArray(input.activeRuns) ? input.activeRuns : [];
  const recentRuns = Array.isArray(input.recentRuns) ? input.recentRuns : [];

  const items = workflows.map<WorkflowGraphDefinitionNavigatorItem>((workflow, index) => {
    const id = readTrimmedString(workflow.id) || `workflow-${index + 1}`;
    const name = readTrimmedString(workflow.name) || "Untitled workflow";
    const description = readTrimmedString(workflow.description);
    const status = readTrimmedString(workflow.status) || "active";
    const normalizedStatus = status.toLowerCase();
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    const trigger = summarizeWorkflowGraphTriggers({
      schedule: workflow.schedule,
      timezone: workflow.timezone,
      triggerLabels: workflow.triggerLabels,
      lastScheduledRunAt: workflow.lastScheduledRunAt,
      lastScheduleError: workflow.lastScheduleError,
      lastScheduleErrorAt: workflow.lastScheduleErrorAt,
    });
    const scopedActiveRuns = scopedManagementRuns(activeRuns, id);
    const scopedRecentRuns = scopedManagementRuns(recentRuns, id);
    const activeBuckets = countRunsByBucket(scopedActiveRuns);
    const recentBuckets = countRunsByBucket(scopedRecentRuns);
    const failedRunCount = activeBuckets.failed + recentBuckets.failed;
    const hasStatusProblem = normalizedStatus === "failed" || normalizedStatus === "error" || normalizedStatus === "blocked";
    const hasProblem = hasStatusProblem || Boolean(trigger.schedule.error) || failedRunCount > 0;
    const isScheduled = trigger.enabled;
    const isArchived = normalizedStatus === "archived";
    const badges = [
      isScheduled ? trigger.badges[0] ?? "Scheduled" : "Manual",
      trigger.schedule.timezone || "",
      `${steps.length} step${steps.length === 1 ? "" : "s"}`,
      scopedActiveRuns.length > 0 ? `${scopedActiveRuns.length} active` : "",
      failedRunCount > 0 ? `${failedRunCount} failed` : "",
    ].filter(Boolean);
    const miniSteps = steps.slice(0, 4).map((step) => ({
      id: readTrimmedString(step.id),
      title: readTrimmedString(step.title) || readTrimmedString(step.id) || "Step",
      type: readTrimmedString(step.type) || "agent",
    }));
    const matchText = [
      id,
      name,
      description,
      status,
      workflow.schedule,
      workflow.timezone,
      workflow.createParentIssuePolicy,
      ...trigger.labels,
      ...steps.flatMap((step) => [step.id, step.title, step.type]),
    ].map((part) => readTrimmedString(part).toLowerCase()).filter(Boolean).join(" ");

    return {
      id,
      name,
      description,
      status,
      stepCount: steps.length,
      miniSteps,
      trigger,
      activeRunCount: scopedActiveRuns.length,
      recentRunCount: scopedRecentRuns.length,
      failedRunCount,
      hasProblem,
      isScheduled,
      isArchived,
      badges,
      matchText,
    };
  });

  const matchesSearch = (item: WorkflowGraphDefinitionNavigatorItem): boolean => {
    if (!search) return true;
    return item.matchText.includes(search);
  };
  const matchesFilter = (item: WorkflowGraphDefinitionNavigatorItem): boolean => {
    if (filter === "active") return item.status.trim().toLowerCase() === "active";
    if (filter === "scheduled") return item.isScheduled;
    if (filter === "problems") return item.hasProblem;
    if (filter === "archived") return item.isArchived;
    return !item.isArchived;
  };
  const visibleItems = items.filter((item) => matchesSearch(item) && matchesFilter(item));
  const activeCount = items.filter((item) => item.status.trim().toLowerCase() === "active").length;
  const scheduledCount = items.filter((item) => item.isScheduled).length;
  const needsReviewCount = items.filter((item) => item.hasProblem).length;
  const pausedCount = items.filter((item) => item.status.trim().toLowerCase() === "paused").length;
  const archivedCount = items.filter((item) => item.isArchived).length;
  const activeRunCount = items.reduce((sum, item) => sum + item.activeRunCount, 0);

  return {
    items,
    visibleItems,
    stats: {
      total: items.length,
      visible: visibleItems.length,
      active: activeCount,
      scheduled: scheduledCount,
      activeRuns: activeRunCount,
      needsReview: needsReviewCount,
      paused: pausedCount,
      archived: archivedCount,
    },
    filters: [
      { id: "all", label: "All", count: items.filter((item) => !item.isArchived).length },
      { id: "active", label: "Active", count: activeCount },
      { id: "scheduled", label: "Scheduled", count: scheduledCount },
      { id: "problems", label: "Issues", count: needsReviewCount },
      { id: "archived", label: "Archived", count: archivedCount },
    ],
    badges: [
      `${scheduledCount} scheduled`,
      `${activeRunCount} active run${activeRunCount === 1 ? "" : "s"}`,
      `${needsReviewCount} need review`,
    ],
  };
}

function addSearchField(fields: Map<string, string[]>, field: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) addSearchField(fields, field, entry);
    return;
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return;
  const entries = fields.get(field) ?? [];
  entries.push(text);
  fields.set(field, entries);
}

export function searchWorkflowGraphNodes<TStep extends WorkflowGraphStep>(
  graph: WorkflowGraphModel<TStep>,
  query: string,
): WorkflowGraphSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const groupsByStepId = new Map<string, WorkflowGraphGroup[]>();
  for (const group of graph.groups) {
    for (const stepId of group.stepIds) {
      const groups = groupsByStepId.get(stepId) ?? [];
      groups.push(group);
      groupsByStepId.set(stepId, groups);
    }
  }

  const containersByStepId = new Map<string, WorkflowGraphContainer[]>();
  for (const container of graph.containers) {
    for (const stepId of container.stepIds) {
      const containers = containersByStepId.get(stepId) ?? [];
      containers.push(container);
      containersByStepId.set(stepId, containers);
    }
  }

  return graph.nodes.flatMap((node) => {
    const fields = new Map<string, string[]>();
    addSearchField(fields, "id", node.id);
    addSearchField(fields, "id", node.step.id);
    addSearchField(fields, "title", node.label);
    addSearchField(fields, "type", node.kind);
    addSearchField(fields, "note", node.step.graphNote);
    addSearchField(fields, "policy", [
      node.advanced.badges,
      node.advanced.earlyStopCondition,
      node.advanced.suspendUntil,
      node.advanced.suspendTimeoutAction,
      node.advanced.earlyReturnContentType,
      node.advanced.earlyReturnSchema,
      node.advanced.errorHandlerScope,
      node.advanced.errorHandlerInput,
      node.advanced.restartStrategy,
      node.advanced.restartInput,
    ]);
    addSearchField(fields, "approval", [
      node.advanced.approval.prompt,
      node.advanced.approval.recipients,
      node.advanced.approval.timeoutAction,
      node.advanced.approval.badges,
    ]);
    addSearchField(fields, "testing", [
      node.testing.mockResult,
      node.testing.pinnedResultRunId,
      node.testing.badges,
    ]);
    addSearchField(fields, "execution", [
      node.execution.concurrencyKey,
      node.execution.priority,
      node.execution.badges,
    ]);
    addSearchField(fields, "data", [
      node.dataFlow.inputExpression,
      node.dataFlow.outputSchema,
      node.dataFlow.workProductPattern,
      node.dataFlow.badges,
    ]);
    addSearchField(fields, "resources", [
      node.resources.resourceRefs,
      node.resources.secretRefs,
      node.resources.badges,
    ]);
    addSearchField(fields, "status", node.runStatus.status);
    addSearchField(fields, "issue", node.runStatus.issueIdentifier);
    addSearchField(fields, "run", node.runStatus.summary);
    addSearchField(fields, "run", node.runStatus.resultPreview);
    addSearchField(fields, "run", node.runStatus.logPreview);
    addSearchField(fields, "runtime", [
      node.runStatus.runtimeBadges,
      node.runStatus.concurrencyBlocked
        ? [
          node.runStatus.concurrencyBlocked.concurrencyKey,
          String(node.runStatus.concurrencyBlocked.concurrencyLimit ?? ""),
          String(node.runStatus.concurrencyBlocked.runningCount ?? ""),
          node.runStatus.concurrencyBlocked.checkedAt,
        ]
        : [],
      node.runStatus.retentionDeleted
        ? [
          "delete after use",
          node.runStatus.retentionDeleted.toolName,
          String(node.runStatus.retentionDeleted.success ?? ""),
          String(node.runStatus.retentionDeleted.exitCode ?? ""),
          node.runStatus.retentionDeleted.deletedAt,
        ]
        : [],
    ]);

    for (const group of groupsByStepId.get(node.step.id) ?? []) {
      addSearchField(fields, "group", [group.id, group.title]);
    }

    for (const container of containersByStepId.get(node.step.id) ?? []) {
      addSearchField(fields, "container", [
        container.id,
        container.type,
        container.title,
        container.description,
        container.mode,
        container.condition,
        container.iterator,
        container.badges,
      ]);
    }

    const matchedFields: string[] = [];
    const matchedText: string[] = [];
    for (const [field, values] of fields.entries()) {
      const matches = values.filter((value) => value.toLowerCase().includes(normalizedQuery));
      if (matches.length === 0) continue;
      matchedFields.push(field);
      matchedText.push(...matches);
    }
    if (matchedFields.length === 0) return [];

    return [{
      nodeId: node.id,
      stepId: node.step.id,
      label: node.label,
      kind: node.kind,
      matchFields: matchedFields,
      matchText: Array.from(new Set(matchedText)).join(" · "),
    }];
  });
}

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
    const retryDelaySeconds = hasRetryDelaySeconds && patch.retryDelaySeconds !== undefined && Number.isFinite(patch.retryDelaySeconds) && patch.retryDelaySeconds > 0
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

export function setStepGraphRunStatus<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: { status?: string; issueIdentifier?: string; updatedAt?: string; summary?: string },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    return {
      ...step,
      ...(patch.status !== undefined ? { graphRunStatus: normalizeGraphRunStatus(patch.status) } : {}),
      ...(patch.issueIdentifier !== undefined ? { graphRunIssueIdentifier: patch.issueIdentifier.trim() } : {}),
      ...(patch.updatedAt !== undefined ? { graphRunUpdatedAt: patch.updatedAt.trim() } : {}),
      ...(patch.summary !== undefined ? { graphRunSummary: patch.summary.trim() } : {}),
    };
  });
  return changed ? next : steps;
}

export function applyStepRunsToGraphSteps<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepRuns: WorkflowGraphStepRunInput[],
): TStep[] {
  const runByStepId = new Map<string, WorkflowGraphStepRunInput>();
  for (const run of stepRuns) {
    const stepId = typeof run.stepId === "string" ? run.stepId.trim() : "";
    if (stepId) runByStepId.set(stepId, run);
  }

  return steps.map((step) => {
    const run = runByStepId.get(step.id.trim());
    if (!run) {
      return {
        ...step,
        graphRunStatus: step.graphRunStatus ?? "planned",
      };
    }
    const updatedAt = run.completedAt?.trim()
      || run.startedAt?.trim()
      || run.lastDispatchAcceptedAt?.trim()
      || run.lastDispatchAttemptAt?.trim()
      || run.lastDispatchErrorAt?.trim()
      || "";
    const summary = run.lastDispatchErrorSummary?.trim()
      || (typeof run.agentName === "string" ? run.agentName.trim() : "")
      || "";
    const metadata = readRecord(run.metadata);
    const resultPreview = readString(metadata?.resultPreview);
    const logPreview = readString(metadata?.logPreview);
    return {
      ...step,
      graphRunStatus: normalizeGraphRunStatus(run.status),
      graphRunStepRunId: run.id?.trim() || "",
      graphRunIssueId: run.issueId?.trim() || "",
      graphRunIssueIdentifier: run.issueIdentifier?.trim() || run.issueId?.trim() || "",
      graphRunUpdatedAt: updatedAt,
      graphRunSummary: summary,
      graphRunStartedAt: run.startedAt?.trim() || "",
      graphRunCompletedAt: run.completedAt?.trim() || "",
      graphRunLastDispatchAttemptAt: run.lastDispatchAttemptAt?.trim() || "",
      graphRunLastDispatchAcceptedAt: run.lastDispatchAcceptedAt?.trim() || "",
      graphRunLastDispatchErrorAt: run.lastDispatchErrorAt?.trim() || "",
      graphRunLastDispatchErrorSummary: run.lastDispatchErrorSummary?.trim() || "",
      graphRunLastDispatchRequestId: run.lastDispatchRequestId?.trim() || "",
      graphRunResultPreview: resultPreview,
      graphRunLogPreview: logPreview,
      graphRunWorkProducts: normalizeWorkProducts(run.workProducts),
      graphRunConcurrencyBlocked: readRecord(metadata?.concurrencyBlocked) ?? undefined,
      graphRunRetentionDeleted: readRecord(metadata?.retentionDeleted) ?? undefined,
    };
  });
}

export function connectSteps<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  sourceId: string,
  targetId: string,
): TStep[] {
  const source = sourceId.trim();
  const target = targetId.trim();
  if (!source || !target) return steps;
  if (source === target) {
    throw new Error("A workflow step cannot depend on itself.");
  }
  const stepMap = buildStepMap(steps);
  if (!stepMap.has(source) || !stepMap.has(target)) {
    throw new Error("Both workflow steps must exist before connecting them.");
  }
  if (hasPath(steps, target, source)) {
    throw new Error(`Connecting "${source}" to "${target}" would create a cycle.`);
  }

  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== target) return step;
    const dependencies = parseDependencies(step.dependsOn);
    if (dependencies.includes(source)) return step;
    changed = true;
    return { ...step, dependsOn: formatDependencies([...dependencies, source]) };
  });

  return changed ? next : steps;
}

export function disconnectSteps<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  sourceId: string,
  targetId: string,
): TStep[] {
  const source = sourceId.trim();
  const target = targetId.trim();
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== target) return step;
    const dependencies = parseDependencies(step.dependsOn);
    const filtered = dependencies.filter((dependency) => dependency !== source);
    if (filtered.length === dependencies.length) return step;
    changed = true;
    const graphEdgeMetadata = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
      ? compactGraphEdgeMetadata(Object.fromEntries(
        Object.entries(step.graphEdgeMetadata).filter(([metadataSource]) => metadataSource !== source),
      ))
      : undefined;
    return { ...step, dependsOn: formatDependencies(filtered), graphEdgeMetadata };
  });
  return changed ? next : steps;
}

export function renameWorkflowStep<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  nextStepId: string,
): TStep[] {
  const currentId = stepId.trim();
  const nextId = nextStepId.trim();
  if (!currentId || !nextId || currentId === nextId) return steps;
  const sourceIndex = steps.findIndex((step) => step.id.trim() === currentId);
  if (sourceIndex < 0) return steps;
  if (steps.some((step, index) => index !== sourceIndex && step.id.trim() === nextId)) {
    throw new Error(`Workflow step "${nextId}" already exists.`);
  }

  return steps.map((step, index) => {
    const dependencies = parseDependencies(step.dependsOn);
    const renamedDependencies = dependencies.map((dependency) => dependency === currentId ? nextId : dependency);
    const graphEdgeMetadata = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
      ? compactGraphEdgeMetadata(Object.fromEntries(
        Object.entries(step.graphEdgeMetadata).map(([metadataSource, metadata]) => [
          metadataSource === currentId ? nextId : metadataSource,
          metadata,
        ]),
      ))
      : undefined;
    const renamedStep = index === sourceIndex ? { ...step, id: nextId } : step;
    const dependenciesChanged = renamedDependencies.some((dependency, dependencyIndex) => dependency !== dependencies[dependencyIndex]);
    const metadataChanged = graphEdgeMetadata !== step.graphEdgeMetadata;
    if (!dependenciesChanged && !metadataChanged && renamedStep === step) return step;
    return {
      ...renamedStep,
      ...(dependenciesChanged ? { dependsOn: formatDependencies(renamedDependencies) } : {}),
      ...(metadataChanged ? { graphEdgeMetadata } : {}),
    };
  });
}

export function duplicateWorkflowStep<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  const sourceIndex = steps.findIndex((step) => step.id.trim() === id);
  if (sourceIndex < 0) return steps;
  const sourceStep = steps[sourceIndex]!;
  const copyId = nextUniqueStepId(steps, `${id}-copy`);
  const sourceTitle = typeof sourceStep.title === "string" ? sourceStep.title.trim() : "";
  const copy = {
    ...clearGraphRunOverlay(sourceStep),
    id: copyId,
    title: sourceTitle ? `${sourceTitle} copy` : `${copyId}`,
  } as unknown as TStep;
  return [...steps.slice(0, sourceIndex + 1), copy, ...steps.slice(sourceIndex + 1)];
}

export function duplicateWorkflowContainer<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  containerId: string,
): TStep[] {
  const id = containerId.trim();
  if (!id) return steps;
  const graph = buildWorkflowGraphModel(steps);
  const container = graph.containers.find((candidate) => candidate.id === id);
  if (!container || container.stepIds.length === 0) return steps;

  const stepIdSet = new Set(container.stepIds);
  const sourceIndexes = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => stepIdSet.has(step.id.trim()));
  if (sourceIndexes.length === 0) return steps;

  const existingIds = new Set(steps.map((step) => step.id.trim()).filter(Boolean));
  const allocateStepId = (baseId: string): string => {
    const normalizedBaseId = baseId.trim() || "step";
    let candidate = normalizedBaseId;
    let index = 2;
    while (existingIds.has(candidate)) {
      candidate = `${normalizedBaseId}-${index}`;
      index += 1;
    }
    existingIds.add(candidate);
    return candidate;
  };

  const existingContainerIds = new Set(steps
    .map((step) => typeof step.graphContainerId === "string" ? step.graphContainerId.trim() : "")
    .filter(Boolean));
  let copiedContainerId = `${id}-copy`;
  let copiedContainerIndex = 2;
  while (existingContainerIds.has(copiedContainerId)) {
    copiedContainerId = `${id}-copy-${copiedContainerIndex}`;
    copiedContainerIndex += 1;
  }
  const idMap = new Map<string, string>();
  for (const { step } of sourceIndexes) {
    idMap.set(step.id, allocateStepId(`${step.id}-copy`));
  }

  const copiedTitle = container.title.trim() ? `${container.title.trim()} copy` : copiedContainerId;
  const copies = sourceIndexes.map(({ step }) => {
    const copyId = idMap.get(step.id) ?? `${step.id}-copy`;
    const copiedDependencies = parseDependencies(step.dependsOn).map((dependency) => idMap.get(dependency) ?? dependency);
    const graphEdgeMetadata = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
      ? compactGraphEdgeMetadata(Object.fromEntries(
        Object.entries(step.graphEdgeMetadata).map(([sourceId, metadata]) => [
          idMap.get(sourceId) ?? sourceId,
          metadata,
        ]),
      ))
      : undefined;
    const title = typeof step.title === "string" && step.title.trim() ? `${step.title.trim()} copy` : copyId;
    return {
      ...clearGraphRunOverlay(step),
      id: copyId,
      title,
      dependsOn: formatDependencies(copiedDependencies),
      graphEdgeMetadata,
      graphContainerId: copiedContainerId,
      graphContainerTitle: copiedTitle,
    } as unknown as TStep;
  });

  const insertAfterIndex = Math.max(...sourceIndexes.map(({ index }) => index));
  return [...steps.slice(0, insertAfterIndex + 1), ...copies, ...steps.slice(insertAfterIndex + 1)];
}

export function removeWorkflowStep<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
): TStep[] {
  const id = stepId.trim();
  if (!id || !steps.some((step) => step.id.trim() === id)) return steps;
  return steps
    .filter((step) => step.id.trim() !== id)
    .map((step) => {
      const dependencies = parseDependencies(step.dependsOn);
      const filteredDependencies = dependencies.filter((dependency) => dependency !== id);
      const graphEdgeMetadata = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
        ? compactGraphEdgeMetadata(Object.fromEntries(
          Object.entries(step.graphEdgeMetadata).filter(([metadataSource]) => metadataSource !== id),
        ))
        : undefined;
      if (filteredDependencies.length === dependencies.length && graphEdgeMetadata === step.graphEdgeMetadata) {
        return step;
      }
      return {
        ...step,
        dependsOn: formatDependencies(filteredDependencies),
        graphEdgeMetadata,
      };
    });
}

export function updateGraphEdgeMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  sourceId: string,
  targetId: string,
  patch: WorkflowGraphEdgeMetadataInput,
): TStep[] {
  const source = sourceId.trim();
  const target = targetId.trim();
  if (!source || !target) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== target) return step;
    if (!parseDependencies(step.dependsOn).includes(source)) return step;
    const current = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
      ? step.graphEdgeMetadata
      : {};
    const merged = compactGraphEdgeMetadata({
      ...current,
      [source]: {
        kind: patch.kind ?? current[source]?.kind,
        label: patch.label ?? current[source]?.label,
        condition: patch.condition ?? current[source]?.condition,
      },
    });
    changed = true;
    return { ...step, graphEdgeMetadata: merged };
  });
  return changed ? next : steps;
}

export function applyWorkflowGraphFailureRoute<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  sourceStepIds: string[],
  handlerStepId: string,
  options: WorkflowGraphFailureRouteOptions = {},
): TStep[] {
  const summary = buildWorkflowGraphFailureRouteSummary(steps, sourceStepIds, handlerStepId, options);
  if (summary.blocked) return steps;

  let next = steps;
  for (const sourceId of summary.sourceStepIds) {
    next = connectSteps(next, sourceId, summary.handlerStepId);
    next = updateGraphEdgeMetadata(next, sourceId, summary.handlerStepId, {
      kind: "failure",
      label: summary.label,
      condition: summary.condition,
    });
  }

  const handlerScope = options.handlerScope?.trim() || "selected-path";
  const handlerInput = options.handlerInput?.trim() || "";
  return next.map((step) => {
    const stepId = step.id.trim();
    if (summary.sourceStepIds.includes(stepId)) {
      return {
        ...step,
        onFailure: "handler",
      };
    }
    if (stepId === summary.handlerStepId) {
      return {
        ...step,
        graphErrorHandler: true,
        graphErrorHandlerScope: handlerScope,
        ...(handlerInput ? { graphErrorHandlerInput: handlerInput } : {}),
      };
    }
    return step;
  });
}

export function appendStepAfter<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  afterStepId: string | null,
): TStep[] {
  const existingIds = new Set(steps.map((step) => step.id));
  let index = steps.length + 1;
  let id = `step-${index}`;
  while (existingIds.has(id)) {
    index += 1;
    id = `step-${index}`;
  }

  const afterIndex = afterStepId ? steps.findIndex((step) => step.id === afterStepId) : -1;
  const insertAt = afterIndex >= 0 ? afterIndex + 1 : steps.length;
  const newStep = {
    id,
    title: "New step",
    description: "",
    type: "agent",
    toolName: "",
    toolArgs: "{}",
    agentName: "",
    tools: "",
    dependsOn: afterIndex >= 0 ? steps[afterIndex]!.id : "",
    onFailure: "",
    graphApprovalRequired: false,
    graphApprovalPrompt: "",
    graphApprovalRecipients: "",
    graphApprovalTimeoutSeconds: "",
    graphApprovalTimeoutAction: "",
    graphGroupId: "",
    graphGroupTitle: "",
    graphGroupColor: "#64748b",
    graphGroupCollapsed: false,
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
  } as unknown as TStep;

  return [...steps.slice(0, insertAt), newStep, ...steps.slice(insertAt)];
}

function workflowPaletteTemplate(
  kind: WorkflowGraphPaletteNodeKind,
  id: string,
  dependsOn: string,
): Record<string, unknown> {
  const base = {
    id,
    title: "Agent step",
    description: "",
    type: "agent",
    toolName: "",
    toolArgs: "{}",
    agentName: "",
    tools: "",
    dependsOn,
    onFailure: "",
    graphApprovalRequired: false,
    graphApprovalPrompt: "",
    graphApprovalRecipients: "",
    graphApprovalTimeoutSeconds: "",
    graphApprovalTimeoutAction: "",
    graphGroupId: "",
    graphGroupTitle: "",
    graphGroupColor: "#64748b",
    graphGroupCollapsed: false,
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

  if (kind === "tool") {
    return {
      ...base,
      title: "Tool step",
      type: "tool",
    };
  }

  if (kind === "branch") {
    return {
      ...base,
      title: "Branch",
      graphContainerId: `${id}-branch`,
      graphContainerType: "branch",
      graphContainerTitle: "Branch",
      graphContainerMode: "branch-one",
    };
  }

  if (kind === "loop") {
    return {
      ...base,
      title: "Loop",
      graphContainerId: `${id}-loop`,
      graphContainerType: "loop",
      graphContainerTitle: "Loop",
      graphContainerMode: "for-each",
      graphContainerIterator: "result.items",
      graphContainerRunInParallel: true,
      graphContainerParallelism: 4,
    };
  }

  if (kind === "failure-handler") {
    return {
      ...base,
      title: "Failure handler",
      onFailure: "escalate",
      graphEdgeMetadata: dependsOn
        ? {
          [dependsOn]: {
            kind: "failure",
            label: "failure",
            condition: "upstream step failed",
          },
        }
        : {},
    };
  }

  if (kind === "approval") {
    return {
      ...base,
      title: "Approval gate",
      graphApprovalRequired: true,
      graphApprovalPrompt: "Review and approve before continuing.",
      graphApprovalTimeoutAction: "cancel",
    };
  }

  return base;
}

export function insertWorkflowStepFromPalette<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  afterStepId: string | null,
  kind: WorkflowGraphPaletteNodeKind,
): TStep[] {
  const baseId = kind === "failure-handler" ? "failure-handler" : kind;
  const id = nextUniqueStepId(steps, baseId);
  const afterIndex = afterStepId ? steps.findIndex((step) => step.id.trim() === afterStepId.trim()) : -1;
  const insertAt = afterIndex >= 0 ? afterIndex + 1 : steps.length;
  const dependencyId = afterIndex >= 0 ? steps[afterIndex]!.id.trim() : "";
  const newStep = workflowPaletteTemplate(kind, id, dependencyId) as unknown as TStep;

  const next = [
    ...steps.slice(0, insertAt),
    newStep,
    ...steps.slice(insertAt),
  ];
  if (!dependencyId) return next;

  return next.map((step) => {
    if (step.id === id) return step;
    const dependencies = parseDependencies(step.dependsOn);
    if (!dependencies.includes(dependencyId)) return step;
    const rewiredDependencies = dependencies.map((dependency) => dependency === dependencyId ? id : dependency);
    const existingMetadata = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
      ? step.graphEdgeMetadata
      : {};
    const rewiredMetadata = compactGraphEdgeMetadata(Object.fromEntries(
      Object.entries(existingMetadata).map(([sourceId, metadata]) => [
        sourceId === dependencyId ? id : sourceId,
        metadata,
      ]),
    ));
    return {
      ...step,
      dependsOn: formatDependencies(rewiredDependencies),
      graphEdgeMetadata: rewiredMetadata,
    };
  });
}
