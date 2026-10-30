import { describe, expect, it } from "vitest";
import type { MissionHumanOperatorRequest, MissionListItem, MissionStatus } from "../api/missions";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import { selectHumanOperatorSurface } from "./human-operator-surface";

const companyId = "company-1";
const issueId = "issue-1";
const missionId = "mission-1";
const timestamp = "2026-07-29T10:00:00.000Z";

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
  ownerIssueId = issueId,
  eventIssueId = ownerIssueId,
  missionStatus = "active" as MissionStatus,
  eventRunId,
}: {
  id?: string;
  eventId?: string | null;
  ownerCompanyId?: string;
  eventCompanyId?: string;
  ownerMissionId?: string;
  eventMissionId?: string;
  ownerIssueId?: string;
  eventIssueId?: string;
  missionStatus?: MissionStatus;
  eventRunId?: string;
} = {}): MissionHumanOperatorRequest {
  return {
    id, companyId: ownerCompanyId, missionId: ownerMissionId, missionTitle: "Mission", missionStatus,
    issueId: ownerIssueId, title: id, summary: "Operator request", timestamp,
    event: {
      id: `diagnostic-${id}`, companyId: eventCompanyId,
      scope: { missionId: eventMissionId, issueId: eventIssueId, ...(eventRunId ? { workflowRunId: eventRunId } : {}) },
      sourceRef: { type: "activity_log", id, table: "activity_log" }, eventType: "owner_diagnosis",
      title: "Human/operator input requested", summary: "Choose a direction", timestamp,
      ...(eventId ? { evidenceRefs: [{ type: "log", ref: eventId, label: "mission owner decision" }] } : {}),
    },
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
} = { ownerMissionId: missionId, ownerIssueId: issueId }): OperatorDecisionView {
  return {
    id, companyId: ownerCompanyId, schemaVersion: 1, requestKey, status: "pending", priority: "critical",
    interactionType: "single_select", title: id, description: "Choose a direction", sourceType, sourceId: eventId,
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
    createdAt: timestamp, updatedAt: timestamp, continuation: null,
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
  it("coalesces an exact moi2 event when company, mission, and owner anchor agree and diagnostic run is absent", () => {
    const surface = select({ requests: [makeRequest()], cards: [makeCard()] });
    expect(surface.active.requests[0]?.card?.id).toBe("card-1");
    expect(surface.active.cards).toHaveLength(0);
    expect(surface.displayedCount).toBe(1);
    expect(surface.active.requests[0]?.card?.status).toBe("pending");
  });

  it("keeps the legacy moi1 path bounded to its exact original event key", () => {
    const request = makeRequest();
    const exact = makeCard({ requestKey: "moi1:event-1" });
    expect(select({ requests: [request], cards: [exact] }).active.requests[0]?.card?.id).toBe("card-1");

    const wrongKey = makeCard({ requestKey: "moi1:other-event" });
    const surface = select({ requests: [request], cards: [wrongKey] });
    expect(surface.active.requests[0]?.card).toBeNull();
    expect(surface.active.cards.map(({ decision }) => decision.id)).toEqual(["card-1"]);
  });

  it("does not merge a different event even when issue and mission are the same", () => {
    const surface = select({ requests: [makeRequest()], cards: [makeCard({ eventId: "event-2" })] });
    expect(surface.active.requests[0]?.card).toBeNull();
    expect(surface.active.cards.map(({ decision }) => decision.sourceId)).toEqual(["event-2"]);
    expect(surface.activeCount).toBe(2);
    expect(surface.unknown.requests).toHaveLength(0);
    expect(surface.unknown.cards).toHaveLength(0);

    const sameIssueDifferentMission = select({
      missions: [makeMission("active"), makeMission("active", "mission-2")],
      requests: [makeRequest()],
      cards: [makeCard({ eventId: "event-2", ownerMissionId: "mission-2" })],
    });
    expect(sameIssueDifferentMission.activeCount).toBe(2);
    expect(sameIssueDifferentMission.unknown.requests).toHaveLength(0);
    expect(sameIssueDifferentMission.unknown.cards).toHaveLength(0);
  });

  it("keeps exact same-event mission identity conflicts unbound and unknown", () => {
    const surface = select({
      missions: [makeMission("active"), makeMission("active", "mission-2")],
      requests: [makeRequest()],
      cards: [makeCard({ ownerMissionId: "mission-2" })],
    });

    expect(surface.activeCount).toBe(0);
    expect(surface.unknown.requests.map(({ request }) => request.id)).toEqual(["request-1"]);
    expect(surface.unknown.requests[0]?.card).toBeNull();
    expect(surface.unknown.cards.map(({ decision }) => decision.id)).toEqual(["card-1"]);
    expect(surface.displayedCount).toBe(2);
  });

  it("leaves repeated diagnostics and one-to-many card matches ambiguous", () => {
    const repeated = select({
      requests: [makeRequest({ id: "request-1" }), makeRequest({ id: "request-2" })], cards: [makeCard()],
    });
    expect(repeated.active.requests.map(({ card }) => card)).toEqual([null, null]);
    expect(repeated.active.cards).toHaveLength(1);

    const duplicated = select({ requests: [makeRequest()], cards: [makeCard(), makeCard({ id: "card-2" })] });
    expect(duplicated.active.requests[0]?.card).toBeNull();
    expect(duplicated.active.cards).toHaveLength(2);
  });

  it("keeps same-issue QA and different-event human cards separate", () => {
    const qaCard = makeCard({ id: "qa-card", sourceType: "qa_rework" });
    const humanCard = makeCard({ id: "other-human-card", eventId: "event-2" });
    const surface = select({ requests: [makeRequest()], cards: [qaCard, humanCard] });
    expect(surface.active.requests[0]?.card).toBeNull();
    expect(surface.active.cards.map(({ decision }) => decision.id)).toEqual(["qa-card", "other-human-card"]);
  });

  it("keeps cross-company and unselected-company work out of the active count", () => {
    const otherCompany = "company-2";
    const crossCompany = select({
      missions: [makeMission("active"), makeMission("active", "mission-2", otherCompany)],
      requests: [makeRequest({ ownerCompanyId: otherCompany, eventCompanyId: otherCompany, ownerMissionId: "mission-2", eventMissionId: "mission-2" })],
      cards: [makeCard({ ownerCompanyId: otherCompany, ownerMissionId: "mission-2" })],
    });
    expect(crossCompany.activeCount).toBe(0);
    expect(crossCompany.unknown.requests).toHaveLength(1);
    expect(crossCompany.unknown.cards).toHaveLength(1);

    const unselected = select({ selectedCompanyId: null, requests: [makeRequest()], cards: [makeCard()] });
    expect(unselected.activeCount).toBe(0);
    expect(unselected.unknown.requests).toHaveLength(1);
    expect(unselected.unknown.cards).toHaveLength(1);
  });

  it("does not bind when a diagnostic publishes a different workflow run", () => {
    const surface = select({ requests: [makeRequest({ eventRunId: "run-2" })], cards: [makeCard()] });
    expect(surface.active.requests[0]?.card).toBeNull();
    expect(surface.activeCount).toBe(2);
  });

  it("shows self-contradictory snapshot anchors and runs as unknown instead of active", () => {
    const anchorConflict = select({
      requests: [makeRequest()], cards: [makeCard({ snapshotIssueId: "issue-2" })],
    });
    expect(anchorConflict.active.requests[0]?.card).toBeNull();
    expect(anchorConflict.unknown.cards.map(({ decision }) => decision.id)).toEqual(["card-1"]);

    const runConflict = select({
      requests: [makeRequest()], cards: [makeCard({ runId: "run-1", snapshotRunId: "run-2" })],
    });
    expect(runConflict.active.requests[0]?.card).toBeNull();
    expect(runConflict.unknown.cards.map(({ decision }) => decision.id)).toEqual(["card-1"]);
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
    const surface = select({ requests: [makeRequest()], cards: [makeCard({ eventId: "different-event" })], pendingNextCursor: "next-page" });
    expect(surface.pendingPageIncomplete).toBe(true);
    expect(surface.displayedCount).toBe(2);
    expect(surface.activeCount).toBe(2);
  });
});
