import { z } from "zod";
import { and, eq, or, sql } from "drizzle-orm";
import { operatorDecisions, workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { CreateOperatorDecisionInput, OperatorDecisionDefinition } from "@paperclipai/shared/types/operator-decision";
import { ownerHumanLifetimeSchema, ownerHumanLifetimeKey, sameOwnerHumanValue,
  OWNER_HUMAN_LAYER, OWNER_HUMAN_SOURCE, type OwnerHumanLifetime } from "./missions/owner-human-request-contract.js";
import { buildHistoricalDefaultOwnerHumanInputVariant } from "./missions/mission-owner-human-default-definition.js";
import { buildMissionOwnerHumanInputDecisionCard } from "./missions/mission-owner-human-input-card.js";
import { stripOperatorDecisionServerContext } from "./operator-decision-server-context.js";
import { validateAndHashOperatorDecisionCreate } from "./operator-decision-result.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID } from "./missions/workflow-restart-option.js";

export type RecoveryAdviceDecision = typeof operatorDecisions.$inferSelect;
export type RecoveryAdviceEvent = Pick<typeof workflowTransitionEvents.$inferSelect,
  "id" | "companyId" | "missionId" | "workflowRunId" | "workflowStepRunId" | "issueId" | "heartbeatRunId"
  | "eventType" | "layer" | "reason" | "reasonCode" | "idempotencyKey" | "payload">;
export type RecoveryAdviceFacts = {
  kind: "pending_owner_human_restart_candidate";
  cardLinks: RecoveryAdviceEvent[];
  lifetimes: RecoveryAdviceEvent[];
};
export type RecoveryAdviceFactBundle =
  | (RecoveryAdviceFacts & { card: RecoveryAdviceDecision })
  | { kind: "outside_default_scope"; card: RecoveryAdviceDecision };
export type RecoveryAdviceDisposition =
  | "historical_default_hold"
  | "unproven_restart_hold"
  | "outside_default_scope";
export type RecoveryAdvice = { disposition: RecoveryAdviceDisposition; reason: string };

const cardLinkSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("owner_human_card_v1"),
  lifetimeId: z.string().uuid(), decisionEventId: z.string().uuid(), operatorDecisionId: z.string().uuid(),
}).strict();
const restartId = WORKFLOW_RESTART_FROM_START_OPTION_ID;
const isOwnerHumanRestartCandidate = (card: RecoveryAdviceDecision) => card.sourceType === "mission_owner_human_input"
  && Array.isArray(card.definition.options) && card.definition.options.some((option) => option.id === restartId);
const adviceText: Record<RecoveryAdviceDisposition, string> = {
  historical_default_hold: "저장된 재시작 추천은 과거 카드 생성 규칙에서 붙은 안내입니다. 이 카드는 전체 수집이나 처음부터 재시작할 권한을 입증하지 않습니다. 이미 수행한 작업을 보존하고 기존 오너·정책 검토 경로를 사용하세요.",
  unproven_restart_hold: "재시작 옵션의 범위와 근거가 현재 확인되지 않았습니다. 추천 표시만으로 전체 수집이나 처음부터 재시작할 권한을 입증하지 않습니다. 이미 수행한 작업을 보존하고 기존 오너·정책 검토 경로를 사용하세요.",
  outside_default_scope: "",
};

/** Extract only a locator; event headers and payload binding are revalidated by the predicate. */
export function recoveryAdviceLifetimeIdFromLink(event: RecoveryAdviceEvent): string | null {
  const parsed = cardLinkSchema.safeParse(event.payload);
  return parsed.success ? parsed.data.lifetimeId : null;
}

