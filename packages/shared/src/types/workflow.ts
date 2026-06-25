export type WorkflowDefinitionStatus = "active" | "paused" | "archived";
export type WorkflowExecutionMode = "static_dag" | "dynamic_owner_plan";
export type WorkflowTriggerSource = "manual" | "api" | "schedule" | "label" | string;
export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | string;
export type WorkflowStepRunStatus = "pending" | "running" | "completed" | "failed" | "skipped" | string;

export interface WorkflowStepDefinition {
  id: string;
  title?: string;
  name?: string;
  description?: string;
  dependsOn?: string[];
  dependencies?: string[];
  type?: string;
  toolName?: string;
  toolArgs?: unknown;
  tools?: string[];
  toolNames?: string[];
  sessionMode?: string;
  onFailure?: string;
  escalateTo?: string;
  maxRetries?: number;
  triggerOn?: "normal" | "escalation" | string;
  timeoutSeconds?: number;
  dynamicChildren?: boolean | string;
  ownerPlanBootstrapOnly?: boolean | string;
  bootstrapOnly?: boolean | string;
  agentName?: string;
  agentId?: string;
  assigneeAgentId?: string;
  /**
   * 이 step이 파일 산출물(workProduct)을 생산하는지.
   * true면 dag-engine이 출력 디렉토리 + `[ARTIFACT]:` 등록 contract를 issue에 주입하고
   * heartbeat가 missing-workProduct 자동등록 gate를 적용한다.
   * false는 "QA 단계"를 뜻하지 않는다 — 단지 산출물 contract 강제를 안 할 뿐. verdict는 별개.
   * (UI graphWorkProductRequired 토글과 동일 필드.)
   */
  graphWorkProductRequired?: boolean;
}

export interface WorkflowDefinitionDto {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status: WorkflowDefinitionStatus | string;
  steps: WorkflowStepDefinition[];
  schedule: string | null;
  timezone: string | null;
  deadlineTime: string | null;
  lastScheduledRunAt: string | null;
  lastScheduleError: string | null;
  lastScheduleErrorAt: string | null;
  timeoutMinutes: number | null;
  maxDailyRuns: number | null;
  maxConcurrentRuns: number | null;
  triggerLabels: string[];
  labelIds: string[];
  projectId: string | null;
  goalId: string | null;
  createParentIssuePolicy: string | null;
  executionMode: WorkflowExecutionMode | string | null;
  dynamicPlanBootstrapOnly: boolean;
  source: string | null;
  sourceKind: string | null;
  legacyPluginEntityId: string | null;
  legacyMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunDto {
  id: string;
  workflowId: string;
  companyId: string;
  missionId: string | null;
  status: WorkflowRunStatus;
  originalStatus: string | null;
  triggeredBy: string;
  triggerSource: WorkflowTriggerSource | null;
  runDate: string | null;
  runNumber: number | null;
  runLabel: string | null;
  parentIssueId: string | null;
  scheduledSlotId: string | null;
  legacyPluginRunEntityId: string | null;
  metadata: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface WorkflowStepRunDto {
  id: string;
  workflowRunId: string;
  stepId: string;
  issueId: string | null;
  status: WorkflowStepRunStatus;
  originalStatus: string | null;
  agentName: string | null;
  retryCount: number;
  sessionId: string | null;
  lastDispatchAttemptAt: string | null;
  lastDispatchAcceptedAt: string | null;
  lastDispatchErrorAt: string | null;
  lastDispatchErrorSummary: string | null;
  lastDispatchRequestId: string | null;
  legacyPluginStepEntityId: string | null;
  metadata: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowRunSlotDto {
  id: string;
  workflowDefinitionId: string;
  companyId: string;
  triggerSource: WorkflowTriggerSource;
  scheduledAt: string;
  runDate: string | null;
  timezone: string | null;
  claimedAt: string;
  status: "claimed" | "run_created" | "skipped" | "failed" | "cancelled" | string;
  metadata: Record<string, unknown>;
}
