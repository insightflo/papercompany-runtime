import type { MissionHumanOperatorRequest, MissionListItem, MissionStatus } from "../api/missions";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";

export type HumanOperatorLifecycle = "active" | "paused" | "terminal" | "unknown" | "unscoped";

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
  if (reportedStatus !== undefined && reportedStatus !== mission.status) {
    return { lifecycle: "unknown", missionStatus: null };
  }
  return { lifecycle: lifecycleForStatus(mission.status), missionStatus: mission.status };
}

function decisionEventId(request: MissionHumanOperatorRequest): string | null {
  const references = request.event?.evidenceRefs?.filter(
    (reference) => reference.type === "log" && reference.label === "mission owner decision",
  ) ?? [];
  if (references.length !== 1) return null;
  const id = references[0]?.ref;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function isOwnerHumanCard(decision: OperatorDecisionView): boolean {
  return decision.sourceType === "mission_owner_human_input"
    && (decision.requestKey.startsWith("moi1:") || decision.requestKey.startsWith("moi2:"));
}

function diagnosticAnchor(request: MissionHumanOperatorRequest): string | null {
  const values = [request.issueId, request.event?.scope?.issueId]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (values.length === 0 || values.some((value) => value !== values[0])) return null;
  return values[0]!;
}

function cardAnchor(decision: OperatorDecisionView): string | null {
  const snapshot = decision.sourceContext?.targetSnapshot;
  const values = [decision.issueId, snapshot?.issueId]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (values.length === 0 || values.some((value) => value !== values[0])) return null;
  return values[0]!;
}

function cardRunIds(decision: OperatorDecisionView): string[] | null {
  const values = [decision.sourceContext?.workflowRunId, decision.sourceContext?.targetSnapshot?.workflowRunId]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (values.some((value) => value !== values[0])) return null;
  return values;
}

function hasContradictoryCardScope(decision: OperatorDecisionView): boolean {
  const snapshotIssueId = decision.sourceContext?.targetSnapshot?.issueId;
  return Boolean(decision.issueId && snapshotIssueId && decision.issueId !== snapshotIssueId)
    || cardRunIds(decision) === null;
}

/** This exact-event relation is for display coalescence only; it grants no lifetime or runtime authority. */
function hasConsistentOwnerHumanIdentity(
  companyId: string,
  request: MissionHumanOperatorRequest,
  decision: OperatorDecisionView,
  eventId: string,
): boolean {
  if (!isOwnerHumanCard(decision)
    || decision.sourceId !== eventId
    || request.companyId !== companyId
    || request.event.companyId !== companyId
    || decision.companyId !== companyId
    || request.missionId !== request.event.scope.missionId
    || !request.missionId
    || decision.sourceContext.missionId !== request.missionId) return false;

  // Keep the old moi1 binding only when its full event key and original source ID both match.
  if (decision.requestKey.startsWith("moi1:") && decision.requestKey !== `moi1:${eventId}`) return false;

  const requestIssueId = diagnosticAnchor(request);
  const decisionIssueId = cardAnchor(decision);
  if (!requestIssueId || requestIssueId !== decisionIssueId) return false;

  const runs = cardRunIds(decision);
  if (!runs) return false;
  const diagnosticRunId = request.event.scope.workflowRunId;
  if (diagnosticRunId && runs.some((runId) => runId !== diagnosticRunId)) return false;
  return true;
}

function hasContradictoryPublishedMissionIdentity(
  companyId: string,
  request: MissionHumanOperatorRequest,
  decision: OperatorDecisionView,
  eventId: string,
): boolean {
  const requestMissionId = request.missionId;
  const decisionMissionId = decision.sourceContext.missionId;
  return isOwnerHumanCard(decision)
    && decision.sourceId === eventId
    && request.companyId === companyId
    && request.event.companyId === companyId
    && decision.companyId === companyId
    && requestMissionId === request.event.scope.missionId
    && Boolean(requestMissionId)
    && Boolean(decisionMissionId)
    && requestMissionId !== decisionMissionId
    && (!decision.requestKey.startsWith("moi1:") || decision.requestKey === `moi1:${eventId}`);
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

export function selectHumanOperatorSurface(input: HumanOperatorSurfaceInput): HumanOperatorSurface {
  const sections = sectionMap();
  const requestsByEventId = new Map<string, MissionHumanOperatorRequest[]>();
  const cardsByEventId = new Map<string, OperatorDecisionView[]>();

  if (input.companyId) {
    for (const request of input.requests) {
      const eventId = decisionEventId(request);
      if (!eventId || request.companyId !== input.companyId || request.event.companyId !== input.companyId) continue;
      const requests = requestsByEventId.get(eventId) ?? [];
      requests.push(request);
      requestsByEventId.set(eventId, requests);
    }
    for (const decision of input.pendingDecisions) {
      if (!isOwnerHumanCard(decision) || decision.companyId !== input.companyId) continue;
      const cards = cardsByEventId.get(decision.sourceId) ?? [];
      cards.push(decision);
      cardsByEventId.set(decision.sourceId, cards);
    }
  }

  const boundCards = new Map<string, OperatorDecisionView>();
  const boundCardIds = new Set<string>();
  const conflictingRequests = new Set<MissionHumanOperatorRequest>();
  const conflictingCards = new Set<OperatorDecisionView>();
  for (const [eventId, requests] of requestsByEventId) {
    const cards = cardsByEventId.get(eventId) ?? [];
    // Many-to-one matches stay as separate evidence; never pick a latest or first row.
    if (requests.length !== 1 || cards.length !== 1) continue;
    const request = requests[0]!;
    const card = cards[0]!;
    if (hasContradictoryPublishedMissionIdentity(input.companyId!, request, card, eventId)) {
      conflictingRequests.add(request);
      conflictingCards.add(card);
      continue;
    }
    if (!hasConsistentOwnerHumanIdentity(input.companyId!, request, card, eventId)) continue;
    boundCards.set(request.id, card);
    boundCardIds.add(card.id);
  }

  for (const decision of input.pendingDecisions) {
    if (boundCardIds.has(decision.id)) continue;
    const scope = !conflictingCards.has(decision)
      && decision.companyId === input.companyId
      && !hasContradictoryCardScope(decision)
      ? resolveMissionScope(input.companyId, decision.sourceContext?.missionId, undefined, input.missions)
      : { lifecycle: "unknown" as const, missionStatus: null };
    sections[scope.lifecycle].cards.push({ decision, scope });
  }

  for (const request of input.requests) {
    const companyConsistent = request.companyId === input.companyId
      && request.event.companyId === input.companyId
      && request.missionId === request.event.scope.missionId;
    const scope = !conflictingRequests.has(request) && companyConsistent
      ? resolveMissionScope(input.companyId, request.missionId, request.missionStatus, input.missions)
      : { lifecycle: "unknown" as const, missionStatus: null };
    sections[scope.lifecycle].requests.push({
      request,
      card: boundCards.get(request.id) ?? null,
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
