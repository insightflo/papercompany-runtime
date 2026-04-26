/**
 * DAG Engine
 *
 * Validates and executes Directed Acyclic Graph (DAG) workflows.
 * A workflow is a DAG where each step has dependencies on other steps.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { DagValidationResult, WorkflowExecutionResult } from "./types.js";
import { issueService } from "../issues.js";
import { heartbeatService } from "../heartbeat.js";
import { applyIssueCreatedSideEffects } from "../issue-create-side-effects.js";

/**
 * Workflow step definition.
 */
export interface WorkflowStep {
  id: string;
  name: string;
  agentId: string;
  dependencies: string[]; // step IDs this step depends on
  description?: string;
  toolNames?: string[];
  knowledgeBaseIds?: string[];
}

const WORKFLOW_STEP_TERMINAL_STATUSES = new Set(["completed", "failed", "skipped"]);
const WORKFLOW_STEP_SUCCESS_STATUSES = new Set(["completed"]);

type WorkflowExecutionContext = {
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  steps: WorkflowStep[];
  stepRuns: (typeof workflowStepRuns.$inferSelect)[];
};

/**
 * Validates that a workflow DAG is acyclic and well-formed.
 *
 * @param steps - The workflow steps to validate.
 * @returns Validation result with any errors or warnings.
 */
export function validateDag(steps: WorkflowStep[]): DagValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stepIds = new Set(steps.map((s) => s.id));

  // Check for duplicate step IDs
  if (stepIds.size !== steps.length) {
    errors.push("Duplicate step IDs detected");
  }

  // Check for orphan dependencies
  for (const step of steps) {
    for (const dep of step.dependencies) {
      if (!stepIds.has(dep)) {
        errors.push(`Step "${step.id}" depends on non-existent step "${dep}"`);
      }
    }
  }

  // Check for cycles using depth-first search
  const hasCycle = detectCycle(steps);
  if (hasCycle) {
    errors.push("Workflow contains a cycle (circular dependency)");
  }

  // Check for steps with no dependencies (entry points)
  const entryPoints = steps.filter((s) => s.dependencies.length === 0);
  if (entryPoints.length === 0 && steps.length > 0) {
    errors.push("Workflow has no entry points (all steps have dependencies)");
  }

  // Check for unreachable steps
  if (entryPoints.length > 0) {
    const reachable = new Set<string>();
    for (const entry of entryPoints) {
      dfsReachable(entry, steps, reachable);
    }
    for (const step of steps) {
      if (!reachable.has(step.id)) {
        warnings.push(`Step "${step.id}" is unreachable from any entry point`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Detects cycles in a DAG using DFS with coloring.
 */
function detectCycle(steps: WorkflowStep[]): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;

  const color = new Map<string, number>();
  for (const step of steps) {
    color.set(step.id, WHITE);
  }

  function dfs(stepId: string): boolean {
    const c = color.get(stepId);
    if (c === GRAY) return true; // back edge -> cycle
    if (c === BLACK) return false;

    color.set(stepId, GRAY);

    const step = steps.find((s) => s.id === stepId);
    if (step) {
      for (const dep of step.dependencies) {
        if (dfs(dep)) return true;
      }
    }

    color.set(stepId, BLACK);
    return false;
  }

  for (const step of steps) {
    if (color.get(step.id) === WHITE) {
      if (dfs(step.id)) return true;
    }
  }

  return false;
}

/**
 * Marks all steps reachable from the given step.
 */
function dfsReachable(step: WorkflowStep, allSteps: WorkflowStep[], visited: Set<string>): void {
  if (visited.has(step.id)) return;
  visited.add(step.id);

  for (const depId of step.dependencies) {
    const dep = allSteps.find((s) => s.id === depId);
    if (dep) {
      dfsReachable(dep, allSteps, visited);
    }
  }
}

async function loadWorkflowExecutionContext(db: Db, runId: string): Promise<WorkflowExecutionContext> {
  const runResult = await db
    .select({
      run: workflowRuns,
      definition: workflowDefinitions,
    })
    .from(workflowRuns)
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(eq(workflowRuns.id, runId))
    .limit(1);

  if (!runResult[0]) {
    throw new Error(`Workflow run ${runId} not found`);
  }

  const { run, definition } = runResult[0] as {
    run: typeof workflowRuns.$inferSelect;
    definition: typeof workflowDefinitions.$inferSelect;
  };
  const steps: WorkflowStep[] = (definition.stepsJson as WorkflowStep[]) || [];
  const stepRuns = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));

  return { run, definition, steps, stepRuns };
}

async function ensureStepRunRecords(
  db: Db,
  runId: string,
  steps: WorkflowStep[],
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  const existing = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));

  const existingStepIds = new Set(existing.map((stepRun) => stepRun.stepId));
  const missingSteps = steps.filter((step) => !existingStepIds.has(step.id));

  if (missingSteps.length > 0) {
    await db.insert(workflowStepRuns).values(
      missingSteps.map((step) => ({
        id: crypto.randomUUID(),
        workflowRunId: runId,
        stepId: step.id,
        status: "pending",
      })),
    );
  }

  if (missingSteps.length === 0) return existing;
  return db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));
}

