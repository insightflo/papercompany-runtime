import type { PlanQaWakeupHandler } from "../mission-owner-plan-decisions.js";

type WakeupDeps = {
  wakeup: (agentId: string, opts: {
    source?: "timer" | "assignment" | "on_demand" | "automation" | "scheduler";
    triggerDetail?: string | null;
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  }) => Promise<unknown>;
};

export function createPlanQaWakeupHandler(
  heartbeat: WakeupDeps,
  opts: { requestedByActorId?: string; contextSource?: string } = {},
): PlanQaWakeupHandler {
  return (input) => heartbeat.wakeup(input.agentId, {
    source: "assignment",
    triggerDetail: "system",
    reason: "issue_assigned",
    idempotencyKey: `mission-plan-qa:${input.issueId}:issue-assigned`,
    payload: {
      issueId: input.issueId,
      missionId: input.missionId,
      mutation: "create",
      originKind: "mission_plan_qa",
      ...(input.planningIssueId ? { planningIssueId: input.planningIssueId } : {}),
    },
    requestedByActorType: "system",
    requestedByActorId: opts.requestedByActorId ?? "mission-plan-qa",
    contextSnapshot: {
      issueId: input.issueId,
      missionId: input.missionId,
      source: opts.contextSource ?? "mission_plan_qa",
      originKind: "mission_plan_qa",
      ...(input.planningIssueId ? { planningIssueId: input.planningIssueId } : {}),
    },
  });
}
