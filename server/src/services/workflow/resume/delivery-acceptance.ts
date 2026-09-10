import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { companies, workflowResumeExecutions, workflowResumeRequests } from "@paperclipai/db";
import { resumeLeaseUntil, type ClaimedResumeRequestRow } from "./execution-queue.js";
import { budgetBlockers } from "./preview-facts.js";
import type { ResumeSerializationContext } from "./serialization.js";

export type ResumeDeliveryBlockCode = "authority_stale" | "scope_changed" | "budget_hard_stop" | "mission_cancelled";
export type ResumeDeliveryClaim = { kind: "pending" } | { kind: "stale"; executionId: string };
export type AcceptOutcome =
  | { kind: "accepted"; executionId: string }
  | { kind: "blocked" | "cancelled"; code: ResumeDeliveryBlockCode }
  | { kind: "skipped" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Mission → run → steps are already locked. Claim snapshots supply identity, never authority. */
export async function acceptInsideLock(
  context: ResumeSerializationContext,
  snapshot: ClaimedResumeRequestRow,
  owner: string,
  claim: ResumeDeliveryClaim,
): Promise<AcceptOutcome> {
  const { tx, mission, run } = context;
  const requestScope = and(
    eq(workflowResumeRequests.id, snapshot.id),
    eq(workflowResumeRequests.companyId, mission.companyId),
    eq(workflowResumeRequests.missionId, mission.id),
    eq(workflowResumeRequests.workflowRunId, run.id),
    eq(workflowResumeRequests.state, claim.kind === "pending" ? "pending_delivery" : "accepted"),
  );
  const pendingOwnership = and(
    requestScope,
    eq(workflowResumeRequests.leaseOwner, owner),
    gt(workflowResumeRequests.leaseUntil, sql`clock_timestamp()`),
  );
  const [request] = await tx.select().from(workflowResumeRequests)
    .where(claim.kind === "pending" ? pendingOwnership : requestScope).for("update");
  if (!request) return { kind: "skipped" };

  // Lock even a terminal/foreign execution: its existence must prevent creation/resurrection.
  const [execution] = await tx.select().from(workflowResumeExecutions)
    .where(eq(workflowResumeExecutions.requestId, request.id)).for("update");
  if (claim.kind === "stale" && execution?.id !== claim.executionId) return { kind: "skipped" };
  if (execution && (execution.companyId !== request.companyId || execution.missionId !== request.missionId
    || execution.workflowRunId !== request.workflowRunId || execution.leaseOwner !== owner
    || !["queued", "running"].includes(execution.state))) return { kind: "skipped" };
  const executionOwnership = execution ? and(
    eq(workflowResumeExecutions.id, execution.id),
    eq(workflowResumeExecutions.requestId, request.id),
    eq(workflowResumeExecutions.companyId, request.companyId),
    eq(workflowResumeExecutions.missionId, request.missionId),
    eq(workflowResumeExecutions.workflowRunId, request.workflowRunId),
    inArray(workflowResumeExecutions.state, ["queued", "running"]),
    eq(workflowResumeExecutions.leaseOwner, owner),
    gt(workflowResumeExecutions.leaseUntil, sql`clock_timestamp()`),
  ) : undefined;

  const terminal = await terminalReason(context, request);
  // Revalidate/renew at the write boundary using the DB clock, including time spent awaiting reads.
  // Locks prevent takeover during the following atomic acceptance/terminal writes.
  if (execution) {
    const renewed = await tx.update(workflowResumeExecutions).set({ leaseUntil: resumeLeaseUntil() })
      .where(executionOwnership).returning({ id: workflowResumeExecutions.id });
    if (!renewed.length) return { kind: "skipped" };
  }
  if (claim.kind === "pending") {
    const renewed = await tx.update(workflowResumeRequests).set({ leaseUntil: resumeLeaseUntil() })
      .where(pendingOwnership).returning({ id: workflowResumeRequests.id });
    if (!renewed.length) return { kind: "skipped" };
  }
  if (terminal) {
    await tx.update(workflowResumeRequests)
      .set({ state: terminal.kind, code: terminal.code, leaseOwner: null, leaseUntil: null }).where(requestScope);
    if (execution) await tx.update(workflowResumeExecutions)
      .set({ state: terminal.kind, code: terminal.code, leaseOwner: null, leaseUntil: null }).where(executionOwnership);
    return terminal;
  }
  let executionId = execution?.id;
  if (!executionId) {
    const [inserted] = await tx.insert(workflowResumeExecutions).values({
      requestId: request.id, companyId: request.companyId, missionId: request.missionId,
      workflowRunId: request.workflowRunId, authorityVersion: run.dispatchAuthorityVersion,
      generations: request.appliedGenerations, state: "queued", leaseOwner: owner, leaseUntil: resumeLeaseUntil(),
    }).returning({ id: workflowResumeExecutions.id });
    // Unique(requestId) is the final race fence; a conflict rolls back, never resets an existing execution.
    executionId = inserted!.id;
  }
  await tx.update(workflowResumeRequests).set({
    state: "accepted", acceptedAt: sql`coalesce(${workflowResumeRequests.acceptedAt}, clock_timestamp())`,
    code: null, leaseOwner: null, leaseUntil: null,
  }).where(requestScope);
  return { kind: "accepted", executionId };
}

async function terminalReason(
  { tx, mission, run, steps }: ResumeSerializationContext,
  request: ClaimedResumeRequestRow,
): Promise<{ kind: "blocked" | "cancelled"; code: ResumeDeliveryBlockCode } | null> {
  if (mission.status === "cancelled" || run.status === "cancelled") {
    return { kind: "cancelled", code: "mission_cancelled" };
  }
  const [company] = await tx.select().from(companies).where(eq(companies.id, request.companyId)).limit(1);
  if (budgetBlockers({ budgetMonthlyCents: company?.budgetMonthlyCents, spentMonthlyCents: company?.spentMonthlyCents }).length) {
    return { kind: "blocked", code: "budget_hard_stop" };
  }
  const metadata = isRecord(run.metadata) ? run.metadata : {};
  if (metadata.resumeRequestId !== request.id || !Number.isSafeInteger(metadata.resumeAuthorityVersion)
    || (metadata.resumeAuthorityVersion as number) < 0 || metadata.resumeAuthorityVersion !== run.dispatchAuthorityVersion) {
    return { kind: "blocked", code: "authority_stale" };
  }
  if ((mission.status !== "active" && mission.status !== "completed") || run.status !== "running"
    || !stepScopeMatches(steps, request)) return { kind: "blocked", code: "scope_changed" };
  return null;
}

function stepScopeMatches(steps: ResumeSerializationContext["steps"], request: ClaimedResumeRequestRow): boolean {
  const generations = request.appliedGenerations;
  if (!isRecord(generations)) return false;
  const entries = Object.entries(generations);
  if (!entries.length) return false;
  const byStepId = new Map(steps.map((step) => [step.stepId, step]));
  return entries.every(([stepId, generation]) => {
    const step = byStepId.get(stepId);
    return step?.executionGeneration === generation && isRecord(step.metadata) && step.metadata.resumeRequestId === request.id;
  });
}
