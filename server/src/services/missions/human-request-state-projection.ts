import {
  agentWakeupRequests, agents, heartbeatRuns, issues, operatorDecisionContinuations, operatorDecisions, type Db,
} from "@paperclipai/db";
import type { OperatorDecisionContinuationView, OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import type {
  HumanOperatorRequestContinuationState,
  HumanOperatorRequestDecisionState,
  HumanOperatorRequestStateV1,
} from "@paperclipai/shared/types/human-operator-request-state";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import {
  buildContinuationRetryHint, deriveOperatorDecisionContinuationStatus, type ContinuationStatusInput,
} from "../operator-decision-continuation-status.js";

const LIMIT = 250;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE = "mission_owner_human_input";

export type HumanOperatorRequestCandidate = {
  activityId: string; companyId: string; missionId: string; decisionEventId: string; decisionKind: string;
  ownerActionIssueId: string; payloadOwnerIssueId: unknown; payloadMissionId: unknown; payloadCompanyId: unknown;
  sourceIssueId: string | null; sourceIsConsistent: boolean; workflowRunId: unknown;
};

type Card = Pick<typeof operatorDecisions.$inferSelect,
  "id" | "companyId" | "requestKey" | "sourceType" | "sourceId" | "issueId" | "sourceContext" | "status" |
  "result" | "resolvedAt" | "cancelledAt" | "continuationMode" | "requestedByAgentId">;
type Continuation = Pick<typeof operatorDecisionContinuations.$inferSelect,
  "id" | "companyId" | "operatorDecisionId" | "issueId" | "state" | "generation" | "attemptCount" |
  "maxAttempts" | "manualRetryCount" | "nextAttemptAt" | "leaseExpiresAt" | "targetAgentId" | "wakeupRequestId" | "errorCode">;
type ReadDb = Pick<Db, "select">;
type Delivery = { continuation: HumanOperatorRequestContinuationState | null; attention: boolean | null };
type AnyRow = Record<string, unknown>;

const asRecord = (value: unknown): AnyRow | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as AnyRow : null;

function unknownState(candidate: HumanOperatorRequestCandidate, identity: "missing" | "ambiguous" | "unsupported", reasonCode: string): HumanOperatorRequestStateV1 {
  return {
    schemaVersion: 1, identity, reasonCode, decisionEventId: candidate.decisionEventId,
    ownerActionIssueId: candidate.ownerActionIssueId, sourceIssueId: candidate.sourceIssueId,
    decision: null, continuation: null, attention: null,
  };
}

function candidateProblem(candidate: HumanOperatorRequestCandidate): string | null {
  if (!UUID.test(candidate.decisionEventId)) return "invalid_decision_event_id";
  if (!UUID.test(candidate.ownerActionIssueId) || candidate.payloadOwnerIssueId !== candidate.ownerActionIssueId) return "owner_identity_conflict";
  if (candidate.payloadMissionId !== candidate.missionId) return "mission_identity_conflict";
  if (candidate.payloadCompanyId !== undefined && candidate.payloadCompanyId !== candidate.companyId) return "company_identity_conflict";
  if (!candidate.sourceIsConsistent) return "source_scope_conflict";
  if (candidate.workflowRunId != null && (typeof candidate.workflowRunId !== "string" || !UUID.test(candidate.workflowRunId))) return "invalid_workflow_run_id";
  if (candidate.decisionKind !== "request_input" && candidate.decisionKind !== "escalate") return "unsupported_request_kind";
  return null;
}

function cardScopeProblem(card: Card, candidate: HumanOperatorRequestCandidate): string | null {
  if (card.companyId !== candidate.companyId || card.issueId !== candidate.ownerActionIssueId) return "card_owner_conflict";
  const context = asRecord(card.sourceContext);
  if (!context || context.missionId !== candidate.missionId) return "card_mission_conflict";
  if (context.targetSnapshot != null && !asRecord(context.targetSnapshot)) return "card_snapshot_invalid";
  const snapshot = asRecord(context.targetSnapshot);
  if (snapshot?.issueId != null && snapshot.issueId !== candidate.ownerActionIssueId) return "card_snapshot_owner_conflict";
  const contextRun = context.workflowRunId;
  const snapshotRun = snapshot?.workflowRunId;
  if ([contextRun, snapshotRun].some((run) => run != null && (typeof run !== "string" || !UUID.test(run)))) return "card_run_conflict";
  if (contextRun && snapshotRun && contextRun !== snapshotRun) return "card_run_conflict";
  if (candidate.workflowRunId && (contextRun ?? snapshotRun) !== candidate.workflowRunId) return "request_run_conflict";
  return null;
}

function decisionView(card: Card): HumanOperatorRequestDecisionState {
  return {
    id: card.id, requestKey: card.requestKey, sourceId: card.sourceId,
    status: card.status as OperatorDecisionView["status"], result: card.result,
    resolvedAt: card.resolvedAt?.toISOString() ?? null, cancelledAt: card.cancelledAt?.toISOString() ?? null,
    continuationMode: card.continuationMode as OperatorDecisionView["continuationMode"],
  };
}

function cardSelection() {
  return {
    id: operatorDecisions.id, companyId: operatorDecisions.companyId, requestKey: operatorDecisions.requestKey,
    sourceType: operatorDecisions.sourceType, sourceId: operatorDecisions.sourceId, issueId: operatorDecisions.issueId,
    sourceContext: operatorDecisions.sourceContext, status: operatorDecisions.status, result: operatorDecisions.result,
    resolvedAt: operatorDecisions.resolvedAt, cancelledAt: operatorDecisions.cancelledAt,
    continuationMode: operatorDecisions.continuationMode, requestedByAgentId: operatorDecisions.requestedByAgentId,
  };
}

async function findCards(tx: ReadDb, candidates: readonly HumanOperatorRequestCandidate[]) {
  const companyId = candidates[0]!.companyId;
  const events = [...new Set(candidates.map((candidate) => candidate.decisionEventId).filter((id) => UUID.test(id)))];
  const owners = [...new Set(candidates.map((candidate) => candidate.ownerActionIssueId).filter((id) => UUID.test(id)))];
  const direct = events.length ? await tx.select(cardSelection()).from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, companyId), inArray(operatorDecisions.requestKey, events.map((id) => `moi1:${id}`)),
  )) as Card[] : [];
  const remaining = Math.max(0, LIMIT - direct.length);
  const nearby = owners.length ? await tx.select(cardSelection()).from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, companyId), eq(operatorDecisions.sourceType, SOURCE),
    inArray(operatorDecisions.issueId, owners), ...(direct.length ? [notInArray(operatorDecisions.id, direct.map((row) => row.id))] : []),
  )).orderBy(desc(operatorDecisions.createdAt), desc(operatorDecisions.id)).limit(remaining + 1) as Card[] : [];
  return { cards: [...direct, ...nearby.slice(0, remaining)], directIds: new Set(direct.map((row) => row.id)), overflow: nearby.length > remaining };
}

