import type { Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "./issue-assignment-wakeup.js";

export interface IssueCreatedActorContext {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

export async function applyIssueCreatedSideEffects(input: {
  db: Db;
  heartbeat: IssueAssignmentWakeupDeps;
  issue: {
    id: string;
    companyId: string;
    title: string;
    identifier: string | null;
    assigneeAgentId: string | null;
    status: string;
  };
  actor: IssueCreatedActorContext;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  waitForWakeCompletion?: boolean;
  rethrowOnWakeError?: boolean;
}) {
  const wakePromise = queueIssueAssignmentWakeup({
    heartbeat: input.heartbeat,
    issue: input.issue,
    reason: "issue_assigned",
    mutation: "create",
    contextSource: input.contextSource,
    requestedByActorType: input.requestedByActorType ?? input.actor.actorType,
    requestedByActorId: input.requestedByActorId ?? input.actor.actorId,
    rethrowOnError: input.rethrowOnWakeError,
  });

  if (input.waitForWakeCompletion) {
    await wakePromise;
  }

  await logActivity(input.db, {
    companyId: input.issue.companyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    agentId: input.actor.agentId ?? null,
    runId: input.actor.runId ?? null,
    action: "issue.created",
    entityType: "issue",
    entityId: input.issue.id,
    details: {
      title: input.issue.title,
      identifier: input.issue.identifier,
    },
  });
}
