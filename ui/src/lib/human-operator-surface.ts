import type { HumanOperatorRequestStateV1 } from "@paperclipai/shared/types/human-operator-request-state";
import type { MissionHumanOperatorRequest, MissionListItem, MissionStatus } from "../api/missions";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";

export type HumanOperatorLifecycle = "active" | "paused" | "terminal" | "unknown" | "unscoped";
export type HumanOperatorRequestStateProblem = "legacy" | "malformed" | "scope-conflict" | "card-conflict" | "duplicate-decision";

export interface HumanOperatorScope {
  lifecycle: HumanOperatorLifecycle;
  missionStatus: MissionStatus | null;
}

export interface HumanOperatorCardItem {
  decision: OperatorDecisionView;
  scope: HumanOperatorScope;
}

export interface HumanOperatorRequestItem {
  request: MissionHumanOperatorRequest;
  requestState: HumanOperatorRequestStateV1 | null;
  requestStateProblem: HumanOperatorRequestStateProblem | null;
  card: OperatorDecisionView | null;
  scope: HumanOperatorScope;
}

export interface HumanOperatorSurfaceInput {
  companyId: string | null;
  missions: readonly MissionListItem[] | undefined;
  requests: readonly MissionHumanOperatorRequest[];
  pendingDecisions: readonly OperatorDecisionView[];
  pendingNextCursor?: string | null;
}

export interface HumanOperatorSurfaceSection {
  cards: HumanOperatorCardItem[];
  requests: HumanOperatorRequestItem[];
}

export interface HumanOperatorSurface {
  active: HumanOperatorSurfaceSection;
  paused: HumanOperatorSurfaceSection;
  terminal: HumanOperatorSurfaceSection;
  unknown: HumanOperatorSurfaceSection;
  unscoped: HumanOperatorSurfaceSection;
  activeCount: number;
  displayedCount: number;
  pendingPageIncomplete: boolean;
}

