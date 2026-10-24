// C04: all writes use the caller's transaction; this module never commits or executes effects.
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { issueComments, issues, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { and, asc, eq, like, sql } from "drizzle-orm";
import { stableStringify } from "../issue-execution-cards/hash.js";
import { isTerminalRunStatus, type TerminalStepRunRef } from "./run-terminal-boundary.js";
import { recordWorkflowStepStatusTransition } from "./workflow-sync-source.js";
import { captureFailureCascadeProvenance } from "./failure-cascade-provenance.js";

export type CascadeTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type FailureCascadeRun = Pick<typeof workflowRuns.$inferSelect,
  "id" | "companyId" | "missionId" | "status" | "dispatchAuthorityVersion">;
export type FailureCascadeStep = TerminalStepRunRef & { statusTransitionVersion: number };
export type DeadlockCascadeStep = FailureCascadeStep & Pick<typeof workflowStepRuns.$inferSelect, "dispatchReadyAt">;

type Observation = { run: FailureCascadeRun; boundaryEnabled: boolean } & (
  | { kind: "stuck"; pendingSteps: FailureCascadeStep[]; boundaryStepRuns: FailureCascadeStep[] }
  | { kind: "deadlock"; stepsToSkip: FailureCascadeStep[]; runSteps: DeadlockCascadeStep[]; mayFinalize: boolean }
);
type StepRow = typeof workflowStepRuns.$inferSelect;

function indexSteps(steps: readonly FailureCascadeStep[]): Map<string, FailureCascadeStep> | null {
  const ids = new Map<string, FailureCascadeStep>();
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id) || stepIds.has(step.stepId)) return null;
    ids.set(step.id, step);
    stepIds.add(step.stepId);
  }
  return ids;
}

function sameStep(current: FailureCascadeStep, observed: FailureCascadeStep): boolean {
  return current.id === observed.id && current.stepId === observed.stepId
    && current.status === observed.status && current.statusTransitionVersion === observed.statusTransitionVersion
    && current.issueId === observed.issueId
    && stableStringify(current.metadata) === stableStringify(observed.metadata);
}

function sameSet(current: readonly StepRow[], observed: readonly FailureCascadeStep[]): boolean {
  const indexed = indexSteps(observed);
  return indexed !== null && current.length === indexed.size
    && current.every(step => {
      const previous = indexed.get(step.id);
      return previous !== undefined && sameStep(step, previous);
    });
}

/** Run first, then every current step in stable order, then compare the original observations. */
export async function lockCascadeObservation(
  tx: CascadeTx, input: Observation,
): Promise<"current" | "classify" | "stale_observation"> {
  const { run } = input;
  const [current] = await tx.select().from(workflowRuns)
    .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.companyId, run.companyId))).for("update");
  if (!current) return "stale_observation";
  const steps = await tx.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, run.id))
    .orderBy(asc(workflowStepRuns.stepId), asc(workflowStepRuns.id)).for("update");
  if (current.companyId !== run.companyId || current.missionId !== run.missionId || run.status !== "running") {
    return "stale_observation";
  }
  const mayFinalize = input.kind === "stuck" || input.mayFinalize;
  if (input.boundaryEnabled && mayFinalize
    && (current.dispatchAuthorityVersion !== run.dispatchAuthorityVersion || isTerminalRunStatus(current.status))) {
    // No prefix writes. The real finalizer owns authority precedence and terminal conflicts.
    return "classify";
  }
  if (current.status !== "running" || current.dispatchAuthorityVersion !== run.dispatchAuthorityVersion) {
    return "stale_observation";
  }
  const currentById = indexSteps(steps);
  if (!currentById) return "stale_observation";
  const pending = steps.filter(step => step.status === "pending");
  if (input.kind === "stuck") {
    if (!sameSet(pending, input.pendingSteps)) return "stale_observation";
    if (input.boundaryEnabled || input.boundaryStepRuns.length > 0) {
      if (!sameSet(steps, input.boundaryStepRuns)) return "stale_observation";
    } else if (steps.some(step => step.status === "running")) {
      // OFF callers intentionally supply no full boundary snapshot.
      return "stale_observation";
    }
  } else {
    if (!sameSet(steps, input.runSteps)) return "stale_observation";
    if (input.runSteps.some(step => !("dispatchReadyAt" in step)
      || (step.dispatchReadyAt != null) !== ((steps.find(row => row.id === step.id)!).dispatchReadyAt != null))) {
      return "stale_observation";
    }
    const selected = indexSteps(input.stepsToSkip);
    if (!selected || input.stepsToSkip.some(step => {
      const row = currentById.get(step.id);
      return step.status !== "pending" || !row || !sameStep(row, step);
    }) || input.mayFinalize !== (pending.length === selected.size)) return "stale_observation";
  }
  return "current";
}

