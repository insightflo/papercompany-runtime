import { and, eq, inArray, or } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, missions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { budgetService } from "./budgets.js";
import { assertRunNotReplaced } from "./workflow/run-replacement-guard.js";
import { budgetBlockers } from "./workflow/resume/preview-facts.js";
import { assertMissionRuntimeAcceptsWork } from "./missions/mission-runtime-manager.js";
import { claimQueuedHeartbeatRun } from "./heartbeat-finalization/shadow-writes.js";

type Scope = {
  companyId: string;
  agentId: string;
  issueId?: string | null;
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  contextSnapshot?: unknown;
  wakeupRequestId?: string | null;
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** All identity paths are OR-ed: an explicit hint never hides the issue's actual run.
 * Owner/oversight issue mission membership alone is deliberately NOT an execution link.
 * Caller owns a transaction; acquire mission → run before issue/wake/heartbeat locks.
 */
export async function assertHeartbeatRecoveryAdmission(db: Db, input: Scope) {
  const context = record(input.contextSnapshot);
  const issueIds = [...new Set([input.issueId, text(context.issueId)].filter((id): id is string => !!id))];
  const stepIds = [...new Set([input.workflowStepRunId, text(context.workflowStepRunId)].filter((id): id is string => !!id))];
  const runIds = new Set([input.workflowRunId, text(context.workflowRunId)].filter((id): id is string => !!id));
  if (input.wakeupRequestId) {
    const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, input.wakeupRequestId), eq(agentWakeupRequests.companyId, input.companyId)));
    if (wake?.workflowRunId) runIds.add(wake.workflowRunId);
    if (wake?.workflowStepRunId) stepIds.push(wake.workflowStepRunId);
    if (wake?.issueId) issueIds.push(wake.issueId);
  }
  if (issueIds.length || stepIds.length) {
    const steps = await db.select({ runId: workflowStepRuns.workflowRunId }).from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
      .where(and(eq(workflowRuns.companyId, input.companyId), or(inArray(workflowStepRuns.issueId, issueIds), inArray(workflowStepRuns.id, stepIds))));
    for (const step of steps) runIds.add(step.runId);
    const origins = await db.select({ runId: issues.originRunId }).from(issues).where(and(
      eq(issues.companyId, input.companyId), inArray(issues.id, issueIds), eq(issues.originKind, "workflow_execution")));
    for (const origin of origins) if (origin.runId) runIds.add(origin.runId);
  }
  if (!runIds.size) return;
  const runs = await db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, input.companyId), inArray(workflowRuns.id, [...runIds])));
  if (runs.length !== runIds.size) throw conflict("heartbeat_workflow_scope_missing");
  runs.sort((a, b) => (a.missionId ?? "").localeCompare(b.missionId ?? "") || a.id.localeCompare(b.id));
  for (const run of runs) {
    // NO KEY UPDATE conflicts with replacement's UPDATE lock but permits FK key-share
    // reads by the existing session initializer on its separate connection.
    if (run.missionId) {
      await db.select().from(missions).where(and(eq(missions.id, run.missionId), eq(missions.companyId, input.companyId))).for("no key update");
      await assertMissionRuntimeAcceptsWork(db, { companyId: input.companyId, missionId: run.missionId });
    }
    const [locked] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.companyId, input.companyId))).for("no key update");
    if (!locked || locked.missionId !== run.missionId) throw conflict("workflow_run_scope_changed");
    await assertRunNotReplaced(db, run.id, input.companyId);
    if (locked.status === "cancelled") throw conflict("workflow_run_cancelled");
  }
  // The monthly counters are authoritative even before an asynchronous pause policy fires.
  // Share locks keep budget/cancel updates from crossing the actual adapter-start boundary.
  const [company] = await db.select().from(companies).where(eq(companies.id, input.companyId)).for("share");
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))).for("share");
  if (!company || !agent || budgetBlockers(company).length || budgetBlockers(agent).length) throw conflict("heartbeat_workflow_budget_hard_stop");
  if (["paused", "terminated", "pending_approval"].includes(agent.status)) throw conflict("heartbeat_agent_not_invokable");
  const block = await budgetService(db).getInvocationBlock(input.companyId, input.agentId, {
    issueId: input.issueId ?? text(context.issueId), projectId: text(context.projectId),
  });
  if (block) throw conflict(block.reason);
}

/** Claim and replacement admission serialize on the same mission/source-run locks. */
export async function claimHeartbeatWithRecoveryGuard(db: Db, run: typeof heartbeatRuns.$inferSelect, claimedAt: Date) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await assertHeartbeatRecoveryAdmission(t, run);
    const [agent] = await t.select().from(agents).where(eq(agents.id, run.agentId));
    if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status)) throw conflict("Cancelled because the agent is not invokable");
    const context = record(run.contextSnapshot);
    const block = await budgetService(t).getInvocationBlock(run.companyId, run.agentId, { issueId: text(context.issueId), projectId: text(context.projectId) });
    if (block) throw conflict(block.reason);
    const missionId = text(context.missionId);
    if (missionId) await assertMissionRuntimeAcceptsWork(t, { companyId: run.companyId, missionId });
    return claimQueuedHeartbeatRun(t, run, claimedAt);
  });
}

function executionIdentity(run: typeof heartbeatRuns.$inferSelect) {
  const context = record(run.contextSnapshot);
  return JSON.stringify([run.agentId, run.issueId, run.wakeupRequestId, run.workflowStepRunId,
    run.workflowExecutionGeneration, context.issueId, context.workflowRunId, context.workflowStepRunId]);
}

/** Start the adapter under the lock, but never hold a DB transaction for its lifetime.
 * The returned box prevents Promise assimilation until after the transaction commits.
 */
export async function executeHeartbeatWithRecoveryGuard<T>(db: Db, run: typeof heartbeatRuns.$inferSelect, execute: () => Promise<T>): Promise<T> {
  const started = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await assertHeartbeatRecoveryAdmission(t, run).catch((error) => {
      throw Object.assign(error, { code: "heartbeat_recovery_blocked" });
    });
    const [current] = await t.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId))).for("share");
    if (!current || current.status !== "running" || executionIdentity(current) !== executionIdentity(run)) {
      throw Object.assign(conflict("heartbeat_execution_cancelled_or_scope_changed"), { code: "heartbeat_recovery_blocked" });
    }
    const result = execute();
    // Attach immediately so an adapter's synchronous rejection cannot be unhandled while committing.
    void result.catch(() => {});
    return { result };
  });
  return started.result;
}
