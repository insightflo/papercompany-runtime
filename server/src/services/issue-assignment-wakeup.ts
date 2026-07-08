import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
      idempotencyKey?: string | null;
    },
  ) => Promise<unknown>;
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  payload?: Record<string, unknown>;
  contextSnapshot?: Record<string, unknown>;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}) {
  const idempotency =
    typeof input.idempotencyKey === "string" && input.idempotencyKey.trim().length > 0
      ? { idempotencyKey: input.idempotencyKey.trim() }
      : {};
  const workflowResumeContext = {
    ...(input.payload ?? {}),
    ...(input.contextSnapshot ?? {}),
  };
  const isWorkflowResume =
    input.mutation === "workflow_resume" &&
    typeof workflowResumeContext.workflowRunId === "string" &&
    typeof workflowResumeContext.workflowStepRunId === "string";
  if (
    !input.issue.assigneeAgentId ||
    input.issue.status === "backlog" ||
    (input.issue.status === "blocked" && !isWorkflowResume) ||
    (input.issue.status === "done" && !isWorkflowResume) ||
    input.issue.status === "cancelled"
  ) {
    return;
  }

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation, ...(input.payload ?? {}) },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issue.id, source: input.contextSource, ...(input.contextSnapshot ?? {}) },
      ...idempotency,
    })
    .catch((err) => {
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
