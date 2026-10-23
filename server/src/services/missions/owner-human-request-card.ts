// C08 stage 9: current lifetime -> real card binding, committed in the create transaction.
// The moi2 key is only a lookup hint. Stored authority, immutable input and both sides of the
// binding are checked before either insertion or replay. API submission/approval are later stages.
import { and, eq } from "drizzle-orm";
import { missions, operatorDecisions, workflowTransitionEvents } from "@paperclipai/db";
import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import { z } from "zod";
import { conflict } from "../../errors.js";
import type { OperatorDecisionActor } from "../operator-decision-create.js";
import { validateAndHashOperatorDecisionCreate } from "../operator-decision-result.js";
import { buildMissionOwnerHumanInputDecisionCard, MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE } from "./mission-owner-human-input-card.js";
import { lockOwnerHumanRequestAuthority } from "./owner-human-request-authority.js";
import { readOwnerHumanCurrent, type OwnerHumanCurrentRecord } from "./owner-human-request-state.js";
import { OWNER_HUMAN_LAYER, OWNER_HUMAN_SOURCE, ownerHumanLifetimeSchema,
  sameOwnerHumanValue, type OwnerHumanTx } from "./owner-human-request-contract.js";

const linkKind = "owner_human_card_v1";
const linkKey = (id: string) => `owner-human-card:v1:${id}`;
const linkSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal(linkKind), lifetimeId: z.string().uuid(),
  decisionEventId: z.string().uuid(), operatorDecisionId: z.string().uuid(),
}).strict();
type Card = typeof operatorDecisions.$inferSelect;
type Guard = { current: OwnerHumanCurrentRecord; input: CreateOperatorDecisionInput; card: Card | null };
const fail = (): never => { throw conflict("Owner human request card conflict", {
  reason: "owner_human_request_card_mismatch",
}); };

export function isOwnerHumanLifetimeCard(input: CreateOperatorDecisionInput): boolean {
  return input.sourceType === MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE && input.requestKey.startsWith("moi2:");
}

function assertCard(card: Card, input: CreateOperatorDecisionInput, authorAgentId: string) {
  const expected = validateAndHashOperatorDecisionCreate(input);
  const actual = {
    schemaVersion: card.schemaVersion, requestKey: card.requestKey, priority: card.priority,
    interactionType: card.interactionType, title: card.title, description: card.description,
    sourceType: card.sourceType, sourceId: card.sourceId, sourceContext: card.sourceContext,
    definition: card.definition, issueId: card.issueId, continuationMode: card.continuationMode,
  };
  if (card.requestHash !== expected.requestHash || !sameOwnerHumanValue(actual, expected.input)
    || card.requestedByAgentId !== authorAgentId || card.requestedByUserId !== null
    || card.qualityActionId !== null || card.qualityBinding !== null) fail();
}

