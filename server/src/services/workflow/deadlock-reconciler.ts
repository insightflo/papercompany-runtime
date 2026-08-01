import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueComments, issues, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { and, eq, inArray, like, lt, sql } from "drizzle-orm";
import { classifyStepActivation, workflowHasConditionalEdges } from "./control-flow/edge-condition.js";
import {
  buildWorkflowExecutionSteps,
  getWorkflowLaunchSteps,
  isDynamicOwnerPlanWorkflowDefinition,
} from "./dag-engine.js";
import { buildPredFactsMap, buildStepRunMap } from "./reconciler-edge-helpers.js";
import type { ReconciliationResult } from "./reconciler.js";
import { hasActiveWorkflowReworkIteration } from "./rework-liveness.js";
import { recordWorkflowStepStatusTransition } from "./workflow-sync-source.js";
import { isHeartbeatFinalizationV1Enabled } from "../heartbeat-finalization/flag.js";

const DEADLOCK_COMMENT_MARKER = "control-plane-deadlock";

export async function reconcileDeadlockedWorkflowRuns(
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
      if (await hasActiveWorkflowStep(db, run.id)) continue;

      const runSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
      const pending = runSteps.filter((step) => step.status === "pending");
      const hasFailedPredecessor = runSteps.some((step) => step.status === "failed");
      if (pending.length === 0 || !hasFailedPredecessor) continue;

      const linkedIssueIds = pending
        .map((step) => step.issueId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const linkedIssueRows = linkedIssueIds.length > 0
        ? await db.select({ id: issues.id, status: issues.status }).from(issues).where(inArray(issues.id, linkedIssueIds))
        : [];
      if (linkedIssueRows.some((issue) => issue.status === "in_review")) continue;
      const issueStatusById = new Map(linkedIssueRows.map((issue) => [issue.id, issue.status]));

      const definition = await db
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, run.workflowId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!definition) continue;

      const steps = buildWorkflowExecutionSteps(definition);
      const stepById = new Map(steps.map((step) => [step.id, step]));
      const v1Enforcement = await isHeartbeatFinalizationV1Enabled(db);
      const predsByStepId = buildPredFactsMap(steps, buildStepRunMap(runSteps), undefined, v1Enforcement);
      const hasConditionalEdges = workflowHasConditionalEdges(steps);
      const dynamicOwnerPlan = isDynamicOwnerPlanWorkflowDefinition({
        name: definition.name,
        executionMode: definition.executionMode,
        dynamicPlanBootstrapOnly: definition.dynamicPlanBootstrapOnly,
        steps,
      });
      const launchStepIds = dynamicOwnerPlan
        ? new Set(getWorkflowLaunchSteps(steps, { dynamicOwnerPlan }).map((step) => step.id))
        : undefined;

      const hasProgressCandidate = pending.some((step) => {
        const stepDef = stepById.get(step.stepId);
        if (!stepDef) return true;
        if (!classifyStepActivation(stepDef, predsByStepId).runnable) return false;
        if (step.issueId) return issueStatusById.get(step.issueId) === "todo";
        if (launchStepIds && !launchStepIds.has(stepDef.id)) return false;
        return hasConditionalEdges;
      });
      if (hasProgressCandidate) continue;

      const now = new Date();
      for (const step of pending) {
        const priorMetadata = (step.metadata as Record<string, unknown> | null) ?? {};
        const [updated] = await db
          .update(workflowStepRuns)
          .set({ status: "skipped", completedAt: now, metadata: { ...priorMetadata, controlFlowSkipped: true } })
          .where(eq(workflowStepRuns.id, step.id))
          .returning({
            id: workflowStepRuns.id,
            transitionVersion: workflowStepRuns.statusTransitionVersion,
          });
        if (updated) {
          await recordWorkflowStepStatusTransition(db, {
            companyId: run.companyId,
            missionId: run.missionId,
            workflowRunId: run.id,
            workflowStepRunId: step.id,
            issueId: step.issueId,
            fromStatus: step.status,
            toStatus: "skipped",
            source: "workflow_deadlock_reconciler",
            transitionVersion: updated.transitionVersion > step.statusTransitionVersion
              ? updated.transitionVersion
              : null,
          });
        }
        if (step.issueId) {
          await blockIssueOnDeadlock(db, {
            issueId: step.issueId,
            companyId: run.companyId,
            runId: run.id,
            stepId: step.id,
          });
        }
      }

      await db.update(workflowRuns).set({ status: "failed", completedAt: now }).where(eq(workflowRuns.id, run.id));
      results.push({
        runId: run.id,
        action: "recovered",
        reason: "Deadlock: no runnable/no active step + failed predecessor; converged without 60-min wait",
      });
    } catch (error) {
      results.push({ runId: run.id, action: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

async function hasActiveWorkflowStep(db: Db, workflowRunId: string) {
  return db
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, workflowRunId),
      sql`(
        ${workflowStepRuns.status} = 'running'
        OR EXISTS (
          SELECT 1 FROM ${issues}
          WHERE ${issues.id} = ${workflowStepRuns.issueId}
            AND ${issues.status} IN ('in_progress', 'in_review')
        )
        OR EXISTS (
          SELECT 1 FROM ${heartbeatRuns}
          WHERE ${heartbeatRuns.issueId} = ${workflowStepRuns.issueId}
            AND ${heartbeatRuns.status} IN ('queued', 'running')
        )
      )`,
    ))
    .limit(1)
    .then((rows) => Boolean(rows[0]));
}

async function blockIssueOnDeadlock(
  db: Db,
  input: { issueId: string; companyId: string; runId: string; stepId: string },
) {
  const marker = `[${DEADLOCK_COMMENT_MARKER}:${input.runId}:${input.stepId}]`;
  const issue = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!issue || issue.status === "blocked" || issue.status === "done" || issue.status === "cancelled") return;

  const existing = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(and(eq(issueComments.issueId, input.issueId), like(issueComments.body, `%${marker}%`)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return;

  const now = new Date();
  await db.update(issues).set({ status: "blocked", updatedAt: now }).where(eq(issues.id, input.issueId));
  await db.insert(issueComments).values({
    id: randomUUID(),
    companyId: input.companyId,
    issueId: input.issueId,
    authorUserId: null,
    body: `unreachable: upstream step failed; replan or cancel ${marker}`,
    createdAt: now,
    updatedAt: now,
  });
}
