/**
 * Workflow Service Types
 *
 * Defines the TypeScript interfaces for workflow definitions, runs, and step runs.
 * These align with the database schema in packages/db/src/schema/workflow_*.ts
 */

import type { WorkflowStep } from "./dag-engine.js";

/**
 * A workflow definition defines a DAG of steps to execute.
 */
export interface WorkflowDefinition {
  id: string;
  companyId: string;
  name: string;
  steps: WorkflowStep[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input to create a new workflow definition.
 */
export interface CreateWorkflowDefinitionInput {
  companyId: string;
  name: string;
  steps: WorkflowStep[];
}

/**
 * A workflow run represents a single execution of a workflow definition.
 */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  companyId: string;
  missionId: string | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  triggeredBy: string;
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
}

/**
 * A workflow step run represents the execution of a single step within a workflow run.
 */
export interface WorkflowStepRun {
  id: string;
  workflowRunId: string;
  stepId: string;
  issueId: string | null;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt: Date | null;
  completedAt: Date | null;
}

/**
 * Result of a workflow execution.
 */
export interface WorkflowExecutionResult {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  completedAt: Date;
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
