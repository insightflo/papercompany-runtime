/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HumanOperatorRequestStateV1, HumanOperatorRequestContinuationState } from "@paperclipai/shared/types/human-operator-request-state";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import type { MissionHumanOperatorRequest, MissionListItem, MissionStatus } from "../api/missions";
import { CompanyLanguageProvider } from "../lib/companyLanguage";
import { focusOperatorDecisionSuccessTarget, HumanOperator } from "./HumanOperator";

const { mockState, resolveSpy, invalidateSpy } = vi.hoisted(() => ({
  mockState: {
    pendingCards: [] as OperatorDecisionView[],
    requests: [] as MissionHumanOperatorRequest[],
    missions: [] as MissionListItem[],
    pendingNextCursor: null as string | null,
    requestsError: null as Error | null,
    pendingError: null as Error | null,
    missionsError: null as Error | null,
    refetchRequests: vi.fn(),
    refetchPending: vi.fn(),
    refetchMissions: vi.fn(),
  },
  resolveSpy: vi.fn().mockResolvedValue({ decision: {}, applied: true, continuation: null }),
  invalidateSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateSpy }),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "operator-decisions" && queryKey[2] === "pending") {
      return { data: { data: mockState.pendingCards, page: { nextCursor: mockState.pendingNextCursor } }, isLoading: false, isFetching: false, error: mockState.pendingError, refetch: mockState.refetchPending };
    }
    if (queryKey[0] === "missions" && queryKey[2] === "human-operator-requests") {
      return { data: mockState.requests, isLoading: false, isFetching: false, isStale: false, error: mockState.requestsError, refetch: mockState.refetchRequests };
    }
    if (queryKey[0] === "missions" && queryKey[1] === "company-1") {
      return { data: mockState.missions, isLoading: false, isFetching: false, isStale: false, error: mockState.missionsError, refetch: mockState.refetchMissions };
    }
    return { data: [], isLoading: false, isFetching: false, isStale: false, error: null, refetch: vi.fn() };
  },
}));
vi.mock("../api/operator-decisions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/operator-decisions")>();
  return { ...actual, operatorDecisionsApi: { ...actual.operatorDecisionsApi, resolve: resolveSpy } };
});
vi.mock("../context/CompanyContext", async (importOriginal) => ({ ...await importOriginal<typeof import("../context/CompanyContext")>(), useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../components/ExternalAutomationApprovals", () => ({ ExternalAutomationApprovals: () => <section>External automation approvals</section> }));
vi.mock("../lib/router", () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }));
vi.mock("../components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => <button onClick={onClick} disabled={disabled}>{children}</button>,
}));
vi.mock("../components/StatusBadge", () => ({ StatusBadge: ({ status }: { status: string }) => <span>{status}</span> }));
vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div>Loading</div> }));
vi.mock("../components/EmptyState", () => ({ EmptyState: ({ message }: { message: string }) => <div>{message}</div> }));

const companyId = "company-1";
const missionId = "mission-1";
const pausedMissionId = "mission-2";
const timestamp = "2026-07-29T10:00:00.000Z";
const id = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
const EVENT_PENDING = id(1);
const EVENT_RESOLVED = id(2);
const EVENT_EXHAUSTED = id(3);
const EVENT_MISSING = id(4);
const EVENT_BAD = id(5);
const EVENT_UNSUPPORTED = id(6);
const EVENT_AMBIGUOUS = id(7);
const OWNER_ISSUE = id(20);
const SOURCE_ISSUE = id(21);
const PENDING_CARD_ID = id(30);
const RESOLVED_CARD_ID = id(31);

function makeMission(idValue: string, status: MissionStatus): MissionListItem {
  const now = new Date(timestamp);
  return { id: idValue, companyId, ownerAgentId: "owner-1", title: "Mission", description: null, status, goalId: null,
    startedAt: null, completedAt: null, createdAt: now, updatedAt: now };
}

function continuation(overrides: Partial<HumanOperatorRequestContinuationState> = {}): HumanOperatorRequestContinuationState {
  return {
    id: id(40), state: "accepted", generation: 1, attemptCount: 0, maxAttempts: 3,
    manualRetryCount: 0, maxManualRetries: 2, wakeupRequestId: id(41), effectiveStatus: "deferred",
    errorCode: null, retryHint: null, ...overrides,
  };
}

