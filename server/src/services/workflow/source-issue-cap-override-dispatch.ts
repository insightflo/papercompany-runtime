import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { issues, workflowDefinitions, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { wakeExistingWorkflowStepIssue } from "./dag-engine.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { findAcceptedWakeProof, hasCurrentCapOverrideAuthority, validateOwnerDecisionComment } from "./source-issue-cap-override-authority.js";
import { casRestoreCapOverrideSnapshot, parseCapOverridePriorSnapshot, restoreCapOverrideSnapshotInTransaction } from "./source-issue-cap-override-snapshot.js";
import { enqueueCapOverrideWake } from "./source-issue-cap-override-wake.js";
import { lockCapRecovery } from "./cap-recovery-safety.js";
import type { SourceIssueNativeResumeOutcome } from "./source-issue-native-resume.js";

const str = (value: unknown): string | null => typeof value === "string" ? value : null;
const num = (value: unknown): number | null => typeof value === "number" ? value : null;
const rec = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const P = workflowTransitionEvents.payload;

interface CapDispatchContext {
  companyId: string; auditId: string; auditIdempotencyKey: string; payload: Record<string, unknown>;
  wakeKey: string; wakeFn?: typeof wakeExistingWorkflowStepIssue; allowBlockedIssue: boolean;
  mode: "fresh" | "recover" | "atomic"; afterClaim?: () => Promise<void>;
}

/** Participates in the caller's transaction; never opens a new connection or catches refusal. */
export async function acceptCapOverrideInTransaction(db: Db, ctx: Omit<CapDispatchContext, "mode" | "afterClaim">): Promise<SourceIssueNativeResumeOutcome> {
  return executeCapOverride(db, { ...ctx, mode: "atomic" }, (accept) => accept(db));
}

export async function dispatchCapOverrideWake(db: Db, ctx: CapDispatchContext): Promise<SourceIssueNativeResumeOutcome> {
  return executeCapOverride(db, ctx, (accept) => db.transaction((tx) => accept(tx as unknown as Db)));
}

async function executeCapOverride(db: Db, ctx: CapDispatchContext,
  transact: (accept: (tx: Db) => Promise<SourceIssueNativeResumeOutcome>) => Promise<SourceIssueNativeResumeOutcome>,
): Promise<SourceIssueNativeResumeOutcome> {
  const payload = ctx.payload, runId = str(payload.workflowRunId), stepRunId = str(payload.producerStepRunId);
  const stepId = str(payload.producerStepId), producerIssueId = str(payload.producerIssueId);
  const rollback: SourceIssueNativeResumeOutcome = { kind: "report_only", reason: "cap_override_queue_rolled_back",
    workflowRunId: runId, workflowStepRunId: stepRunId, stepId };
  const refused: SourceIssueNativeResumeOutcome = { ...rollback, reason: "wake_rejected" };
  const already = (): SourceIssueNativeResumeOutcome => ({ kind: "cap_override_already_applied", ownerActionIssueId: str(payload.ownerActionIssueId) ?? "" });
  if (!runId || !stepRunId || !producerIssueId) return refused;
  // Validate captured definition before writes; snapshot corruption remains a surfaced error.
  await loadExecutionDefinition(db, runId, { requireHistorical: false });
  const toIteration = num(payload.toIteration), cleanedMetadata = rec(payload.producerCleanedMetadata);
  const priorSnapshot = parseCapOverridePriorSnapshot(payload.priorSnapshot);
  const forwardedIssueUpdatedAt = str(payload.forwardedIssueUpdatedAt);
  const restoreInput = priorSnapshot && cleanedMetadata && forwardedIssueUpdatedAt && toIteration !== null ? {
    companyId: ctx.companyId, snapshot: priorSnapshot, cleanedMetadata, toIteration, forwardedIssueUpdatedAt,
    auditIdempotencyKey: ctx.auditIdempotencyKey, auditPayload: payload,
  } : null;
  let failureReason = "fenced_transaction_failed";
  try {
    // Test interruption boundary is before locks. No independently committed audit lease can
    // survive a rejected run/mission check or invert the mission→run→step→audit lock order.
    await ctx.afterClaim?.();
    return await transact(async (tx): Promise<SourceIssueNativeResumeOutcome> => {
      const t = tx as unknown as Db;
      // Exact accepted replay is read-only; never use its receipt to start the source again.
      const [observed] = await tx.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.id, ctx.auditId), eq(workflowTransitionEvents.companyId, ctx.companyId)));
      if (observed?.payload?.status === "accepted") {
        const proof = await findAcceptedWakeProof(t, ctx.companyId, ctx.wakeKey, { workflowRunId: runId, stepRunId, issueId: producerIssueId }, str(observed.payload.acceptedWakeupRequestId) ?? "");
        return proof ? already() : refused;
      }
      const { run, steps } = await lockCapRecovery(t, ctx.companyId, runId);
      const token = randomUUID(), observedStatus = str(payload.status) ?? "pending";
      const claimPayload = { ...payload, status: "dispatching", dispatchToken: token,
        dispatchEpoch: (num(payload.dispatchEpoch) ?? 0) + 1, dispatchStartedAt: new Date().toISOString() };
      const claimed = await tx.update(workflowTransitionEvents).set({ payload: claimPayload }).where(and(
        eq(workflowTransitionEvents.id, ctx.auditId), eq(workflowTransitionEvents.companyId, ctx.companyId),
        eq(workflowTransitionEvents.idempotencyKey, ctx.auditIdempotencyKey),
        sql`${P}->>'status' = ${observedStatus}`,
        observedStatus === "dispatching" ? sql`${P}->>'dispatchToken' IS NOT DISTINCT FROM ${str(payload.dispatchToken)}` : sql`true`,
        observedStatus === "dispatching" ? sql`${P}->>'dispatchEpoch' IS NOT DISTINCT FROM ${String(num(payload.dispatchEpoch) ?? "")}` : sql`true`,
        observedStatus === "dispatching" ? sql`${P}->>'dispatchStartedAt' IS NOT DISTINCT FROM ${str(payload.dispatchStartedAt)}` : sql`true`,
      )).returning();
      if (!claimed.length) throw new Error("cap_override_claim_lost");
      const stepRun = steps.find((s) => s.id === stepRunId);
      const [definition] = await tx.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.id, run.workflowId), eq(workflowDefinitions.companyId, ctx.companyId)));
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, producerIssueId), eq(issues.companyId, ctx.companyId))).for("update");
      const execution = await loadExecutionDefinition(tx, run.id, { requireHistorical: false });
      const producerStep = execution.steps.find((s) => s.id === stepId);
      const [shape] = stepRun && cleanedMetadata ? await tx.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
        .where(and(eq(workflowStepRuns.id, stepRun.id), eq(workflowStepRuns.metadata, cleanedMetadata))) : [];
      const shapeOk = shape && stepRun && definition && producerStep && issue && restoreInput && priorSnapshot
        && priorSnapshot.run.id === run.id && priorSnapshot.run.status === "failed"
        && priorSnapshot.stepRun.id === stepRun.id && priorSnapshot.stepRun.status === "completed"
        && priorSnapshot.stepRun.iterationIndex === num(payload.fromIteration) && toIteration === priorSnapshot.stepRun.iterationIndex + 1
        && priorSnapshot.issue.id === issue.id && run.status === "running" && run.missionId === str(payload.missionId)
        && run.workflowId === str(payload.workflowDefinitionId) && run.startedAt?.toISOString() === priorSnapshot.run.startedAt && !run.completedAt
        && stepRun.issueId === issue.id && stepRun.stepId === stepId && stepRun.status === "pending" && stepRun.iterationIndex === toIteration
        && !stepRun.startedAt && !stepRun.completedAt && !stepRun.lastDispatchAttemptAt && !stepRun.lastDispatchAcceptedAt
        && !stepRun.lastDispatchErrorAt && !stepRun.lastDispatchErrorSummary && !stepRun.lastDispatchRequestId
        && issue.missionId === run.missionId && issue.status === "todo" && !issue.completedAt
        && issue.updatedAt.toISOString() === forwardedIssueUpdatedAt;
      if (!shapeOk) { failureReason = "post_forward_shape_mismatch"; throw new Error(failureReason); }
      const authority = await hasCurrentCapOverrideAuthority(t, ctx.companyId, payload);
      const decision = authority && await validateOwnerDecisionComment(t, ctx.companyId, {
        decisionCommentId: str(payload.decisionCommentId) ?? "", ownerActionIssueId: str(payload.ownerActionIssueId) ?? "",
        missionOwnerAgentId: str(payload.missionOwnerAgentId) ?? "", producerIssueId, producerIdentifier: issue.identifier,
        producerCompletedAt: str(payload.producerCompletedAt) ? new Date(str(payload.producerCompletedAt)!) : null,
      });
      if (!authority || !decision) {
        if (ctx.mode === "atomic") throw new Error(authority ? "decision_revalidation_failed" : "current_authority_invalid");
        await restoreCapOverrideSnapshotInTransaction(t, { ...restoreInput, dispatchToken: token,
          rollbackReason: authority ? "decision_revalidation_failed" : "current_authority_invalid" });
        return rollback;
      }
      const proof = await findAcceptedWakeProof(t, ctx.companyId, ctx.wakeKey, { workflowRunId: run.id, stepRunId, issueId: issue.id });
      const queued = await enqueueCapOverrideWake({ db: t, companyId: ctx.companyId, wakeKey: ctx.wakeKey,
        run, definition, step: producerStep, stepRunId, stepRunMetadata: cleanedMetadata!, issueId: issue.id,
        allowBlockedIssue: ctx.allowBlockedIssue, existingProofId: proof?.id ?? null, wakeFn: ctx.wakeFn });
      if (!queued.proof) { failureReason = queued.failureReason; throw new Error(failureReason); }
      await tx.update(workflowTransitionEvents).set({ payload: { ...claimPayload, status: "accepted", acceptedWakeupRequestId: queued.proof.id } })
        .where(eq(workflowTransitionEvents.id, ctx.auditId));
      return queued.dispatched ? { kind: "cap_override_applied", workflowRunId: run.id, workflowDefinitionId: definition.id,
        stepId: producerStep.id, workflowStepRunId: stepRunId, ownerActionIssueId: str(payload.ownerActionIssueId) ?? "",
        fromIteration: num(payload.fromIteration) ?? 0, toIteration: toIteration!, cap: num(payload.cap) ?? 0 } : already();
    });
  } catch (error) {
    // Fresh reset + queue acceptance must abort the caller's outer transaction on ANY refusal.
    if (ctx.mode === "atomic") throw error;
    const [accepted] = await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.id, ctx.auditId), eq(workflowTransitionEvents.companyId, ctx.companyId)));
    if (accepted?.payload?.status === "accepted" && await findAcceptedWakeProof(db, ctx.companyId, ctx.wakeKey,
      { workflowRunId: runId, stepRunId, issueId: producerIssueId }, str(accepted.payload.acceptedWakeupRequestId) ?? "")) return already();
    if (ctx.mode === "fresh" && restoreInput
      && await casRestoreCapOverrideSnapshot(db, { ...restoreInput, rollbackReason: failureReason }) === "restored") return rollback;
    // Legacy pending state is retained for later recovery, not falsely reported as restored.
    return refused;
  }
}
