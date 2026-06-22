/**
 * Workflow Service Types
 *
 * Defines the TypeScript interfaces for workflow definitions, runs, and step runs.
 * These align with the database schema in packages/db/src/schema/workflow_*.ts
 */

import type { WorkflowExecutionMode, WorkflowStep } from "./dag-engine.js";

/**
 * A workflow definition defines a DAG of steps to execute.
 */
export interface WorkflowDefinition {
  id: string;
  companyId: string;
  name: string;
  description?: string | null;
  status?: string;
  steps: WorkflowStep[];
  schedule?: string | null;
  timezone?: string | null;
  deadlineTime?: string | null;
  lastScheduledRunAt?: Date | null;
  lastScheduleError?: string | null;
  lastScheduleErrorAt?: Date | null;
  timeoutMinutes?: number | null;
  maxDailyRuns?: number | null;
  maxConcurrentRuns?: number | null;
  triggerLabels?: string[];
  labelIds?: string[];
  projectId?: string | null;
  goalId?: string | null;
  createParentIssuePolicy?: string | null;
  executionMode: WorkflowExecutionMode | string | null;
  dynamicPlanBootstrapOnly?: boolean;
  source?: string | null;
  sourceKind?: string | null;
  legacyPluginEntityId?: string | null;
  legacyMetadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input to create a new workflow definition.
 */
export interface CreateWorkflowDefinitionInput {
  companyId: string;
  name: string;
  description?: string | null;
  steps: WorkflowStep[];
  status?: string;
  schedule?: string | null;
  timezone?: string | null;
  deadlineTime?: string | null;
  timeoutMinutes?: number | null;
  maxDailyRuns?: number | null;
  maxConcurrentRuns?: number | null;
  triggerLabels?: string[];
  labelIds?: string[];
  projectId?: string | null;
  goalId?: string | null;
  createParentIssuePolicy?: string | null;
  executionMode?: WorkflowExecutionMode | string | null;
  dynamicPlanBootstrapOnly?: boolean;
  source?: string | null;
  sourceKind?: string | null;
  legacyPluginEntityId?: string | null;
  legacyMetadata?: Record<string, unknown>;
}

/**
 * A workflow run represents a single execution of a workflow definition.
 */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  companyId: string;
  missionId: string | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | string;
  originalStatus?: string | null;
  triggeredBy: string;
  triggerSource?: string | null;
  runDate?: string | null;
  runNumber?: number | null;
  runLabel?: string | null;
  parentIssueId?: string | null;
  scheduledSlotId?: string | null;
  legacyPluginRunEntityId?: string | null;
  metadata?: Record<string, unknown>;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

/**
 * Input to create a new workflow run.
 */
export interface CreateWorkflowRunInput {
  workflowId: string;
  companyId: string;
  missionId?: string;
  triggeredBy: string;
  triggerSource?: string | null;
  runDate?: string | null;
  runNumber?: number | null;
  runLabel?: string | null;
  parentIssueId?: string | null;
  scheduledSlotId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Internal scheduler-only input for claiming a scheduled workflow slot.
 * Public REST trigger bodies must not accept scheduledSlotId directly.
 */
export interface ClaimScheduledWorkflowRunInput {
  workflowId: string;
  companyId: string;
  scheduledAt: Date;
  triggerSource?: string;
  triggeredBy?: string;
  runDate?: string | null;
  runNumber?: number | null;
  runLabel?: string | null;
  timezone?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ClaimScheduledWorkflowRunResult {
  claimed: boolean;
  scheduledSlotId: string | null;
  run: WorkflowExecutionResult | null;
}

/**
 * A workflow step run represents the execution of a single step within a workflow run.
 */
export interface WorkflowStepRun {
  id: string;
  workflowRunId: string;
  stepId: string;
  issueId: string | null;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | string;
  originalStatus?: string | null;
  agentName?: string | null;
  retryCount?: number;
  sessionId?: string | null;
  lastDispatchAttemptAt?: Date | null;
  lastDispatchAcceptedAt?: Date | null;
  lastDispatchErrorAt?: Date | null;
  lastDispatchErrorSummary?: string | null;
  lastDispatchRequestId?: string | null;
  legacyPluginStepEntityId?: string | null;
  metadata?: Record<string, unknown>;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface WorkflowRunSlot {
  id: string;
  workflowDefinitionId: string;
  companyId: string;
  triggerSource?: string;
  scheduledAt: Date;
  runDate?: string | null;
  timezone?: string | null;
  claimedAt: Date;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowStepExecutionContract {
  workflowRunId: string;
  workflowId: string;
  missionId: string | null;
  stepId: string;
  stepName: string;
  toolNames: string[];
  toolArgs: unknown;
  knowledgeBaseIds: string[];
}

/**
 * Result of a workflow execution.
 */
export interface WorkflowExecutionResult {
  runId: string;
  workflowId: string;
  missionId: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  completedAt: Date | null;
  error?: string;
  stepRuns: WorkflowStepRun[];
}

/**
 * DAG validation result.
 */
export interface DagValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
