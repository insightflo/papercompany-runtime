// C08 identity/authority reads. No checkout adoption, card writes or execution admission occurs here.
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, missions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { z } from "zod";
import { conflict } from "../../errors.js";
import type { OwnerRecoveryTarget } from "./mission-owner-recovery-events.js";
import { MISSION_OWNER_DECISION_EVENT_TYPE, MISSION_OWNER_DECISION_SOURCE } from "./mission-owner-decision-contract.js";
import { ownerRecoveryRunMatches, ownerRecoveryStepMatches } from "./owner-recovery-submission-guards.js";
import {
  OWNER_HUMAN_LAYER, ownerHumanScopeSchema, ownerHumanSubmissionSchema, sameOwnerHumanValue,
  type OwnerHumanLifetime, type OwnerHumanTx,
} from "./owner-human-request-contract.js";

const toolLinkSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("tool_step"),
  workflowRunId: z.string().uuid(), stepRunId: z.string().uuid() }).strict();
const originalPayloadSchema = ownerHumanSubmissionSchema.extend({
  kind: z.literal(MISSION_OWNER_DECISION_EVENT_TYPE), source: z.literal(MISSION_OWNER_DECISION_SOURCE),
  ownerActionIssueId: z.string().uuid(), sourceIssueId: z.string().uuid().nullable(), commentId: z.string().uuid().nullable(),
}).strict();
const reject = (): never => { throw conflict("Owner human request authority mismatch", {
  reason: "owner_human_request_authority_mismatch",
}); };

async function toolIdentity(tx: OwnerHumanTx, companyId: string, missionId: string, anchorId: string) {
  const rows = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.missionId, missionId),
    eq(workflowTransitionEvents.issueId, anchorId), eq(workflowTransitionEvents.eventType, "owner_tool_recovery_target_v1")));
  if (rows.length > 1) return reject();
  const row = rows[0];
  if (!row) return null;
  const parsed = toolLinkSchema.safeParse(row.payload);
  if (!parsed.success || row.layer !== OWNER_HUMAN_LAYER
    || row.workflowRunId !== parsed.data.workflowRunId || row.workflowStepRunId !== parsed.data.stepRunId
    || row.idempotencyKey !== `owner-tool-card:${parsed.data.stepRunId}`) return reject();
  return parsed.data;
}

export type OwnerHumanAuthorityInput = {
  companyId: string; missionId: string; ownerActionIssueId: string;
  agentId: string; heartbeatRunId: string; recoveryTarget?: OwnerRecoveryTarget;
  purpose?: "submit" | "settle";
};

// Caller holds the existing quality prefix, if applicable. The only locking order here is:
// mission -> related run -> heartbeat -> sorted issues -> step. Pointer/card/continuation follow.
// Discovery reads are not authority: all mutable identity facts are checked again under these locks.
export async function lockOwnerHumanRequestAuthority(tx: OwnerHumanTx, input: OwnerHumanAuthorityInput) {
  const purpose = input.purpose ?? "submit";
  const [mission] = await tx.select().from(missions).where(and(
    eq(missions.id, input.missionId), eq(missions.companyId, input.companyId))).for("update");
  if (!mission || mission.ownerAgentId !== input.agentId) return reject();
  if (purpose === "submit" && ["completed", "cancelled"].includes(mission.status)) return reject();
  const [observed] = await tx.select().from(issues).where(and(
    eq(issues.id, input.ownerActionIssueId), eq(issues.companyId, input.companyId),
    eq(issues.missionId, input.missionId)));
  if (!observed) return reject();
  const oversight = observed.originKind === "mission_main_executor_oversight";
  if (!oversight && observed.originKind !== "mission_main_executor_unblock") return reject();
  if (oversight && input.recoveryTarget) return reject();
  let source: typeof issues.$inferSelect | undefined;
  if (!oversight) {
    if (!observed.originId) return reject();
    [source] = await tx.select().from(issues).where(and(eq(issues.id, observed.originId),
      eq(issues.companyId, input.companyId), eq(issues.missionId, input.missionId)));
    if (!source) return reject();
  }
  const tool = await toolIdentity(tx, input.companyId, input.missionId, observed.id);
  if (oversight && tool) return reject();
  const runId = tool?.workflowRunId ?? source?.originRunId ?? null;
  let run: typeof workflowRuns.$inferSelect | undefined;
  if (runId) {
    [run] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId),
      eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.missionId, input.missionId))).for("update");
    if (!run) return reject();
  }
  const [heartbeat] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.heartbeatRunId)).for("share");
  const locked = new Map<string, typeof issues.$inferSelect>();
  for (const id of [...new Set([observed.id, ...(source ? [source.id] : [])])].sort()) {
    const [row] = await tx.select().from(issues).where(eq(issues.id, id)).for("update");
    if (!row || row.companyId !== input.companyId || row.missionId !== input.missionId) return reject();
    locked.set(id, row);
  }
  const anchor = locked.get(observed.id)!;
  if (anchor.originKind !== observed.originKind || anchor.originId !== observed.originId
    || anchor.assigneeAgentId !== input.agentId || !heartbeat || heartbeat.companyId !== input.companyId
    || heartbeat.agentId !== input.agentId || heartbeat.issueId !== anchor.id) return reject();
  if (purpose === "submit" && (["done", "cancelled"].includes(anchor.status)
    || (oversight && heartbeat.status !== "running"))) return reject();
  if (source) {
    source = locked.get(source.id)!;
    if (source.id !== anchor.originId || (!tool && source.originRunId !== runId)) return reject();
  }
  let step: typeof workflowStepRuns.$inferSelect | undefined;
  if (tool) {
    [step] = await tx.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.id, tool.stepRunId),
      eq(workflowStepRuns.workflowRunId, tool.workflowRunId))).for("update");
    if (!step) return reject();
  }
  const target = input.recoveryTarget;
  if (target?.kind === "tool_step") {
    if (!tool || target.workflowRunId !== tool.workflowRunId || target.stepRunId !== tool.stepRunId) return reject();
    if (purpose === "submit" && (!ownerRecoveryRunMatches(run, target) || !ownerRecoveryStepMatches(step, target))) return reject();
  } else if (target && (tool || target.issueId !== source?.id)) return reject();
  const scope = ownerHumanScopeSchema.parse({ companyId: input.companyId, missionId: input.missionId,
    target: oversight ? { kind: "oversight" } : tool
      ? { kind: "tool_step", workflowRunId: tool.workflowRunId, stepRunId: tool.stepRunId }
      : { kind: "source_issue", issueId: source!.id } });
  return { tx, scope, anchor, source, run, step, purpose,
    agentId: input.agentId, heartbeatRunId: input.heartbeatRunId, recoveryTarget: input.recoveryTarget };
}
export type OwnerHumanAuthority = Awaited<ReturnType<typeof lockOwnerHumanRequestAuthority>>;

