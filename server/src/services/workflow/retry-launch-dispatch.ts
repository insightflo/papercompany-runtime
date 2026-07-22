import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import {
  findAcceptedWorkflowRetryWakeEvidence,
  hasActiveWorkflowRetryRecoveryExecution,
} from "./retry-execution-state.js";
import { markRetryDispatching } from "./retry-dispatch-state.js";
import { isWorkflowRetryDue, readWorkflowRetryMetadata } from "./retry-policy.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function stripRetryTrackingOnSuccess(metadata: unknown): Record<string, unknown> | null {
  const cleaned = record(metadata);
  if (!cleaned.workflowRetry && !cleaned.workflowRetryExhaustion) return null;
  delete cleaned.workflowRetry;
  delete cleaned.workflowRetryExhaustion;
  return cleaned;
}

export function isRetryDelayBlockingDispatch(metadata: unknown, now: Date): boolean {
  const retryMeta = record(metadata).workflowRetry;
  return retryMeta ? !isWorkflowRetryDue(retryMeta, now) : false;
}

export async function shouldPreservePendingRetryFromIssueState(input: {
  db: Db;
  companyId: string;
  issueId: string;
  stepRunStatus: string;
  metadata: unknown;
}): Promise<boolean> {
  if (input.stepRunStatus !== "pending") return false;
  const retryMeta = readWorkflowRetryMetadata(record(input.metadata).workflowRetry);
  if (retryMeta?.state === "waiting") return true;
  if (retryMeta?.state !== "dispatching") return false;
  return hasActiveWorkflowRetryRecoveryExecution(input.db, {
    companyId: input.companyId,
    issueId: input.issueId,
  });
}

export async function markIssueLessRetryDispatchingFromProof(input: {
  db: Db;
  workflowRunId: string;
  stepRunId: string;
  observedRetryCount: number;
  priorLastDispatchRequestId: string | null;
  metadata: unknown;
}): Promise<void> {
  const retryMeta = readWorkflowRetryMetadata(record(input.metadata).workflowRetry);
  if (!retryMeta) return;
  const [proof] = await input.db.select({
    status: workflowStepRuns.status,
    lastDispatchRequestId: workflowStepRuns.lastDispatchRequestId,
  })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, input.stepRunId))
    .limit(1);
  if (
    !proof
    || proof.status !== "running"
    || !proof.lastDispatchRequestId
    || proof.lastDispatchRequestId === input.priorLastDispatchRequestId
  ) return;
  await markRetryDispatching(input.db, {
    stepRunId: input.stepRunId,
    workflowRunId: input.workflowRunId,
    expectedRetryNumber: retryMeta.retryNumber,
    observedRetryCount: input.observedRetryCount,
    requiredStatus: "running",
    requiredLastDispatchRequestId: proof.lastDispatchRequestId,
  });
}

export async function wakeIssueBackedRetryAndMarkDispatching<TRun, TDefinition, TStep>(input: {
  db: Db;
  companyId: string;
  workflowRunId: string;
  definition: TDefinition;
  run: TRun;
  step: TStep;
  stepRunId: string;
  stepRunMetadata: unknown;
  issueId: string;
  observedRetryCount: number;
  resumeExistingIssue: boolean;
  wakeExistingWorkflowStepIssue: (args: {
    db: Db;
    run: TRun;
    definition: TDefinition;
    step: TStep;
    stepRunId: string;
    stepRunMetadata: unknown;
    issueId: string;
    allowCompletedIssue: boolean;
    allowBlockedIssue: boolean;
    forceFreshSession: boolean;
    idempotencyKey?: string | null;
  }) => Promise<boolean>;
}): Promise<void> {
  const retryMeta = readWorkflowRetryMetadata(record(input.stepRunMetadata).workflowRetry);
  const isRetry = retryMeta !== null;
  const retryWakeIdempotencyKey = isRetry
    ? `workflow-step-retry:${input.stepRunId}:${retryMeta.retryNumber}`
    : null;
  await input.wakeExistingWorkflowStepIssue({
    db: input.db,
    run: input.run,
    definition: input.definition,
    step: input.step,
    stepRunId: input.stepRunId,
    stepRunMetadata: input.stepRunMetadata,
    issueId: input.issueId,
    allowCompletedIssue: input.resumeExistingIssue,
    allowBlockedIssue: input.resumeExistingIssue,
    forceFreshSession: isRetry,
    idempotencyKey: retryWakeIdempotencyKey,
  });
  if (!retryMeta || !retryWakeIdempotencyKey) return;
  const acceptedWake = await findAcceptedWorkflowRetryWakeEvidence(input.db, {
    companyId: input.companyId,
    issueId: input.issueId,
    workflowRunId: input.workflowRunId,
    stepRunId: input.stepRunId,
    idempotencyKey: retryWakeIdempotencyKey,
  });
  if (!acceptedWake) return;
  await markRetryDispatching(input.db, {
    stepRunId: input.stepRunId,
    workflowRunId: input.workflowRunId,
    expectedRetryNumber: retryMeta.retryNumber,
    observedRetryCount: input.observedRetryCount,
    requiredStatus: "pending",
  });
}
