import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { buildWorkflowExecutionSteps, wakeExistingWorkflowStepIssue, type WorkflowStep } from "./dag-engine.js";
import {
  findAcceptedWakeProof,
  hasCurrentCapOverrideAuthority,
  validateOwnerDecisionComment,
} from "./source-issue-cap-override-authority.js";
import {
  casRestoreCapOverrideSnapshot,
  parseCapOverridePriorSnapshot,
  restoreCapOverrideSnapshotInTransaction,
} from "./source-issue-cap-override-snapshot.js";
import { enqueueCapOverrideWake } from "./source-issue-cap-override-wake.js";
import type { SourceIssueNativeResumeOutcome } from "./source-issue-native-resume.js";

const P = workflowTransitionEvents.payload;
const str = (value: unknown): string | null => typeof value === "string" ? value : null;
const num = (value: unknown): number | null => typeof value === "number" ? value : null;
const rec = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const pStr = (field: string, value: string | null): SQL => sql`${P}->>'${sql.raw(field)}' IS NOT DISTINCT FROM ${value}`;
const pNumText = (field: string, value: number | null): SQL => sql`${P}->>'${sql.raw(field)}' IS NOT DISTINCT FROM ${value === null ? null : String(value)}`;
const rollback = (runId: string | null, stepRunId: string | null, stepId: string | null): SourceIssueNativeResumeOutcome => ({
  kind: "report_only",
  reason: "cap_override_queue_rolled_back",
  workflowRunId: runId,
  workflowStepRunId: stepRunId,
  stepId,
});

type DispatchTransactionResult =
  | { kind: "ready"; run: typeof workflowRuns.$inferSelect; definition: typeof workflowDefinitions.$inferSelect; step: WorkflowStep; stepRunId: string; toIteration: number; existingProofId: string | null }
  | { kind: "fence_lost" }
  | { kind: "rolled_back" }
  | { kind: "retryable_failure"; reason: string };

