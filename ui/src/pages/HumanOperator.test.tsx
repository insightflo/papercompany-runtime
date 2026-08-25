/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import {
  focusOperatorDecisionSuccessTarget,
  HumanOperator,
  isContinuationRetryEligible,
} from "./HumanOperator";

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
  result: null, issueId: null, continuationMode: "none", requestedBy: null,
  resolvedByUserId: null, resolvedAt: null, cancelledAt: null,
  createdAt: "2026-07-29T10:00:00.000Z", updatedAt: "2026-07-29T10:00:00.000Z", continuation: null,
};
const attention: OperatorDecisionView = {
  ...pending,
  id: "attention-1", requestKey: "attention", status: "resolved", title: "Continuation needs attention",
  result: { actionId: "hold", outcome: "hold", selectedOptionIds: [], comment: null },
  resolvedByUserId: "board", resolvedAt: "2026-07-29T10:01:00.000Z",
  continuation: {
    id: "continuation-1", state: "blocked", generation: 1, attemptCount: 1, maxAttempts: 3,
    manualRetryCount: 0, maxManualRetries: 2, nextAttemptAt: "2026-07-29T10:01:00.000Z",
    leaseExpiresAt: null, targetAgentId: null, wakeupRequestId: null,
    effectiveStatus: "blocked", errorCode: "issue_unassigned",
    issueIdentifier: "GAZ-1337", issueTitle: "[OVERSIGHT] gazua-morning", issueStatus: "in_progress",
    issueAssigneeAgentId: null, missionId: null, missionTitle: "2026-08-25 gazua-morning",
    retryHint: "연결 이슈가 진행 중이지만 담당자가 없습니다. 이슈에 담당자를 지정하면 재시도가 깨움으로 이어집니다.",
  },
};

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "operator-decisions" && queryKey[2] === "pending") {
      return { data: { data: [pending], page: { nextCursor: null } }, isLoading: false, isFetching: false, error: null, refetch: vi.fn() };
    }
    if (queryKey[0] === "operator-decisions" && queryKey[2] === "attention") {
      return { data: { data: [attention], page: { nextCursor: null } }, isLoading: false, isFetching: false, error: null, refetch: vi.fn() };
    }
    return {
      data: [{
        id: "request-1", severity: "attention", missionStatus: "active", timestamp: "2026-07-29T10:00:00Z", title: "Mission request",
        summary: "무엇이: 미션 Mission · 이슈 RES-3638 — Draft\n왜 막힘: the source issue is blocked\n운영자 할 일: assign the idle agent",
        missionTitle: "Mission", missionId: "mission-1", issueId: null,
      }],
      isLoading: false, isFetching: false, error: null, refetch: vi.fn(),
    };
  },
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../components/ExternalAutomationApprovals", () => ({ ExternalAutomationApprovals: () => <section>External automation approvals</section> }));
vi.mock("../lib/router", () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }));
vi.mock("../components/ui/button", () => ({ Button: ({ children }: { children: ReactNode }) => <button>{children}</button> }));
vi.mock("../components/StatusBadge", () => ({ StatusBadge: ({ status }: { status: string }) => <span>{status}</span> }));
vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div>Loading</div> }));
vi.mock("../components/EmptyState", () => ({ EmptyState: ({ message }: { message: string }) => <div>{message}</div> }));

describe("HumanOperator", () => {
  it("renders pending cards, attention, automation, then existing requests in order", () => {
    const html = renderToStaticMarkup(<HumanOperator />);
    const pendingIndex = html.indexOf("Pending Interactive Card");
    const attentionIndex = html.indexOf("Continuation needs attention");
    const automationIndex = html.indexOf("External automation approvals");
    const requestIndex = html.indexOf("Mission request");
    expect(pendingIndex).toBeGreaterThan(-1);
    expect(pendingIndex).toBeLessThan(attentionIndex);
    expect(attentionIndex).toBeLessThan(automationIndex);
    expect(automationIndex).toBeLessThan(requestIndex);
  });

  it("renders the structured request summary with preserved line breaks", () => {
    const html = renderToStaticMarkup(<HumanOperator />);
    expect(html).toContain("whitespace-pre-line");
    expect(html).toContain("무엇이: 미션 Mission · 이슈 RES-3638 — Draft");
    expect(html).toContain("왜 막힘: the source issue is blocked");
    expect(html).toContain("운영자 할 일: assign the idle agent");
    expect(html).not.toContain("Issue: "); // raw issue UUID line removed from the card
  });

  it("counts pending cards plus existing requests without counting attention", () => {
    const html = renderToStaticMarkup(<HumanOperator />);
    expect(html).toContain("2 actionable");
    expect(html).toContain("Retry continuation");
    expect(html).toContain("issue unassigned");
  });

  it("only enables retries for server-eligible continuation states", () => {
    expect(isContinuationRetryEligible(attention)).toBe(true);
    expect(isContinuationRetryEligible({
      ...attention,
      continuation: { ...attention.continuation!, state: "pending", effectiveStatus: "pending", errorCode: "dispatch_delayed" },
    })).toBe(false);
    expect(isContinuationRetryEligible({
      ...attention,
      continuation: { ...attention.continuation!, state: "blocked", errorCode: "issue_missing" },
    })).toBe(false);
    expect(isContinuationRetryEligible({
      ...attention,
      continuation: { ...attention.continuation!, state: "accepted", effectiveStatus: "failed", errorCode: "heartbeat_failed" },
    })).toBe(true);
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
});
