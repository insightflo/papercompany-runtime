import { randomUUID } from "node:crypto";
import { and, eq, exists, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowResumeExecutions, workflowResumeRequests } from "@paperclipai/db";
import { ensureMissionRuntimesForResumeReactivation } from "../../missions/mission-workflow-lifecycle.js";
import { assertWorkflowToolStepsReady, syncWorkflowRunState } from "../dag-engine.js";
import { loadExecutionDefinition } from "../execution-definition.js";
import {
  claimPendingResumeRequests, claimStaleResumeExecutions, resumeLeaseUntil,
  validateResumeClaimOptions, type ClaimedResumeRequestRow,
} from "./execution-queue.js";
import { acceptInsideLock, type AcceptOutcome, type ResumeDeliveryClaim } from "./delivery-acceptance.js";
import { assertResumeExecutionReadiness } from "./readiness.js";
import { withResumeSerialization } from "./serialization.js";

export type { ResumeDeliveryBlockCode } from "./delivery-acceptance.js";

/** Durable delivery: claim → serialized acceptance → leased runtime/readiness/sync → conditional completion.
 * Exceptions preserve the recoverable lease. No transaction spans external operations.
 * Boundary checks do NOT replace downstream generation fencing inside mutations.
 */
export interface ResumeDispatchResult {
  claimedCount: number; acceptedCount: number; completedCount: number;
  blockedCount: number; cancelledCount: number; failedCount: number; skippedCount: number;
}

export async function dispatchAcceptedResumeWork(
  db: Db,
  options: { now?: Date; maxItems?: number } = {},
): Promise<ResumeDispatchResult> {
  // `now` is retained for source compatibility only; caller clocks never authorize delivery.
  const { limit } = validateResumeClaimOptions({ limit: options.maxItems });
  const owner = `resume-dispatcher:${randomUUID()}`;
  const result: ResumeDispatchResult = {
    claimedCount: 0, acceptedCount: 0, completedCount: 0,
    blockedCount: 0, cancelledCount: 0, failedCount: 0, skippedCount: 0,
  };
  const claimedRequests = await claimPendingResumeRequests(db, { limit, owner });
  const claimedExecutions = await claimStaleResumeExecutions(db, { limit, owner });
  result.claimedCount = claimedRequests.length + claimedExecutions.length;
  const drivenRequestIds = new Set<string>();
  for (const request of claimedRequests) {
    drivenRequestIds.add(request.id);
    await driveResumeDelivery(db, { request, owner, claim: { kind: "pending" } }, result);
  }
  for (const execution of claimedExecutions) {
    if (drivenRequestIds.has(execution.requestId)) continue;
    const [request] = await db.select().from(workflowResumeRequests)
      .where(eq(workflowResumeRequests.id, execution.requestId)).limit(1);
    if (!request) { result.skippedCount += 1; continue; }
    await driveResumeDelivery(db, {
      request, owner, claim: { kind: "stale", executionId: execution.id },
    }, result);
  }
  return result;
}

async function driveResumeDelivery(
  db: Db,
  input: { request: ClaimedResumeRequestRow; owner: string; claim: ResumeDeliveryClaim },
  result: ResumeDispatchResult,
): Promise<void> {
  let outcome: AcceptOutcome;
  try {
    outcome = await withResumeSerialization(db, {
      companyId: input.request.companyId, missionId: input.request.missionId, runId: input.request.workflowRunId,
    }, (context) => acceptInsideLock(context, input.request, input.owner, input.claim));
  } catch {
    result.failedCount += 1;
    return;
  }
  if (outcome.kind !== "accepted") {
    if (outcome.kind === "blocked") result.blockedCount += 1;
    else if (outcome.kind === "cancelled") result.cancelledCount += 1;
    else result.skippedCount += 1;
    return;
  }
  result.acceptedCount += 1;
  await deliverExecution(db, { ...input, executionId: outcome.executionId }, result);
}

type DeliveryIdentity = { request: ClaimedResumeRequestRow; owner: string; executionId: string };

function ownedExecution(db: Db, input: DeliveryIdentity) {
  const { request } = input;
  return and(
    eq(workflowResumeExecutions.id, input.executionId),
    eq(workflowResumeExecutions.requestId, request.id),
    eq(workflowResumeExecutions.companyId, request.companyId),
    eq(workflowResumeExecutions.missionId, request.missionId),
    eq(workflowResumeExecutions.workflowRunId, request.workflowRunId),
    eq(workflowResumeExecutions.leaseOwner, input.owner),
    gt(workflowResumeExecutions.leaseUntil, sql`clock_timestamp()`),
    exists(db.select({ id: workflowResumeRequests.id }).from(workflowResumeRequests).where(and(
      eq(workflowResumeRequests.id, request.id),
      eq(workflowResumeRequests.companyId, request.companyId),
      eq(workflowResumeRequests.missionId, request.missionId),
      eq(workflowResumeRequests.workflowRunId, request.workflowRunId),
      eq(workflowResumeRequests.state, "accepted"),
    ))),
  );
}

async function deliverExecution(db: Db, input: DeliveryIdentity, result: ResumeDispatchResult): Promise<void> {
  // Only explicit claims acquire ownership. Running/renewal never takes over an expired lease.
  const renew = async (initial = false) => {
    const rows = await db.update(workflowResumeExecutions).set({
      state: "running", leaseUntil: resumeLeaseUntil(), code: null,
      ...(initial ? { attempts: sql`case when ${workflowResumeExecutions.state} = 'queued'
        then ${workflowResumeExecutions.attempts} + 1 else ${workflowResumeExecutions.attempts} end` } : {}),
    }).where(and(ownedExecution(db, input), initial
      ? inArray(workflowResumeExecutions.state, ["queued", "running"])
      : eq(workflowResumeExecutions.state, "running")))
      .returning({ id: workflowResumeExecutions.id });
    if (!rows.length) result.skippedCount += 1;
    return rows.length > 0;
  };
  try {
    if (!await renew(true)) return;
    await ensureMissionRuntimesForResumeReactivation(db, {
      companyId: input.request.companyId, missionId: input.request.missionId,
      workflowRunId: input.request.workflowRunId, resumeRequestId: input.request.id,
    });
    if (!await renew()) return;
    const steps = (await loadExecutionDefinition(db, input.request.workflowRunId, { requireHistorical: false })).steps;
    if (!await renew()) return;
    await assertResumeExecutionReadiness({
      db, companyId: input.request.companyId, steps, assertToolsReady: assertWorkflowToolStepsReady,
    });
    if (!await renew()) return;
    await syncWorkflowRunState(db, input.request.workflowRunId, "workflow_resume_dispatch");
    const completed = await db.update(workflowResumeExecutions)
      .set({ state: "completed", completedAt: sql`clock_timestamp()`, leaseOwner: null, leaseUntil: null })
      .where(and(ownedExecution(db, input), eq(workflowResumeExecutions.state, "running")))
      .returning({ id: workflowResumeExecutions.id });
    if (completed.length) result.completedCount += 1;
    else result.skippedCount += 1;
  } catch {
    result.failedCount += 1;
  }
}
