// Exact SELECT-only human-wait inspection for callers holding the company-scoped mission lock.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issues, missions, operatorDecisions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { missionOwnerDecisionSubmitSchema } from "@paperclipai/shared";
import { operatorDecisionSourceContextSchema } from "@paperclipai/shared/validators/operator-decision";
import { z } from "zod";
import { collectTargetSnapshotMismatch } from "../operator-decision-currentness.js";
import { validateAndHashOperatorDecisionCreate } from "../operator-decision-result.js";
import { stripOperatorDecisionServerContext } from "../operator-decision-server-context.js";
import { MISSION_OWNER_DECISION_EVENT_TYPE, MISSION_OWNER_DECISION_SOURCE, MISSION_OWNER_RECOVERY_LAYER, normalizeSubmission } from "./mission-owner-decision-contract.js";
import { assertOwnerHumanOriginalDecision, readOwnerToolIdentity } from "./owner-human-request-authority.js";
import { buildMissionOwnerHumanInputDecisionCard, MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE } from "./mission-owner-human-input-card.js";
import { readOwnerHumanCurrentForScope, type OwnerHumanCurrentRecord } from "./owner-human-request-state.js";
import { OWNER_HUMAN_LAYER, OWNER_HUMAN_SOURCE, ownerHumanLifetimeKey, ownerHumanLifetimeSchema, sameOwnerHumanValue, type OwnerHumanScope, type OwnerHumanTx } from "./owner-human-request-contract.js";
import { buildHistoricalDefaultOwnerHumanInputVariant } from "./mission-owner-human-default-definition.js";
import type { OwnerRecoveryTarget } from "./mission-owner-recovery-events.js";
import { ownerRecoveryRunMatches, ownerRecoveryStepMatches } from "./owner-recovery-submission-guards.js";
type ToolTarget = Extract<OwnerRecoveryTarget, { kind: "tool_step" }>;
export type ExactRecoveryScope =
  | { kind: "source_issue"; issueId: string }
  | ({ kind: "tool_step" } & ToolTarget);
export type OwnerRetryHumanWaitContext = {
  companyId: string;
  missionId: string;
  ownerActionIssueId: string;
  originalSourceIssueId: string;
  retryIssueId: string;
  toolTarget?: unknown;
};
export type OwnerRetryHumanWaitVerdict =
  | { kind: "clear"; checkedScopes: ExactRecoveryScope[] }
  | { kind: "waiting"; bindingIds: string[]; checkedScopes: ExactRecoveryScope[] }
  | { kind: "unresolved"; reasonCode: string; checkedScopes: ExactRecoveryScope[] };

const uuid = z.string().uuid();
const unresolved = (reasonCode: string, checkedScopes: ExactRecoveryScope[]): OwnerRetryHumanWaitVerdict =>
  ({ kind: "unresolved", reasonCode, checkedScopes });
