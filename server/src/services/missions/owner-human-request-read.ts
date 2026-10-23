// C08 stage 11: SELECT-only projection of the authoritative current request.
// Existing authority/state helpers acquire locks but never adopt checkout or write records.
// A consistent transaction keeps pointer, immutable origin, real card and delivery together.
import { and, eq, sql } from "drizzle-orm";
import { issues, missions, operatorDecisions, operatorDecisionContinuations,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import { z } from "zod";
import { conflict, forbidden, unauthorized } from "../../errors.js";
import type { OwnerRecoveryApiActor } from "./mission-owner-recovery-agent-api.js";
import { lockOwnerHumanRequestAuthority } from "./owner-human-request-authority.js";
import { readOwnerHumanCurrent, type OwnerHumanCurrentRecord } from "./owner-human-request-state.js";
import { OWNER_HUMAN_LAYER, OWNER_HUMAN_SOURCE, sameOwnerHumanValue,
  type OwnerHumanTx } from "./owner-human-request-contract.js";
import { buildMissionOwnerHumanInputDecisionCard } from "./mission-owner-human-input-card.js";
import { validateAndHashOperatorDecisionCreate } from "../operator-decision-result.js";

const cardLinkSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("owner_human_card_v1"),
  lifetimeId: z.string().uuid(), decisionEventId: z.string().uuid(),
  operatorDecisionId: z.string().uuid(),
}).strict();
const fail = (): never => { throw conflict("Owner human request current reference mismatch", {
  reason: "owner_human_request_current_mismatch",
}); };

async function readCardAndDelivery(tx: OwnerHumanTx, current: OwnerHumanCurrentRecord) {
  const lifetime = current.lifetime;
  const keyed = lifetime.identityMode === "keyed";
  const expected = validateAndHashOperatorDecisionCreate(buildMissionOwnerHumanInputDecisionCard({
    ...lifetime.cardInput, ...(keyed ? { lifetimeId: lifetime.lifetimeId } : {}),
  }));
  const [link] = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, lifetime.scope.companyId),
    eq(workflowTransitionEvents.idempotencyKey, `owner-human-card:v1:${lifetime.lifetimeId}`)));
  const [card] = await tx.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, lifetime.scope.companyId),
    eq(operatorDecisions.requestKey, expected.input.requestKey))).for("share");
  if (link) {
    const parsed = cardLinkSchema.safeParse(link.payload);
    if (!keyed || !parsed.success || !card || parsed.data.operatorDecisionId !== card.id
      || parsed.data.lifetimeId !== lifetime.lifetimeId
      || parsed.data.decisionEventId !== lifetime.decisionEventId
      || link.eventType !== "owner_human_card_v1" || link.layer !== OWNER_HUMAN_LAYER
      || link.reason !== OWNER_HUMAN_SOURCE || link.reasonCode !== OWNER_HUMAN_SOURCE
      || link.missionId !== lifetime.scope.missionId || link.issueId !== lifetime.anchorIssueId
      || link.heartbeatRunId !== lifetime.heartbeatRunId
      || link.workflowRunId !== lifetime.cardInput.workflowRunId
      || link.workflowStepRunId !== (lifetime.scope.target.kind === "tool_step"
        ? lifetime.scope.target.stepRunId : null)) return fail();
  } else if (keyed && card) return fail();
  // Absence on both sides is the existing post-commit card failure boundary, not repair authority.
  if (!card) return { card: null, delivery: null };
  const actual = {
    schemaVersion: card.schemaVersion, requestKey: card.requestKey, priority: card.priority,
    interactionType: card.interactionType, title: card.title, description: card.description,
    sourceType: card.sourceType, sourceId: card.sourceId, sourceContext: card.sourceContext,
    definition: card.definition, issueId: card.issueId, continuationMode: card.continuationMode,
  };
  if (card.requestHash !== expected.requestHash || !sameOwnerHumanValue(actual, expected.input)
    || card.requestedByAgentId !== lifetime.authorAgentId || card.requestedByUserId !== null
    || card.qualityActionId !== null || card.qualityBinding !== null) return fail();
  const [delivery] = await tx.select().from(operatorDecisionContinuations)
    .where(eq(operatorDecisionContinuations.operatorDecisionId, card.id)).for("share");
  if (delivery && (delivery.companyId !== lifetime.scope.companyId
    || delivery.issueId !== lifetime.anchorIssueId
    || (delivery.targetAgentId !== null && delivery.targetAgentId !== lifetime.authorAgentId))) return fail();
  return {
    card: { id: card.id, requestKey: card.requestKey, sourceId: card.sourceId,
      status: card.status, result: card.result, resolvedAt: card.resolvedAt, cancelledAt: card.cancelledAt },
    // Queue state is reported as stored; accepted is never presented as actual consumption.
    delivery: delivery ? { id: delivery.id, state: delivery.state, generation: delivery.generation,
      attemptCount: delivery.attemptCount, targetAgentId: delivery.targetAgentId,
      wakeupRequestId: delivery.wakeupRequestId, acceptedAt: delivery.acceptedAt,
      errorCode: delivery.errorCode, errorSummary: delivery.errorSummary } : null,
  };
}

