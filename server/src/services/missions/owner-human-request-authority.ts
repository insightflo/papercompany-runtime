// C08 identity/authority reads. No checkout adoption, card writes or execution admission occurs here.
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, missions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { z } from "zod";
import { conflict } from "../../errors.js";
import type { OwnerRecoveryTarget } from "./mission-owner-recovery-events.js";
import { MISSION_OWNER_DECISION_EVENT_TYPE, MISSION_OWNER_DECISION_SOURCE } from "./mission-owner-decision-contract.js";
import { ownerRecoveryRunMatches, ownerRecoveryStepMatches } from "./owner-recovery-submission-guards.js";
import {
  OWNER_HUMAN_LAYER, OWNER_HUMAN_SOURCE, ownerHumanScopeSchema, ownerHumanSubmissionSchema, sameOwnerHumanValue,
  ownerHumanLifetimeSchema, ownerHumanLifetimeKey, ownerHumanEndKey, ownerHumanEndSchema,
  type OwnerHumanLifetime, type OwnerHumanTx,
} from "./owner-human-request-contract.js";

const toolLinkV1 = z.object({ schemaVersion: z.literal(1), kind: z.literal("tool_step"),
  workflowRunId: z.string().uuid(), stepRunId: z.string().uuid() }).strict();
const toolLinkSchema = z.union([toolLinkV1, toolLinkV1.extend({ schemaVersion: z.literal(2),
  companyId: z.string().uuid(), missionId: z.string().uuid(), anchorIssueId: z.string().uuid(),
  sourceIssueId: z.string().uuid() }).strict()]);
const originalPayloadSchema = ownerHumanSubmissionSchema.extend({
  kind: z.literal(MISSION_OWNER_DECISION_EVENT_TYPE), source: z.literal(MISSION_OWNER_DECISION_SOURCE),
  ownerActionIssueId: z.string().uuid(), sourceIssueId: z.string().uuid().nullable(), commentId: z.string().uuid().nullable(),
}).strict();
const reject = (): never => { throw conflict("Owner human request authority mismatch", {
  reason: "owner_human_request_authority_mismatch",
}); };

export function validateOwnerToolIdentity(row: typeof workflowTransitionEvents.$inferSelect,
  anchor: typeof issues.$inferSelect, companyId: string, missionId: string) {
  const parsed = toolLinkSchema.safeParse(row.payload);
  if (!parsed.success) return reject();
  const value = parsed.data;
  if (row.companyId !== companyId || row.missionId !== missionId || row.issueId !== anchor.id
    || row.eventType !== "owner_tool_recovery_target_v1" || row.layer !== OWNER_HUMAN_LAYER
    || row.workflowRunId !== value.workflowRunId || row.workflowStepRunId !== value.stepRunId
    || anchor.companyId !== companyId || anchor.missionId !== missionId
    || anchor.originKind !== "mission_main_executor_unblock" || !anchor.originId
    || row.idempotencyKey !== (value.schemaVersion === 1 ? `owner-tool-card:${value.stepRunId}`
      : `owner-tool-card:v2:${value.stepRunId}:${anchor.id}`)) return reject();
  if (value.schemaVersion === 2 && (value.companyId !== companyId || value.missionId !== missionId
    || value.anchorIssueId !== anchor.id || value.sourceIssueId !== anchor.originId)) return reject();
  return { ...value, companyId, missionId, anchorIssueId: anchor.id, sourceIssueId: anchor.originId };
}

export async function readOwnerToolIdentity(tx: OwnerHumanTx, companyId: string, missionId: string, anchorId: string) {
  // Classify scoped, supported links first; malformed headers/keys within that set still fail closed.
  const rows = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.missionId, missionId),
    sql`(${workflowTransitionEvents.payload} @> '{"schemaVersion":1}'::jsonb
      or ${workflowTransitionEvents.payload} @> '{"schemaVersion":2}'::jsonb)`,
    or(eq(workflowTransitionEvents.issueId, anchorId),
      sql`${workflowTransitionEvents.payload}->>'anchorIssueId' = ${anchorId}`),
    or(eq(workflowTransitionEvents.eventType, "owner_tool_recovery_target_v1"),
      sql`${workflowTransitionEvents.payload}->>'kind' = 'tool_step'`,
      sql`${workflowTransitionEvents.idempotencyKey} like 'owner-tool-card:%'`)));
  if (rows.length > 1) return reject();
  const row = rows[0];
  if (!row) return null;
  const [anchor] = await tx.select().from(issues).where(eq(issues.id, anchorId));
  if (!anchor) return reject();
  const identity = validateOwnerToolIdentity(row, anchor, companyId, missionId);
  const [source] = await tx.select({ id: issues.id }).from(issues).where(and(
    eq(issues.id, identity.sourceIssueId), eq(issues.companyId, companyId), eq(issues.missionId, missionId)));
  if (!source) return reject();
  return identity;
}