// Exact immutable-origin validation, also used when reading current state after a restart.
// These plain historical reads do not acquire an earlier lock after the pointer lock.
export async function assertOwnerHumanOriginalDecision(tx: OwnerHumanTx, lifetime: OwnerHumanLifetime) {
  const [event] = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.id, lifetime.decisionEventId),
    eq(workflowTransitionEvents.companyId, lifetime.scope.companyId)));
  if (!event || event.eventType !== MISSION_OWNER_DECISION_EVENT_TYPE || event.layer !== OWNER_HUMAN_LAYER
    || event.reason !== MISSION_OWNER_DECISION_SOURCE || event.reasonCode !== MISSION_OWNER_DECISION_SOURCE
    || event.missionId !== lifetime.scope.missionId || event.issueId !== lifetime.anchorIssueId
    || event.heartbeatRunId !== lifetime.heartbeatRunId || event.decision !== lifetime.submission.decision) return reject();
  const parsed = originalPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return reject();
  const { kind: _kind, source: _source, ownerActionIssueId, sourceIssueId, commentId: _comment, ...submission } = parsed.data;
  if (ownerActionIssueId !== lifetime.anchorIssueId || sourceIssueId !== lifetime.sourceIssueId
    || !sameOwnerHumanValue(submission, lifetime.submission)) return reject();
  const [heartbeat] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, lifetime.heartbeatRunId));
  const [anchor] = await tx.select().from(issues).where(eq(issues.id, lifetime.anchorIssueId));
  if (!heartbeat || heartbeat.companyId !== lifetime.scope.companyId || heartbeat.issueId !== lifetime.anchorIssueId
    || heartbeat.agentId !== lifetime.authorAgentId || !anchor || anchor.companyId !== lifetime.scope.companyId
    || anchor.missionId !== lifetime.scope.missionId) return reject();
  const target = lifetime.scope.target;
  if (target.kind === "oversight") {
    if (anchor.originKind !== "mission_main_executor_oversight" || lifetime.sourceIssueId !== null
      || lifetime.submission.recoveryTarget) return reject();
  } else {
    if (anchor.originKind !== "mission_main_executor_unblock" || anchor.originId !== lifetime.sourceIssueId) return reject();
    const [source] = await tx.select().from(issues).where(and(eq(issues.id, lifetime.sourceIssueId!),
      eq(issues.companyId, lifetime.scope.companyId), eq(issues.missionId, lifetime.scope.missionId)));
    if (!source) return reject();
    if (target.kind === "source_issue" && target.issueId !== source.id) return reject();
    if (target.kind === "tool_step") {
      const tool = await toolIdentity(tx, lifetime.scope.companyId, lifetime.scope.missionId, lifetime.anchorIssueId);
      if (!tool || tool.workflowRunId !== target.workflowRunId || tool.stepRunId !== target.stepRunId) return reject();
    }
  }
  if (lifetime.cardInput.workflowRunId) {
    const [run] = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
      eq(workflowRuns.id, lifetime.cardInput.workflowRunId), eq(workflowRuns.companyId, lifetime.scope.companyId),
      eq(workflowRuns.missionId, lifetime.scope.missionId)));
    if (!run) return reject();
  }
}