function exactState(
  eventId: string,
  options: {
    decisionId?: string; requestKey?: string; ownerIssueId?: string; sourceIssueId?: string | null;
    status?: "pending" | "resolved" | "cancelled"; continuationMode?: "none" | "issue_current_assignee";
    continuation?: HumanOperatorRequestContinuationState | null; attention?: boolean | null;
  } = {},
): HumanOperatorRequestStateV1 {
  const status = options.status ?? "pending";
  return {
    schemaVersion: 1, identity: "exact", reasonCode: null, decisionEventId: eventId,
    ownerActionIssueId: options.ownerIssueId ?? OWNER_ISSUE,
    sourceIssueId: options.sourceIssueId === undefined ? SOURCE_ISSUE : options.sourceIssueId,
    decision: {
      id: options.decisionId ?? PENDING_CARD_ID,
      requestKey: options.requestKey ?? `moi1:${eventId}`,
      sourceId: eventId, status,
      result: status === "resolved" ? { actionId: "approve", outcome: "approve", selectedOptionIds: ["approve"], comment: "approved with evidence" } : null,
      resolvedAt: status === "resolved" ? timestamp : null,
      cancelledAt: status === "cancelled" ? timestamp : null,
      continuationMode: options.continuationMode ?? "issue_current_assignee",
    },
    continuation: options.continuation ?? null,
    attention: options.attention ?? (status === "pending" ? false : null),
  };
}

function identityState(eventId: string, identity: "missing" | "ambiguous" | "unsupported"): HumanOperatorRequestStateV1 {
  return {
    schemaVersion: 1, identity, reasonCode: identity === "missing" ? "exact_card_not_found" : `${identity}_card`,
    decisionEventId: eventId, ownerActionIssueId: OWNER_ISSUE, sourceIssueId: SOURCE_ISSUE,
    decision: null, continuation: null, attention: null,
  };
}

function makeRequest(
  requestId: string,
  state: HumanOperatorRequestStateV1 | null | undefined,
  options: { missionId?: string; missionStatus?: MissionStatus; navigationIssueId?: string } = {},
): MissionHumanOperatorRequest {
  const scopedMissionId = options.missionId ?? missionId;
  const navigationIssueId = options.navigationIssueId ?? state?.sourceIssueId ?? OWNER_ISSUE;
  return {
    id: `request-${requestId}`, companyId, missionId: scopedMissionId, missionTitle: "Mission",
    missionStatus: options.missionStatus ?? "active", issueId: navigationIssueId,
    title: `Mission request ${requestId}`, timestamp,
    summary: "무엇이: 미션 Mission\n운영자 할 일: assign the idle agent",
    ...(state ? { requestState: state } : {}),
    event: {
      id: `owner-diagnosis-${requestId}`, companyId,
      scope: { missionId: scopedMissionId, issueId: navigationIssueId },
      sourceRef: { type: "activity_log", id: requestId, table: "activity_log" },
      eventType: "owner_diagnosis", title: "Human/operator input requested", summary: "Direction is requested.", timestamp,
    },
  };
}

const legacyRequest = makeRequest("legacy", undefined);
const activeMission = makeMission(missionId, "active");
const pausedMission = makeMission(pausedMissionId, "paused");

const nonOwnerCard: OperatorDecisionView = {
  id: id(50), companyId, schemaVersion: 1, requestKey: "system:pending", status: "pending",
  priority: "critical", interactionType: "action", title: "Pending Interactive Card", description: "Act now",
  sourceType: "system", sourceId: "system-source",
  sourceContext: { missionId, workflowId: null, workflowRunId: null, artifactRefs: [] },
  definition: { options: [], actions: [{ id: "hold", label: "Hold", outcome: "hold", tone: "neutral", requiresSelection: false }],
    selection: null, comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 }, approvedScope: [], forbiddenScope: [] },
  result: null, issueId: null, issueIdentifier: null, issueTitle: null, missionTitle: null, continuationMode: "none", requestedBy: null,
  resolvedByUserId: null, resolvedAt: null, cancelledAt: null, createdAt: timestamp, updatedAt: timestamp, continuation: null,
};

