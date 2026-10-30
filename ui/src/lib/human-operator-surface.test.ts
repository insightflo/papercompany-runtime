import { describe, expect, it } from "vitest";
import type { HumanOperatorRequestStateV1 } from "@paperclipai/shared/types/human-operator-request-state";
import type { MissionHumanOperatorRequest, MissionListItem, MissionStatus } from "../api/missions";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import { selectHumanOperatorSurface } from "./human-operator-surface";

const companyId = "company-1";
const issueId = "issue-1";
const missionId = "mission-1";
const timestamp = "2026-07-29T10:00:00.000Z";
const EVENT_ONE = "00000000-0000-4000-8000-000000000001";
const EVENT_TWO = "00000000-0000-4000-8000-000000000002";
const DECISION_ONE = "00000000-0000-4000-8000-000000000011";
const DECISION_TWO = "00000000-0000-4000-8000-000000000012";
const OWNER_ISSUE = "00000000-0000-4000-8000-000000000021";
const SOURCE_ISSUE = "00000000-0000-4000-8000-000000000022";
const MOI2_REQUEST_UUID = "00000000-0000-4000-8000-000000000031";

function exactRequestState({
  eventId = EVENT_ONE,
  decisionId = DECISION_ONE,
  ownerIssueId = OWNER_ISSUE,
  sourceIssueId = SOURCE_ISSUE,
  requestKey = `moi2:${MOI2_REQUEST_UUID}`,
}: {
  eventId?: string;
  decisionId?: string;
  ownerIssueId?: string;
  sourceIssueId?: string | null;
  requestKey?: string;
} = {}): HumanOperatorRequestStateV1 {
  return {
    schemaVersion: 1, identity: "exact", reasonCode: null,
    decisionEventId: eventId, ownerActionIssueId: ownerIssueId, sourceIssueId,
    decision: {
      id: decisionId, requestKey, sourceId: eventId, status: "pending", result: null,
      resolvedAt: null, cancelledAt: null, continuationMode: "none",
    },
    continuation: null, attention: false,
  };
}

function nonExactRequestState(
  identity: "missing" | "ambiguous" | "unsupported",
  eventId = EVENT_ONE,
): HumanOperatorRequestStateV1 {
  return {
    schemaVersion: 1, identity, reasonCode: `${identity}_request`, decisionEventId: eventId,
    ownerActionIssueId: OWNER_ISSUE, sourceIssueId: SOURCE_ISSUE,
    decision: null, continuation: null, attention: null,
  };
}

function makeMission(status: MissionStatus, id = missionId, ownerCompanyId = companyId): MissionListItem {
  const now = new Date(timestamp);
  return { id, companyId: ownerCompanyId, ownerAgentId: "owner-1", title: id, description: null,
    status, goalId: null, startedAt: null, completedAt: null, createdAt: now, updatedAt: now };
}

function makeRequest({
  id = "request-1",
  eventId = "event-1",
  ownerCompanyId = companyId,
  eventCompanyId = ownerCompanyId,
  ownerMissionId = missionId,
  eventMissionId = ownerMissionId,
  sourceIssueId = SOURCE_ISSUE,
  eventIssueId = sourceIssueId,
  missionStatus = "active" as MissionStatus,
  eventRunId,
  evidenceEventId = eventId,
  requestState,
}: {
  id?: string;
  eventId?: string | null;
  ownerCompanyId?: string;
  eventCompanyId?: string;
  ownerMissionId?: string;
  eventMissionId?: string;
  sourceIssueId?: string;
  eventIssueId?: string;
  missionStatus?: MissionStatus;
  eventRunId?: string;
  evidenceEventId?: string | null;
  requestState?: HumanOperatorRequestStateV1;
} = {}): MissionHumanOperatorRequest {
  return {
    id, companyId: ownerCompanyId, missionId: ownerMissionId, missionTitle: "Mission", missionStatus,
    issueId: sourceIssueId, title: id, summary: "Operator request", timestamp,
    event: {
      id: `diagnostic-${id}`, companyId: eventCompanyId,
      scope: { missionId: eventMissionId, issueId: eventIssueId, ...(eventRunId ? { workflowRunId: eventRunId } : {}) },
      sourceRef: { type: "activity_log", id, table: "activity_log" }, eventType: "owner_diagnosis",
      title: "Human/operator input requested", summary: "Choose a direction", timestamp,
      ...(evidenceEventId ? { evidenceRefs: [{ type: "log", ref: evidenceEventId, label: "mission owner decision" }] } : {}),
    },
    ...(requestState ? { requestState } : {}),
  };
}

