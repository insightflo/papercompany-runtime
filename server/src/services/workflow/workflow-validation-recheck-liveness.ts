import { and, eq, inArray, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { TERMINAL_RUN_STATUSES } from "./run-terminal-boundary.js";

/** Exact durable continuation liveness only; never verdict, completion or dispatch authority. */
export async function hasLiveValidationRecheck(
  db: Pick<Db, "select">,
  run: { id: string; companyId: string },
): Promise<boolean> {
  const w = agentWakeupRequests, s = workflowStepRuns, r = workflowRuns, h = heartbeatRuns;
  const exactHeartbeatTyping = and(
    eq(h.workflowStepRunId, s.id), eq(h.workflowExecutionGeneration, s.executionGeneration),
  );
  const [live] = await db.select({ id: w.id }).from(w)
    .innerJoin(s, and(eq(w.workflowStepRunId, s.id), eq(w.issueId, s.issueId),
      eq(w.workflowExecutionGeneration, s.executionGeneration)))
    .innerJoin(r, and(eq(s.workflowRunId, r.id), eq(w.workflowRunId, r.id), eq(w.companyId, r.companyId)))
    .leftJoin(h, eq(h.id, w.runId))
    .where(and(
      eq(r.id, run.id), eq(r.companyId, run.companyId), notInArray(r.status, [...TERMINAL_RUN_STATUSES]),
      isNotNull(s.issueId), isNotNull(w.workflowExecutionGeneration),
      eq(w.requestKind, "workflow_resume"), isNull(w.finishedAt),
      or(
        and(inArray(w.status, ["queued", "deferred_issue_execution"]), isNull(w.runId)),
        and(
          eq(h.wakeupRequestId, w.id), eq(h.companyId, w.companyId), eq(h.agentId, w.agentId), eq(h.issueId, s.issueId),
          isNull(h.finishedAt), isNull(h.terminalOutcome), isNull(h.terminalDecidedAt),
          or(
            and(eq(w.status, "queued"), eq(h.status, "queued"),
              or(and(isNull(h.workflowStepRunId), isNull(h.workflowExecutionGeneration)), exactHeartbeatTyping)),
            and(inArray(w.status, ["queued", "claimed"]), eq(h.status, "running"), exactHeartbeatTyping),
          ),
        ),
      ),
    )).limit(1);
  return live !== undefined;
}
