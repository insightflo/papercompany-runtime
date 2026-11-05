import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { OriginalWorkflowAuthority } from "../plugin-tool-execution-receipt.js";
import type { WorkflowStep } from "./dag-engine.js";

const ORPHANED_TOOL_CLAIM_GRACE_MS = 5 * 60_000;
const ORPHANED_TOOL_CLAIM_MIN_AGE_MS = 15 * 60_000;

export type OrphanedWorkflowToolClaim = {
  stepRun: typeof workflowStepRuns.$inferSelect;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
};

export type OrphanedWorkflowToolClaimWork = {
  step: WorkflowStep;
  requestId: string;
  toolName: string;
  args: unknown;
  timeoutMs: number;
  correction?: unknown;
};

export type OrphanedWorkflowToolClaimWrite = (
  writer: Db,
  run: typeof workflowRuns.$inferSelect,
  stepRun: typeof workflowStepRuns.$inferSelect | undefined,
) => Promise<boolean>;

export interface OrphanedWorkflowToolClaimDependencies {
  prepare(candidate: OrphanedWorkflowToolClaim): Promise<OrphanedWorkflowToolClaimWork | null>;
  fail(input: {
    db: Db;
    run: typeof workflowRuns.$inferSelect;
    stepRun: typeof workflowStepRuns.$inferSelect;
    work: OrphanedWorkflowToolClaimWork;
    now: Date;
    error: string;
  }): Promise<void>;
  sync(runId: string): Promise<void>;
  withCorrectionAuthority?(
    candidate: OrphanedWorkflowToolClaim,
    work: OrphanedWorkflowToolClaimWork,
    write: OrphanedWorkflowToolClaimWrite,
  ): Promise<boolean | null>;
}

export function captureWorkflowToolStepOriginalAuthority(input: {
  run: typeof workflowRuns.$inferSelect;
  stepRun: typeof workflowStepRuns.$inferSelect;
  requestId: string;
}): OriginalWorkflowAuthority {
  if (input.run.status !== "running" || input.stepRun.status !== "running"
    || !input.stepRun.lastDispatchAcceptedAt || input.stepRun.lastDispatchRequestId !== input.requestId) {
    throw new Error("workflow_tool_claim_authority_missing");
  }
  return {
    missionId: input.run.missionId,
    workflowRunId: input.stepRun.workflowRunId,
    stepRunId: input.stepRun.id,
    stepId: input.stepRun.stepId,
    requestId: input.requestId,
    executionGeneration: input.stepRun.executionGeneration,
    statusTransitionVersion: input.stepRun.statusTransitionVersion,
    runStatus: "running",
    stepStatus: "running",
    acceptedAt: input.stepRun.lastDispatchAcceptedAt.toISOString(),
  };
}

export function workflowToolQueueCandidate() {
  return or(isNull(workflowStepRuns.issueId), sql`exists (
    select 1 from ${workflowTransitionEvents}
    where ${workflowTransitionEvents.companyId} = ${workflowRuns.companyId}
      and ${workflowTransitionEvents.workflowRunId} = ${workflowRuns.id}
      and ${workflowTransitionEvents.workflowStepRunId} = ${workflowStepRuns.id}
      and ${workflowTransitionEvents.issueId} = ${workflowStepRuns.issueId}
      and ${workflowTransitionEvents.eventType} = 'qa_correction_followup_requested'
  )`);
}

