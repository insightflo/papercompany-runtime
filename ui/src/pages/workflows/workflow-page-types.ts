import type { WorkflowGraphEdgeMetadataRecord, WorkflowGraphWorkProduct, WorkflowGraphStep } from "./workflow-graph.js";
import type { CreateParentIssuePolicy } from "./workflow-parent-policy.js";

export type PluginPageProps = { context?: { companyId?: string | null } };
export type PluginWidgetProps = { context?: { companyId?: string | null } };

export type StepEditorMode = "graph" | "form" | "json";

export type ProjectOption = { id: string; name: string };
export type LabelOption = { id: string; name: string; color: string };
export type WorkflowToolOption = {
  name: string;
  displayName: string;
  description: string;
  pluginId: string;
  source?: string;
  enabled?: boolean;
};

export type WorkflowToolGrant = {
  agentName: string;
  toolName: string;
};

export type WorkflowOverviewData = {
  projects?: ProjectOption[];
  labels?: LabelOption[];
  workflows: Array<{
    id: string;
    name: string;
    description: string;
    status: string;
    triggerLabels?: string[];
    labelIds?: string[];
      schedule?: string;
      maxDailyRuns?: number;
      timezone?: string;
      source?: string;
      sourceKind?: string;
      deadlineTime?: string;
      lastScheduledRunAt?: string;
    lastScheduleError?: string;
    lastScheduleErrorAt?: string;
    projectId?: string;
    createParentIssuePolicy?: CreateParentIssuePolicy;
    executionMode?: string;
    dynamicPlanBootstrapOnly?: boolean;
    legacyMetadata?: Record<string, unknown>;
    steps: Array<{
      id: string;
      title: string;
      type?: string;
      toolName?: string;
      agentName?: string;
      dependsOn: string[];
      executionMode?: string;
      ownerPlanBootstrapOnly?: boolean;
      dynamicChildren?: boolean;
      graphPositionX?: number | string;
      graphPositionY?: number | string;
      graphEdgeMetadata?: WorkflowGraphEdgeMetadataRecord;
      [key: string]: unknown;
    }>;
  }>;
  activeRuns: Array<{
    id: string;
    workflowId?: string;
    missionId?: string;
    workflowName: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    triggerSource?: string;
    parentIssueId?: string;
    parentIssueIdentifier?: string;
    runLabel?: string;
  }>;
  recentRuns: Array<{
    id: string;
    workflowId?: string;
    missionId?: string;
    workflowName: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    triggerSource?: string;
    parentIssueId?: string;
    parentIssueIdentifier?: string;
    runLabel?: string;
  }>;
};

export type OverviewData = WorkflowOverviewData;

export type WorkflowRunDetailData = {
  run: {
    id: string;
    status: string;
    [key: string]: unknown;
  };
  stepRuns: Array<{
    id: string;
    stepId: string;
    stepTitle?: string;
    stepType?: string;
    issueId?: string;
    issueIdentifier?: string;
    status: string;
    agentName?: string;
    startedAt?: string;
    completedAt?: string;
    lastDispatchAcceptedAt?: string;
    lastDispatchAttemptAt?: string;
    lastDispatchErrorAt?: string;
    lastDispatchErrorSummary?: string;
    lastDispatchRequestId?: string;
    workProducts?: WorkflowGraphWorkProduct[];
  }>;
  workflow: {
    id: string;
    steps?: Array<WorkflowGraphStep & { id: string; title: string; type?: string }>;
    [key: string]: unknown;
  } | null;
};

export type StatusFilter = "active" | "archived";
export type WorkflowScopeFilter = "reusable" | "manual_mission";
export type WorkflowRestoreKind = "reusable" | "manual";

export type WorkflowSummary = WorkflowOverviewData["workflows"][number];
export type WorkflowRunSummary = WorkflowOverviewData["activeRuns"][number];
