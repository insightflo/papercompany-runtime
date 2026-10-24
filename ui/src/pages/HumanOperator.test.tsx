/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import {
  CompanyLanguageProvider,
} from "../lib/companyLanguage";
import {
  focusOperatorDecisionSuccessTarget,
  HumanOperator,
} from "./HumanOperator";

const { mockState, resolveSpy, invalidateSpy } = vi.hoisted(() => ({
  mockState: {
    pendingCards: [] as OperatorDecisionView[],
    requests: [] as unknown[],
  },
  resolveSpy: vi.fn().mockResolvedValue({ decision: {}, applied: true, continuation: null }),
  invalidateSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidateSpy }),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "operator-decisions" && queryKey[2] === "pending") {
      return { data: { data: mockState.pendingCards, page: { nextCursor: null } }, isLoading: false, isFetching: false, error: null, refetch: vi.fn() };
    }
    return {
      data: mockState.requests,
      isLoading: false, isFetching: false, error: null, refetch: vi.fn(),
    };
  },
}));
vi.mock("../api/operator-decisions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/operator-decisions")>();
  return {
    ...actual,
    operatorDecisionsApi: {
      ...actual.operatorDecisionsApi,
      resolve: resolveSpy,
    },
  };
});
vi.mock("../context/CompanyContext", async (importOriginal) => ({ ...await importOriginal<typeof import("../context/CompanyContext")>(), useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../components/ExternalAutomationApprovals", () => ({ ExternalAutomationApprovals: () => <section>External automation approvals</section> }));
vi.mock("../lib/router", () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }));
vi.mock("../components/ui/button", () => ({ Button: ({ children }: { children: ReactNode }) => <button>{children}</button> }));
vi.mock("../components/StatusBadge", () => ({ StatusBadge: ({ status }: { status: string }) => <span>{status}</span> }));
vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div>Loading</div> }));
vi.mock("../components/EmptyState", () => ({ EmptyState: ({ message }: { message: string }) => <div>{message}</div> }));

const pending: OperatorDecisionView = {
  id: "pending-1", companyId: "company-1", schemaVersion: 1, requestKey: "pending", status: "pending",
  priority: "critical", interactionType: "action", title: "Pending Interactive Card", description: "Act now",
  sourceType: "system", sourceId: "source",
  sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
  definition: {
    options: [], actions: [{ id: "hold", label: "Hold", outcome: "hold", tone: "neutral", requiresSelection: false }],
    selection: null, comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
    approvedScope: [], forbiddenScope: [],
  },
  result: null, issueId: null, issueIdentifier: null, issueTitle: null, missionTitle: null, continuationMode: "none", requestedBy: null,
  resolvedByUserId: null, resolvedAt: null, cancelledAt: null,
  createdAt: "2026-07-29T10:00:00.000Z", updatedAt: "2026-07-29T10:00:00.000Z", continuation: null,
};

// [Stage 2 fixture] Stage 1 기본 정의(moi1:{decisionEventId}, approve/hold/reject + comment required) 재현.
const moiCard: OperatorDecisionView = {
  ...pending,
  id: "moi-card-1", requestKey: "moi1:decision-event-1", sourceType: "mission_owner_human_input", sourceId: "decision-event-1",
  title: "Owner asks for direction", description: "Choose the next step for the blocked mission.",
  interactionType: "single_select",
  definition: {
    ...pending.definition,
    options: [
      { id: "approve", label: "Approve", description: "Proceed with the requested next step", facts: [], evidenceRefs: [] },
      { id: "hold", label: "Hold", description: "Keep waiting", facts: [], evidenceRefs: [] },
      { id: "reject", label: "Reject", description: "Send the handoff back", facts: [], evidenceRefs: [] },
    ],
    actions: [{ id: "approve", label: "Approve", outcome: "approve", tone: "primary", requiresSelection: true }],
    selection: { min: 1, max: 1 },
    comment: { mode: "required", label: "Reason", placeholder: null, maxLength: 100 },
    humanReview: {
      schemaVersion: "human-review-v1",
      decisionSubject: "Choose the next step for the blocked mission",
      evidence: [{ label: "Blocked issue", description: "The blocked source issue.", href: "/issues/issue-1", location: "Issue > blocker" }],
      interpretation: "One direction must be chosen.",
      impact: { ifApproved: "The owner proceeds.", ifRejected: "The handoff returns.", ifWrong: "The wrong step runs." },
      unresolvedFacts: [], questions: [],
      recommendedNextStep: "Approve the requested next step.", requiredReviewer: "Human Operator",
    },
  },
};

function moiRequest(id: string, decisionEventId: string | null) {
  return {
    id: `request-${id}`, severity: "attention", missionStatus: "active", timestamp: "2026-07-29T10:00:00Z",
    title: `Mission request ${id}`,
    summary: "무엇이: 미션 Mission · 이슈 RES-3638 — Draft\n왜 막힘: the source issue is blocked\n운영자 할 일: assign the idle agent",
    missionTitle: "Mission", missionId: "mission-1", issueId: null,
    event: {
      id: `owner_diagnosis:activity_log:${id}`, companyId: "company-1",
      scope: { missionId: "mission-1" },
      sourceRef: { type: "activity_log", id, table: "activity_log" },
      eventType: "owner_diagnosis", title: "Human/operator input requested", summary: "…",
      timestamp: "2026-07-29T10:00:00Z",
      ...(decisionEventId
        ? { evidenceRefs: [{ type: "log", ref: decisionEventId, label: "mission owner decision" }] }
        : {}),
    },
  };
}