/** Load link/lifetime facts in two batch queries, always paired by company and persisted key. */
async function loadCandidateFacts(
  db: Db,
  candidates: readonly RecoveryAdviceDecision[],
): Promise<Map<string, RecoveryAdviceFacts>> {
  const facts = new Map<string, RecoveryAdviceFacts>(candidates.map((row) => [row.id,
    { kind: "pending_owner_human_restart_candidate", cardLinks: [], lifetimes: [] }]));
  if (candidates.length === 0) return facts;
  const columns = {
    id: workflowTransitionEvents.id, companyId: workflowTransitionEvents.companyId,
    missionId: workflowTransitionEvents.missionId, workflowRunId: workflowTransitionEvents.workflowRunId,
    workflowStepRunId: workflowTransitionEvents.workflowStepRunId, issueId: workflowTransitionEvents.issueId,
    heartbeatRunId: workflowTransitionEvents.heartbeatRunId, eventType: workflowTransitionEvents.eventType,
    layer: workflowTransitionEvents.layer, reason: workflowTransitionEvents.reason,
    reasonCode: workflowTransitionEvents.reasonCode, idempotencyKey: workflowTransitionEvents.idempotencyKey,
    payload: workflowTransitionEvents.payload,
  };
  const links = await db.select(columns).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.eventType, "owner_human_card_v1"),
    or(...candidates.map((row) => and(eq(workflowTransitionEvents.companyId, row.companyId),
      sql`${workflowTransitionEvents.payload}->>'operatorDecisionId' = ${row.id}`)))!,
  ));
  const ids = new Map<string, { companyId: string; id: string }>();
  for (const event of links) {
    const decisionId = event.payload.operatorDecisionId;
    if (typeof decisionId === "string") facts.get(decisionId)?.cardLinks.push(event);
    const lifetimeId = recoveryAdviceLifetimeIdFromLink(event);
    if (lifetimeId) ids.set(`${event.companyId}|${lifetimeId}`, { companyId: event.companyId, id: lifetimeId });
  }
  if (ids.size === 0) return facts;
  const lifetimeRows = await db.select(columns).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.eventType, "owner_human_lifetime_v1"),
    or(...[...ids.values()].map((pair) => and(eq(workflowTransitionEvents.companyId, pair.companyId),
      eq(workflowTransitionEvents.id, pair.id))))!,
  ));
  for (const event of lifetimeRows) {
    for (const { cardLinks, lifetimes } of facts.values()) {
      if (cardLinks.some((link) => link.companyId === event.companyId
        && recoveryAdviceLifetimeIdFromLink(link) === event.id)) lifetimes.push(event);
    }
  }
  return facts;
}

export async function loadRecoveryAdviceFacts(db: Db, rows: readonly RecoveryAdviceDecision[]) {
  return loadCandidateFacts(db, rows.filter((row) => row.status === "pending" && isOwnerHumanRestartCandidate(row)));
}

/** Transactional admission reads identity facts for an already-resolved row without the display status filter. */
export async function loadRecoveryAdviceIdentityFacts(db: Db, card: RecoveryAdviceDecision) {
  if (!isOwnerHumanRestartCandidate(card)) return null;
  return (await loadCandidateFacts(db, [card])).get(card.id) ?? null;
}

export function recoveryAdviceStoredInput(card: RecoveryAdviceDecision): CreateOperatorDecisionInput | null {
  const raw = {
    schemaVersion: card.schemaVersion, requestKey: card.requestKey, priority: card.priority,
    interactionType: card.interactionType, title: card.title, description: card.description,
    sourceType: card.sourceType, sourceId: card.sourceId,
    sourceContext: stripOperatorDecisionServerContext(card.sourceContext),
    definition: card.definition, issueId: card.issueId, continuationMode: card.continuationMode,
  };
  try {
    const parsed = validateAndHashOperatorDecisionCreate(raw);
    return sameOwnerHumanValue(raw, parsed.input) && parsed.requestHash === card.requestHash ? parsed.input : null;
  } catch { return null; }
}

function withoutRestartRecommendation(input: CreateOperatorDecisionInput): CreateOperatorDecisionInput {
  return { ...input, definition: { ...input.definition, options: input.definition.options.map((option) => {
    if (option.id !== restartId) return option;
    const { recommended: _recommended, recommendationReason: _reason, ...neutral } = option;
    return neutral;
  }) } };
}

function hasRestart(input: CreateOperatorDecisionInput): boolean {
  return input.definition.options.some((option) => option.id === restartId);
}