const MISSION_STATUSES: readonly MissionStatus[] = ["planning", "active", "paused", "completed", "cancelled"];
const DECISION_STATUSES = ["pending", "resolved", "cancelled"] as const;
const DECISION_MODES = ["none", "issue_current_assignee"] as const;
const CONTINUATION_STATES = ["pending", "leased", "accepted", "blocked", "exhausted"] as const;
const EFFECTIVE_STATUSES = [
  "pending", "dispatching", "blocked", "exhausted", "queued", "deferred", "running", "coalesced",
  "completed", "skipped", "failed", "cancelled", "timed_out", "agent_unrunnable", "assignee_changed", "issue_terminal",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RequestDecision = NonNullable<HumanOperatorRequestStateV1["decision"]>;
type RequestContinuation = NonNullable<HumanOperatorRequestStateV1["continuation"]>;
type ParsedState = { value: HumanOperatorRequestStateV1 | null; problem: HumanOperatorRequestStateProblem | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableDate(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function isMissionStatus(value: unknown): value is MissionStatus {
  return typeof value === "string" && MISSION_STATUSES.includes(value as MissionStatus);
}

function lifecycleForStatus(status: MissionStatus): HumanOperatorLifecycle {
  if (status === "planning" || status === "active") return "active";
  if (status === "paused") return "paused";
  return "terminal";
}

function resolveMissionScope(
  companyId: string | null,
  missionId: string | null | undefined,
  reportedStatus?: unknown,
  missions?: readonly MissionListItem[],
): HumanOperatorScope {
  if (!missionId) return { lifecycle: "unscoped", missionStatus: null };
  if (!companyId || !missions) return { lifecycle: "unknown", missionStatus: null };
  const matches = missions.filter((mission) => mission.id === missionId);
  if (matches.length !== 1) return { lifecycle: "unknown", missionStatus: null };
  const mission = matches[0]!;
  if (mission.companyId !== companyId || !isMissionStatus(mission.status)) {
    return { lifecycle: "unknown", missionStatus: null };
  }
  if (reportedStatus !== undefined && reportedStatus !== mission.status) return { lifecycle: "unknown", missionStatus: null };
  return { lifecycle: lifecycleForStatus(mission.status), missionStatus: mission.status };
}

function isResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isString(value.actionId)
    && ["submit", "approve", "reject", "hold"].includes(String(value.outcome))
    && Array.isArray(value.selectedOptionIds) && value.selectedOptionIds.every(isString)
    && isNullableString(value.comment);
}

function isRequestDecision(value: unknown): value is RequestDecision {
  if (!isRecord(value)) return false;
  const result = value.result;
  const resultValid = result === null || isResult(result);
  return isString(value.id)
    && isString(value.requestKey)
    && isString(value.sourceId)
    && DECISION_STATUSES.includes(value.status as typeof DECISION_STATUSES[number])
    && resultValid
    && (value.status !== "resolved" || result !== null)
    && (value.status !== "pending" || result === null)
    && isNullableDate(value.resolvedAt)
    && isNullableDate(value.cancelledAt)
    && DECISION_MODES.includes(value.continuationMode as typeof DECISION_MODES[number]);
}

function isRequestContinuation(value: unknown): value is RequestContinuation {
  if (!isRecord(value)) return false;
  const count = (item: unknown, minimum = 0) => Number.isSafeInteger(item) && (item as number) >= minimum;
  return isString(value.id)
    && CONTINUATION_STATES.includes(value.state as typeof CONTINUATION_STATES[number])
    && count(value.generation, 1)
    && count(value.attemptCount)
    && count(value.maxAttempts, 1)
    && count(value.manualRetryCount)
    && count(value.maxManualRetries)
    && isNullableString(value.wakeupRequestId)
    && EFFECTIVE_STATUSES.includes(value.effectiveStatus as typeof EFFECTIVE_STATUSES[number])
    && isNullableString(value.errorCode)
    && isNullableString(value.retryHint);
}

function isRequestStateV1(value: unknown): value is HumanOperatorRequestStateV1 {
  if (!isRecord(value) || value.schemaVersion !== 1
    || !["exact", "missing", "ambiguous", "unsupported"].includes(String(value.identity))
    || !isString(value.decisionEventId) || !isString(value.ownerActionIssueId)
    || !(value.sourceIssueId === null || isString(value.sourceIssueId))
    || !isNullableString(value.reasonCode)
    || !(value.attention === null || typeof value.attention === "boolean")) return false;
  if (value.identity === "exact") {
    return isRequestDecision(value.decision)
      && value.decision.sourceId === value.decisionEventId
      && (value.continuation === null || isRequestContinuation(value.continuation));
  }
  return value.decision === null && value.continuation === null;
}

function isExactRequestKey(requestKey: string, eventId: string): boolean {
  return requestKey === `moi1:${eventId}` || /^moi2:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey);
}

function requestStateFor(request: MissionHumanOperatorRequest): ParsedState {
  const raw = (request as MissionHumanOperatorRequest & { requestState?: unknown }).requestState;
  if (raw === undefined || raw === null) return { value: null, problem: "legacy" };
  if (!isRequestStateV1(raw)) return { value: null, problem: "malformed" };
  const navigationIssues = [request.issueId, request.event?.scope?.issueId]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (navigationIssues.some((issueId) => issueId !== navigationIssues[0])
    || navigationIssues.some((issueId) => !UUID.test(issueId))) {
    return { value: null, problem: "scope-conflict" };
  }
  const navigationIssue = navigationIssues[0];
  if (navigationIssue && navigationIssue !== raw.ownerActionIssueId && navigationIssue !== raw.sourceIssueId) {
    return { value: null, problem: "scope-conflict" };
  }
  if (raw.identity === "exact") {
    if (!UUID.test(raw.decisionEventId) || !UUID.test(raw.ownerActionIssueId)
      || (raw.sourceIssueId !== null && !UUID.test(raw.sourceIssueId))
      || !UUID.test(raw.decision!.id)
      || !isExactRequestKey(raw.decision!.requestKey, raw.decisionEventId)) {
      return { value: null, problem: "malformed" };
    }
  }
  return { value: raw, problem: null };
}

function cardRunIds(decision: OperatorDecisionView): string[] | null {
  const sourceRunId: unknown = decision.sourceContext?.workflowRunId;
  const snapshotRunId: unknown = decision.sourceContext?.targetSnapshot?.workflowRunId;
  if ((sourceRunId !== null && sourceRunId !== undefined && typeof sourceRunId !== "string")
    || (snapshotRunId !== null && snapshotRunId !== undefined && typeof snapshotRunId !== "string")) return null;
  const values = [sourceRunId, snapshotRunId].filter((value): value is string => typeof value === "string" && value.length > 0);
  return values.some((runId) => runId !== values[0]) ? null : values;
}

function hasConsistentPendingCard(
  companyId: string,
  request: MissionHumanOperatorRequest,
  state: HumanOperatorRequestStateV1,
  card: OperatorDecisionView,
): boolean {
  const projected = state.decision;
  const snapshot = card.sourceContext?.targetSnapshot;
  if (!projected || projected.status !== "pending" || card.status !== "pending"
    || card.id !== projected.id || card.requestKey !== projected.requestKey
    || card.sourceType !== "mission_owner_human_input"
    || card.sourceId !== state.decisionEventId || card.sourceId !== projected.sourceId
    || card.companyId !== companyId || request.companyId !== companyId || request.event?.companyId !== companyId
    || !request.missionId || request.missionId !== request.event?.scope?.missionId
    || card.sourceContext?.missionId !== request.missionId
    || card.issueId !== state.ownerActionIssueId
    || (typeof snapshot?.issueId === "string" && snapshot.issueId !== state.ownerActionIssueId)
    || !isExactRequestKey(card.requestKey, state.decisionEventId)) return false;
  const requestRunId: unknown = request.event?.scope?.workflowRunId;
  if (requestRunId !== undefined && requestRunId !== null && typeof requestRunId !== "string") return false;
  const runs = cardRunIds(card);
  if (!runs || (typeof requestRunId === "string" && requestRunId.length > 0 && !runs.includes(requestRunId))) return false;
  return true;
}

function hasContradictoryCardScope(decision: OperatorDecisionView): boolean {
  const snapshotIssueId = decision.sourceContext?.targetSnapshot?.issueId;
  return Boolean(decision.issueId && snapshotIssueId && decision.issueId !== snapshotIssueId)
    || cardRunIds(decision) === null;
}

function sectionMap(): Record<HumanOperatorLifecycle, HumanOperatorSurfaceSection> {
  return {
    active: { cards: [], requests: [] },
    paused: { cards: [], requests: [] },
    terminal: { cards: [], requests: [] },
    unknown: { cards: [], requests: [] },
    unscoped: { cards: [], requests: [] },
  };
}

function requestCompanyMissionConsistent(companyId: string | null, request: MissionHumanOperatorRequest): boolean {
  return !!companyId && request.companyId === companyId && request.event?.companyId === companyId
    && !!request.missionId && request.missionId === request.event?.scope?.missionId;
}

/** Applies only the server's versioned, exact display projection; it grants no execution authority. */
export function selectHumanOperatorSurface(input: HumanOperatorSurfaceInput): HumanOperatorSurface {
  const sections = sectionMap();
  const parsedStates = new Map<MissionHumanOperatorRequest, ParsedState>();
  const exactRequestsByDecisionId = new Map<string, MissionHumanOperatorRequest[]>();
  const pendingByDecisionId = new Map<string, OperatorDecisionView[]>();
  for (const request of input.requests) {
    const parsed = requestStateFor(request);
    parsedStates.set(request, parsed);
    const decision = parsed.value?.identity === "exact" ? parsed.value.decision : null;
    if (decision) {
      const requests = exactRequestsByDecisionId.get(decision.id) ?? [];
      requests.push(request);
      exactRequestsByDecisionId.set(decision.id, requests);
    }
  }
  for (const decision of input.pendingDecisions) {
    const cards = pendingByDecisionId.get(decision.id) ?? [];
    cards.push(decision);
    pendingByDecisionId.set(decision.id, cards);
  }

  const cardsByRequest = new Map<MissionHumanOperatorRequest, OperatorDecisionView>();
  const stateProblems = new Map<MissionHumanOperatorRequest, HumanOperatorRequestStateProblem>();
  const boundCardIds = new Set<string>();
  const cardConflicts = new Set<OperatorDecisionView>();
  for (const [decisionId, requests] of exactRequestsByDecisionId) {
    if (requests.length !== 1) {
      for (const request of requests) stateProblems.set(request, "duplicate-decision");
      continue;
    }
    const request = requests[0]!;
    const state = parsedStates.get(request)?.value;
    if (!state || state.identity !== "exact" || state.decision?.status !== "pending") {
      const cards = pendingByDecisionId.get(decisionId) ?? [];
      if (cards.length > 0) stateProblems.set(request, "card-conflict");
      for (const card of cards) cardConflicts.add(card);
      continue;
    }
    const cards = pendingByDecisionId.get(decisionId) ?? [];
    if (cards.length === 0) continue;
    if (cards.length !== 1 || !hasConsistentPendingCard(input.companyId ?? "", request, state, cards[0]!)) {
      stateProblems.set(request, "card-conflict");
      for (const card of cards) cardConflicts.add(card);
      continue;
    }
    const card = cards[0]!;
    cardsByRequest.set(request, card);
    boundCardIds.add(card.id);
  }

  for (const decision of input.pendingDecisions) {
    if (boundCardIds.has(decision.id)) continue;
    const scope = !cardConflicts.has(decision)
      && decision.companyId === input.companyId
      && !hasContradictoryCardScope(decision)
      ? resolveMissionScope(input.companyId, decision.sourceContext?.missionId, undefined, input.missions)
      : { lifecycle: "unknown" as const, missionStatus: null };
    sections[scope.lifecycle].cards.push({ decision, scope });
  }

  for (const request of input.requests) {
    const parsed = parsedStates.get(request) ?? { value: null, problem: "legacy" as const };
    const requestStateProblem = stateProblems.get(request) ?? parsed.problem;
    const companyMissionConsistent = requestCompanyMissionConsistent(input.companyId, request);
    const scope = companyMissionConsistent
      ? resolveMissionScope(input.companyId, request.missionId, request.missionStatus, input.missions)
      : { lifecycle: "unknown" as const, missionStatus: null };
    sections[scope.lifecycle].requests.push({
      request,
      requestState: companyMissionConsistent && !stateProblems.has(request) ? parsed.value : null,
      requestStateProblem: !companyMissionConsistent ? "scope-conflict" : requestStateProblem,
      card: cardsByRequest.get(request) ?? null,
      scope,
    });
  }

  const displayedCount = Object.values(sections).reduce(
    (total, section) => total + section.cards.length + section.requests.length,
    0,
  );
  return {
    ...sections,
    activeCount: sections.active.cards.length + sections.active.requests.length,
    displayedCount,
    pendingPageIncomplete: input.pendingNextCursor != null,
  };
}