function ownerPendingCard(eventId: string, decisionId: string, requestKey: string, scopedMissionId = missionId): OperatorDecisionView {
  return {
    ...nonOwnerCard, id: decisionId, requestKey, sourceType: "mission_owner_human_input", sourceId: eventId,
    title: "Owner asks for direction", description: "Choose the next step for the blocked mission.",
    companyId, issueId: OWNER_ISSUE, issueIdentifier: "OWNER-1", issueTitle: "Owner action issue", missionTitle: "Mission",
    interactionType: "single_select", continuationMode: "issue_current_assignee",
    sourceContext: { missionId: scopedMissionId, workflowId: null, workflowRunId: "run-1", artifactRefs: [],
      targetSnapshot: { issueId: OWNER_ISSUE, workflowRunId: "run-1" } },
    definition: {
      ...nonOwnerCard.definition,
      options: [
        { id: "approve", label: "Approve", description: "Proceed with requested next step", facts: [], evidenceRefs: [] },
        { id: "hold", label: "Hold", description: "Keep waiting", facts: [], evidenceRefs: [] },
        { id: "reject", label: "Reject", description: "Return the handoff", facts: [], evidenceRefs: [] },
      ],
      actions: [{ id: "approve", label: "Approve", outcome: "approve", tone: "primary", requiresSelection: true }],
      selection: { min: 1, max: 1 },
      comment: { mode: "required", label: "Reason", placeholder: null, maxLength: 100 },
      humanReview: {
        schemaVersion: "human-review-v1", decisionSubject: "Choose the next step for the blocked mission",
        evidence: [{ label: "Blocked issue", description: "The blocked source issue.", href: "/issues/source", location: "Issue > blocker" }],
        interpretation: "One direction must be chosen.", impact: { ifApproved: "The owner proceeds.", ifRejected: "The handoff returns.", ifWrong: "The wrong step runs." },
        unresolvedFacts: [], questions: [], recommendedNextStep: "Approve the requested next step.", requiredReviewer: "Human Operator",
      },
    },
  };
}

function setDefaultMocks() {
  mockState.pendingCards = [nonOwnerCard];
  mockState.requests = [legacyRequest];
  mockState.missions = [activeMission];
  mockState.pendingNextCursor = null;
  mockState.requestsError = null;
  mockState.pendingError = null;
  mockState.missionsError = null;
  mockState.refetchRequests.mockClear();
  mockState.refetchPending.mockClear();
  mockState.refetchMissions.mockClear();
}

function renderKo(ui: ReactNode) {
  return renderToStaticMarkup(<CompanyLanguageProvider language="ko">{ui}</CompanyLanguageProvider>);
}

let host: HTMLDivElement;
let root: Root;

