// C08 stage 13B: one transaction renews the lifetime and binds a fresh pending card.
// The producer owns the transaction (and any quality-prefix locks) and publishes only after
// commit. This writer neither creates an anchor, submits an agent decision nor starts a run.
import { and, eq } from "drizzle-orm";
import { activityLog, agents, operatorDecisions, workflowTransitionEvents } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { validateAndHashOperatorDecisionCreate } from "../operator-decision-result.js";
import { buildMissionOwnerHumanInputDecisionCard } from "./mission-owner-human-input-card.js";
import { lockOwnerHumanRequestAuthority } from "./owner-human-request-authority.js";
import { connectOwnerHumanRequestCard, lockOwnerHumanCurrentCard } from "./owner-human-request-card.js";
import { findPendingMissionHumanCard, withdrawPendingMissionHumanCard } from "./mission-owner-human-input-card.js";
import { ownerHumanLifetimeSchema, type OwnerHumanTx } from "./owner-human-request-contract.js";
import { renewOwnerHumanRequest } from "./owner-human-request-state.js";
import { activePlanDecisionHash } from "../operator-decision-server-context.js";

const fail = (): never => { throw conflict("Owner human request renewal conflict", {
  reason: "owner_human_request_renewal_mismatch",
}); };

export async function renewOwnerHumanRequestWithCard(tx: OwnerHumanTx, input: {
  companyId: string; previousLifetimeId: string; anchorIssueId: string; requestKey: string;
}) {
  // IDs locate immutable evidence; the caller cannot supply an author, heartbeat or prose.
  // Authority re-reads that evidence under mission/run/heartbeat/sorted-issue/step locks.
  const [row] = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, input.companyId),
    eq(workflowTransitionEvents.id, input.previousLifetimeId)));
  const parsed = ownerHumanLifetimeSchema.safeParse(row?.payload);
  if (!parsed.success || parsed.data.lifetimeId !== input.previousLifetimeId
    || parsed.data.scope.companyId !== input.companyId) return fail();
  const previous = parsed.data;
  const [author] = await tx.select({ id: agents.id }).from(agents).where(and(
    eq(agents.id, previous.authorAgentId), eq(agents.companyId, input.companyId)));
  if (!author) return fail();
  const auth = await lockOwnerHumanRequestAuthority(tx, {
    companyId: input.companyId, missionId: previous.scope.missionId,
    ownerActionIssueId: previous.anchorIssueId, agentId: previous.authorAgentId,
    heartbeatRunId: previous.heartbeatRunId, recoveryTarget: previous.submission.recoveryTarget,
    purpose: "renew", renewal: { previousLifetimeId: previous.lifetimeId, anchorIssueId: input.anchorIssueId },
  });
  // Human resolution is not source settlement. An unresolved recovery pointer and an actual
  // current blocker are required, even when the historical card already contains an approval.
  if (!auth.source || auth.source.hiddenAt) return fail();
  const current = await renewOwnerHumanRequest(auth, {
    requestKey: input.requestKey, expectedCurrentLifetimeId: input.previousLifetimeId,
  });
  const validated = validateAndHashOperatorDecisionCreate(buildMissionOwnerHumanInputDecisionCard({
    ...current.lifetime.cardInput, lifetimeId: current.lifetime.lifetimeId,
  }));
  const guard = await lockOwnerHumanCurrentCard(auth, validated.input,
    { type: "agent", id: current.lifetime.authorAgentId });
  if (guard.card) return { current, card: guard.card, cardCreated: false };
  // [C1 2026-11-08] 미션당 pending 사람 카드 1장(부분 고유 인덱스) 계약 아래 갱신은 표면 교체다.
  // 새 카드를 발행하는 경로(재전송·기존 카드 채택이 아닌 경우)에서만, 교체 대상 pending 카드
  // (갱신된 이전 수명의 카드·SELECT→INSERT 레이스 잔존)를 같은 트랜잭션에서 회수한다.
  // 시스템 갱신 경로(anchor·tool-recovery)는 기존대로 사전검사에서 보류되므로 여기까지
  // pending 이 있는 경우는 직접 갱신·동시 레이스 경로뿐이다.
  if (await findPendingMissionHumanCard(tx, input.companyId, previous.scope.missionId)) {
    await withdrawPendingMissionHumanCard(tx, input.companyId, previous.scope.missionId, {
      actorId: "system:owner-human-request-renewal", reason: "owner_human_request_replaced",
      details: { previousLifetimeId: previous.lifetimeId },
    });
  }
  // Only immutable request fields are copied. Results, approvals, cancellation and delivery
  // state are never inherited, and replay never resets a card that has since been resolved.
  const value = guard.input;
  const sourceContext = { ...value.sourceContext,
    planDecisionHash: await activePlanDecisionHash(tx, input.companyId, current.lifetime.scope.missionId) };
  const [card] = await tx.insert(operatorDecisions).values({
    companyId: input.companyId, schemaVersion: value.schemaVersion,
    requestKey: value.requestKey, requestHash: validated.requestHash, status: "pending",
    priority: value.priority, interactionType: value.interactionType,
    title: value.title, description: value.description, definition: value.definition,
    sourceType: value.sourceType, sourceId: value.sourceId, sourceContext,
    issueId: value.issueId, continuationMode: value.continuationMode,
    requestedByAgentId: current.lifetime.authorAgentId, requestedByUserId: null,
  }).returning();
  if (!card) return fail();
  await connectOwnerHumanRequestCard(tx, guard, card.id);
  await tx.insert(activityLog).values({
    companyId: input.companyId, actorType: "system", actorId: "system:owner-human-request-renewal",
    action: "operator_decision.created", entityType: "operator_decision", entityId: card.id,
    details: { schemaVersion: 1, operatorDecisionId: card.id,
      requestKey: card.requestKey, priority: card.priority, interactionType: card.interactionType,
      sourceType: card.sourceType, sourceId: card.sourceId, issueId: card.issueId,
      continuationMode: card.continuationMode, lifetimeId: current.lifetime.lifetimeId,
      previousLifetimeId: input.previousLifetimeId },
  });
  // The caller may issue the existing card alert after its outer transaction commits.
  return { current, card, cardCreated: true };
}