export async function writeStuckCascade(
  tx: CascadeTx, run: FailureCascadeRun, pendingSteps: FailureCascadeStep[], now: Date,
): Promise<void> {
  const provenance = await captureFailureCascadeProvenance(tx, run, pendingSteps, "workflow_reconciler");
  for (const step of pendingSteps) {
    const metadata = step.metadata && typeof step.metadata === "object" && !Array.isArray(step.metadata)
      ? step.metadata as Record<string, unknown> : {};
    const [updated] = await tx.update(workflowStepRuns)
      .set({ status: "skipped", completedAt: now, metadata: { ...metadata, failureCascadeSkipped: true,
        failureCascadeProvenance: provenance.get(step.id)! } })
      .where(eq(workflowStepRuns.id, step.id))
      .returning({ id: workflowStepRuns.id, transitionVersion: workflowStepRuns.statusTransitionVersion });
    if (updated) {
      await recordWorkflowStepStatusTransition(tx, {
        companyId: run.companyId,
        missionId: run.missionId,
        workflowRunId: run.id,
        workflowStepRunId: step.id,
        issueId: step.issueId,
        fromStatus: step.status,
        toStatus: "skipped",
        source: "workflow_reconciler",
        transitionVersion: updated.transitionVersion > step.statusTransitionVersion ? updated.transitionVersion : null,
      });
    }
  }
}

export async function writeDeadlockCascade(
  tx: CascadeTx, run: FailureCascadeRun, stepsToSkip: FailureCascadeStep[], now: Date,
): Promise<void> {
  const provenance = await captureFailureCascadeProvenance(tx, run, stepsToSkip, "workflow_deadlock_reconciler");
  for (const step of stepsToSkip) {
    const priorMetadata = (step.metadata as Record<string, unknown> | null) ?? {};
    const [updated] = await tx.update(workflowStepRuns)
      .set({ status: "skipped", completedAt: now, metadata: { ...priorMetadata, controlFlowSkipped: true,
        failureCascadeProvenance: provenance.get(step.id)! } })
      .where(eq(workflowStepRuns.id, step.id))
      .returning({ id: workflowStepRuns.id, transitionVersion: workflowStepRuns.statusTransitionVersion });
    if (updated) {
      await recordWorkflowStepStatusTransition(tx, {
        companyId: run.companyId,
        missionId: run.missionId,
        workflowRunId: run.id,
        workflowStepRunId: step.id,
        issueId: step.issueId,
        fromStatus: step.status,
        toStatus: "skipped",
        source: "workflow_deadlock_reconciler",
        transitionVersion: updated.transitionVersion > step.statusTransitionVersion ? updated.transitionVersion : null,
      });
    }
    if (step.issueId) {
      await blockIssueOnDeadlock(tx, { issueId: step.issueId, companyId: run.companyId, runId: run.id, stepId: step.id });
    }
  }
}

const DEADLOCK_COMMENT_MARKER = "control-plane-deadlock";

async function blockIssueOnDeadlock(
  db: CascadeTx,
  input: { issueId: string; companyId: string; runId: string; stepId: string },
) {
  const marker = `[${DEADLOCK_COMMENT_MARKER}:${input.runId}:${input.stepId}]`;
  const issue = await db
    .select({ status: issues.status, language: sql<string>`(select default_language from companies where id = ${issues.companyId})` })
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
    body: `unreachable: upstream step failed; replan or cancel ${marker}\n${issue.language === "ko" ? "선행 단계 실패로 이 단계를 실행할 수 없습니다. 다음 행동: 실패한 의존 업무를 확인한 뒤 수정 계획을 제출하거나 업무를 취소해 주세요. 이 차단은 재시도를 요청하지 않습니다." : "The upstream failure prevents this step from running. Next action: review the failed dependency, then submit a revised plan or cancel the work. This block does not request a retry."}`,
    createdAt: now,
    updatedAt: now,
  });
}