function desiredStepRunStatusFromIssueStatus(issueStatus: string): "pending" | "running" | "completed" | "failed" {
  if (issueStatus === "done") return "completed";
  if (issueStatus === "blocked" || issueStatus === "cancelled") return "failed";
  if (issueStatus === "in_progress" || issueStatus === "in_review") return "running";
  return "pending";
}

async function syncStepRunsFromIssueState(
  db: Db,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  const issueIds = stepRuns
    .map((stepRun) => stepRun.issueId)
    .filter((issueId): issueId is string => Boolean(issueId));
  if (issueIds.length === 0) return stepRuns;

  const issueRows = await db
    .select({
      id: issues.id,
      status: issues.status,
      startedAt: issues.startedAt,
      completedAt: issues.completedAt,
      cancelledAt: issues.cancelledAt,
    })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));

  for (const stepRun of stepRuns) {
    if (!stepRun.issueId) continue;
    const issue = issueById.get(stepRun.issueId);
    if (!issue) continue;

    const desiredStatus = desiredStepRunStatusFromIssueStatus(issue.status);
    const patch: Partial<typeof workflowStepRuns.$inferInsert> = {};
    const now = new Date();

    if (desiredStatus !== stepRun.status) {
      patch.status = desiredStatus;
    }

    if (desiredStatus === "running") {
      patch.startedAt = stepRun.startedAt ?? issue.startedAt ?? now;
      patch.completedAt = null;
    } else if (desiredStatus === "completed") {
      patch.startedAt = stepRun.startedAt ?? issue.startedAt ?? now;
      patch.completedAt = issue.completedAt ?? now;
    } else if (desiredStatus === "failed") {
      patch.startedAt = stepRun.startedAt ?? issue.startedAt ?? now;
      patch.completedAt = issue.cancelledAt ?? issue.completedAt ?? now;
    } else {
      patch.startedAt = null;
      patch.completedAt = null;
    }

    if (Object.keys(patch).length === 0) continue;
    await db
      .update(workflowStepRuns)
      .set(patch)
      .where(eq(workflowStepRuns.id, stepRun.id));
  }

  return db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, stepRuns[0]!.workflowRunId));
}

async function createWorkflowStepIssue(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
}): Promise<string> {
  const issueSvc = issueService(input.db);
  const heartbeat = heartbeatService(input.db);

  const assigneeAgentId = typeof input.step.agentId === "string" && input.step.agentId.trim()
    ? input.step.agentId.trim()
    : undefined;

  const createdIssue = await issueSvc.create(input.run.companyId, {
    title: `${input.definition.name}: ${input.step.name}`,
    description: input.step.description || "",
    status: "todo",
    assigneeAgentId,
    missionId: input.run.missionId ?? null,
    originKind: "workflow_execution",
    originId: input.run.id,
    originRunId: input.run.id,
  });

  await applyIssueCreatedSideEffects({
    db: input.db,
    heartbeat,
    issue: createdIssue,
    actor: {
      actorType: "system",
      actorId: `workflow:${input.definition.id}`,
    },
    contextSource: "workflow.dispatch",
  });

  return createdIssue.id;
}