function parseToolTarget(raw: unknown): ToolTarget | null {
  const parsed = missionOwnerDecisionSubmitSchema.safeParse({ decision: "retry_source_issue", recoveryTarget: raw });
  return parsed.success && parsed.data.recoveryTarget?.kind === "tool_step" ? parsed.data.recoveryTarget : null;
}
function sameToolTarget(left: unknown, right: ToolTarget): boolean {
  const value = parseToolTarget(left);
  return Boolean(value && value.workflowRunId === right.workflowRunId && value.stepRunId === right.stepRunId
    && value.expectedAuthorityVersion === right.expectedAuthorityVersion
    && value.expectedExecutionGeneration === right.expectedExecutionGeneration
    && value.failedDispatchRequestId === right.failedDispatchRequestId);
}
function scopeKey(scope: ExactRecoveryScope) {
  return scope.kind === "source_issue" ? `source:${scope.issueId}`
    : `tool:${scope.workflowRunId}:${scope.stepRunId}:${scope.expectedAuthorityVersion}`
      + `:${scope.expectedExecutionGeneration}:${scope.failedDispatchRequestId ?? "null"}`;
}
async function hasOrphanLifetime(tx: OwnerHumanTx, scope: OwnerHumanScope) {
  const [row] = await tx.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, scope.companyId), eq(workflowTransitionEvents.missionId, scope.missionId),
    eq(workflowTransitionEvents.eventType, "owner_human_lifetime_v1"),
    sql`${workflowTransitionEvents.payload}->'scope' = ${JSON.stringify(scope)}::jsonb`)).limit(1);
  return Boolean(row);
}
async function exactLaterRetry(tx: OwnerHumanTx, current: OwnerHumanCurrentRecord,
  scope: ExactRecoveryScope, context: OwnerRetryHumanWaitContext): Promise<boolean | "unresolved"> {
  const [row] = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, context.companyId), eq(workflowTransitionEvents.missionId, context.missionId),
    eq(workflowTransitionEvents.issueId, current.lifetime.anchorIssueId),
    eq(workflowTransitionEvents.eventType, MISSION_OWNER_DECISION_EVENT_TYPE),
    eq(workflowTransitionEvents.layer, MISSION_OWNER_RECOVERY_LAYER),
    eq(workflowTransitionEvents.reason, MISSION_OWNER_DECISION_SOURCE),
    eq(workflowTransitionEvents.reasonCode, MISSION_OWNER_DECISION_SOURCE)))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(1);
  if (!row || row.id === current.lifetime.decisionEventId) return false;
  const [incarnation] = await tx.select({ createdAt: workflowTransitionEvents.createdAt }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.id, current.lifetime.lifetimeId),
      eq(workflowTransitionEvents.companyId, context.companyId),
      eq(workflowTransitionEvents.missionId, context.missionId),
      eq(workflowTransitionEvents.eventType, "owner_human_lifetime_v1"),
      eq(workflowTransitionEvents.layer, OWNER_HUMAN_LAYER),
      eq(workflowTransitionEvents.reason, OWNER_HUMAN_SOURCE),
      eq(workflowTransitionEvents.reasonCode, OWNER_HUMAN_SOURCE),
      eq(workflowTransitionEvents.idempotencyKey, ownerHumanLifetimeKey(current.lifetime.requestKey))));
  if (!incarnation) return "unresolved";
  // A retry supersedes this renewed incarnation only with strictly later timestamp evidence.
  if (row.createdAt <= incarnation.createdAt) return false;
  const payload = row.payload as Record<string, unknown> | null;
  const submission = payload && payload.kind === MISSION_OWNER_DECISION_EVENT_TYPE
    && payload.source === MISSION_OWNER_DECISION_SOURCE
    && payload.ownerActionIssueId === row.issueId
    ? normalizeSubmission(payload as { decision: string }) : null;
  if (!submission || row.decision !== submission.decision) return "unresolved";
  const target = submission.recoveryTarget;
  const exact = submission.decision === "retry_source_issue" && (scope.kind === "source_issue"
    ? target ? target.kind === "issue" && target.issueId === scope.issueId
      : payload?.sourceIssueId === scope.issueId
    : target?.kind === "tool_step" && sameToolTarget(target, scope));
  if (!exact) return false;
  const [anchor] = await tx.select({ originKind: issues.originKind, originId: issues.originId }).from(issues).where(and(
    eq(issues.id, current.lifetime.anchorIssueId), eq(issues.companyId, context.companyId),
    eq(issues.missionId, context.missionId)));
  const [mission] = await tx.select({ ownerAgentId: missions.ownerAgentId }).from(missions).where(and(
    eq(missions.id, context.missionId), eq(missions.companyId, context.companyId)));
  const [heartbeat] = row.heartbeatRunId ? await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, row.heartbeatRunId), eq(heartbeatRuns.companyId, context.companyId),
    eq(heartbeatRuns.issueId, current.lifetime.anchorIssueId))) : [];
  if (!anchor || anchor.originKind !== "mission_main_executor_unblock"
    || anchor.originId !== payload?.sourceIssueId || !mission || !heartbeat || !mission.ownerAgentId
    || heartbeat.agentId !== mission.ownerAgentId) return "unresolved";
  return true;
}
async function legacyWaitForScope(tx: OwnerHumanTx, scope: ExactRecoveryScope,
  context: OwnerRetryHumanWaitContext): Promise<{ id: string } | null | "unresolved"> {
  const relatedSourceIds = [...new Set([context.originalSourceIssueId, context.retryIssueId])];
  const anchors = await tx.select({ id: issues.id, originId: issues.originId }).from(issues).where(and(
    eq(issues.companyId, context.companyId), eq(issues.missionId, context.missionId),
    eq(issues.originKind, "mission_main_executor_unblock"), inArray(issues.originId, relatedSourceIds)));
  if (!anchors.length) return null;
  const cards = await tx.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, context.companyId), inArray(operatorDecisions.issueId, anchors.map((a) => a.id)),
    eq(operatorDecisions.sourceType, "mission_owner_human_input"), eq(operatorDecisions.status, "pending")));
  for (const card of cards) {
    const anchor = anchors.find((candidate) => candidate.id === card.issueId);
    if (!anchor?.originId) return "unresolved";
    if (card.requestKey.startsWith("moi2:")) {
      const validC08 = await validatedC08LifetimeCard(tx, card, anchor.id, anchor.originId, context);
      if (validC08 !== true) return "unresolved";
      continue;
    }
    const [event] = typeof card.sourceId === "string" && uuid.safeParse(card.sourceId).success
      ? await tx.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.id, card.sourceId), eq(workflowTransitionEvents.companyId, context.companyId))) : [];
    if (!event) return "unresolved";
    const payload = event.payload as Record<string, unknown> | null;
    if (event.eventType !== MISSION_OWNER_DECISION_EVENT_TYPE || event.layer !== MISSION_OWNER_RECOVERY_LAYER
      || event.reason !== MISSION_OWNER_DECISION_SOURCE || event.reasonCode !== MISSION_OWNER_DECISION_SOURCE
      || event.missionId !== context.missionId || event.issueId !== anchor.id || !event.heartbeatRunId
      || payload?.ownerActionIssueId !== anchor.id || payload.sourceIssueId !== anchor.originId
      || payload.kind !== MISSION_OWNER_DECISION_EVENT_TYPE || payload.source !== MISSION_OWNER_DECISION_SOURCE) {
      return "unresolved";
    }
    const submission = normalizeSubmission(payload as { decision: string });
    if (!submission || (submission.decision !== "request_input" && submission.decision !== "escalate")) return "unresolved";
    const target = submission.recoveryTarget;
    const sameTarget = scope.kind === "source_issue"
      ? target ? target.kind === "issue" && target.issueId === scope.issueId
        : anchor.originId === scope.issueId
      : target?.kind === "tool_step" && sameToolTarget(target, scope);
    if (!sameTarget) continue;
    if (card.sourceId !== event.id || card.requestKey !== `moi1:${event.id}` || card.resolvedAt || card.cancelledAt) {
      return "unresolved";
    }
    const contextValue = operatorDecisionSourceContextSchema.safeParse(stripOperatorDecisionServerContext(card.sourceContext));
    if (!contextValue.success || contextValue.data.missionId !== context.missionId
      || !contextValue.data.targetSnapshot || contextValue.data.targetSnapshot.issueId !== anchor.id) return "unresolved";
    const [heartbeat] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, event.heartbeatRunId),
      eq(heartbeatRuns.companyId, context.companyId), eq(heartbeatRuns.issueId, anchor.id)));
    if (!heartbeat) return "unresolved";
    const mismatch = await collectTargetSnapshotMismatch(tx, context.companyId,
      contextValue.data.targetSnapshot, "terminal_only");
    if (mismatch.length) continue;
    if (scope.kind === "tool_step" && contextValue.data.targetSnapshot.workflowRunId
      && contextValue.data.targetSnapshot.workflowRunId !== scope.workflowRunId) return "unresolved";
    return { id: card.id };
  }
  return null;
}
const c08CardLinkKind = "owner_human_card_v1";
const c08CardLinkSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal(c08CardLinkKind),
  lifetimeId: uuid, decisionEventId: uuid, operatorDecisionId: uuid }).strict();

