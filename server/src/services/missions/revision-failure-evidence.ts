import { and, desc, eq, sql } from "drizzle-orm";
import { heartbeatRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { z } from "zod";
import { loadStructuralGateVerdictByRequest } from "../workflow/control-flow/structural-gate-ledger.js";
import type { RevisionStep } from "../workflow/revision-step-config.js";

const toolFailure = z.object({ requestId: z.string().min(1), success: z.literal(false) }).passthrough();
/** A failed result is not necessarily an adapter error. Official QA rejection and native
 * tool completion have their own durable authority, without a failed heartbeat/errorCode. */
export async function hasRevisionResultFailure(db: Db, companyId: string, step: typeof workflowStepRuns.$inferSelect,
  definition: RevisionStep, heartbeats: (typeof heartbeatRuns.$inferSelect)[]) {
  if (definition.type === "tool" && step.lastDispatchRequestId) {
    const result = toolFailure.safeParse(step.metadata?.toolResult);
    if (result.success && result.data.requestId === step.lastDispatchRequestId) return true;
    if (definition.qaType === "structural") {
      const verdict = await loadStructuralGateVerdictByRequest(db, companyId, step.id, step.lastDispatchRequestId);
      if (verdict?.verdict === "request_changes" && verdict.producerToken) return true;
    }
  }
  if (!step.issueId) return false;
  const verdicts = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.workflowRunId, step.workflowRunId),
    eq(workflowTransitionEvents.workflowStepRunId, step.id), eq(workflowTransitionEvents.issueId, step.issueId),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"), eq(workflowTransitionEvents.reason, "workflow_api"),
    sql`${workflowTransitionEvents.payload}->>'sourceCommentId' is null`,
  )).orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id));
  const latest = verdicts.find(v => heartbeats.some(h => h.id === v.heartbeatRunId));
  return latest?.verdict === "request_changes";
}
