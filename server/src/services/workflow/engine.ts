/**
 * Workflow Engine Service
 *
 * Main service interface for workflow operations.
 * Provides create, trigger, cancel, and query operations for workflows.
 */

import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq, asc } from "drizzle-orm";
import { validateDag, executeWorkflowRun, reconcileWorkflowRuns, syncWorkflowRunForIssue, cancelWorkflowRunWithCleanup } from "./dag-engine.js";
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
    .where(eq(agents.companyId, companyId))
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
    const runInput = await ensureMissionForWorkflowRun(db, input);
    const run = await createWorkflowRun(db, runInput);
    if (run.missionId) {
      const workflow = await getWorkflowDefinitionById(db, run.workflowId);
      if (workflow) {
        const mission = await missionService(db).getById(run.missionId);
        if (mission) {
          await missionService(db).ensureMainExecutorOversightIssue(mission, workflow.name, {
            sourceRunId: run.id,
            workflowStepIds: workflow.steps.map((step) => step.id),
          });
        }
      }
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