async function validatedC08LifetimeCard(tx: OwnerHumanTx, card: typeof operatorDecisions.$inferSelect,
  anchorIssueId: string, sourceIssueId: string, context: OwnerRetryHumanWaitContext): Promise<boolean> {
  const lifetimeId = z.string().uuid().safeParse(card.requestKey.slice("moi2:".length));
  if (!lifetimeId.success) return false;
  const [row] = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, context.companyId), eq(workflowTransitionEvents.id, lifetimeId.data)));
  const parsed = ownerHumanLifetimeSchema.safeParse(row?.payload);
  if (!row || !parsed.success) return false;
  const lifetime = parsed.data;
  if (row.id !== lifetime.lifetimeId || row.missionId !== context.missionId || row.issueId !== lifetime.anchorIssueId
    || row.heartbeatRunId !== lifetime.heartbeatRunId
    || row.eventType !== lifetime.kind || row.layer !== OWNER_HUMAN_LAYER
    || row.reason !== OWNER_HUMAN_SOURCE || row.reasonCode !== OWNER_HUMAN_SOURCE
    || row.idempotencyKey !== ownerHumanLifetimeKey(lifetime.requestKey)
    || lifetime.lifetimeId !== lifetimeId.data
    || lifetime.scope.companyId !== context.companyId || lifetime.scope.missionId !== context.missionId
    || lifetime.anchorIssueId !== anchorIssueId || lifetime.sourceIssueId !== sourceIssueId
    || card.companyId !== context.companyId || card.issueId !== anchorIssueId
    || card.sourceType !== MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE || card.sourceId !== lifetime.decisionEventId
    || card.requestKey !== `moi2:${lifetime.lifetimeId}` || card.resolvedAt || card.cancelledAt) return false;
  try {
    await assertOwnerHumanOriginalDecision(tx, lifetime);
    const current = await readOwnerHumanCurrentForScope(tx, lifetime.scope, { lockPointer: false });
    if (!current) return false;
    let ancestor = current.lifetime, linked = false;
    while (true) {
      if (ancestor.lifetimeId === lifetime.lifetimeId) { linked = true; break; }
      if (!ancestor.renewal) break;
      const [parent] = await tx.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, context.companyId),
        eq(workflowTransitionEvents.id, ancestor.renewal.previousLifetimeId)));
      const saved = ownerHumanLifetimeSchema.safeParse(parent?.payload);
      if (!parent || !saved.success) return false;
      ancestor = saved.data;
    }
    if (!linked) return false;
  } catch { return false; }
  const expectedInput = buildMissionOwnerHumanInputDecisionCard({ ...lifetime.cardInput, lifetimeId: lifetime.lifetimeId });
  const expected = validateAndHashOperatorDecisionCreate(expectedInput);
  const actual = { schemaVersion: card.schemaVersion, requestKey: card.requestKey, priority: card.priority,
    interactionType: card.interactionType, title: card.title, description: card.description,
    sourceType: card.sourceType, sourceId: card.sourceId, sourceContext: stripOperatorDecisionServerContext(card.sourceContext), definition: card.definition,
    issueId: card.issueId, continuationMode: card.continuationMode };
  const historical = buildHistoricalDefaultOwnerHumanInputVariant(expected.input), candidates = [expected, ...(historical ? [validateAndHashOperatorDecisionCreate(historical)] : [])];
  if (!candidates.some((candidate) => card.requestHash === candidate.requestHash
    && sameOwnerHumanValue(actual, candidate.input)) || card.requestedByAgentId !== lifetime.authorAgentId
    || card.requestedByUserId !== null
    || card.qualityActionId !== null || card.qualityBinding !== null) return false;
  const [link] = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, context.companyId),
    eq(workflowTransitionEvents.idempotencyKey, `owner-human-card:v1:${lifetime.lifetimeId}`)));
  const binding = c08CardLinkSchema.safeParse(link?.payload);
  return Boolean(link && binding.success && link.eventType === c08CardLinkKind
    && link.layer === OWNER_HUMAN_LAYER && link.reason === OWNER_HUMAN_SOURCE
    && link.reasonCode === OWNER_HUMAN_SOURCE && link.missionId === context.missionId
    && link.issueId === lifetime.anchorIssueId && link.heartbeatRunId === lifetime.heartbeatRunId
    && link.workflowRunId === lifetime.cardInput.workflowRunId
    && link.workflowStepRunId === (lifetime.scope.target.kind === "tool_step" ? lifetime.scope.target.stepRunId : null)
    && binding.data.lifetimeId === lifetime.lifetimeId
    && binding.data.decisionEventId === lifetime.decisionEventId
    && binding.data.operatorDecisionId === card.id);
}
async function currentToolTarget(tx: OwnerHumanTx, context: OwnerRetryHumanWaitContext, target: ToolTarget) {
  const identity = await readOwnerToolIdentity(tx, context.companyId, context.missionId, context.ownerActionIssueId);
  if (!identity || identity.workflowRunId !== target.workflowRunId || identity.stepRunId !== target.stepRunId
    || identity.sourceIssueId !== context.originalSourceIssueId) return false;
  const [run] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, target.workflowRunId),
    eq(workflowRuns.companyId, context.companyId), eq(workflowRuns.missionId, context.missionId)));
  const [step] = await tx.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.id, target.stepRunId),
    eq(workflowStepRuns.workflowRunId, target.workflowRunId)));
  return Boolean(run && step && ownerRecoveryRunMatches(run, target) && ownerRecoveryStepMatches(step, target));
}
/** SELECT-only. Caller holds the company-scoped mission row lock before invoking this reader. */
export async function readExactOwnerRetryHumanWait(
  tx: OwnerHumanTx,
  context: OwnerRetryHumanWaitContext,
): Promise<OwnerRetryHumanWaitVerdict> {
  const checkedScopes: ExactRecoveryScope[] = [];
  if (![context.companyId, context.missionId, context.ownerActionIssueId,
    context.originalSourceIssueId, context.retryIssueId].every((value) => uuid.safeParse(value).success)) {
    return unresolved("invalid_context", checkedScopes);
  }
  const sourceIds = [...new Set([context.originalSourceIssueId, context.retryIssueId])];
  const scopes: ExactRecoveryScope[] = sourceIds.map((issueId) => ({ kind: "source_issue", issueId }));
  const toolTarget = context.toolTarget === undefined ? null : parseToolTarget(context.toolTarget);
  if (context.toolTarget !== undefined && !toolTarget) return unresolved("tool_target_unproven", checkedScopes);
  if (toolTarget) {
    const scope: ExactRecoveryScope = { ...toolTarget };
    checkedScopes.push(scope);
    try {
      if (!await currentToolTarget(tx, context, toolTarget)) return unresolved("tool_target_not_current", checkedScopes);
    } catch { return unresolved("tool_target_lookup_failed", checkedScopes); }
    scopes.push(scope);
  }
  const bindingIds = new Set<string>(), checkedKeys = new Set(checkedScopes.map(scopeKey));
  for (const target of scopes) {
    if (!checkedKeys.has(scopeKey(target))) { checkedScopes.push(target); checkedKeys.add(scopeKey(target)); }
    try {
      if (target.kind === "source_issue") {
        const scope: OwnerHumanScope = { companyId: context.companyId, missionId: context.missionId, target };
        const current = await readOwnerHumanCurrentForScope(tx, scope, { lockPointer: false });
        if (!current && await hasOrphanLifetime(tx, scope)) return unresolved("owner_human_orphan_lifetime", checkedScopes);
        if (current && current.lifetime.sourceIssueId !== target.issueId) {
          return unresolved("owner_human_scope_mismatch", checkedScopes);
        }
        if (current?.pointer.recoveryNeeded) {
          const later = await exactLaterRetry(tx, current, target, context);
          if (later === "unresolved") return unresolved("owner_retry_event_unresolved", checkedScopes);
          if (!later) bindingIds.add(current.lifetime.lifetimeId);
        }
      } else {
        const scope: OwnerHumanScope = { companyId: context.companyId, missionId: context.missionId,
          target: { kind: "tool_step", workflowRunId: target.workflowRunId, stepRunId: target.stepRunId } };
        const current = await readOwnerHumanCurrentForScope(tx, scope, { lockPointer: false });
        if (!current && await hasOrphanLifetime(tx, scope)) return unresolved("owner_human_orphan_lifetime", checkedScopes);
        if (current?.pointer.recoveryNeeded) {
          const identity = await readOwnerToolIdentity(tx, context.companyId, context.missionId, current.lifetime.anchorIssueId);
          if (!identity || identity.workflowRunId !== target.workflowRunId || identity.stepRunId !== target.stepRunId
            || identity.sourceIssueId !== current.lifetime.sourceIssueId) return unresolved("owner_tool_binding_unresolved", checkedScopes);
          const requested = current.lifetime.submission.recoveryTarget;
          if (!requested || requested.kind !== "tool_step") return unresolved("owner_tool_target_unresolved", checkedScopes);
          if (sameToolTarget(requested, target)) bindingIds.add(current.lifetime.lifetimeId);
        }
      }
      const legacy = await legacyWaitForScope(tx, target, context);
      if (legacy === "unresolved") return unresolved("legacy_human_wait_unresolved", checkedScopes);
      if (legacy) bindingIds.add(legacy.id);
    } catch { return unresolved("human_wait_lookup_failed", checkedScopes); }
  }
  return bindingIds.size ? { kind: "waiting", bindingIds: [...bindingIds], checkedScopes }
    : { kind: "clear", checkedScopes };
}
