import { and, eq, inArray, or, isNull } from "drizzle-orm";
import { companies, agents, agentWakeupRequests, heartbeatRuns, toolExecutionHeartbeats, workflowStepRuns, type Db } from "@paperclipai/db";
import { budgetBlockers } from "./resume/preview-facts.js";
import { budgetService } from "../budgets.js";

type Step = typeof workflowStepRuns.$inferSelect;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Read only machine-written request/result identity. Failed step status is not process quiescence.
export async function replacementExecutionInFlight(db: Pick<Db, "select">, companyId: string, runId: string, steps: Step[]) {
  const ids = steps.map((s) => s.id), issues = steps.flatMap((s) => s.issueId ? [s.issueId] : []);
  const [heartbeat] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), or(inArray(heartbeatRuns.workflowStepRunId, ids), inArray(heartbeatRuns.issueId, issues)),
    or(inArray(heartbeatRuns.status, ["running", "queued"]), and(eq(heartbeatRuns.finalizationVersion, 1), isNull(heartbeatRuns.settledAt))),
  )).limit(1);
  const [wake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId),
    or(eq(agentWakeupRequests.workflowRunId, runId), inArray(agentWakeupRequests.workflowStepRunId, ids), inArray(agentWakeupRequests.issueId, issues)),
    inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
  )).limit(1);
  const [tool] = await db.select({ id: toolExecutionHeartbeats.id }).from(toolExecutionHeartbeats).where(and(
    eq(toolExecutionHeartbeats.companyId, companyId), eq(toolExecutionHeartbeats.state, "active"),
    or(eq(toolExecutionHeartbeats.workflowRunId, runId), inArray(toolExecutionHeartbeats.stepRunId, ids)),
  )).limit(1);
  return !!heartbeat || !!wake || !!tool || steps.some((s) => {
    const metadata = record(s.metadata), invocation = record(metadata.toolInvocation), result = record(metadata.toolResult);
    const requestId = invocation.requestId ?? s.lastDispatchRequestId;
    if (!metadata.toolQueue && !invocation.queuedAt && !invocation.dispatchedAt) return false;
    // Completed matching attempts leave queue metadata behind. A different/absent result cannot settle this request.
    return !(typeof requestId === "string" && result.requestId === requestId && typeof result.completedAt === "string")
      && !invocation.dispatchError;
  });
}

export async function replacementBudgetBlocked(db: Db, companyId: string, ownerAgentId: string) {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  const [owner] = await db.select().from(agents).where(and(eq(agents.id, ownerAgentId), eq(agents.companyId, companyId)));
  if (!company || !owner || budgetBlockers(company).length || budgetBlockers(owner).length) return true;
  return !!await budgetService(db).getInvocationBlock(companyId, ownerAgentId);
}
