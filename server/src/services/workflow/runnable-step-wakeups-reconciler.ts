import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import { classifyStepActivation } from "./control-flow/edge-condition.js";
import {
  buildWorkflowExecutionSteps,
  getWorkflowLaunchSteps,
  isDynamicOwnerPlanWorkflowDefinition,
  wakeExistingWorkflowStepIssue,
} from "./dag-engine.js";
import { buildPredFactsMap, buildStepRunMap } from "./reconciler-edge-helpers.js";
import type { ReconciliationResult } from "./reconciler.js";
import { hasActiveWorkflowReworkIteration } from "./rework-liveness.js";

export async function reconcileRunnableWorkflowStepWakeups(
  db: Db,
  settlingMinutes: number = 5,
): Promise<ReconciliationResult[]> {
  const settlingCutoff = new Date(Date.now() - settlingMinutes * 60 * 1000);
  const candidates = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.status, "running"), lt(workflowRuns.startedAt, settlingCutoff)));

  const results: ReconciliationResult[] = [];
  for (const run of candidates) {
    try {
      if (await hasActiveWorkflowReworkIteration(db, {
        companyId: run.companyId,
        workflowRunId: run.id,
      })) continue;

      const runSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
      const pending = runSteps.filter((step) => step.status === "pending" && step.issueId);
      if (pending.length === 0) continue;

      const definition = await db
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, run.workflowId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!definition) continue;

      const steps = buildWorkflowExecutionSteps(definition);
      const stepById = new Map(steps.map((step) => [step.id, step]));
      const predsByStepId = buildPredFactsMap(steps, buildStepRunMap(runSteps));
      const dynamicOwnerPlan = isDynamicOwnerPlanWorkflowDefinition({
        name: definition.name,
        executionMode: definition.executionMode,
        dynamicPlanBootstrapOnly: definition.dynamicPlanBootstrapOnly,
        steps,
      });
      const launchStepIds = dynamicOwnerPlan
        ? new Set(getWorkflowLaunchSteps(steps, { dynamicOwnerPlan }).map((step) => step.id))
        : undefined;

      const linkedIssueIds = pending
        .map((step) => step.issueId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const linkedIssueRows = linkedIssueIds.length > 0
        ? await db.select({ id: issues.id, status: issues.status }).from(issues).where(inArray(issues.id, linkedIssueIds))
        : [];
      const issueStatusById = new Map(linkedIssueRows.map((issue) => [issue.id, issue.status]));

      for (const stepRun of pending) {
        if (!stepRun.issueId) continue;
        if (issueStatusById.get(stepRun.issueId) !== "todo") continue;
        const step = stepById.get(stepRun.stepId);
        if (!step) continue;
        if (launchStepIds && !launchStepIds.has(step.id)) continue;
        if (!classifyStepActivation(step, predsByStepId).runnable) continue;
        if (await hasActiveHeartbeat(db, stepRun.issueId)) continue;
        if (await hasActiveWakeup(db, run.companyId, stepRun.issueId, run.id)) continue;

        const queued = await wakeExistingWorkflowStepIssue({ db, run, definition, step, issueId: stepRun.issueId });
        if (queued) {
          results.push({
            runId: run.id,
            action: "recovered",
            reason: `Queued missing workflow_resume wakeup for runnable step ${stepRun.stepId}`,
          });
        }
      }
    } catch (error) {
      results.push({ runId: run.id, action: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

async function hasActiveHeartbeat(db: Db, issueId: string) {
  return db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.issueId, issueId), inArray(heartbeatRuns.status, ["queued", "running"])))
    .limit(1)
    .then((rows) => Boolean(rows[0]));
}

async function hasActiveWakeup(db: Db, companyId: string, issueId: string, workflowRunId: string) {
  return db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.issueId, issueId),
      eq(agentWakeupRequests.workflowRunId, workflowRunId),
      inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
    ))
    .limit(1)
    .then((rows) => Boolean(rows[0]));
}