async function deliveryFacts(tx: ReadDb, companyId: string, missionById: Map<string, string>, cards: Map<string, Card>, now: Date) {
  const ids = [...cards.keys()];
  const output = new Map<string, Delivery>();
  if (!ids.length) return output;
  const continuations = await tx.select({
    id: operatorDecisionContinuations.id, companyId: operatorDecisionContinuations.companyId,
    operatorDecisionId: operatorDecisionContinuations.operatorDecisionId, issueId: operatorDecisionContinuations.issueId,
    state: operatorDecisionContinuations.state, generation: operatorDecisionContinuations.generation,
    attemptCount: operatorDecisionContinuations.attemptCount, maxAttempts: operatorDecisionContinuations.maxAttempts,
    manualRetryCount: operatorDecisionContinuations.manualRetryCount, nextAttemptAt: operatorDecisionContinuations.nextAttemptAt,
    leaseExpiresAt: operatorDecisionContinuations.leaseExpiresAt, targetAgentId: operatorDecisionContinuations.targetAgentId,
    wakeupRequestId: operatorDecisionContinuations.wakeupRequestId, errorCode: operatorDecisionContinuations.errorCode,
  }).from(operatorDecisionContinuations).where(inArray(operatorDecisionContinuations.operatorDecisionId, ids)) as Continuation[];
  const wakeupIds = [...new Set(continuations.flatMap((row) => row.wakeupRequestId ? [row.wakeupRequestId] : []))];
  const wakeups = wakeupIds.length ? await tx.select({
    id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId, agentId: agentWakeupRequests.agentId,
    status: agentWakeupRequests.status, runId: agentWakeupRequests.runId,
  }).from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakeupIds)) : [];
  const runIds = [...new Set(wakeups.flatMap((row) => row.runId ? [row.runId] : []))];
  const runs = runIds.length ? await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds))) : [];
  const issueIds = [...new Set(continuations.flatMap((row) => row.issueId ? [row.issueId] : []))];
  const issueRows = issueIds.length ? await tx.select({
    id: issues.id, companyId: issues.companyId, missionId: issues.missionId, status: issues.status, assigneeAgentId: issues.assigneeAgentId,
  }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds))) : [];
  const agentIds = [...new Set(continuations.flatMap((row) => row.targetAgentId ? [row.targetAgentId] : []))];
  const targetAgents = agentIds.length ? await tx.select({ id: agents.id, companyId: agents.companyId, status: agents.status })
    .from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))) : [];
  const wakeupById = new Map(wakeups.map((row) => [row.id, row]));
  const runById = new Map(runs.map((row) => [row.id, row]));
  const issueById = new Map(issueRows.map((row) => [row.id, row]));
  const agentById = new Map(targetAgents.map((row) => [row.id, row]));
  const byDecision = new Map<string, Continuation[]>();
  for (const row of continuations) byDecision.set(row.operatorDecisionId, [...(byDecision.get(row.operatorDecisionId) ?? []), row]);
  for (const [id, card] of cards) {
    const rows = byDecision.get(id) ?? [];
    if (!rows.length) {
      output.set(id, { continuation: null, attention: card.status === "pending" || (card.status === "resolved" && card.continuationMode !== "none") });
      continue;
    }
    if (rows.length !== 1) { output.set(id, { continuation: null, attention: null }); continue; }
    const row = rows[0]!;
    const wakeup = row.wakeupRequestId ? wakeupById.get(row.wakeupRequestId) ?? null : null;
    const run = wakeup?.runId ? runById.get(wakeup.runId) ?? null : null;
    const issue = row.issueId ? issueById.get(row.issueId) ?? null : null;
    const agent = row.targetAgentId ? agentById.get(row.targetAgentId) ?? null : null;
    const inconsistent = row.companyId !== companyId
      || (row.issueId !== null && row.issueId !== card.issueId)
      || Boolean(issue && issue.missionId !== missionById.get(id))
      || Boolean(wakeup && (wakeup.companyId !== companyId || wakeup.agentId !== row.targetAgentId));
    if (inconsistent) { output.set(id, { continuation: null, attention: null }); continue; }
    const status = deriveOperatorDecisionContinuationStatus({
      continuation: row as ContinuationStatusInput["continuation"], wakeup, run, issue, targetAgent: agent,
      requestedByAgentId: card.requestedByAgentId, now,
    });
    output.set(id, { attention: status.attention, continuation: {
      id: row.id, state: row.state as OperatorDecisionContinuationView["state"], generation: row.generation,
      attemptCount: row.attemptCount, maxAttempts: row.maxAttempts, manualRetryCount: row.manualRetryCount,
      maxManualRetries: 2, wakeupRequestId: row.wakeupRequestId, effectiveStatus: status.effectiveStatus,
      errorCode: status.errorCode, retryHint: buildContinuationRetryHint(status.effectiveStatus, status.errorCode, issue?.status ?? null),
    } });
  }
  return output;
}

