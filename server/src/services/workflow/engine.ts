/**
 * Workflow Engine Service
 *
 * Main service interface for workflow operations.
 * Provides create, trigger, cancel, and query operations for workflows.
 */

import type { Db } from "@paperclipai/db";
import { validateDag, executeWorkflowRun, reconcileWorkflowRuns, syncWorkflowRunForIssue } from "./dag-engine.js";
import {
  createWorkflowDefinition,
  getWorkflowDefinitionById,
  listWorkflowDefinitions,
  updateWorkflowDefinition,
  deleteWorkflowDefinition,
  createWorkflowRun,
  getWorkflowRunById,
  listWorkflowRuns,
  listWorkflowStepRuns,
  getWorkflowStepExecutionContractForIssue,
  updateWorkflowRunStatus,
  cancelWorkflowRun,
} from "./workflow-store.js";
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepRun,
  CreateWorkflowDefinitionInput,
  CreateWorkflowRunInput,
  DagValidationResult,
  WorkflowExecutionResult,
  WorkflowStepExecutionContract,
} from "./types.js";
import type { WorkflowStep } from "./dag-engine.js";

type WorkflowStepLike = WorkflowStep & {
  title?: unknown;
  dependsOn?: unknown;
  tools?: unknown;
  agentName?: unknown;
};

function normalizeWorkflowSteps(steps: unknown[]): WorkflowStep[] {
  return steps.map((rawStep) => {
    const step = (rawStep && typeof rawStep === "object" ? rawStep : {}) as WorkflowStepLike;
    const dependencies = Array.isArray(step.dependencies)
      ? step.dependencies
      : Array.isArray(step.dependsOn)
        ? step.dependsOn
        : [];
    const toolNames = Array.isArray(step.toolNames)
      ? step.toolNames
      : typeof step.tools === "string"
        ? step.tools.split(",").map((tool) => tool.trim()).filter(Boolean)
        : undefined;

    return {
      ...step,
      id: typeof step.id === "string" ? step.id : crypto.randomUUID(),
      name: typeof step.name === "string"
        ? step.name
        : typeof step.title === "string"
          ? step.title
          : typeof step.id === "string"
            ? step.id
            : "Untitled step",
      agentId: typeof step.agentId === "string" ? step.agentId : "",
      dependencies,
      ...(toolNames ? { toolNames } : {}),
    };
  });
}

/**
 * Workflow service singleton.
 */
export const workflowService = {
  /**
   * Create a new workflow definition.
   */
  async createDefinition(
    db: Db,
    input: CreateWorkflowDefinitionInput,
  ): Promise<WorkflowDefinition> {
    const steps = normalizeWorkflowSteps(input.steps as unknown[]);
    // Validate DAG structure
    const validation = validateDag(steps);
    if (!validation.valid) {
      throw new Error(`Invalid workflow DAG: ${validation.errors.join(", ")}`);
    }

    return createWorkflowDefinition(db, { ...input, steps });
  },

  /**
   * Get a workflow definition by ID.
   */
  async getDefinition(db: Db, id: string): Promise<WorkflowDefinition | null> {
    return getWorkflowDefinitionById(db, id);
  },

  /**
   * List workflow definitions for a company.
   */
  async listDefinitions(db: Db, companyId: string): Promise<WorkflowDefinition[]> {
    return listWorkflowDefinitions(db, companyId);
  },

  /**
   * Update a workflow definition.
   */
  async updateDefinition(
    db: Db,
    id: string,
    updates: Partial<Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt">>,
  ): Promise<WorkflowDefinition | null> {
    if (updates.steps) {
      const steps = normalizeWorkflowSteps(updates.steps as unknown[]);
      const validation = validateDag(steps);
      if (!validation.valid) {
        throw new Error(`Invalid workflow DAG: ${validation.errors.join(", ")}`);
      }
      updates = { ...updates, steps };
    }

    return updateWorkflowDefinition(db, id, updates);
  },

  /**
   * Delete a workflow definition.
   */
  async deleteDefinition(db: Db, id: string): Promise<boolean> {
    return deleteWorkflowDefinition(db, id);
  },

  /**
   * Trigger (create and execute) a workflow run.
   */
  async trigger(
    db: Db,
    input: CreateWorkflowRunInput,
  ): Promise<WorkflowExecutionResult> {
    const run = await createWorkflowRun(db, input);
    return executeWorkflowRun(db, run.id);
  },

  /**
   * Cancel a workflow run.
   */
  async cancelRun(db: Db, id: string): Promise<boolean> {
    return cancelWorkflowRun(db, id);
  },

  /**
   * Get a workflow run by ID.
   */
  async getRun(db: Db, id: string): Promise<WorkflowRun | null> {
    return getWorkflowRunById(db, id);
  },

  /**
   * List workflow runs.
   */
  async listRuns(
    db: Db,
    filters: { companyId?: string; workflowId?: string; missionId?: string },
  ): Promise<WorkflowRun[]> {
    return listWorkflowRuns(db, filters);
  },

  /**
   * List step runs for a workflow run.
   */
  async listStepRuns(db: Db, workflowRunId: string): Promise<WorkflowStepRun[]> {
    return listWorkflowStepRuns(db, workflowRunId);
  },

  /**
   * Resolve the workflow step execution contract for a workflow-owned issue.
   */
  async getStepExecutionContractForIssue(
    db: Db,
    issueId: string,
  ): Promise<WorkflowStepExecutionContract | null> {
    return getWorkflowStepExecutionContractForIssue(db, issueId);
  },

  /**
   * Validate a workflow DAG without creating it.
   */
  async validateDag(steps: unknown[]): Promise<DagValidationResult> {
    return validateDag(normalizeWorkflowSteps(steps));
  },

  /**
   * Reconcile stuck workflow runs.
   */
  async reconcile(
    db: Db,
    timeoutMinutes: number = 60,
  ): Promise<{ recovered: number; failed: number }> {
    return reconcileWorkflowRuns(db, timeoutMinutes);
  },

  /**
   * Synchronize a workflow run after one of its execution issues changed state.
   */
  async syncRunStatusForIssue(db: Db, issueId: string): Promise<WorkflowExecutionResult | null> {
    return syncWorkflowRunForIssue(db, issueId);
  },
};

// Re-export types for convenience
export type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepRun,
  CreateWorkflowDefinitionInput,
  CreateWorkflowRunInput,
  DagValidationResult,
  WorkflowExecutionResult,
  WorkflowStepExecutionContract,
};