function makeCard({
  id = "card-1",
  eventId = "event-1",
  requestKey = "moi2:00000000-0000-4000-8000-000000000001",
  ownerCompanyId = companyId,
  ownerMissionId = missionId,
  ownerIssueId = issueId,
  snapshotIssueId = ownerIssueId,
  runId = "run-1",
  snapshotRunId = runId,
  sourceType = "mission_owner_human_input",
  title = id,
  description = "Choose a direction",
  createdAt = timestamp,
}: {
  id?: string;
  eventId?: string;
  requestKey?: string;
  ownerCompanyId?: string;
  ownerMissionId?: string | null;
  ownerIssueId?: string | null;
  snapshotIssueId?: string | null;
  runId?: string | null;
  snapshotRunId?: string | null;
  sourceType?: string;
  title?: string;
  description?: string;
  createdAt?: string;
} = { ownerMissionId: missionId, ownerIssueId: issueId }): OperatorDecisionView {
  return {
    id, companyId: ownerCompanyId, schemaVersion: 1, requestKey, status: "pending", priority: "critical",
    interactionType: "single_select", title, description, sourceType, sourceId: eventId,
    sourceContext: {
      missionId: ownerMissionId, workflowId: null, workflowRunId: runId, artifactRefs: [],
      targetSnapshot: { issueId: snapshotIssueId, workflowRunId: snapshotRunId },
    },
    definition: {
      options: [], actions: [], selection: null,
      comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
      approvedScope: [], forbiddenScope: [],
    },
    result: null, issueId: ownerIssueId, issueIdentifier: null, issueTitle: null, missionTitle: null,
    continuationMode: "none", requestedBy: null, resolvedByUserId: null, resolvedAt: null, cancelledAt: null,
    createdAt, updatedAt: timestamp, continuation: null,
  };
}

function select({
  selectedCompanyId = companyId,
  missions = [makeMission("active")],
  requests = [],
  cards = [],
  pendingNextCursor = null,
}: {
  selectedCompanyId?: string | null;
  missions?: readonly MissionListItem[];
  requests?: readonly MissionHumanOperatorRequest[];
  cards?: readonly OperatorDecisionView[];
  pendingNextCursor?: string | null;
} = {}) {
  return selectHumanOperatorSurface({
    companyId: selectedCompanyId, missions, requests, pendingDecisions: cards, pendingNextCursor,
  });
}

