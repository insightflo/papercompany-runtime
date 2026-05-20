// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MissionExecutionOverview } from "./MissionExecutionOverview";

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "agents" && queryKey[1] === "company-1") {
      return {
        data: [
          { id: "agent-1", name: "Planner", status: "active" },
          { id: "agent-2", name: "Reviewer", status: "paused" },
        ],
        isLoading: false,
        error: null,
      };
    }

    if (queryKey[0] === "missions" && queryKey[3] === "issues") {
      return {
        data: [
          { id: "issue-1", status: "blocked" },
          { id: "issue-2", status: "in_review" },
          { id: "issue-3", status: "done" },
        ],
        isLoading: false,
        error: null,
      };
    }

    if (queryKey[0] === "missions" && queryKey[3] === "workflow-runs") {
      return {
        data: [
          {
            id: "run-1",
            status: "running",
            steps: [
              { toolNames: ["search-docs"], knowledgeBaseIds: ["kb-product"] },
              { toolNames: ["fetch-spec"], knowledgeBaseIds: [] },
            ],
          },
          {
            id: "run-2",
            status: "failed",
            steps: [
              { toolNames: [], knowledgeBaseIds: ["kb-policy"] },
            ],
          },
        ],
        isLoading: false,
        error: null,
      };
    }

    return {
      data: null,
      isLoading: false,
      error: null,
    };
  },
  useQueries: ({ queries }: { queries: Array<{ queryKey: readonly unknown[] }> }) =>
    queries.map((query) => {
      const agentId = String(query.queryKey[2]);
      if (agentId === "agent-1") {
        return {
          data: {
            sessionAuthority: "mission_session",
            sessionDisplayId: "mission-session-1",
            latestMissionSession: { missionId: "mission-1", runCount: 3 },
            lastRunStatus: "running",
            lastError: null,
          },
          isLoading: false,
          error: null,
        };
      }
      return {
        data: {
          sessionAuthority: "task_session",
          sessionDisplayId: "legacy-session-2",
          latestMissionSession: null,
          lastRunStatus: "failed",
          lastError: "Needs operator attention",
        },
        isLoading: false,
        error: null,
      };
    }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

describe("MissionExecutionOverview", () => {
  it("renders read-only mission owner status without raw markers", () => {
    const html = renderToStaticMarkup(
      <MissionExecutionOverview
        missionId="mission-1"
        mission={{
          id: "mission-1",
          companyId: "company-1",
          ownerAgentId: "agent-1",
          title: "Mission",
          description: null,
          status: "active",
          goalId: null,
          startedAt: null,
          completedAt: null,
          createdAt: new Date("2026-04-15T00:00:00.000Z"),
          updatedAt: new Date("2026-04-15T00:00:00.000Z"),
          ownerAgentName: "Planner",
          agents: [],
          sessionBindings: [],
          ownerActionExplanations: [
            {
              ownerActionIssue: {
                id: "owner-action-1",
                identifier: "PC-9",
                title: "Unblock source work",
                status: "done",
                originKind: "mission_main_executor_unblock",
              },
              sourceIssue: {
                id: "source-1",
                identifier: "PC-7",
                title: "Repair adapter handoff",
                status: "todo",
                assigneeAgentId: "agent-2",
              },
              latestDecision: {
                decision: "retry_source_issue",
                sourceIssueRef: "PC-7",
                reason: "Retry after owner review",
                nextAction: "Return to queue",
                evidence: "mission-owner-decision-applied raw marker should not render",
              },
              retryApplied: true,
              status: "retry_applied_no_wakeup",
              explanation: "Retry was explicitly applied; mission-owner-decision-applied raw marker should not render.",
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Mission owner status");
    expect(html).toContain("Retry queued, no wakeup created");
    expect(html).toContain("PC-9");
    expect(html).toContain("Unblock source work");
    expect(html).toContain("PC-7");
    expect(html).toContain("Repair adapter handoff");
    expect(html).toContain("Source status: todo");
    expect(html).toContain("Assignee: agent-2");
    expect(html).toContain("Decision: retry source issue");
    expect(html).not.toContain("mission-owner-decision-applied");
    expect(html).not.toContain("mission-owner-action");
    expect(html).not.toContain("{&quot;");
    expect(html).not.toContain("<button");
  });

  it("renders mission continuity, risk, and delivery summaries", () => {
    const html = renderToStaticMarkup(
      <MissionExecutionOverview
        missionId="mission-1"
        mission={{
          id: "mission-1",
          companyId: "company-1",
          ownerAgentId: "agent-1",
          title: "Mission",
          description: null,
          status: "active",
          goalId: null,
          startedAt: null,
          completedAt: null,
          createdAt: new Date("2026-04-15T00:00:00.000Z"),
          updatedAt: new Date("2026-04-15T00:00:00.000Z"),
          ownerAgentName: "Planner",
          agents: [
            { agentId: "agent-1", role: "owner", agentName: "Planner" },
            { agentId: "agent-2", role: "reviewer", agentName: "Reviewer" },
          ],
          sessionBindings: [
            {
              agentId: "agent-1",
              adapterType: "codex_local",
              status: "active",
              lastActiveAt: "2026-04-15T01:00:00.000Z",
              runCount: 3,
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Mission Continuity");
    expect(html).toContain("Delivery Contract");
    expect(html).toContain("Planner");
    expect(html).toContain("mission session");
    expect(html).toContain("Needs operator attention");
    expect(html).toContain("search-docs");
    expect(html).toContain("fetch-spec");
    expect(html).toContain("Product");
    expect(html).toContain("Policy");
    expect(html).not.toContain("kb:kb-product");
    expect(html).not.toContain("kb:kb-policy");
    expect(html).toContain("2 unique tools across 2 workflow runs");
    expect(html).toContain("2 knowledge bases across 2 workflow runs");
    expect(html).toContain("Workflow runs");
    expect(html).toContain("run-1");
    expect(html).toContain("running");
    expect(html).toContain("run-2");
    expect(html).toContain("failed");
    expect(html).toContain("Search-Docs");
    expect(html).toContain("Fetch-Spec");
    expect(html).toContain("1 blocked, 1 in review");
    expect(html).toContain("1 active, 1 failed");
  });
});