export type OwnerHumanAuthorityInput = {
  companyId: string; missionId: string; ownerActionIssueId: string;
  agentId: string; heartbeatRunId: string; recoveryTarget?: OwnerRecoveryTarget;
  purpose?: "submit" | "settle" | "renew";
  renewal?: { previousLifetimeId: string; anchorIssueId: string };
};

// Caller holds the existing quality prefix, if applicable. The only locking order here is:
// mission -> related run -> heartbeat -> sorted issues -> step. Pointer/card/continuation follow.
// Discovery reads are not authority: all mutable identity facts are checked again under these locks.
export async function lockOwnerHumanRequestAuthority(tx: OwnerHumanTx, input: OwnerHumanAuthorityInput) {
  const purpose = input.purpose ?? "submit";
  if ((purpose === "renew" && !input.renewal) || (purpose === "submit" && input.renewal)) return reject();
  const [mission] = await tx.select().from(missions).where(and(
    eq(missions.id, input.missionId), eq(missions.companyId, input.companyId))).for("update");
  if (!mission || mission.ownerAgentId !== input.agentId) return reject();
  if (purpose !== "settle" && ["completed", "cancelled"].includes(mission.status)) return reject();
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
  const tool = await readOwnerToolIdentity(tx, input.companyId, input.missionId, observed.id);
  if (oversight && tool) return reject();
  let runId = tool?.workflowRunId ?? source?.originRunId ?? null;
  if (oversight && !runId) {
    const [latestFailedRun] = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowRuns.missionId, input.missionId),
      eq(workflowRuns.status, "failed"),
      isNull(workflowRuns.parentRunId),
    )).orderBy(desc(workflowRuns.createdAt)).limit(1);
    runId = latestFailedRun?.id ?? null;
  }
  let run: typeof workflowRuns.$inferSelect | undefined;
  if (runId) {
    [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).for("update");
    // Legacy source origins may name a heartbeat, not a workflow. Tool links must name a real workflow.
    if ((!run && tool) || (run && (run.companyId !== input.companyId || run.missionId !== input.missionId))) return reject();
  }
  const [heartbeat] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.heartbeatRunId)).for("share");
  const locked = new Map<string, typeof issues.$inferSelect>();
  for (const id of [...new Set([observed.id, ...(source ? [source.id] : []),
    ...(input.renewal ? [input.renewal.anchorIssueId] : [])])].sort()) {
    const [row] = await tx.select().from(issues).where(eq(issues.id, id)).for("update");
    if (!row || row.companyId !== input.companyId || row.missionId !== input.missionId) return reject();
    locked.set(id, row);
  }
  const anchor = locked.get(observed.id)!;
  if ((tool && anchor.hiddenAt) || anchor.originKind !== observed.originKind || anchor.originId !== observed.originId
    || anchor.assigneeAgentId !== input.agentId || !heartbeat || heartbeat.companyId !== input.companyId
    || heartbeat.agentId !== input.agentId
    || (purpose !== "renew" && heartbeat.issueId !== anchor.id)) return reject();
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
    if (purpose !== "settle" && (!ownerRecoveryRunMatches(run, target) || !ownerRecoveryStepMatches(step, target))) return reject();
  } else if (target && (tool || target.issueId !== source?.id)) return reject();
  const scope = ownerHumanScopeSchema.parse({ companyId: input.companyId, missionId: input.missionId,
    target: oversight ? { kind: "oversight" } : tool
      ? { kind: "tool_step", workflowRunId: tool.workflowRunId, stepRunId: tool.stepRunId }
      : { kind: "source_issue", issueId: source!.id } });
  const renewalAnchor = input.renewal ? locked.get(input.renewal.anchorIssueId) : undefined;
  if (input.renewal) {
    const next = renewalAnchor && await readOwnerToolIdentity(tx, input.companyId, input.missionId, renewalAnchor.id);
    if (tool) {
      if (!next || next.schemaVersion !== 2 || next.companyId !== tool.companyId
        || next.missionId !== tool.missionId || next.sourceIssueId !== tool.sourceIssueId
        || next.workflowRunId !== tool.workflowRunId || next.stepRunId !== tool.stepRunId) return reject();
    } else if (next) return reject();
    const previous = await readOwnerHumanOrigin(tx, input.companyId, input.renewal.previousLifetimeId);
    await assertOwnerHumanOriginalDecision(tx, previous);
    if (oversight || !source || !renewalAnchor || renewalAnchor.id === anchor.id
      || renewalAnchor.hiddenAt
      || renewalAnchor.originKind !== "mission_main_executor_unblock"
      || renewalAnchor.originId !== source.id || renewalAnchor.assigneeAgentId !== input.agentId
      || previous.anchorIssueId !== anchor.id || previous.authorAgentId !== input.agentId
      || previous.heartbeatRunId !== heartbeat.id || !sameOwnerHumanValue(previous.scope, scope)
      || !sameOwnerHumanValue(previous.submission.recoveryTarget, input.recoveryTarget)
      || previous.cardInput.workflowRunId !== (run?.id ?? null)
      || (tool && (!target || target.kind !== "tool_step"))) return reject();
    if (purpose === "renew" && (!["done", "cancelled"].includes(anchor.status)
      || ["done", "cancelled"].includes(renewalAnchor.status)
      || (!tool && source.status !== "blocked"))) return reject();
  }
  return { tx, scope, anchor, source, run, step, purpose, renewal: input.renewal, renewalAnchor,
    agentId: input.agentId, heartbeatRunId: input.heartbeatRunId, recoveryTarget: input.recoveryTarget };
}
export type OwnerHumanAuthority = Awaited<ReturnType<typeof lockOwnerHumanRequestAuthority>>;