// No earlier lock is acquired after the pointer. The authority helper retains the existing order:
// quality prefix (if present in the caller) -> mission/run/heartbeat/sorted issues/step -> pointer -> card.
// settle purpose permits the original heartbeat to have finished; this operation still requires
// an active recovery pointer and nonterminal mission/anchor. It neither adopts checkout nor settles.
export async function lockOwnerHumanRequestCard(tx: OwnerHumanTx, companyId: string,
  input: CreateOperatorDecisionInput, actor: OperatorDecisionActor): Promise<Guard | null> {
  if (!isOwnerHumanLifetimeCard(input)) return null;
  const id = z.string().uuid().safeParse(input.requestKey.slice("moi2:".length));
  if (!id.success) return fail();
  const [discovered] = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.id, id.data)));
  const parsed = ownerHumanLifetimeSchema.safeParse(discovered?.payload);
  if (!parsed.success || actor.type !== "agent" || actor.id !== parsed.data.authorAgentId) return fail();
  const lifetime = parsed.data;
  const auth = await lockOwnerHumanRequestAuthority(tx, {
    companyId, missionId: lifetime.scope.missionId, ownerActionIssueId: lifetime.anchorIssueId,
    agentId: actor.id, heartbeatRunId: lifetime.heartbeatRunId,
    recoveryTarget: lifetime.submission.recoveryTarget, purpose: "settle",
  });
  const [mission] = await tx.select().from(missions).where(and(
    eq(missions.companyId, companyId), eq(missions.id, lifetime.scope.missionId)));
  if (!mission || ["completed", "cancelled"].includes(mission.status)
    || ["done", "cancelled"].includes(auth.anchor.status)
    || !sameOwnerHumanValue(auth.scope, lifetime.scope)) return fail();
  const current = await readOwnerHumanCurrent(auth);
  if (!current || !current.pointer.recoveryNeeded || current.pointer.lifetimeId !== id.data
    || current.pointer.anchorIssueId !== auth.anchor.id
    || !sameOwnerHumanValue(current.lifetime, lifetime)) return fail();
  // Rebuild from the saved input, never from today's display title/status or the caller's prose.
  const expected = validateAndHashOperatorDecisionCreate(buildMissionOwnerHumanInputDecisionCard({
    ...current.lifetime.cardInput, lifetimeId: current.lifetime.lifetimeId,
  })).input;
  if (!sameOwnerHumanValue(input, expected)) return fail();
  const [link] = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId),
    eq(workflowTransitionEvents.idempotencyKey, linkKey(lifetime.lifetimeId)))).for("update");
  const [card] = await tx.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, companyId), eq(operatorDecisions.requestKey, input.requestKey))).for("update");
  if (link) {
    const payload = linkSchema.safeParse(link.payload);
    if (!payload.success || link.eventType !== linkKind || link.layer !== OWNER_HUMAN_LAYER
      || link.reason !== OWNER_HUMAN_SOURCE || link.reasonCode !== OWNER_HUMAN_SOURCE
      || link.missionId !== lifetime.scope.missionId || link.issueId !== lifetime.anchorIssueId
      || link.heartbeatRunId !== lifetime.heartbeatRunId
      || link.workflowRunId !== lifetime.cardInput.workflowRunId
      || link.workflowStepRunId !== (lifetime.scope.target.kind === "tool_step" ? lifetime.scope.target.stepRunId : null)
      || payload.data.lifetimeId !== lifetime.lifetimeId
      || payload.data.decisionEventId !== lifetime.decisionEventId
      || !card || payload.data.operatorDecisionId !== card.id) return fail();
  } else if (card) {
    // A real create always commits its link. Never adopt an unbound row by its key/hash alone.
    return fail();
  }
  if (card) assertCard(card, expected, lifetime.authorAgentId);
  return { current, input: expected, card: card ?? null };
}

export async function connectOwnerHumanRequestCard(tx: OwnerHumanTx, guard: Guard | null, cardId: string) {
  if (!guard) return;
  const lifetime = guard.current.lifetime;
  const [card] = await tx.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, lifetime.scope.companyId), eq(operatorDecisions.id, cardId))).for("update");
  if (!card) return fail();
  assertCard(card, guard.input, lifetime.authorAgentId);
  await tx.insert(workflowTransitionEvents).values({
    companyId: lifetime.scope.companyId, missionId: lifetime.scope.missionId,
    issueId: lifetime.anchorIssueId, heartbeatRunId: lifetime.heartbeatRunId,
    workflowRunId: lifetime.cardInput.workflowRunId,
    workflowStepRunId: lifetime.scope.target.kind === "tool_step" ? lifetime.scope.target.stepRunId : null,
    eventType: linkKind, layer: OWNER_HUMAN_LAYER, reason: OWNER_HUMAN_SOURCE, reasonCode: OWNER_HUMAN_SOURCE,
    idempotencyKey: linkKey(lifetime.lifetimeId),
    payload: { schemaVersion: 1, kind: linkKind, lifetimeId: lifetime.lifetimeId,
      decisionEventId: lifetime.decisionEventId, operatorDecisionId: cardId },
  });
}