describe("HumanOperator", () => {
  beforeEach(() => {
    setDefaultMocks();
    resolveSpy.mockClear();
    invalidateSpy.mockClear();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it("keeps pending cards, automation, and requests ordered with a bounded-window notice", () => {
    const html = renderToStaticMarkup(<HumanOperator />);
    expect(html.indexOf("Pending Interactive Card")).toBeLessThan(html.indexOf("External automation approvals"));
    expect(html.indexOf("External automation approvals")).toBeLessThan(html.indexOf("Mission request legacy"));
    expect(html).toContain("not a total or a count of all pending work");
    expect(html).toContain("Historical request evidence · not a current instruction");
    expect(html).not.toContain("Continuations needing attention");
  });

  it("keeps the old request summary visibly historical and preserves line breaks", () => {
    const html = renderKo(<HumanOperator />);
    expect(html).toContain("과거 요청 증거 · 현재 지시가 아닙니다");
    expect(html).toContain("whitespace-pre-line");
    expect(html).toContain("운영자 할 일: assign the idle agent");
    expect(html).toContain("이 서버 응답에 결정 상태가 없습니다");
  });

  it("counts only displayed rows and cards, and still labels an empty bounded window", () => {
    expect(renderToStaticMarkup(<HumanOperator />)).toContain("2 items displayed");
    mockState.pendingCards = []; mockState.requests = [];
    const empty = renderKo(<HumanOperator />);
    expect(empty).toContain("최근 요청 일부 표시이며 전체 요청 또는 전체 대기 수가 아닙니다");
    expect(empty).toContain("최근 요청 범위에 표시할 요청이 없습니다");
  });

  it("moves success focus to pending, attention, then the empty heading", () => {
    document.body.innerHTML = '<h2 data-operator-decision-heading tabindex="-1">Pending</h2><h2 data-operator-decision-attention-heading tabindex="-1">Attention</h2><h2 data-human-operator-empty-heading tabindex="-1">Empty</h2>';
    focusOperatorDecisionSuccessTarget(); expect(document.activeElement?.textContent).toBe("Pending");
    document.querySelector("[data-operator-decision-heading]")?.remove();
    focusOperatorDecisionSuccessTarget(); expect(document.activeElement?.textContent).toBe("Attention");
    document.querySelector("[data-operator-decision-attention-heading]")?.remove();
    focusOperatorDecisionSuccessTarget(); expect(document.activeElement?.textContent).toBe("Empty");
  });

  it("renders only the exact pending card once and keeps the paused mission paused after one resolve", async () => {
    const pausedState = exactState(EVENT_PENDING, { decisionId: PENDING_CARD_ID });
    mockState.missions = [activeMission, pausedMission];
    mockState.requests = [makeRequest("paused", pausedState, { missionId: pausedMissionId, missionStatus: "paused" })];
    const moiCard = ownerPendingCard(EVENT_PENDING, PENDING_CARD_ID, `moi1:${EVENT_PENDING}`, pausedMissionId);
    mockState.pendingCards = [nonOwnerCard, moiCard];
    await act(async () => root.render(<CompanyLanguageProvider language="ko"><HumanOperator /></CompanyLanguageProvider>));
    const row = host.querySelector('li[data-human-operator-lifecycle="paused"]')!;
    expect(row.textContent).toContain("방향 선택 대기");
    expect(row.querySelector("[data-operator-decision-heading]")?.textContent).toBe("Choose the next step for the blocked mission");
    expect(row.querySelector("[data-owner-action-issue-id]")?.textContent).toBe(OWNER_ISSUE);
    expect(row.querySelector("[data-source-issue-id]")?.textContent).toBe(SOURCE_ISSUE);
    expect(host.textContent?.split("Owner asks for direction").length - 1).toBe(1);
    expect(row.querySelector("a[href]")?.getAttribute("href")).toBe(`/missions/${pausedMissionId}?issue=${SOURCE_ISSUE}`);

    resolveSpy.mockClear(); invalidateSpy.mockClear();
    act(() => (host.querySelector('[data-operator-decision-option="approve"]') as HTMLElement).click());
    const comment = host.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(comment, "proceed"); comment.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => ([...host.querySelectorAll("button")].find((button) => button.textContent === "Approve") as HTMLElement).click());
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith(PENDING_CARD_ID, { actionId: "approve", selectedOptionIds: ["approve"], comment: "proceed" });
    expect(pausedMission.status).toBe("paused");
    expect(row.closest("section")?.textContent).toContain("방향을 선택해도 미션이 자동으로 재개되지는 않습니다");
  });

  it("shows resolved selected results and deferred continuation separately from source navigation", () => {
    const state = exactState(EVENT_RESOLVED, {
      decisionId: RESOLVED_CARD_ID, status: "resolved",
      continuation: continuation({ state: "accepted", effectiveStatus: "deferred", attemptCount: 1 }),
    });
    mockState.requests = [makeRequest("resolved", state)];
    const html = renderKo(<HumanOperator />);
    expect(html).toContain("방향 결정됨");
    expect(html).toContain("approve · approve");
    expect(html).toContain("후속 실행 대기");
    expect(html).toContain("실행 접수는 미션 완료나 오너 작업 소비를 뜻하지 않습니다");
    expect(html).toContain("과거 요청 증거 · 현재 지시가 아닙니다");
    expect(html).toContain("운영자 할 일: assign the idle agent");
    expect(html).not.toContain("Choose the next step for the blocked mission");
    expect(html).not.toContain("<textarea");

    act(() => root.render(<CompanyLanguageProvider language="ko"><HumanOperator /></CompanyLanguageProvider>));
    const requestRow = host.querySelector('li[data-human-operator-lifecycle="active"]')!;
    expect(requestRow.querySelector("[data-owner-action-issue-id]")?.textContent).toBe(OWNER_ISSUE);
    expect(requestRow.querySelector("[data-source-issue-id]")?.textContent).toBe(SOURCE_ISSUE);
    expect(requestRow.querySelector("[data-owner-action-issue-id]")?.textContent).not.toBe(requestRow.querySelector("[data-source-issue-id]")?.textContent);
    expect(requestRow.querySelector("a[href]")?.getAttribute("href")).toBe(`/missions/${missionId}?issue=${SOURCE_ISSUE}`);
    expect(requestRow.querySelector("textarea")).toBeNull();
    expect([...requestRow.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["미션 열기"]);
  });

  it("keeps exhausted 3/3 continuation visible on a paused mission without a retry control", () => {
    const state = exactState(EVENT_EXHAUSTED, {
      decisionId: id(32), status: "resolved", attention: true,
      continuation: continuation({ state: "exhausted", effectiveStatus: "exhausted", generation: 3,
        attemptCount: 3, maxAttempts: 3, manualRetryCount: 2, maxManualRetries: 2,
        errorCode: "attempts_exhausted", retryHint: "시도 한도에 도달했습니다." }),
    });
    mockState.missions = [activeMission, pausedMission];
    mockState.requests = [makeRequest("exhausted", state, { missionId: pausedMissionId, missionStatus: "paused" })];
    act(() => root.render(<CompanyLanguageProvider language="ko"><HumanOperator /></CompanyLanguageProvider>));
    const row = host.querySelector('li[data-human-operator-lifecycle="paused"]')!;
    expect(row.textContent).toContain("후속 실행 시도 한도 도달");
    expect(row.textContent).toContain("3/3");
    expect(row.textContent).toContain("attempts_exhausted");
    expect(row.textContent).toContain("시도 한도에 도달했습니다.");
    expect([...row.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["미션 열기"]);
    expect(mockState.missions[1]?.status).toBe("paused");
  });

  it("shows missing required delivery as evidence-needed and mode none as no automatic follow-up", () => {
    const required = exactState(EVENT_MISSING, { decisionId: id(33), status: "resolved", continuation: null });
    const none = exactState(EVENT_BAD, { decisionId: id(34), status: "resolved", continuationMode: "none", continuation: null });
    mockState.requests = [makeRequest("required", required), makeRequest("none", none)];
    const html = renderKo(<HumanOperator />);
    expect(html).toContain("후속 실행 증거 확인 필요");
    expect(html).toContain("자동 후속 실행 대상이 아닙니다");
  });

  it("keeps legacy, malformed-version, missing, ambiguous, and unsupported rows unknown without borrowing a card", () => {
    const oldResolved = exactState(EVENT_BAD, { decisionId: PENDING_CARD_ID, status: "resolved" });
    const malformed = { ...oldResolved, schemaVersion: 2 } as unknown as HumanOperatorRequestStateV1;
    mockState.requests = [
      makeRequest("legacy", undefined),
      makeRequest("malformed", malformed),
      makeRequest("missing", identityState(EVENT_MISSING, "missing")),
      makeRequest("ambiguous", identityState(EVENT_AMBIGUOUS, "ambiguous")),
      makeRequest("unsupported", identityState(EVENT_UNSUPPORTED, "unsupported")),
    ];
    mockState.pendingCards = [nonOwnerCard, ownerPendingCard(EVENT_BAD, PENDING_CARD_ID, `moi1:${EVENT_BAD}`)];
    act(() => root.render(<CompanyLanguageProvider language="ko"><HumanOperator /></CompanyLanguageProvider>));
    expect(host.textContent).toContain("이 서버 응답에 결정 상태가 없습니다");
    expect(host.textContent).toContain("결정 상태 형식을 확인할 수 없습니다");
    expect(host.textContent).toContain("정확히 연결된 결정을 찾지 못했습니다");
    expect(host.textContent).toContain("결정 연결이 모호합니다");
    expect(host.textContent).toContain("지원하지 않는 결정 기록입니다");
    const malformedRow = [...host.querySelectorAll("li")].find((row) => row.textContent?.includes("Mission request malformed"))!;
    expect(malformedRow.querySelector("[data-human-operator-decision-result]")).toBeNull();
    expect(host.textContent?.split("Owner asks for direction").length - 1).toBe(1);
  });

  it("says an exact pending decision card was not loaded when the pending page is incomplete", () => {
    mockState.requests = [makeRequest("not-loaded", exactState(EVENT_PENDING))];
    mockState.pendingCards = [nonOwnerCard]; mockState.pendingNextCursor = "next-page";
    const html = renderKo(<HumanOperator />);
    expect(html).toContain("방향 결정 대기 · 카드 미조회");
    expect(html).toContain("대기 카드가 더 있습니다");
    expect(html).not.toContain("카드 없음");
  });

  it("refreshes the same three read-only surfaces and displays fetch errors", async () => {
    await act(async () => root.render(<CompanyLanguageProvider language="ko"><HumanOperator /></CompanyLanguageProvider>));
    await act(async () => {
      [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Refresh"))?.click();
    });
    expect(mockState.refetchRequests).toHaveBeenCalledTimes(1);
    expect(mockState.refetchPending).toHaveBeenCalledTimes(1);
    expect(mockState.refetchMissions).toHaveBeenCalledTimes(1);

    mockState.requestsError = new Error("requests unavailable");
    const html = renderKo(<HumanOperator />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("requests unavailable");
  });
});