const legacyRequest = {
  id: "request-1", severity: "attention", missionStatus: "active", timestamp: "2026-07-29T10:00:00Z", title: "Mission request",
  summary: "무엇이: 미션 Mission · 이슈 RES-3638 — Draft\n왜 막힘: the source issue is blocked\n운영자 할 일: assign the idle agent",
  missionTitle: "Mission", missionId: "mission-1", issueId: null,
};

function setDefaultMocks() {
  mockState.pendingCards = [pending];
  mockState.requests = [legacyRequest];
}

// 배지·레이블은 회사 언어를 따르므로 검증 언어를 ko 로 고정한다.
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
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("renders pending cards, automation, then existing requests in order", () => {
    const html = renderToStaticMarkup(<HumanOperator />);
    const pendingIndex = html.indexOf("Pending Interactive Card");
    const automationIndex = html.indexOf("External automation approvals");
    const requestIndex = html.indexOf("Mission request");
    expect(pendingIndex).toBeGreaterThan(-1);
    expect(pendingIndex).toBeLessThan(automationIndex);
    expect(automationIndex).toBeLessThan(requestIndex);
    // [2026-10-20] resolved/cancelled 이력(attention·history)은 더 이상 조회·렌더하지 않는다.
    expect(html).not.toContain("Continuations needing attention");
  });

  it("renders the structured request summary with preserved line breaks", () => {
    const html = renderToStaticMarkup(<HumanOperator />);
    expect(html).toContain("whitespace-pre-line");
    expect(html).toContain("무엇이: 미션 Mission · 이슈 RES-3638 — Draft");
    expect(html).toContain("왜 막힘: the source issue is blocked");
    expect(html).toContain("운영자 할 일: assign the idle agent");
    expect(html).not.toContain("Issue: "); // raw issue UUID line removed from the card
  });

  it("counts pending cards plus existing requests", () => {
    const html = renderToStaticMarkup(<HumanOperator />);
    expect(html).toContain("2 actionable");
  });

  it("moves success focus to next pending, attention, then empty heading", () => {
    document.body.innerHTML = `
      <h2 data-operator-decision-heading tabindex="-1">Pending</h2>
      <h2 data-operator-decision-attention-heading tabindex="-1">Attention</h2>
      <h2 data-human-operator-empty-heading tabindex="-1">Empty</h2>
    `;
    focusOperatorDecisionSuccessTarget();
    expect(document.activeElement?.textContent).toBe("Pending");
    document.querySelector("[data-operator-decision-heading]")?.remove();
    focusOperatorDecisionSuccessTarget();
    expect(document.activeElement?.textContent).toBe("Attention");
    document.querySelector("[data-operator-decision-attention-heading]")?.remove();
    focusOperatorDecisionSuccessTarget();
    expect(document.activeElement?.textContent).toBe("Empty");
  });

  it("binds a pending card to its request row, resolves it once, and refetches requests+decisions", async () => {
    mockState.requests = [moiRequest("a", "decision-event-1")];
    mockState.pendingCards = [pending, moiCard];
    await act(async () => {
      root.render(<CompanyLanguageProvider language="ko"><HumanOperator /></CompanyLanguageProvider>);
    });
    // 카드는 요청 행 안에 정확히 1회 렌더된다(pending 섹션 제외). 헤딩은 humanReview.decisionSubject 우선.
    const row = [...host.querySelectorAll("li")].find((item) => item.textContent?.includes("Mission request a"));
    expect(row?.querySelector("[data-operator-decision-heading]")?.textContent).toBe("Choose the next step for the blocked mission");
    expect(host.textContent?.split("Owner asks for direction").length - 1).toBe(1);

    resolveSpy.mockClear();
    invalidateSpy.mockClear();
    act(() => (host.querySelector('[data-operator-decision-option="approve"]') as HTMLElement).click());
    const comment = host.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(comment, "proceed");
      comment.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      ([...host.querySelectorAll("button")].find((button) => button.textContent === "Approve") as HTMLElement).click();
    });
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith("moi-card-1", {
      actionId: "approve", selectedOptionIds: ["approve"], comment: "proceed",
    });
    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => (call[0] as { queryKey?: readonly unknown[] })?.queryKey?.[0]);
    expect(invalidatedKeys).toContain("missions");
    expect(invalidatedKeys).toContain("operator-decisions");
  });

  it("marks rows without an extractable decision event or matching card as card-less", () => {
    mockState.requests = [legacyRequest, moiRequest("b", "decision-event-missing")];
    mockState.pendingCards = [pending];
    const html = renderKo(<HumanOperator />);
    // 과거 행(Stage 1 이전)과 매칭 카드가 없는 행 모두 "카드 없음" 배지.
    expect(html.split("카드 없음").length - 1).toBe(2);
    expect(html).not.toContain("Owner asks for direction");
  });

  it("marks rows with resolved/cancelled cards as card-less since history is not fetched", () => {
    mockState.requests = [moiRequest("b", "decision-event-2"), moiRequest("c", "decision-event-3")];
    const html = renderKo(<HumanOperator />);
    // [2026-10-20] resolved/cancelled 이력 조회 제거 — 매칭 행은 카드 없음 배지로 표시한다.
    expect(html.split("카드 없음").length - 1).toBe(2);
    expect(html).not.toContain("해결됨");
    expect(html).not.toContain("취소됨");
    expect(html).not.toContain('value="approve"');
  });

  it("keeps a pending card bound to a request row out of the pending card section", () => {
    mockState.requests = [moiRequest("a", "decision-event-1")];
    mockState.pendingCards = [pending, moiCard];
    const html = renderKo(<HumanOperator />);
    expect(html.split("Owner asks for direction").length - 1).toBe(1);
    expect(html).toContain("Pending Interactive Card"); // non-moi pending stays in its section
    expect(html).toContain("2 actionable"); // 1 unbound pending + 1 request (bound card counts once via its row)
  });
});