export async function dispatchCapOverrideWake(
  db: Db,
  ctx: {
    companyId: string;
    auditId: string;
    auditIdempotencyKey: string;
    payload: Record<string, unknown>;
    wakeKey: string;
    wakeFn?: typeof wakeExistingWorkflowStepIssue;
    allowBlockedIssue: boolean;
    mode: "fresh" | "recover";
    afterClaim?: () => Promise<void>;
  },
): Promise<SourceIssueNativeResumeOutcome> {
  const payload = ctx.payload;
  const runId = str(payload.workflowRunId);
  const stepRunId = str(payload.producerStepRunId);
  const stepId = str(payload.producerStepId);
  const producerIssueId = str(payload.producerIssueId);
  const token = randomUUID();
  const epoch = (num(payload.dispatchEpoch) ?? 0) + 1;
  const claimPayload = {
    ...payload,
    status: "dispatching",
    dispatchToken: token,
    dispatchEpoch: epoch,
    dispatchStartedAt: new Date().toISOString(),
  };
  const observedStatus = str(payload.status) ?? "pending";
  const claimWhere = observedStatus === "dispatching"
    ? and(
        eq(workflowTransitionEvents.id, ctx.auditId),
        sql`${P}->>'status' = 'dispatching'`,
        pStr("dispatchToken", str(payload.dispatchToken)),
        pNumText("dispatchEpoch", num(payload.dispatchEpoch)),
        pStr("dispatchStartedAt", str(payload.dispatchStartedAt)),
      )
    : and(
        eq(workflowTransitionEvents.id, ctx.auditId),
        sql`${P}->>'status' = 'pending'`,
        pStr("decisionCommentId", str(payload.decisionCommentId)),
        pStr("producerStepRunId", stepRunId),
        pStr("workflowRunId", runId),
      );
  const claimed = await db.update(workflowTransitionEvents)
    .set({ payload: claimPayload })
    .where(claimWhere)
    .returning({ id: workflowTransitionEvents.id });
  if (claimed.length !== 1) return rollback(runId, stepRunId, stepId);

  const releaseLease = (reason: string) => db.update(workflowTransitionEvents).set({
    payload: {
      ...claimPayload,
      status: "pending",
      recoverable: true,
      lastRecoveryFailure: reason,
      lastRecoveryFailedAt: new Date().toISOString(),
      dispatchToken: null,
      dispatchStartedAt: null,
    },
  }).where(and(
    eq(workflowTransitionEvents.id, ctx.auditId),
    sql`${P}->>'status' = 'dispatching'`,
    pStr("dispatchToken", token),
  ));

  try {
    await ctx.afterClaim?.();
  } catch {
    await releaseLease("after_claim_failed");
    return rollback(runId, stepRunId, stepId);
  }

  const toIteration = num(payload.toIteration);
  const cleanedMetadata = rec(payload.producerCleanedMetadata);
  const priorSnapshot = parseCapOverridePriorSnapshot(payload.priorSnapshot);
  const forwardedIssueUpdatedAt = str(payload.forwardedIssueUpdatedAt);
  const restoreInput = priorSnapshot && cleanedMetadata && forwardedIssueUpdatedAt && toIteration !== null ? {
    companyId: ctx.companyId,
    snapshot: priorSnapshot,
    cleanedMetadata,
    toIteration,
    forwardedIssueUpdatedAt,
    auditIdempotencyKey: ctx.auditIdempotencyKey,
    auditPayload: payload,
    dispatchToken: token,
  } : null;

  let transactionResult: DispatchTransactionResult;
  try {
    transactionResult = await db.transaction(async (tx): Promise<DispatchTransactionResult> => {
      const txDb = tx as unknown as Db;
      const fenced = await txDb.update(workflowTransitionEvents)
        .set({ payload: claimPayload })
        .where(and(
          eq(workflowTransitionEvents.id, ctx.auditId),
          sql`${P}->>'status' = 'dispatching'`,
          pStr("dispatchToken", token),
        ))
        .returning({ id: workflowTransitionEvents.id });
      if (fenced.length !== 1) return { kind: "fence_lost" };

      const definitionId = str(payload.workflowDefinitionId);
      const missionId = str(payload.missionId);
      const [stepRun] = stepRunId && toIteration !== null ? await txDb.select().from(workflowStepRuns).where(and(
        eq(workflowStepRuns.id, stepRunId),
        eq(workflowStepRuns.status, "pending"),
        eq(workflowStepRuns.iterationIndex, toIteration),
        isNull(workflowStepRuns.startedAt),
        isNull(workflowStepRuns.completedAt),
        isNull(workflowStepRuns.lastDispatchAttemptAt),
        isNull(workflowStepRuns.lastDispatchAcceptedAt),
        isNull(workflowStepRuns.lastDispatchErrorAt),
        isNull(workflowStepRuns.lastDispatchErrorSummary),
        isNull(workflowStepRuns.lastDispatchRequestId),
        cleanedMetadata ? eq(workflowStepRuns.metadata, cleanedMetadata) : sql`false`,
      )).limit(1) : [];
      const [run] = stepRun ? await txDb.select().from(workflowRuns).where(and(
        eq(workflowRuns.id, stepRun.workflowRunId),
        eq(workflowRuns.companyId, ctx.companyId),
      )).limit(1) : [];
      const [definition] = run ? await txDb.select().from(workflowDefinitions).where(and(
        eq(workflowDefinitions.id, run.workflowId),
        eq(workflowDefinitions.companyId, ctx.companyId),
      )).limit(1) : [];
      const [issue] = producerIssueId ? await txDb.select().from(issues).where(and(
        eq(issues.id, producerIssueId),
        eq(issues.companyId, ctx.companyId),
      )).limit(1) : [];
      const steps: WorkflowStep[] = definition ? buildWorkflowExecutionSteps(definition) : [];
      const producerStep = steps.find((step) => step.id === (stepRun?.stepId ?? "")) ?? null;
      const forwardedAt = forwardedIssueUpdatedAt ? new Date(forwardedIssueUpdatedAt) : null;
      const fromIteration = num(payload.fromIteration);
      const shapeOk = !!stepRun && !!run && !!definition && !!producerStep && !!issue && !!producerIssueId && !!definitionId && !!missionId && !!cleanedMetadata && !!priorSnapshot && !!forwardedAt && !Number.isNaN(forwardedAt.getTime()) && toIteration !== null && fromIteration !== null &&
        priorSnapshot.run.id === run.id && priorSnapshot.run.status === "failed" &&
        priorSnapshot.stepRun.id === stepRun.id && priorSnapshot.stepRun.status === "completed" &&
        priorSnapshot.stepRun.iterationIndex === fromIteration && toIteration === fromIteration + 1 &&
        priorSnapshot.issue.id === issue.id &&
        run.id === runId && run.status === "running" && run.missionId === missionId && run.workflowId === definitionId &&
        run.startedAt?.toISOString() === priorSnapshot.run.startedAt && run.completedAt === null &&
        definition.id === definitionId && definition.companyId === ctx.companyId &&
        stepRun.workflowRunId === run.id && stepRun.issueId === producerIssueId && stepRun.stepId === stepId &&
        producerStep.id === stepId &&
        issue.id === producerIssueId && issue.companyId === ctx.companyId && issue.missionId === missionId &&
        issue.status === "todo" && issue.completedAt === null && issue.updatedAt.getTime() === forwardedAt.getTime();
      if (!shapeOk) return { kind: "retryable_failure", reason: "post_forward_shape_mismatch" };

      const authorityValid = await hasCurrentCapOverrideAuthority(txDb, ctx.companyId, payload);
      const decisionValid = authorityValid ? await validateOwnerDecisionComment(txDb, ctx.companyId, {
        decisionCommentId: str(payload.decisionCommentId) ?? "",
        ownerActionIssueId: str(payload.ownerActionIssueId) ?? "",
        missionOwnerAgentId: str(payload.missionOwnerAgentId) ?? "",
        producerCompletedAt: str(payload.producerCompletedAt) ? new Date(str(payload.producerCompletedAt)!) : null,
        producerIssueId,
        producerIdentifier: issue.identifier,
      }) : null;
      if (!authorityValid || !decisionValid) {
        if (!restoreInput) return { kind: "retryable_failure", reason: "authority_snapshot_missing" };
        await restoreCapOverrideSnapshotInTransaction(txDb, {
          ...restoreInput,
          rollbackReason: authorityValid ? "decision_revalidation_failed" : "current_authority_invalid",
        });
        return { kind: "rolled_back" };
      }

      const existingProof = await findAcceptedWakeProof(txDb, ctx.companyId, ctx.wakeKey, {
        workflowRunId: run.id,
        stepRunId: stepRun.id,
        issueId: producerIssueId,
      });
      return {
        kind: "ready",
        run,
        definition,
        step: producerStep,
        stepRunId: stepRun.id,
        toIteration,
        existingProofId: existingProof?.id ?? null,
      };
    });
  } catch {
    const reason = "fenced_transaction_failed";
    if (ctx.mode === "fresh" && restoreInput) {
      const restored = await casRestoreCapOverrideSnapshot(db, { ...restoreInput, rollbackReason: reason });
      if (restored === "restored") return rollback(runId, stepRunId, stepId);
    }
    await releaseLease(reason);
    return rollback(runId, stepRunId, stepId);
  }

  if (transactionResult.kind === "rolled_back") return rollback(runId, stepRunId, stepId);
  if (transactionResult.kind === "fence_lost") {
    if (runId && stepRunId && producerIssueId) {
      const [acceptedAudit] = await db.select({ payload: workflowTransitionEvents.payload })
        .from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, ctx.auditId)).limit(1);
      const acceptedPayload = rec(acceptedAudit?.payload);
      const wakeId = str(acceptedPayload?.acceptedWakeupRequestId);
      const proof = acceptedPayload && acceptedPayload.status === "accepted" && wakeId
        ? await findAcceptedWakeProof(db, ctx.companyId, ctx.wakeKey, { workflowRunId: runId, stepRunId, issueId: producerIssueId }, wakeId)
        : null;
      if (proof) return { kind: "cap_override_already_applied", ownerActionIssueId: str(payload.ownerActionIssueId) ?? "" };
    }
    return rollback(runId, stepRunId, stepId);
  }
  if (transactionResult.kind === "retryable_failure") {
    if (ctx.mode === "fresh" && restoreInput) {
      const restored = await casRestoreCapOverrideSnapshot(db, { ...restoreInput, rollbackReason: transactionResult.reason });
      if (restored === "restored") return rollback(runId, stepRunId, stepId);
    }
    await releaseLease(transactionResult.reason);
    return rollback(runId, stepRunId, stepId);
  }

  const queueResult = await enqueueCapOverrideWake({
    db,
    companyId: ctx.companyId,
    wakeKey: ctx.wakeKey,
    run: transactionResult.run,
    definition: transactionResult.definition,
    step: transactionResult.step,
    stepRunId: transactionResult.stepRunId,
    stepRunMetadata: cleanedMetadata!,
    issueId: producerIssueId!,
    allowBlockedIssue: ctx.allowBlockedIssue,
    existingProofId: transactionResult.existingProofId,
    wakeFn: ctx.wakeFn,
  });
  if (!queueResult.proof) {
    if (ctx.mode === "fresh" && restoreInput) {
      const restored = await casRestoreCapOverrideSnapshot(db, { ...restoreInput, rollbackReason: queueResult.failureReason });
      if (restored === "restored") return rollback(runId, stepRunId, stepId);
    }
    await releaseLease(queueResult.failureReason);
    return rollback(runId, stepRunId, stepId);
  }

  const marked = await db.update(workflowTransitionEvents).set({
    payload: { ...claimPayload, status: "accepted", acceptedWakeupRequestId: queueResult.proof.id },
  }).where(and(
    eq(workflowTransitionEvents.id, ctx.auditId),
    sql`${P}->>'status' = 'dispatching'`,
    pStr("dispatchToken", token),
  )).returning({ id: workflowTransitionEvents.id });
  if (marked.length !== 1 || !queueResult.dispatched) {
    return { kind: "cap_override_already_applied", ownerActionIssueId: str(payload.ownerActionIssueId) ?? "" };
  }
  return {
    kind: "cap_override_applied",
    workflowRunId: transactionResult.run.id,
    workflowDefinitionId: transactionResult.definition.id,
    stepId: transactionResult.step.id,
    workflowStepRunId: transactionResult.stepRunId,
    ownerActionIssueId: str(payload.ownerActionIssueId) ?? "",
    fromIteration: num(payload.fromIteration) ?? 0,
    toIteration: transactionResult.toIteration,
    cap: num(payload.cap) ?? 0,
  };
}