describe("selectHumanOperatorSurface", () => {
  it("binds an exact moi2 event and decision while keeping owner separate from source navigation", () => {
    const request = makeRequest({
      eventId: EVENT_ONE, sourceIssueId: OWNER_ISSUE, eventIssueId: OWNER_ISSUE,
      requestState: exactRequestState({ eventId: EVENT_ONE, decisionId: DECISION_ONE }),
    });
    const card = makeCard({
      id: DECISION_ONE, eventId: EVENT_ONE, requestKey: `moi2:${MOI2_REQUEST_UUID}`, ownerIssueId: OWNER_ISSUE,
    });
    const surface = select({ requests: [request], cards: [card] });
    const item = surface.active.requests[0];
    expect(item?.card?.id).toBe(DECISION_ONE);
    expect(item?.requestState?.decisionEventId).toBe(EVENT_ONE);
    expect(item?.requestState?.ownerActionIssueId).toBe(OWNER_ISSUE);
    expect(item?.requestState?.sourceIssueId).toBe(SOURCE_ISSUE);
    expect(request.issueId).toBe(OWNER_ISSUE);
    expect(card.issueId).toBe(OWNER_ISSUE);
    expect(surface.active.cards).toHaveLength(0);
    expect(surface.displayedCount).toBe(1);
    expect(item?.card?.status).toBe("pending");
  });

  it("binds moi1 only for the exact immutable event key", () => {
    const request = makeRequest({
      eventId: EVENT_TWO, sourceIssueId: SOURCE_ISSUE, eventIssueId: SOURCE_ISSUE,
      requestState: exactRequestState({
        eventId: EVENT_TWO, decisionId: DECISION_TWO, requestKey: `moi1:${EVENT_TWO}`,
      }),
    });
    const exact = makeCard({
      id: DECISION_TWO, eventId: EVENT_TWO, requestKey: `moi1:${EVENT_TWO}`, ownerIssueId: OWNER_ISSUE,
    });
    expect(request.issueId).toBe(SOURCE_ISSUE);
    expect(select({ requests: [request], cards: [exact] }).active.requests[0]?.card?.id).toBe(DECISION_TWO);

    const wrongKey = makeCard({
      id: DECISION_TWO, eventId: EVENT_TWO, requestKey: `moi1:${EVENT_ONE}`, ownerIssueId: OWNER_ISSUE,
    });
    const surface = select({ requests: [request], cards: [wrongKey] });
    expect(surface.active.requests[0]?.card).toBeNull();
    expect(surface.active.requests[0]?.requestStateProblem).toBe("card-conflict");
    expect(surface.unknown.cards.map(({ decision }) => decision.id)).toEqual([DECISION_TWO]);
    expect(surface.displayedCount).toBe(2);

    const wrongDecisionId = makeCard({
      id: DECISION_ONE, eventId: EVENT_TWO, requestKey: `moi1:${EVENT_TWO}`, ownerIssueId: OWNER_ISSUE,
    });
    const differentId = select({ requests: [request], cards: [wrongDecisionId] });
    expect(differentId.active.requests[0]?.requestState?.decision?.id).toBe(DECISION_TWO);
    expect(differentId.active.requests[0]?.card).toBeNull();
    expect(differentId.active.cards.map(({ decision }) => decision.id)).toEqual([DECISION_ONE]);
  });

  it("keeps a later request independent from an older event and its evidence reference", () => {
    const request = makeRequest({
      id: "later-request", eventId: EVENT_TWO, evidenceEventId: EVENT_ONE,
      sourceIssueId: SOURCE_ISSUE, eventIssueId: SOURCE_ISSUE,
      requestState: exactRequestState({ eventId: EVENT_TWO, decisionId: DECISION_TWO }),
    });
    const olderCard = makeCard({
      id: DECISION_ONE, eventId: EVENT_ONE, ownerIssueId: OWNER_ISSUE,
    });
    const surface = select({ requests: [request], cards: [olderCard] });
    expect(surface.active.requests[0]?.card).toBeNull();
    expect(surface.active.requests[0]?.requestState?.decisionEventId).toBe(EVENT_TWO);
    expect(surface.active.cards.map(({ decision }) => decision.sourceId)).toEqual([EVENT_ONE]);
    expect(surface.activeCount).toBe(2);
    expect(surface.displayedCount).toBe(2);
  });

  it("does not adopt an exact event card from another owner issue or mission", () => {
    const request = makeRequest({
      eventId: EVENT_ONE, sourceIssueId: SOURCE_ISSUE, eventIssueId: SOURCE_ISSUE,
      requestState: exactRequestState({ eventId: EVENT_ONE, decisionId: DECISION_ONE }),
    });
    const wrongOwner = select({
      requests: [request], cards: [makeCard({ id: DECISION_ONE, eventId: EVENT_ONE, ownerIssueId: "other-owner" })],
    });
    expect(wrongOwner.active.requests[0]?.card).toBeNull();
    expect(wrongOwner.active.requests[0]?.requestStateProblem).toBe("card-conflict");
    expect(wrongOwner.unknown.cards.map(({ decision }) => decision.id)).toEqual([DECISION_ONE]);

    const wrongMission = select({
      missions: [makeMission("active"), makeMission("active", "mission-2")], requests: [request],
      cards: [makeCard({ id: DECISION_ONE, eventId: EVENT_ONE, ownerIssueId: OWNER_ISSUE, ownerMissionId: "mission-2" })],
    });
    expect(wrongMission.active.requests[0]?.requestState).toBeNull();
    expect(wrongMission.active.requests[0]?.requestStateProblem).toBe("card-conflict");
    expect(wrongMission.unknown.cards.map(({ decision }) => decision.id)).toEqual([DECISION_ONE]);
    expect(wrongMission.displayedCount).toBe(2);
  });

  it("keeps duplicate exact requests and multiple same-id cards visible without choosing one", () => {
    const state = exactRequestState({ eventId: EVENT_ONE, decisionId: DECISION_ONE });
    const repeated = select({
      requests: [makeRequest({ id: "request-1", requestState: state }), makeRequest({ id: "request-2", requestState: state })],
      cards: [makeCard({ id: DECISION_ONE, eventId: EVENT_ONE, ownerIssueId: OWNER_ISSUE })],
    });
    expect(repeated.active.requests.map(({ card, requestState, requestStateProblem }) => [card, requestState, requestStateProblem]))
      .toEqual([[null, null, "duplicate-decision"], [null, null, "duplicate-decision"]]);
    expect(repeated.active.cards.map(({ decision }) => decision.id)).toEqual([DECISION_ONE]);
    expect(repeated.displayedCount).toBe(3);

    const duplicated = select({
      requests: [makeRequest({ requestState: state })],
      cards: [
        makeCard({ id: DECISION_ONE, eventId: EVENT_ONE, ownerIssueId: OWNER_ISSUE }),
        makeCard({ id: DECISION_ONE, eventId: EVENT_ONE, ownerIssueId: OWNER_ISSUE }),
      ],
    });
    expect(duplicated.active.requests[0]?.card).toBeNull();
    expect(duplicated.active.requests[0]?.requestStateProblem).toBe("card-conflict");
    expect(duplicated.unknown.cards.map(({ decision }) => decision.id)).toEqual([DECISION_ONE, DECISION_ONE]);
    expect(duplicated.displayedCount).toBe(3);
  });

  it("keeps QA-source and different-event human cards separate from an exact owner request", () => {
    const request = makeRequest({
      eventId: EVENT_ONE, requestState: exactRequestState({ eventId: EVENT_ONE, decisionId: DECISION_ONE }),
    });
    const qaCard = makeCard({ id: DECISION_ONE, eventId: EVENT_ONE, ownerIssueId: OWNER_ISSUE, sourceType: "qa_rework" });
    const humanCard = makeCard({ id: DECISION_TWO, eventId: EVENT_TWO });
    const surface = select({ requests: [request], cards: [qaCard, humanCard] });
    expect(surface.active.requests[0]?.card).toBeNull();
    expect(surface.active.requests[0]?.requestStateProblem).toBe("card-conflict");
    expect(surface.active.cards.map(({ decision }) => decision.id)).toEqual([DECISION_TWO]);
    expect(surface.unknown.cards.map(({ decision }) => decision.id)).toEqual([DECISION_ONE]);
    expect(surface.displayedCount).toBe(3);
  });

  it("keeps cross-company and unselected-company work out of the active count", () => {
    const otherCompany = "company-2";
    const crossCompany = select({
      missions: [makeMission("active"), makeMission("active", "mission-2", otherCompany)],
      requests: [makeRequest({
        ownerCompanyId: otherCompany, eventCompanyId: otherCompany, ownerMissionId: "mission-2", eventMissionId: "mission-2",
        requestState: exactRequestState({ eventId: EVENT_ONE, decisionId: DECISION_ONE }),
      })],
      cards: [makeCard({
        id: DECISION_ONE, eventId: EVENT_ONE, ownerCompanyId: otherCompany, ownerMissionId: "mission-2", ownerIssueId: OWNER_ISSUE,
      })],
    });
    expect(crossCompany.activeCount).toBe(0);
    expect(crossCompany.unknown.requests).toHaveLength(1);
    expect(crossCompany.unknown.cards).toHaveLength(1);
    expect(crossCompany.displayedCount).toBe(2);

    const unselected = select({
      selectedCompanyId: null,
      requests: [makeRequest({ requestState: exactRequestState({ eventId: EVENT_ONE, decisionId: DECISION_ONE }) })],
      cards: [makeCard({ id: DECISION_ONE, eventId: EVENT_ONE, ownerIssueId: OWNER_ISSUE })],
    });
    expect(unselected.activeCount).toBe(0);
    expect(unselected.unknown.requests).toHaveLength(1);
    expect(unselected.unknown.cards).toHaveLength(1);
    expect(unselected.displayedCount).toBe(2);
  });

  it("does not bind when a diagnostic publishes a different workflow run", () => {
    const surface = select({
      requests: [makeRequest({
        eventRunId: "run-2", requestState: exactRequestState({ eventId: EVENT_ONE, decisionId: DECISION_ONE }),
      })],
      cards: [makeCard({ id: DECISION_ONE, eventId: EVENT_ONE, ownerIssueId: OWNER_ISSUE, runId: "run-1", snapshotRunId: "run-1" })],
    });
    expect(surface.active.requests[0]?.card).toBeNull();
    expect(surface.active.requests[0]?.requestStateProblem).toBe("card-conflict");
    expect(surface.unknown.cards.map(({ decision }) => decision.id)).toEqual([DECISION_ONE]);
    expect(surface.activeCount).toBe(1);
    expect(surface.displayedCount).toBe(2);
  });

  it("shows self-contradictory snapshot anchors and runs as unknown instead of active", () => {
    const anchorConflict = select({
      requests: [makeRequest({ requestState: exactRequestState({ eventId: EVENT_ONE, decisionId: DECISION_ONE }) })],
      cards: [makeCard({ id: DECISION_ONE, eventId: EVENT_ONE, ownerIssueId: OWNER_ISSUE, snapshotIssueId: "issue-2" })],
    });
    expect(anchorConflict.active.requests[0]?.card).toBeNull();
    expect(anchorConflict.active.requests[0]?.requestStateProblem).toBe("card-conflict");
    expect(anchorConflict.unknown.cards.map(({ decision }) => decision.id)).toEqual([DECISION_ONE]);

    const runConflict = select({
      requests: [makeRequest({ requestState: exactRequestState({ eventId: EVENT_ONE, decisionId: DECISION_ONE }) })],
      cards: [makeCard({ id: DECISION_ONE, eventId: EVENT_ONE, ownerIssueId: OWNER_ISSUE, runId: "run-1", snapshotRunId: "run-2" })],
    });
    expect(runConflict.active.requests[0]?.card).toBeNull();
    expect(runConflict.active.requests[0]?.requestStateProblem).toBe("card-conflict");
    expect(runConflict.unknown.cards.map(({ decision }) => decision.id)).toEqual([DECISION_ONE]);
  });

  it("keeps old-server, missing, malformed, ambiguous, and unsupported request states visible", () => {
    const malformed = {
      ...nonExactRequestState("missing", EVENT_ONE), schemaVersion: 2,
    } as unknown as HumanOperatorRequestStateV1;
    const requests = [
      makeRequest({ id: "legacy" }),
      makeRequest({ id: "missing", requestState: nonExactRequestState("missing", EVENT_ONE) }),
      makeRequest({ id: "ambiguous", requestState: nonExactRequestState("ambiguous", EVENT_TWO) }),
      makeRequest({ id: "unsupported", requestState: nonExactRequestState("unsupported", EVENT_ONE) }),
      makeRequest({ id: "malformed", requestState: malformed }),
    ];
    const surface = select({ requests });
    const rows = new Map(surface.active.requests.map((item) => [item.request.id, item]));

    expect([...rows.keys()]).toEqual(["legacy", "missing", "ambiguous", "unsupported", "malformed"]);
    expect(rows.get("legacy")?.requestStateProblem).toBe("legacy");
    expect(rows.get("missing")?.requestState?.identity).toBe("missing");
    expect(rows.get("ambiguous")?.requestState?.identity).toBe("ambiguous");
    expect(rows.get("unsupported")?.requestState).toMatchObject({ identity: "unsupported", attention: null });
    expect(rows.get("malformed")?.requestState).toBeNull();
    expect(rows.get("malformed")?.requestStateProblem).toBe("malformed");
    expect(surface.activeCount).toBe(5);
    expect(surface.displayedCount).toBe(5);
  });

  it("does not join a legacy row by matching evidence, title, prose, or newer card order", () => {
    const request = makeRequest({ id: "legacy-row", eventId: EVENT_ONE, evidenceEventId: EVENT_ONE });
    const cards = [
      makeCard({ id: "newer-looking", eventId: EVENT_ONE, title: request.title, description: request.event!.summary,
        createdAt: "2026-07-30T10:00:00.000Z" }),
      makeCard({ id: "older-looking", eventId: EVENT_ONE, title: request.title, description: request.summary,
        createdAt: "2026-07-28T10:00:00.000Z" }),
    ];
    const surface = select({ requests: [request], cards });

    expect(surface.active.requests[0]?.requestStateProblem).toBe("legacy");
    expect(surface.active.requests[0]?.card).toBeNull();
    expect(surface.active.cards.map(({ decision }) => decision.id)).toEqual(["newer-looking", "older-looking"]);
    expect(surface.displayedCount).toBe(3);
  });

  it("marks reported-status conflicts and missing mission records unknown", () => {
    const statusConflict = makeRequest({ id: "status-conflict", missionStatus: "active" });
    const missingMission = makeRequest({ id: "missing-mission", ownerMissionId: "missing" });
    const surface = select({
      missions: [makeMission("paused")], requests: [statusConflict, missingMission],
    });
    expect(surface.unknown.requests.map(({ request }) => request.id)).toEqual(["status-conflict", "missing-mission"]);
    expect(surface.activeCount).toBe(0);
  });

  it("separates active/planning, paused, and completed/cancelled mission lifecycles", () => {
    const statuses: MissionStatus[] = ["planning", "active", "paused", "completed", "cancelled"];
    const missions = statuses.map((status, index) => makeMission(status, `mission-${index}`));
    const requests = statuses.map((status, index) => makeRequest({
      id: status, eventId: null, ownerMissionId: `mission-${index}`, eventMissionId: `mission-${index}`, missionStatus: status,
    }));
    const surface = select({ missions, requests });
    expect(surface.active.requests.map(({ request }) => request.missionStatus)).toEqual(["planning", "active"]);
    expect(surface.paused.requests.map(({ request }) => request.missionStatus)).toEqual(["paused"]);
    expect(surface.terminal.requests.map(({ request }) => request.missionStatus)).toEqual(["completed", "cancelled"]);
    expect(surface.activeCount).toBe(2);
    expect(surface.displayedCount).toBe(5);
  });

  it("retains a genuinely unscoped card in the unscoped section", () => {
    const card = makeCard({
      sourceType: "system", requestKey: "system:unscoped", eventId: "system-event",
      ownerMissionId: null, ownerIssueId: null, snapshotIssueId: null, runId: null, snapshotRunId: null,
    });
    const surface = select({ cards: [card] });
    expect(surface.unscoped.cards.map(({ decision }) => decision.id)).toEqual(["card-1"]);
    expect(surface.displayedCount).toBe(1);
  });

  it("flags an incomplete pending page so its displayed count remains a lower bound", () => {
    const request = makeRequest({
      eventId: EVENT_TWO, requestState: exactRequestState({ eventId: EVENT_TWO, decisionId: DECISION_TWO }),
    });
    const notLoadedCard = makeCard({ id: DECISION_ONE, eventId: EVENT_ONE, ownerIssueId: OWNER_ISSUE });
    const surface = select({ requests: [request], cards: [notLoadedCard], pendingNextCursor: "next-page" });
    expect(surface.pendingPageIncomplete).toBe(true);
    expect(surface.active.requests[0]?.requestState?.identity).toBe("exact");
    expect(surface.active.requests[0]?.card).toBeNull();
    expect(surface.active.cards.map(({ decision }) => decision.id)).toEqual([DECISION_ONE]);
    expect(surface.displayedCount).toBe(2);
    expect(surface.activeCount).toBe(2);
  });
});
