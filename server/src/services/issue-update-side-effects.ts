import type { Db } from "@paperclipai/db";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "./issue-assignment-wakeup.js";

export interface IssueUpdatedActorContext {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

export async function applyIssueUpdatedSideEffects(input: {
  db: Db;
  heartbeat?: IssueAssignmentWakeupDeps;
  actor: IssueUpdatedActorContext;
  existing: {
    id: string;
    companyId: string;
    identifier: string | null;
    assigneeAgentId?: string | null;
    status: string;
  };
  updated: {
    id: string;
    companyId: string;
    identifier: string | null;
    assigneeAgentId?: string | null;
    status: string;
  };
  patch: Record<string, unknown>;
  logActivity: (db: Db, input: {
    companyId: string;
    actorType: "agent" | "user" | "system";
    actorId: string;
    agentId?: string | null;
    runId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown> | null;
  }) => Promise<void>;
}) {
  const previous: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input.patch)) {
    if (key in input.existing && input.existing[key as keyof typeof input.existing] !== value) {
      previous[key] = input.existing[key as keyof typeof input.existing];
    }
  }

  if (Object.keys(previous).length === 0) {
    return;
  }

  await input.logActivity(input.db, {
    companyId: input.updated.companyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    agentId: input.actor.agentId ?? null,
    runId: input.actor.runId ?? null,
    action: "issue.updated",
    entityType: "issue",
    entityId: input.updated.id,
    details: {
      ...input.patch,
      identifier: input.updated.identifier,
      _previous: previous,
    },
  });

  if (!input.heartbeat) return;

  const assigneeChanged =
    Object.prototype.hasOwnProperty.call(previous, "assigneeAgentId") &&
    input.updated.assigneeAgentId !== input.existing.assigneeAgentId;
  const statusChangedFromBacklog =
    Object.prototype.hasOwnProperty.call(previous, "status") &&
    input.existing.status === "backlog" &&
    input.updated.status !== "backlog";

  if (assigneeChanged) {
    void queueIssueAssignmentWakeup({
      heartbeat: input.heartbeat,
      issue: {
        id: input.updated.id,
        assigneeAgentId: input.updated.assigneeAgentId ?? null,
        status: input.updated.status,
      },
      reason: "issue_assigned",
      mutation: "update",
      contextSource: "plugin.issues.update",
      requestedByActorType: input.actor.actorType,
      requestedByActorId: input.actor.actorId,
    });
    return;
  }

  if (statusChangedFromBacklog) {
    const assigneeAgentId = input.updated.assigneeAgentId ?? null;
    if (!assigneeAgentId || input.updated.status === "backlog") return;
    void input.heartbeat.wakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_status_changed",
      payload: { issueId: input.updated.id, mutation: "update" },
      requestedByActorType: input.actor.actorType,
      requestedByActorId: input.actor.actorId,
      contextSnapshot: { issueId: input.updated.id, source: "plugin.issue.status_change" },
    });
  }
}
