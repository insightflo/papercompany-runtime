/**
 * Workflow Engine Service
 *
 * Main service interface for workflow operations.
 * Provides create, trigger, cancel, and query operations for workflows.
 */

import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { and, eq, asc, ne } from "drizzle-orm";
import { validateDag, executeWorkflowRun, reconcileWorkflowRuns, syncWorkflowRunForIssue, cancelWorkflowRunWithCleanup, normalizeWorkflowStepsForExecution } from "./dag-engine.js";
import { missionService } from "../missions.js";
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
  resumeWorkflowRun,
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
import type { WorkflowExecutionMode, WorkflowStep } from "./dag-engine.js";

type WorkflowStepLike = WorkflowStep & {
  title?: unknown;
  dependsOn?: unknown;
  tools?: unknown;
  toolName?: unknown;
  agentName?: unknown;
};

function normalizeWorkflowSteps(
  steps: unknown[],
  options: { executionMode?: unknown; dynamicPlanBootstrapOnly?: unknown } = {},
): WorkflowStep[] {
  const normalizedSteps = steps.map((rawStep) => {
    const step = (rawStep && typeof rawStep === "object" ? rawStep : {}) as WorkflowStepLike;
    const normalized = normalizeWorkflowStepsForExecution([step])[0]!;
    const toolNames = normalized.toolNames;

    return {
      ...step,
      id: normalized.id,
      name: normalized.name,
      agentId: normalized.agentId,
      dependencies: normalized.dependencies,
      ...(toolNames ? { toolNames } : {}),
    };
  });

  const dynamicOwnerPlan = options.executionMode === "dynamic_owner_plan"
    || options.dynamicPlanBootstrapOnly === true
    || options.dynamicPlanBootstrapOnly === "true";
  if (!dynamicOwnerPlan) return normalizedSteps;

  return normalizedSteps.map((step) => {
    if (step.triggerOn === "escalation" || step.dependencies.length > 0) return step;
    return {
      ...step,
      dynamicChildren: step.dynamicChildren ?? true,
      ownerPlanBootstrapOnly: step.ownerPlanBootstrapOnly ?? true,
      executionMode: step.executionMode ?? "dynamic_owner_plan",
    };
  });
}

function formatWorkflowMissionTitle(workflowName: string, now = new Date()): string {
  const yyyyMmDd = now.toISOString().slice(0, 10);
  return `${yyyyMmDd} ${workflowName}`;
}

async function resolveWorkflowMissionOwnerAgentId(
  db: Db,
  companyId: string,
  workflow: WorkflowDefinition,
): Promise<string> {
  const stepAgentId = workflow.steps.find((step) => typeof step.agentId === "string" && step.agentId.trim())?.agentId;
  if (stepAgentId) return stepAgentId;

  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      ne(agents.status, "terminated"),
      ne(agents.status, "pending_approval"),
    ))
    .orderBy(asc(agents.createdAt))
    .limit(1);

  if (!agent) {
    throw new Error("Cannot create workflow mission: no agent exists for company");
  }
  return agent.id;
}

async function ensureMissionForWorkflowRun(
  db: Db,
  input: CreateWorkflowRunInput,
): Promise<CreateWorkflowRunInput> {
  if (input.missionId) return input;

  const workflow = await getWorkflowDefinitionById(db, input.workflowId);
  if (!workflow) {
    throw new Error(`Workflow definition not found: ${input.workflowId}`);
  }

  const ownerAgentId = await resolveWorkflowMissionOwnerAgentId(db, input.companyId, workflow);
  const mission = await missionService(db).create({
    companyId: input.companyId,
    ownerAgentId,
    title: formatWorkflowMissionTitle(workflow.name),
    description: `Created automatically for workflow run: ${workflow.name}`,
    status: "active",
    source: "workflow",
  });
  await missionService(db).ensureMainExecutorOversightIssue(mission, workflow.name, {
    workflowStepIds: workflow.steps.map((step) => step.id),
  });

  return { ...input, missionId: mission.id };
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
    const steps = normalizeWorkflowSteps(input.steps as unknown[], {
      executionMode: input.executionMode,
    });
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
      const steps = normalizeWorkflowSteps(updates.steps as unknown[], {
        executionMode: updates.executionMode,
      });
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
    const workflow = await getWorkflowDefinitionById(db, input.workflowId);
    if (!workflow) {
      throw new Error(`Workflow definition not found: ${input.workflowId}`);
    }
    if (workflow.companyId !== input.companyId) {
      throw new Error(`Workflow does not belong to company: ${input.workflowId}`);
    }
    const runInput = await ensureMissionForWorkflowRun(db, input);
    const run = await createWorkflowRun(db, runInput);
    if (run.missionId) {
      const mission = await missionService(db).getById(run.missionId);
      if (mission) {
        await missionService(db).ensureMainExecutorOversightIssue(mission, workflow.name, {
          sourceRunId: run.id,
          workflowStepIds: workflow.steps.map((step) => step.id),
        });
      }
    }
    return executeWorkflowRun(db, run.id);
  },

  /**
   * Resume a workflow run through the native server DAG execution path.
   */
  async resumeRun(
    db: Db,
    input: { runId: string; companyId: string },
  ): Promise<WorkflowExecutionResult> {
    const run = await resumeWorkflowRun(db, input.runId, input.companyId);
    if (!run) {
      throw new Error(`Workflow run not found: ${input.runId}`);
    }
    return executeWorkflowRun(db, run.id);
  },

  /**
   * Cancel a workflow run.
   */
  async cancelRun(db: Db, id: string): Promise<boolean> {
    return cancelWorkflowRunWithCleanup(db, id);
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