export async function projectHumanRequestStates(
  tx: ReadDb,
  input: { companyId: string; candidates: readonly HumanOperatorRequestCandidate[]; now: Date },
): Promise<Map<string, HumanOperatorRequestStateV1>> {
  const result = new Map<string, HumanOperatorRequestStateV1>();
  const usable = input.candidates.filter((candidate) => {
    const problem = candidate.companyId === input.companyId ? candidateProblem(candidate) : "company_identity_conflict";
    if (!problem) return true;
    const unsupported = problem.startsWith("unsupported") || problem.startsWith("invalid");
    result.set(candidate.activityId, unknownState(candidate, unsupported ? "unsupported" : "ambiguous", problem));
    return false;
  });
  if (!usable.length) return result;
  const found = await findCards(tx, usable);
  const exactByActivity = new Map<string, Card>();
  const cardsById = new Map<string, Card>();
  const missionById = new Map<string, string>();
  for (const candidate of usable) {
    const key = `moi1:${candidate.decisionEventId}`;
    const direct = found.cards.filter((card) => found.directIds.has(card.id) && card.requestKey === key);
    const owner = found.cards.filter((card) => !found.directIds.has(card.id) && card.issueId === candidate.ownerActionIssueId
      && card.sourceId === candidate.decisionEventId);
    const alias = found.cards.some((card) => card.issueId === candidate.ownerActionIssueId
      && asRecord(asRecord(card.sourceContext)?.missionOwnerHumanInput)?.lastSeenDecisionEventId === candidate.decisionEventId);
    const accepted: Card[] = [];
    let conflict: string | null = null;
    for (const card of [...direct, ...owner]) {
      if (card.sourceId !== candidate.decisionEventId || card.issueId !== candidate.ownerActionIssueId) { conflict = "card_relation_conflict"; continue; }
      if (card.sourceType !== SOURCE) { conflict = "unsupported_card_source"; continue; }
      const moi1 = card.requestKey === key;
      const moi2 = /^moi2:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(card.requestKey);
      if (!moi1 && !moi2) { conflict = "unsupported_card_key"; continue; }
      const problem = cardScopeProblem(card, candidate);
      if (problem) { conflict = problem; continue; }
      accepted.push(card);
    }
    const uniqueMoi1 = direct.find((card) => accepted.includes(card));
    if (found.overflow && !uniqueMoi1) { result.set(candidate.activityId, unknownState(candidate, "ambiguous", "card_search_incomplete")); continue; }
    if (conflict) {
      result.set(candidate.activityId, unknownState(candidate, conflict.startsWith("unsupported") ? "unsupported" : "ambiguous", conflict));
    } else if (accepted.length === 1) {
      const card = accepted[0]!;
      exactByActivity.set(candidate.activityId, card); cardsById.set(card.id, card); missionById.set(card.id, candidate.missionId);
    } else if (accepted.length > 1) result.set(candidate.activityId, unknownState(candidate, "ambiguous", "duplicate_exact_cards"));
    else if (alias) result.set(candidate.activityId, unknownState(candidate, "ambiguous", "repeat_alias_only"));
    else result.set(candidate.activityId, unknownState(candidate, "missing", "exact_card_not_found"));
  }
  const deliveries = await deliveryFacts(tx, input.companyId, missionById, cardsById, input.now);
  for (const candidate of usable) {
    const card = exactByActivity.get(candidate.activityId);
    if (!card) continue;
    const delivery = deliveries.get(card.id) ?? { continuation: null, attention: null };
    result.set(candidate.activityId, {
      schemaVersion: 1, identity: "exact", reasonCode: null, decisionEventId: candidate.decisionEventId,
      ownerActionIssueId: candidate.ownerActionIssueId, sourceIssueId: candidate.sourceIssueId,
      decision: decisionView(card), continuation: delivery.continuation, attention: delivery.attention,
    });
  }
  return result;
}