/** Any stored marker, even null or malformed, means the reaper cannot prove this claim was unretained. */
export function hasRetainedCompletionMarker(metadata: unknown): boolean {
  const root = isRecord(metadata) ? metadata : {};
  const invocation = isRecord(root.toolInvocation) ? root.toolInvocation : {};
  return Object.prototype.hasOwnProperty.call(invocation, "retainedCompletion");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function metadataRecord(metadata: unknown, key: string): Record<string, unknown> {
  const root = isRecord(metadata) ? metadata : {};
  return isRecord(root[key]) ? root[key] : {};
}

function sameTime(left: Date | null, right: Date | null): boolean {
  return left === null || right === null ? left === right : left.getTime() === right.getTime();
}

function matchesOriginalClaim(
  candidate: OrphanedWorkflowToolClaim,
  work: OrphanedWorkflowToolClaimWork,
  run: typeof workflowRuns.$inferSelect,
  stepRun: typeof workflowStepRuns.$inferSelect | undefined,
): stepRun is typeof workflowStepRuns.$inferSelect {
  if (!stepRun || run.id !== candidate.run.id || run.companyId !== candidate.run.companyId
    || run.missionId !== candidate.run.missionId || run.status !== "running"
    || stepRun.id !== candidate.stepRun.id || stepRun.workflowRunId !== run.id
    || stepRun.stepId !== candidate.stepRun.stepId || stepRun.status !== "running"
    || stepRun.lastDispatchErrorAt !== null || stepRun.lastDispatchRequestId !== work.requestId
    || stepRun.executionGeneration !== candidate.stepRun.executionGeneration
    || stepRun.statusTransitionVersion !== candidate.stepRun.statusTransitionVersion
    || !sameTime(stepRun.lastDispatchAcceptedAt, candidate.stepRun.lastDispatchAcceptedAt)
    || hasRetainedCompletionMarker(stepRun.metadata)) return false;
  return metadataRecord(stepRun.metadata, "toolInvocation").requestId === work.requestId;
}

async function withCanonicalClaimLocks<T>(
  db: Db,
  candidate: OrphanedWorkflowToolClaim,
  write: (writer: Db, run: typeof workflowRuns.$inferSelect, stepRun: typeof workflowStepRuns.$inferSelect | undefined) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    if (candidate.run.missionId) {
      const [mission] = await tx.select().from(missions).where(and(
        eq(missions.id, candidate.run.missionId),
        eq(missions.companyId, candidate.run.companyId),
      )).for("update");
      if (!mission) return null;
    }
    const [run] = await tx.select().from(workflowRuns).where(and(
      eq(workflowRuns.id, candidate.run.id), eq(workflowRuns.companyId, candidate.run.companyId),
    )).for("update");
    if (!run || run.missionId !== candidate.run.missionId) return null;
    const steps = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id))
      .orderBy(asc(workflowStepRuns.stepId), asc(workflowStepRuns.id)).for("update");
    return write(tx as unknown as Db, run, steps.find((step) => step.id === candidate.stepRun.id));
  });
}

export async function reconcileOrphanedWorkflowToolStepClaims(
  db: Db,
  options: { limit?: number; now?: Date },
  dependencies: OrphanedWorkflowToolClaimDependencies,
): Promise<{ orphanedCount: number; skippedCount: number }> {
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const now = options.now ?? new Date();
  const minAgeCutoff = new Date(now.getTime() - ORPHANED_TOOL_CLAIM_MIN_AGE_MS);
  const candidates = await db.select({ stepRun: workflowStepRuns, run: workflowRuns, definition: workflowDefinitions })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(eq(workflowRuns.status, "running"), eq(workflowStepRuns.status, "running"), workflowToolQueueCandidate(),
      isNull(workflowStepRuns.lastDispatchErrorAt), isNotNull(workflowStepRuns.lastDispatchAcceptedAt),
      isNotNull(workflowStepRuns.lastDispatchRequestId), lte(workflowStepRuns.lastDispatchAcceptedAt, minAgeCutoff),
      sql`not coalesce(
        jsonb_typeof(${workflowStepRuns.metadata} -> 'toolInvocation') = 'object'
        and (${workflowStepRuns.metadata} -> 'toolInvocation') ? 'retainedCompletion', false)`))
    .orderBy(asc(workflowStepRuns.lastDispatchAcceptedAt)).limit(limit);

  let orphanedCount = 0;
  let skippedCount = 0;
  for (const candidate of candidates) {
    if (hasRetainedCompletionMarker(candidate.stepRun.metadata)) {
      skippedCount += 1;
      continue;
    }
    const work = await dependencies.prepare(candidate);
    const acceptedAt = candidate.stepRun.lastDispatchAcceptedAt;
    if (!work || !acceptedAt) {
      skippedCount += 1;
      continue;
    }
    const ageMs = now.getTime() - acceptedAt.getTime();
    if (ageMs < work.timeoutMs + ORPHANED_TOOL_CLAIM_GRACE_MS) {
      skippedCount += 1;
      continue;
    }
    const error = `Workflow tool step claim orphaned: no completion since claim at ${acceptedAt.toISOString()} (age ${Math.round(ageMs / 1000)}s exceeded timeout ${work.timeoutMs}ms + ${ORPHANED_TOOL_CLAIM_GRACE_MS}ms grace). Executor restart or stuck dispatch; failed by orphan-claim reaper so onFailure/rerun recovery can proceed.`;
    const write: OrphanedWorkflowToolClaimWrite = async (writer, run, stepRun) => {
      if (!matchesOriginalClaim(candidate, work, run, stepRun)) return false;
      await dependencies.fail({ db: writer, run, stepRun, work, now, error });
      return true;
    };
    const changed = work.correction !== undefined && dependencies.withCorrectionAuthority
      ? await dependencies.withCorrectionAuthority(candidate, work, write)
      : work.correction !== undefined
      ? null
      : await withCanonicalClaimLocks(db, candidate, write);
    if (changed !== true) {
      skippedCount += 1;
      continue;
    }
    await dependencies.sync(candidate.run.id);
    orphanedCount += 1;
  }
  return { orphanedCount, skippedCount };
}