// An ancestry reference alone is insufficient: every predecessor has its exact stored header,
// and its immutable replaced ending must name this successor. No historical link is moved.
async function readOwnerHumanOrigin(tx: OwnerHumanTx, companyId: string, id: string) {
  const [row] = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.id, id)));
  const parsed = ownerHumanLifetimeSchema.safeParse(row?.payload);
  if (!row || !parsed.success) return reject();
  const saved = parsed.data;
  if (saved.lifetimeId !== id || saved.scope.companyId !== companyId || row.missionId !== saved.scope.missionId
    || row.eventType !== saved.kind || row.layer !== OWNER_HUMAN_LAYER
    || row.reason !== OWNER_HUMAN_SOURCE || row.reasonCode !== OWNER_HUMAN_SOURCE
    || row.issueId !== saved.anchorIssueId || row.heartbeatRunId !== saved.heartbeatRunId
    || row.idempotencyKey !== ownerHumanLifetimeKey(saved.requestKey)) return reject();
  return saved;
}

export async function assertOwnerHumanOriginalDecision(tx: OwnerHumanTx, lifetime: OwnerHumanLifetime) {
  const seen = new Set<string>();
  let child = lifetime;
  while (child.renewal) {
    if (seen.has(child.lifetimeId)) return reject();
    seen.add(child.lifetimeId);
    const parent = await readOwnerHumanOrigin(tx, child.scope.companyId, child.renewal.previousLifetimeId);
    if (child.identityMode !== "keyed" || child.requestKey === parent.requestKey
      || child.anchorIssueId === parent.anchorIssueId || child.scope.target.kind === "oversight"
      || child.decisionEventId !== parent.decisionEventId || child.authorAgentId !== parent.authorAgentId
      || child.heartbeatRunId !== parent.heartbeatRunId || child.sourceIssueId !== parent.sourceIssueId
      || !sameOwnerHumanValue(child.scope, parent.scope)
      || !sameOwnerHumanValue(child.submission, parent.submission)
      || !sameOwnerHumanValue(child.cardInput, { ...parent.cardInput, ownerActionIssueId: child.anchorIssueId,
        ownerActionIssueStatus: child.cardInput.ownerActionIssueStatus,
        issueTitle: child.cardInput.issueTitle, issueIdentifier: child.cardInput.issueIdentifier })) return reject();
    const [ending] = await tx.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, child.scope.companyId),
      eq(workflowTransitionEvents.idempotencyKey, ownerHumanEndKey(parent.lifetimeId))));
    const end = ownerHumanEndSchema.safeParse(ending?.payload);
    if (!ending || !end.success || ending.missionId !== parent.scope.missionId
      || ending.issueId !== parent.anchorIssueId || ending.heartbeatRunId !== parent.heartbeatRunId
      || ending.eventType !== end.data.kind || ending.layer !== OWNER_HUMAN_LAYER
      || ending.reason !== OWNER_HUMAN_SOURCE || ending.reasonCode !== OWNER_HUMAN_SOURCE
      || end.data.lifetimeId !== parent.lifetimeId || end.data.reason !== "replaced"
      || end.data.nextLifetimeId !== child.lifetimeId || !sameOwnerHumanValue(end.data.scope, parent.scope)) return reject();
    const [anchor] = await tx.select().from(issues).where(and(
      eq(issues.id, child.anchorIssueId), eq(issues.companyId, child.scope.companyId)));
    if (!anchor || anchor.missionId !== child.scope.missionId
      || anchor.originKind !== "mission_main_executor_unblock" || anchor.originId !== child.sourceIssueId) return reject();
    child = parent;
  }
  if (seen.has(child.lifetimeId)) return reject();
  return assertSubmittedOwnerHumanOriginalDecision(tx, child);
}

// Exact immutable-origin validation, also used when reading current state after a restart.
// These plain historical reads do not acquire an earlier lock after the pointer lock.
async function assertSubmittedOwnerHumanOriginalDecision(tx: OwnerHumanTx, lifetime: OwnerHumanLifetime) {
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
      const tool = await readOwnerToolIdentity(tx, lifetime.scope.companyId, lifetime.scope.missionId, lifetime.anchorIssueId);
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
