import { activityLog, agentWakeupRequests, heartbeatRuns, toolDefinitions, toolExecutionHeartbeats as table,
  workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { toolProgressEventSchema, toolProgressPolicySchema, type ToolProgressEvent, type ToolProgressPolicy } from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { ToolProgressError, validProgressToken } from "./progress-policy.js";
import { lockProgressScope, progressScopeMatches, type ProgressScope, type ProgressTransaction } from "./progress-scope.js";
import { readWorkflowAttemptProof } from "../heartbeat-finalization/workflow-attempt-proof.js";

type StoredHeartbeat = typeof table.$inferSelect;
export type ToolProgressHeartbeat = Omit<StoredHeartbeat, "tokenHash">;
export type ProgressReceipt = { accepted: true } | { accepted: false; reason: "no_progress" | "throttled" };
function dto({ tokenHash: _tokenHash, ...row }: StoredHeartbeat): ToolProgressHeartbeat { return row; }
async function clock(tx: ProgressTransaction): Promise<Date> {
  const rows = await tx.execute(sql`select floor(extract(epoch from clock_timestamp()) * 1000) as now_ms`);
  return new Date(Number(rows[0].now_ms));
}
async function audit(tx: ProgressTransaction, row: StoredHeartbeat, action: string, evidence?: ProgressEvidence | null) {
  await tx.insert(activityLog).values({ companyId: row.companyId, actorType: "system", actorId: "tool-progress",
    action: `tool_progress.${action}`, entityType: "tool_execution_heartbeat", entityId: row.id,
    ...(evidence ? { runId: evidence.runId } : {}),
    details: { sequence: row.sequence, stageIndex: row.stageIndex, current: row.current, total: row.total,
      state: row.state, reason: row.reason, toolId: row.toolId, ...(evidence ? { progressEvidence: evidence } : {}) } });
}
async function settle(tx: ProgressTransaction, row: StoredHeartbeat, now: Date, state: StoredHeartbeat["state"], reason: string | null) {
  const [updated] = await tx.update(table).set({ state, reason, finishedAt: now })
    .where(and(eq(table.companyId, row.companyId), eq(table.id, row.id))).returning();
  await audit(tx, updated, state);
  return updated;
}
async function guard(tx: ProgressTransaction, row: StoredHeartbeat) {
  const matches = await progressScopeMatches(tx, row);
  const now = await clock(tx);
  if (row.state !== "active") return { row, now };
  if (!matches) return { row: await settle(tx, row, now, "failed", "tool_progress_scope_replaced"), now };
  const maxDeadline = row.startedAt.getTime() + row.policy.maxDurationMs;
  const idleDeadline = row.lastProgressAt.getTime() + row.policy.idleTimeoutMs;
  if (now.getTime() >= Math.min(maxDeadline, idleDeadline)) {
    const reason = maxDeadline <= idleDeadline ? "tool_progress_max_timeout" : "tool_progress_idle_timeout";
    return { row: await settle(tx, row, now, "timed_out", reason), now };
  }
  return { row, now };
}
function advance(row: StoredHeartbeat, event: ToolProgressEvent) {
  const index = row.policy.stages.findIndex((stage) => stage.key === event.stage);
  if (event.sequence <= row.sequence || index < 0 || row.policy.stages[index].unit !== event.unit) return null;
  const same = index === row.stageIndex;
  if (same) {
    if (event.current <= row.current || (row.total !== null && event.total !== row.total)) return null;
  } else if (index !== row.stageIndex + 1 || event.current <= 0) return null;
  return { sequence: event.sequence, stageIndex: index, current: event.current, total: event.total ?? null };
}
export type ProgressEvidenceContext = {
  actor: Pick<Express.Request["actor"], "type" | "source" | "companyId" | "agentId" | "runId">;
  targetRunId: string;
};
type LocalEvidenceContext = ProgressEvidenceContext & {
  scope: ProgressScope; agentId?: string | null; stepRunId?: string | null;
};
type ProgressEvidence = {
  schemaVersion: 1; companyId: string; agentId: string; runId: string; wakeupRequestId: string;
  toolExecutionId: string; sequence: number; requestId: string;
  workflowAttempt: (ReturnType<typeof readWorkflowAttemptProof> & { stepId: string }) | null;
};

/** Optional attribution follows acceptance; it never authorizes or rejects execution. */
async function readProgressEvidence(tx: ProgressTransaction, row: StoredHeartbeat,
  context?: LocalEvidenceContext): Promise<ProgressEvidence | null> {
  if (!context || context.actor.type !== "agent" || !context.actor.runId
    || context.actor.runId !== context.targetRunId) return null;
  const { actor, scope } = context;
  if (actor.companyId !== scope.companyId || scope.companyId !== row.companyId
    || !context.agentId || actor.agentId !== context.agentId || scope.toolId !== row.toolId
    || scope.requestId !== row.requestId || (scope.workflowRunId ?? null) !== row.workflowRunId
    || (scope.stepId ?? null) !== row.stepId || (context.stepRunId && context.stepRunId !== row.stepRunId)) return null;
  // A savepoint keeps unavailable/malformed attribution from aborting the accepted advance.
  // Existing guard/authentication/currentness failures remain outside this boundary.
  return tx.transaction(async (evidenceTx): Promise<ProgressEvidence | null> => {
    const [heartbeat] = await evidenceTx.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, context.targetRunId)).for("share");
    if (!heartbeat || heartbeat.companyId !== row.companyId || heartbeat.agentId !== context.agentId
      || !heartbeat.startedAt || !heartbeat.wakeupRequestId) return null;
    const [wake] = await evidenceTx.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId)).for("share");
    if (!wake || wake.companyId !== heartbeat.companyId || wake.agentId !== heartbeat.agentId
      || wake.issueId !== heartbeat.issueId || wake.runId !== heartbeat.id
      || ["coalesced", "skipped"].includes(wake.status) || heartbeat.startedAt < wake.requestedAt) return null;
    let workflowAttempt: ProgressEvidence["workflowAttempt"] = null;
    if (row.workflowRunId !== null) {
      if (!row.stepRunId || !row.stepId) return null;
      const [binding] = await evidenceTx.select({ step: workflowStepRuns, run: workflowRuns }).from(workflowStepRuns)
        .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
        .where(eq(workflowStepRuns.id, row.stepRunId)).for("share", { of: workflowStepRuns });
      if (!binding || binding.run.companyId !== row.companyId || binding.run.id !== row.workflowRunId
        || binding.step.stepId !== row.stepId || binding.step.issueId !== heartbeat.issueId
        || binding.run.missionId !== wake.missionId || heartbeat.workflowStepRunId !== row.stepRunId
        || heartbeat.workflowExecutionGeneration !== row.executionGeneration) return null;
      const proof = readWorkflowAttemptProof(wake);
      if (proof.workflowRunId !== row.workflowRunId || proof.stepRunId !== row.stepRunId
        || proof.executionGeneration !== row.executionGeneration || proof.retryCount !== row.retryCount
        || proof.iterationIndex !== row.iterationIndex || proof.parentHeartbeatRunId !== heartbeat.retryOfRunId) return null;
      workflowAttempt = { ...proof, stepId: row.stepId };
    } else if (row.stepRunId !== null || row.stepId !== null || row.executionGeneration !== null
      || row.retryCount !== null || row.iterationIndex !== null || heartbeat.workflowStepRunId !== null
      || heartbeat.workflowExecutionGeneration !== null || wake.workflowRunId !== null
      || wake.workflowStepRunId !== null || wake.workflowExecutionGeneration !== null) return null;
    return { schemaVersion: 1, companyId: row.companyId, agentId: heartbeat.agentId, runId: heartbeat.id,
      wakeupRequestId: wake.id, toolExecutionId: row.id, sequence: row.sequence, requestId: scope.requestId, workflowAttempt };
  }).catch(() => null);
}