export async function readOwnerHumanRequest(input: {
  db: Db; companyId: string; issueId: string; actor: OwnerRecoveryApiActor;
}) {
  const { actor } = input;
  if (actor.actorType !== "agent" || !actor.agentId) throw forbidden("Agent authentication required");
  if (!actor.runId) throw unauthorized("Agent run id required");
  const agentId = actor.agentId, heartbeatRunId = actor.runId;
  return input.db.transaction(async (tx) => {
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    if (!issue?.missionId) return fail();
    // Hold the native mission prefix before authority/pointer/card locks. This is only a SELECT.
    const [mission] = await tx.select().from(missions).where(and(
      eq(missions.id, issue.missionId), eq(missions.companyId, input.companyId))).for("update");
    if (!mission || mission.ownerAgentId !== agentId) {
      throw forbidden("Only the mission owner agent may read owner-recovery decisions");
    }
    // settle permits inspection of closed requests and finished issuing heartbeats. It does not
    // settle anything: this helper only validates actual source/tool/run/step/oversight identity.
    const auth = await lockOwnerHumanRequestAuthority(tx, { companyId: input.companyId,
      missionId: issue.missionId, ownerActionIssueId: issue.id, agentId, heartbeatRunId, purpose: "settle" });
    const current = await readOwnerHumanCurrent(auth);
    if (!current) {
      // Historical presence can reject a missing pointer, never reconstruct or select a request.
      const [orphan] = await tx.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
        .where(and(eq(workflowTransitionEvents.companyId, input.companyId),
          eq(workflowTransitionEvents.missionId, issue.missionId),
          eq(workflowTransitionEvents.eventType, "owner_human_lifetime_v1"),
          sql`${workflowTransitionEvents.payload}->'scope' = ${JSON.stringify(auth.scope)}::jsonb`)).limit(1);
      if (orphan) return fail();
      return { lifetimeId: null, requestKey: null, anchorIssueId: auth.anchor.id,
        scope: auth.scope, recoveryNeeded: false, closure: null, card: null, delivery: null, resubmit: null };
    }
    const lifetime = current.lifetime;
    // A closed source lifetime remains the CAS predecessor until the owner submits
    // a new request. Expose only its number on the one live recurrence anchor:
    // no historical text, key, approval, delivery or replay body is inherited.
    if (current.pointer.anchorIssueId !== auth.anchor.id && !current.pointer.recoveryNeeded) {
      if (auth.scope.target.kind !== "source_issue" || !auth.source
        || auth.source.status !== "blocked" || auth.source.hiddenAt
        || ["completed", "cancelled"].includes(mission.status)) return fail();
      const siblings = await tx.select().from(issues).where(and(
        eq(issues.companyId, input.companyId), eq(issues.missionId, issue.missionId),
        eq(issues.originKind, "mission_main_executor_unblock"), eq(issues.originId, auth.source.id)));
      const previous = siblings.find((row) => row.id === current.pointer.anchorIssueId);
      const open = siblings.filter((row) => !row.hiddenAt && !["done", "cancelled"].includes(row.status));
      if (!previous || previous.hiddenAt || !["done", "cancelled"].includes(previous.status)
        || open.length !== 1 || open[0]!.id !== auth.anchor.id
        || current.lifetime.authorAgentId !== agentId
        || current.lifetime.sourceIssueId !== auth.source.id
        || current.lifetime.cardInput.workflowRunId !== (auth.run?.id ?? null)) return fail();
      return { lifetimeId: current.lifetime.lifetimeId, requestKey: null, anchorIssueId: auth.anchor.id,
        scope: auth.scope, recoveryNeeded: false, closure: current.pointer.closure,
        card: null, delivery: null, resubmit: null };
    }
    if (current.pointer.anchorIssueId !== auth.anchor.id || lifetime.authorAgentId !== agentId
      || lifetime.sourceIssueId !== (auth.source?.id ?? null)
      || lifetime.cardInput.workflowRunId !== (auth.run?.id ?? null)) return fail();
    const projection = await readCardAndDelivery(tx, current);
    return { lifetimeId: lifetime.lifetimeId, requestKey: lifetime.requestKey,
      anchorIssueId: current.pointer.anchorIssueId, scope: current.pointer.scope,
      recoveryNeeded: current.pointer.recoveryNeeded, closure: current.pointer.closure,
      ...projection,
      resubmit: current.pointer.recoveryNeeded ? { ...lifetime.submission,
        humanRequest: { schemaVersion: 1 as const, requestKey: lifetime.requestKey,
          expectedCurrentLifetimeId: lifetime.lifetimeId } } : null,
    };
  }, { isolationLevel: "repeatable read" });
}
