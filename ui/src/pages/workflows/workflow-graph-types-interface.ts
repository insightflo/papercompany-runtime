import type { WorkflowGraphStep } from "./workflow-graph-types-core.js";
import type { WorkflowGraphManagementRunInput } from "./workflow-graph-types-test.js";

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

export type WorkflowGraphPaletteNodeKind = "agent" | "tool" | "if" | "complete" | "branch" | "loop" | "failure-handler" | "approval";