function boundLifetime(card: RecoveryAdviceDecision, input: CreateOperatorDecisionInput,
  links: RecoveryAdviceEvent[], lifetimes: RecoveryAdviceEvent[]): OwnerHumanLifetime | null {
  if (links.length !== 1) return null;
  const event = links[0]!;
  const parsedLink = cardLinkSchema.safeParse(event.payload);
  if (!parsedLink.success) return null;
  const link = parsedLink.data;
  if (event.companyId !== card.companyId || event.missionId !== input.sourceContext.missionId
    || event.eventType !== "owner_human_card_v1" || event.layer !== OWNER_HUMAN_LAYER
    || event.reason !== OWNER_HUMAN_SOURCE || event.reasonCode !== OWNER_HUMAN_SOURCE
    || event.idempotencyKey !== `owner-human-card:v1:${link.lifetimeId}`
    || event.issueId !== card.issueId || event.workflowRunId !== input.sourceContext.workflowRunId
    || link.operatorDecisionId !== card.id || link.decisionEventId !== card.sourceId) return null;
  const matches = lifetimes.filter((row) => row.id === link.lifetimeId && row.companyId === card.companyId);
  if (matches.length !== 1) return null;
  const lifetimeEvent = matches[0]!;
  const parsedLifetime = ownerHumanLifetimeSchema.safeParse(lifetimeEvent.payload);
  if (!parsedLifetime.success) return null;
  const lifetime = parsedLifetime.data;
  const stepId = lifetime.scope.target.kind === "tool_step" ? lifetime.scope.target.stepRunId : null;
  if (lifetimeEvent.id !== lifetime.lifetimeId || lifetime.lifetimeId !== link.lifetimeId
    || lifetimeEvent.missionId !== lifetime.scope.missionId || lifetimeEvent.issueId !== lifetime.anchorIssueId
    || lifetimeEvent.heartbeatRunId !== lifetime.heartbeatRunId
    || (lifetimeEvent.workflowRunId !== null && lifetimeEvent.workflowRunId !== lifetime.cardInput.workflowRunId)
    || (lifetimeEvent.workflowStepRunId !== null && lifetimeEvent.workflowStepRunId !== stepId)
    || event.heartbeatRunId !== lifetime.heartbeatRunId || event.workflowStepRunId !== stepId
    || event.workflowRunId !== lifetime.cardInput.workflowRunId || event.issueId !== lifetime.anchorIssueId
    || event.eventType !== "owner_human_card_v1" || event.layer !== OWNER_HUMAN_LAYER
    || event.reason !== OWNER_HUMAN_SOURCE || event.reasonCode !== OWNER_HUMAN_SOURCE
    || event.idempotencyKey !== `owner-human-card:v1:${lifetime.lifetimeId}` || lifetimeEvent.eventType !== lifetime.kind
    || lifetimeEvent.layer !== OWNER_HUMAN_LAYER || lifetimeEvent.reason !== OWNER_HUMAN_SOURCE
    || lifetimeEvent.reasonCode !== OWNER_HUMAN_SOURCE
    || lifetimeEvent.idempotencyKey !== ownerHumanLifetimeKey(lifetime.requestKey)
    || lifetime.scope.companyId !== card.companyId || lifetime.scope.missionId !== input.sourceContext.missionId
    || link.decisionEventId !== lifetime.decisionEventId || link.lifetimeId !== lifetime.lifetimeId
    || card.requestKey !== (lifetime.identityMode === "keyed" ? `moi2:${lifetime.lifetimeId}` : `moi1:${lifetime.decisionEventId}`)
    || lifetime.anchorIssueId !== card.issueId || lifetime.authorAgentId !== card.requestedByAgentId
    || card.requestedByUserId !== null || card.qualityActionId !== null || card.qualityBinding !== null
    || lifetime.cardInput.companyId !== card.companyId || lifetime.cardInput.missionId !== input.sourceContext.missionId
    || lifetime.cardInput.decisionEventId !== card.sourceId || lifetime.cardInput.ownerActionIssueId !== card.issueId
    || lifetime.cardInput.requestedByAgentId !== card.requestedByAgentId
    || lifetime.cardInput.workflowRunId !== input.sourceContext.workflowRunId) return null;
  return lifetime;
}

function rebuildLifetimeInput(lifetime: OwnerHumanLifetime, neutral: boolean): CreateOperatorDecisionInput | null {
  const { recommendedOptionId: _recommended, recommendationReason: _reason, ...base } = lifetime.cardInput;
  const cardInput = neutral ? base : lifetime.cardInput;
  try {
    return buildMissionOwnerHumanInputDecisionCard({ ...cardInput,
      ...(lifetime.identityMode === "keyed" ? { lifetimeId: lifetime.lifetimeId } : {}) });
  } catch { return null; }
}

function exactInputMatch(card: RecoveryAdviceDecision, original: CreateOperatorDecisionInput,
  expected: CreateOperatorDecisionInput | null): boolean {
  if (!expected) return false;
  try {
    const hashed = validateAndHashOperatorDecisionCreate(expected);
    return hashed.requestHash === card.requestHash && sameOwnerHumanValue(original, hashed.input);
  } catch { return false; }
}

