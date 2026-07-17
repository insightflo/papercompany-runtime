import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowTransitionEvents } from "@paperclipai/db";
import { wakeExistingWorkflowStepIssue } from "./dag-engine.js";
import { findAcceptedWakeProof } from "./source-issue-cap-override-authority.js";
import { dispatchCapOverrideWake } from "./source-issue-cap-override-dispatch.js";
import type { SourceIssueNativeResumeOutcome } from "./source-issue-native-resume.js";

const DISPATCH_STALE_MS = 60_000;
const EVENT_TYPE = "owner_cap_override_retry";
const P = workflowTransitionEvents.payload;
const str = (value: unknown): string | null => typeof value === "string" ? value : null;
const rec = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const pStr = (field: string, value: string | null): SQL => sql`${P}->>'${sql.raw(field)}' IS NOT DISTINCT FROM ${value}`;
const rollback = (runId: string | null, stepRunId: string | null, stepId: string | null): SourceIssueNativeResumeOutcome => ({
  kind: "report_only",
  reason: "cap_override_queue_rolled_back",
  workflowRunId: runId,
  workflowStepRunId: stepRunId,
  stepId,
});

function isDispatchStale(dispatchStartedAt: unknown): boolean {
  const value = str(dispatchStartedAt);
  if (!value) return true;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) || Date.now() - timestamp > DISPATCH_STALE_MS;
}

export async function recoverOwnerCapOverride(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    allowBlockedIssue?: boolean;
    ownerAction: { decisionCommentId: string; ownerActionIssueId: string; missionId: string };
    wakeFn?: typeof wakeExistingWorkflowStepIssue;
  },
): Promise<SourceIssueNativeResumeOutcome | null> {
  const auditKey = `cap-override:${input.ownerAction.decisionCommentId}`;
  const wakeKey = `cap-override-wake:${input.ownerAction.decisionCommentId}`;
  const [audit] = await db.select({ id: workflowTransitionEvents.id, payload: workflowTransitionEvents.payload })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId),
      eq(workflowTransitionEvents.eventType, EVENT_TYPE),
      eq(workflowTransitionEvents.idempotencyKey, auditKey),
    ))
    .limit(1);
  if (!audit) return null;

  const payload = rec(audit.payload) ?? {};
  const status = str(payload.status) ?? "pending";
  const runId = str(payload.workflowRunId);
  const stepRunId = str(payload.producerStepRunId);
  const stepId = str(payload.producerStepId);
  const producerIssueId = str(payload.producerIssueId);
  if (
    producerIssueId !== input.issueId ||
    str(payload.ownerActionIssueId) !== input.ownerAction.ownerActionIssueId ||
    str(payload.missionId) !== input.ownerAction.missionId ||
    str(payload.decisionCommentId) !== input.ownerAction.decisionCommentId
  ) return rollback(runId, stepRunId, stepId);

  if (status === "accepted") {
    const wakeId = str(payload.acceptedWakeupRequestId);
    const proof = wakeId && runId && stepRunId && producerIssueId
      ? await findAcceptedWakeProof(db, input.companyId, wakeKey, { workflowRunId: runId, stepRunId, issueId: producerIssueId }, wakeId)
      : null;
    if (proof) return { kind: "cap_override_already_applied", ownerActionIssueId: input.ownerAction.ownerActionIssueId };
    await db.update(workflowTransitionEvents).set({
      payload: {
        ...payload,
        status: "pending",
        recoverable: true,
        lastRecoveryFailure: "accepted_wake_proof_missing",
        lastRecoveryFailedAt: new Date().toISOString(),
        dispatchToken: null,
        dispatchStartedAt: null,
        acceptedWakeupRequestId: null,
      },
    }).where(and(
      eq(workflowTransitionEvents.id, audit.id),
      sql`${P}->>'status' = 'accepted'`,
      pStr("acceptedWakeupRequestId", wakeId),
      pStr("decisionCommentId", input.ownerAction.decisionCommentId),
      pStr("producerStepRunId", stepRunId),
      pStr("workflowRunId", runId),
    ));
    return rollback(runId, stepRunId, stepId);
  }
  if (status === "rolled_back") return rollback(runId, stepRunId, stepId);
  if (status === "dispatching" && !isDispatchStale(payload.dispatchStartedAt)) return rollback(runId, stepRunId, stepId);
  return dispatchCapOverrideWake(db, {
    companyId: input.companyId,
    auditId: audit.id,
    auditIdempotencyKey: auditKey,
    payload,
    wakeKey,
    wakeFn: input.wakeFn,
    allowBlockedIssue: input.allowBlockedIssue ?? true,
    mode: "recover",
  });
}