function buildStepRunMap(
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Map<string, typeof workflowStepRuns.$inferSelect> {
  return new Map(stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
}

function findRunnableSteps(
  steps: WorkflowStep[],
  stepRunMap: Map<string, typeof workflowStepRuns.$inferSelect>,
): WorkflowStep[] {
  return steps.filter((step) => {
    const stepRun = stepRunMap.get(step.id);
    if (!stepRun || stepRun.issueId || stepRun.status !== "pending") return false;
    return step.dependencies.every((dependencyId) => {
      const dependencyRun = stepRunMap.get(dependencyId);
      return dependencyRun ? WORKFLOW_STEP_SUCCESS_STATUSES.has(dependencyRun.status) : false;
    });
  });
}

function isIssueLessToolStep(step: WorkflowStep): boolean {
  const hasToolNames = Array.isArray(step.toolNames)
    && step.toolNames.some((toolName) => typeof toolName === "string" && toolName.trim().length > 0);
  const agentId = typeof step.agentId === "string" ? step.agentId.trim() : "";
  return hasToolNames && agentId.length === 0;
}

async function completeIssueLessStepRun(
  db: Db,
  stepRun: typeof workflowStepRuns.$inferSelect,
  now: Date,
): Promise<void> {
  await db
    .update(workflowStepRuns)
    .set({
      status: "completed",
      startedAt: stepRun.startedAt ?? now,
      completedAt: stepRun.completedAt ?? now,
    })
    .where(eq(workflowStepRuns.id, stepRun.id));
}

async function finalizeWorkflowRunState(
  db: Db,
  context: WorkflowExecutionContext,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<typeof workflowRuns.$inferSelect> {
  const hasFailedStep = stepRuns.some((stepRun) => stepRun.status === "failed");
  const hasActiveStep = stepRuns.some((stepRun) => !WORKFLOW_STEP_TERMINAL_STATUSES.has(stepRun.status));
  const allStepsTerminal = stepRuns.length === context.steps.length && !hasActiveStep;
  const nextStatus =
    hasFailedStep && allStepsTerminal
      ? "failed"
      : !hasFailedStep && allStepsTerminal
        ? "completed"
        : "running";
  const patch: Partial<typeof workflowRuns.$inferInsert> = {
    status: nextStatus,
    startedAt: context.run.startedAt ?? new Date(),
    completedAt: nextStatus === "completed" || nextStatus === "failed" ? new Date() : null,
  };

  const [updatedRun] = await db
    .update(workflowRuns)
    .set(patch)
    .where(eq(workflowRuns.id, context.run.id))
    .returning();

  return updatedRun ?? { ...context.run, ...patch } as typeof workflowRuns.$inferSelect;
}

export async function syncWorkflowRunState(
  db: Db,
  runId: string,
): Promise<WorkflowExecutionResult> {
  const context = await loadWorkflowExecutionContext(db, runId);
  let stepRuns = await ensureStepRunRecords(db, runId, context.steps);
  stepRuns = await syncStepRunsFromIssueState(db, stepRuns);

  const hasFailure = stepRuns.some((stepRun) => stepRun.status === "failed");
  if (hasFailure) {
    const unlaunchedPendingSteps = stepRuns.filter((stepRun) => stepRun.status === "pending" && stepRun.issueId == null);
    if (unlaunchedPendingSteps.length > 0) {
      const now = new Date();
      for (const stepRun of unlaunchedPendingSteps) {
        await db
          .update(workflowStepRuns)
          .set({ status: "skipped", completedAt: now })
          .where(eq(workflowStepRuns.id, stepRun.id));
      }
      stepRuns = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runId));
    }
  } else {
    let shouldContinue = true;
    while (shouldContinue) {
      shouldContinue = false;
      const stepRunMap = buildStepRunMap(stepRuns);
      const runnableSteps = findRunnableSteps(context.steps, stepRunMap);
      if (runnableSteps.length === 0) break;

      let completedIssueLessStep = false;
      for (const step of runnableSteps) {
        const stepRun = stepRunMap.get(step.id);
        if (!stepRun) continue;

        if (isIssueLessToolStep(step)) {
          await completeIssueLessStepRun(db, stepRun, new Date());
          completedIssueLessStep = true;
          continue;
        }

        const issueId = await createWorkflowStepIssue({
          db,
          run: context.run,
          definition: context.definition,
          step,
        });
        await db
          .update(workflowStepRuns)
          .set({ issueId })
          .where(eq(workflowStepRuns.id, stepRun.id));
      }

      stepRuns = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runId));

      shouldContinue = completedIssueLessStep;
    }
  }

  const updatedRun = await finalizeWorkflowRunState(db, context, stepRuns);

  return {
    runId,
    status: updatedRun.status as "running" | "completed" | "failed" | "cancelled",
    completedAt: updatedRun.completedAt ?? new Date(),
    error: updatedRun.status === "failed" ? "One or more workflow steps failed" : undefined,
    stepRuns: stepRuns.map((stepRun) => ({
      id: stepRun.id,
      workflowRunId: stepRun.workflowRunId,
      stepId: stepRun.stepId,
      issueId: stepRun.issueId,
      status: stepRun.status as "pending" | "running" | "completed" | "failed" | "skipped",
      startedAt: stepRun.startedAt,
      completedAt: stepRun.completedAt,
    })),
  };
}

export async function syncWorkflowRunForIssue(
  db: Db,
  issueId: string,
): Promise<WorkflowExecutionResult | null> {
  const issue = await db
    .select({
      originKind: issues.originKind,
      originRunId: issues.originRunId,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!issue || issue.originKind !== "workflow_execution" || !issue.originRunId) {
    return null;
  }

  return syncWorkflowRunState(db, issue.originRunId);
}

/**
 * Executes a workflow run.
 *
 * @param db - Database instance.
 * @param runId - The workflow run ID to execute.
 * @param tx - Optional transaction for atomic execution.
 * @returns Execution result.
 */
export async function executeWorkflowRun(
  db: Db,
  runId: string,
): Promise<WorkflowExecutionResult> {
  await db
    .update(workflowRuns)
    .set({
      status: "running",
      startedAt: new Date(),
      completedAt: null,
    })
    .where(eq(workflowRuns.id, runId));
  return syncWorkflowRunState(db, runId);
}

/**
 * Reconciles workflow state - checks for stuck runs and recovers them.
 *
 * @param db - Database instance.
 * @param timeoutMinutes - Consider runs stuck if older than this.
 */
export async function reconcileWorkflowRuns(
  db: Db,
  timeoutMinutes: number = 60,
): Promise<{ recovered: number; failed: number }> {
  const timeout = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  const stuckRuns = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.status, "running"),
        sql`${workflowRuns.startedAt} < ${timeout}`,
      ),
    );

  let recovered = 0;
  let failed = 0;

  for (const run of stuckRuns) {
    try {
      await db
        .update(workflowRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
        })
        .where(eq(workflowRuns.id, run.id));
      failed++;
    } catch (error) {
      recovered++;
    }
  }

  return { recovered, failed };
}
