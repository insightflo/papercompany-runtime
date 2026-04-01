/**
 * DAG Engine
 *
 * Validates and executes Directed Acyclic Graph (DAG) workflows.
 * A workflow is a DAG where each step has dependencies on other steps.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Transaction } from "drizzle-orm";
import type { Db } from "../../packages/db/src/client.js";
import { workflowDefinitions, workflowRuns, workflowStepRuns, issues } from "../../packages/db/src/schema/index.js";
import type { WorkflowStep, DagValidationResult, WorkflowExecutionResult } from "./types.js";

/**
 * Workflow step definition.
 */
export interface WorkflowStep {
  id: string;
  name: string;
  agentId: string;
  dependencies: string[]; // step IDs this step depends on
  description?: string;
}

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
  tx?: Transaction,
): Promise<WorkflowExecutionResult> {
  const executor = tx || db;

  // Fetch workflow run with definition
  const runResult = await executor
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

  const steps: WorkflowStep[] = (definition.stepsJson as unknown[]) || [];

  // Update run status to running
  await executor
    .update(workflowRuns)
    .set({
      status: "running",
      startedAt: new Date(),
    })
    .where(eq(workflowRuns.id, runId));

  // Create step run records
  for (const step of steps) {
    await executor.insert(workflowStepRuns).values({
      id: crypto.randomUUID(),
      workflowRunId: runId,
      stepId: step.id,
      status: "pending",
    });
  }

  // Execute steps in dependency order (simplified - real impl would use topological sort)
  const stepRuns: typeof workflowStepRuns.$inferSelect[] = [];
  let hasFailure = false;

  // Simple execution: execute pending steps whose deps are satisfied
  const pendingSteps = steps.filter((s) => s.dependencies.length === 0);

  for (const step of pendingSteps) {
    const stepRunId = crypto.randomUUID();

    try {
      // Create issue for this step
      const issueResult = await executor
        .insert(issues)
        .values({
          id: crypto.randomUUID(),
          companyId: run.companyId,
          title: `${definition.name}: ${step.name}`,
          description: step.description || "",
          status: "todo",
          originKind: "workflow_execution",
          originId: runId,
          assigneeAgentId: step.agentId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      const issueId = issueResult[0]?.id;

      // Update step run
      await executor
        .insert(workflowStepRuns)
        .values({
          id: stepRunId,
          workflowRunId: runId,
          stepId: step.id,
          issueId: issueId || null,
          status: "pending",
        })
        .onConflictDoNothing();

      stepRuns.push({
        id: stepRunId,
        workflowRunId: runId,
        stepId: step.id,
        issueId: issueId || null,
        status: "pending",
        startedAt: null,
        completedAt: null,
      });
    } catch (error) {
      hasFailure = true;
      // Continue to next step instead of failing immediately
    }
  }

  // Update run status
  const finalStatus = hasFailure ? "failed" : "completed";
  await executor
    .update(workflowRuns)
    .set({
      status: finalStatus,
      completedAt: new Date(),
    })
    .where(eq(workflowRuns.id, runId));

  return {
    runId,
    status: finalStatus,
    completedAt: new Date(),
    error: hasFailure ? "One or more steps failed" : undefined,
    stepRuns: stepRuns.map((sr) => ({
      ...sr,
      status: sr.status as "pending" | "running" | "completed" | "failed" | "skipped",
    })),
  };
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