export function createToolProgressStore(db: Db) {
  async function transaction<T>(operation: (tx: ProgressTransaction) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '2000ms'`);
      await tx.execute(sql`set local lock_timeout = '2000ms'`);
      return operation(tx);
    });
  }
  async function locked(tx: ProgressTransaction, companyId: string, executionId: string) {
    const [row] = await tx.select().from(table).where(and(eq(table.companyId, companyId), eq(table.id, executionId))).for("update");
    if (!row) throw new ToolProgressError(404, "tool_progress_not_found");
    return row;
  }
  async function acceptInternal(companyId: string, executionId: string, raw: ToolProgressEvent, auth: { token: string } | { local: true; progressEvidenceContext?: LocalEvidenceContext }): Promise<ProgressReceipt> {
    const parsed = toolProgressEventSchema.safeParse(raw);
    if (!parsed.success) throw new ToolProgressError(400, "tool_progress_invalid_event");
    if (parsed.data.executionId !== executionId) throw new ToolProgressError(404, "tool_progress_not_found");
    const outcome = await transaction(async (tx) => {
      const original = await locked(tx, companyId, executionId);
      if ("token" in auth && !validProgressToken(original.tokenHash, auth.token)) throw new ToolProgressError(401, "tool_progress_unauthorized");
      if ("local" in auth && (original.adapterType !== "builtin" || original.tokenHash !== null)) {
        throw new ToolProgressError(401, "tool_progress_unauthorized");
      }
      const { row, now } = await guard(tx, original);
      if (row.state !== "active") return { error: new ToolProgressError(409, row.reason ?? "tool_progress_terminal") };
      const next = advance(row, parsed.data);
      if (!next) return { receipt: { accepted: false, reason: "no_progress" } as const };
      if (row.sequence > 0 && now.getTime() - row.lastProgressAt.getTime() < 1000) {
        return { receipt: { accepted: false, reason: "throttled" } as const };
      }
      const [updated] = await tx.update(table).set({ ...next, lastProgressAt: now })
        .where(and(eq(table.companyId, companyId), eq(table.id, executionId))).returning();
      const evidence = "local" in auth ? await readProgressEvidence(tx, updated, auth.progressEvidenceContext) : null;
      await audit(tx, updated, "advanced", evidence);
      return { receipt: { accepted: true } as const };
    });
    // Throw outside the transaction so expiry/scope terminal evidence is committed.
    if (outcome.error) throw outcome.error;
    return outcome.receipt!;
  }
  return {
    async start(scope: ProgressScope, rawPolicy: ToolProgressPolicy, tokenHash?: string): Promise<ToolProgressHeartbeat> {
      const parsed = toolProgressPolicySchema.safeParse(rawPolicy);
      if (!parsed.success) throw new ToolProgressError(422, "tool_progress_invalid_policy");
      if ((scope.adapterType === "http" && !tokenHash) || (tokenHash && !/^[a-f0-9]{64}$/.test(tokenHash))) {
        throw new ToolProgressError(422, "tool_progress_invalid_token_hash");
      }
      return transaction(async (tx) => {
        const [tool] = await tx.select({ id: toolDefinitions.id }).from(toolDefinitions)
          .where(and(eq(toolDefinitions.id, scope.toolId), eq(toolDefinitions.companyId, scope.companyId))).for("share");
        if (!tool) throw new ToolProgressError(422, "tool_progress_invalid_scope");
        const binding = await lockProgressScope(tx, scope);
        const now = await clock(tx);
        const [row] = await tx.insert(table).values({ ...scope, ...binding, policy: parsed.data, tokenHash: tokenHash ?? null,
          startedAt: now, lastProgressAt: now }).returning();
        await audit(tx, row, "started");
        return dto(row);
      });
    },
    accept(companyId: string, executionId: string, event: ToolProgressEvent, token: string): Promise<ProgressReceipt> {
      return acceptInternal(companyId, executionId, event, { token });
    },
    acceptLocal(companyId: string, executionId: string, event: ToolProgressEvent,
      progressEvidenceContext?: LocalEvidenceContext): Promise<ProgressReceipt> {
      return acceptInternal(companyId, executionId, event, { local: true, progressEvidenceContext });
    },
    async check(companyId: string, executionId: string): Promise<ToolProgressHeartbeat> {
      return transaction(async (tx) => dto((await guard(tx, await locked(tx, companyId, executionId))).row));
    },
    async finish(companyId: string, executionId: string, outcome: "succeeded" | "failed", reason?: string): Promise<ToolProgressHeartbeat> {
      const safeReason = reason && /^tool_[a-z0-9_]{1,59}$/.test(reason) ? reason : null;
      return transaction(async (tx) => {
        const { row, now } = await guard(tx, await locked(tx, companyId, executionId));
        if (row.state !== "active") return dto(row);
        return dto(await settle(tx, row, now, outcome, safeReason));
      });
    },
  };
}
export type ToolProgressStore = ReturnType<typeof createToolProgressStore>;