/** Pure read-side policy: identity and hashes are checked here; no status or prose grants authority. */
export function evaluateRecoveryAdviceIdentity(input: RecoveryAdviceFactBundle): RecoveryAdvice {
  if (input.kind === "outside_default_scope") {
    return { disposition: "outside_default_scope", reason: "not_a_pending_owner_restart" };
  }
  const { card, cardLinks, lifetimes } = input;
  const rawHasRestart = Array.isArray(card.definition.options)
    && card.definition.options.some((option) => option.id === restartId);
  if (card.sourceType !== "mission_owner_human_input" || !rawHasRestart) {
    return { disposition: "outside_default_scope", reason: "not_a_pending_owner_restart" };
  }
  const original = recoveryAdviceStoredInput(card);
  if (!original || !hasRestart(original)) {
    return { disposition: "unproven_restart_hold", reason: "stored_input_or_hash_unproven" };
  }
  const neutral = withoutRestartRecommendation(original);
  const historical = buildHistoricalDefaultOwnerHumanInputVariant(neutral);

  const lifetime = boundLifetime(card, original, cardLinks, lifetimes);
  if (cardLinks.length > 0) {
    if (!lifetime) return { disposition: "unproven_restart_hold", reason: "lifetime_binding_unproven" };
    const expected = rebuildLifetimeInput(lifetime, false);
    const neutralExpected = rebuildLifetimeInput(lifetime, true);
    const defaultShape = neutralExpected
      ? buildHistoricalDefaultOwnerHumanInputVariant(neutralExpected) : null;
    if (!defaultShape) return { disposition: "unproven_restart_hold", reason: "saved_default_shape_unproven" };
    const explicitRestart = lifetime.submission.recommendedOptionId === restartId;
    if (!lifetime.submission.recommendedOptionId && exactInputMatch(card, original, defaultShape)) {
      return { disposition: "historical_default_hold", reason: "saved_historical_default_match" };
    }
    if (exactInputMatch(card, original, expected)) {
      return { disposition: "unproven_restart_hold", reason: explicitRestart
        ? "explicit_restart_has_no_execution_proof" : "current_default_has_no_execution_proof" };
    }
    return { disposition: "unproven_restart_hold", reason: "saved_card_binding_unproven" };
  }

  if (card.requestKey.startsWith("moi2:")) {
    return { disposition: "unproven_restart_hold", reason: "current_lifetime_missing" };
  }
  const legacyAgentAuthored = card.requestedByAgentId !== null && card.requestedByUserId === null
    && card.qualityActionId === null && card.qualityBinding === null;
  if (legacyAgentAuthored && card.requestKey.startsWith("moi1:") && historical
    && exactInputMatch(card, original, historical)) {
    return { disposition: "historical_default_hold", reason: "legacy_historical_default_match" };
  }
  if (card.requestKey.startsWith("moi1:")) {
    return { disposition: "unproven_restart_hold", reason: "legacy_default_has_no_execution_proof" };
  }
  return { disposition: "unproven_restart_hold", reason: "owner_restart_identity_unproven" };
}

/** Read projection filter: terminal cards remain byte-for-byte historical and are not re-advised. */
export function evaluateRecoveryAdvice(input: RecoveryAdviceFactBundle): RecoveryAdvice {
  if (input.kind === "outside_default_scope" || input.card.status !== "pending") {
    return { disposition: "outside_default_scope", reason: "not_a_pending_owner_restart" };
  }
  return evaluateRecoveryAdviceIdentity(input);
}

/** Return a display copy only; keep requester text visible without treating it as authority. */
export function overlayRecoveryAdvice(
  definition: OperatorDecisionDefinition,
  advice: RecoveryAdvice,
): OperatorDecisionDefinition {
  if (advice.disposition === "outside_default_scope" || !Array.isArray(definition.options)) return definition;
  const requesterProvidedLabel = "요청자가 제공한 설명(비권위적이며 실행 권한을 부여하지 않습니다):";
  const nextStepLabel = "요청자가 제시한 다음 단계(비권위적이며 실행 권한을 부여하지 않습니다):";
  const warning = adviceText[advice.disposition];
  return {
    ...definition,
    options: definition.options.map((option) => {
      if (option.id !== restartId) return option;
      const { recommended: _recommended, recommendationReason: _reason, ...neutral } = option;
      return neutral;
    }),
    ...(definition.humanReview ? { humanReview: {
      ...definition.humanReview,
      interpretation: `${requesterProvidedLabel}\n${definition.humanReview.interpretation}\n\n${warning}`,
      recommendedNextStep: `${nextStepLabel}\n${definition.humanReview.recommendedNextStep}\n\n${warning}`,
    } } : {}),
  };
}
