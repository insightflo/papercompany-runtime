import type { missions, workflowRuns } from "@paperclipai/db";
import type { Express } from "express";
export function replacementSourceEligible(mission: Pick<typeof missions.$inferSelect, "id" | "status"> | undefined,
  run: Pick<typeof workflowRuns.$inferSelect, "missionId" | "status" | "parentRunId" | "parentStepRunId" | "triggeredBy"> | undefined) {
  return Boolean(mission && mission.status === "active" && run && run.missionId === mission.id && run.status === "failed"
    && !run.parentRunId && !run.parentStepRunId && run.triggeredBy !== "workflow-step");
}
export function replacementDecisionSelected(decision: string | null) { return decision === "restart_from_start"; }
export function replacementOperatorEligible(actor: Express.Request["actor"], companyId: string) {
  return actor.type === "board" && Boolean(actor.userId || actor.source === "local_implicit")
    && (actor.source === "local_implicit" || Boolean(actor.isInstanceAdmin) || Boolean(actor.companyIds?.includes(companyId)));
}
export function replacementRequesterEligible(actor: Express.Request["actor"] | undefined, companyId: string) {
  return actor?.type === "agent" && Boolean(actor.agentId) && actor.companyId === companyId;
}
