import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { CorrectionDeliveryInput } from "./workflow/control-flow/qa-correction-delivery-root.js";
import { assertDeliveryScope, assertDeliverySignature, assertDeliveryWake, readDeliveryWakeCandidates,
  findDeliveryEvent, requireDelivery } from "./workflow/control-flow/qa-correction-delivery-receipt.js";
import { readIssuedQaCorrectionFollowupForAttempt } from "./workflow/control-flow/qa-correction-reader.js";
import { logger } from "../middleware/logger.js";

export class QaCorrectionRootOwnerRequired extends Error {
  readonly code = "qa_correction_root_owner_required";

  constructor() {
    super("qa_correction_root_owner_required");
    this.name = "QaCorrectionRootOwnerRequired";
  }
}

export function isQaCorrectionRootOwnerRequired(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    if (current instanceof QaCorrectionRootOwnerRequired) return true;
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export type ReplacementRootNotifications = {
  readonly agentIds: Set<string>;
  readonly correctionWakeupRequestIds: Set<string>;
};

// Exact DB identity carries notifications only; it does not establish execution authority.
const rootNotifications = new WeakMap<Db, ReplacementRootNotifications>();

export function createReplacementRootNotifications(): ReplacementRootNotifications {
  return { agentIds: new Set<string>(), correctionWakeupRequestIds: new Set<string>() };
}

export function currentReplacementRootNotifications(actualDb: Db): ReplacementRootNotifications | null {
  return rootNotifications.get(actualDb) ?? null;
}

export function registerQaCorrectionRootDrain(actualDb: Db, agentId: string): void {
  const notifications = currentReplacementRootNotifications(actualDb);
  if (!notifications) throw new QaCorrectionRootOwnerRequired();
  notifications.agentIds.add(agentId);
}

export async function validateAndRegisterQaCorrectionRootDrain(actualDb: Db, input: CorrectionDeliveryInput): Promise<void> {
  const history = await readIssuedQaCorrectionFollowupForAttempt(actualDb, input.ref);
  await assertDeliveryScope(actualDb, input, history);
  const pending = await readDeliveryWakeCandidates(actualDb, input);
  if (!pending.length) throw new QaCorrectionRootOwnerRequired();
  requireDelivery(pending.length === 1, "duplicate_wake");
  const wake = pending[0]!;
  requireDelivery((!input.candidateWakeupRequestId || wake.id === input.candidateWakeupRequestId)
    && ["queued", "deferred_issue_execution"].includes(wake.status) && wake.runId === null
    && wake.claimedAt === null && wake.finishedAt === null && wake.error === null, "pending");
  await assertDeliveryWake(actualDb, input, history, wake);
  assertDeliverySignature(input, wake, false);
  requireDelivery(!(await actualDb.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.wakeupRequestId, wake.id))).length && !await findDeliveryEvent(actualDb, input), "pending");
  const notifications = currentReplacementRootNotifications(actualDb);
  if (!notifications) throw new QaCorrectionRootOwnerRequired();
  notifications.correctionWakeupRequestIds.add(wake.id);
}

export async function withReplacementRootNotificationDb<T>(
  actualDb: Db,
  notifications: ReplacementRootNotifications,
  work: () => Promise<T>,
): Promise<T> {
  const previous = rootNotifications.get(actualDb);
  rootNotifications.set(actualDb, notifications);
  try {
    return await work();
  } finally {
    if (previous) rootNotifications.set(actualDb, previous);
    else rootNotifications.delete(actualDb);
  }
}

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
      if (input.rethrowOnError || isQaCorrectionRootOwnerRequired(err)) throw err;
      return null;
    });
}
