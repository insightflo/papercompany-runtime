// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MissionIssueTree } from "./MissionIssueTree";
import type { Issue } from "@paperclipai/shared";

function issue(input: Partial<Issue> & Pick<Issue, "id" | "title" | "createdAt">): Issue {
  return {
    id: input.id,
    companyId: input.companyId ?? "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: input.parentId ?? null,
    title: input.title,
    description: null,
    status: input.status ?? "todo",
    priority: input.priority ?? "medium",
    assigneeAgentId: input.assigneeAgentId ?? null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: input.issueNumber ?? null,
    identifier: input.identifier ?? null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
  };
}

const missionIssues = [
  issue({
    id: "new-parent",
    title: "New parent",
    identifier: "PAP-2",
    createdAt: new Date("2026-06-17T02:00:00.000Z"),
  }),
  issue({
    id: "child-running",
    parentId: "old-parent",
    title: "Todo child with live run",
    identifier: "PAP-3",
    status: "todo",
    createdAt: new Date("2026-06-17T03:00:00.000Z"),
  }),
  issue({
    id: "old-parent",
    title: "Old parent",
    identifier: "PAP-1",
    createdAt: new Date("2026-06-17T01:00:00.000Z"),
  }),
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "missions" && queryKey[3] === "issues") {
      return { data: missionIssues, isLoading: false, error: null };
    }
    if (queryKey[0] === "live-runs") {
      return {
        data: [
          {
            id: "run-child-1",
            status: "running",
            invocationSource: "automation",
            triggerDetail: null,
            startedAt: "2026-06-17T03:05:00.000Z",
            finishedAt: null,
            createdAt: "2026-06-17T03:05:00.000Z",
            agentId: "agent-1",
            agentName: "Executor",
            adapterType: "claude_local",
            issueId: "child-running",
          },
        ],
        isLoading: false,
        error: null,
      };
    }
    return { data: undefined, isLoading: false, error: null };
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("./StatusIcon", () => ({
  StatusIcon: ({ status }: { status: string }) => <span data-status={status} />,
}));

vi.mock("./PriorityIcon", () => ({
  PriorityIcon: ({ priority }: { priority: string }) => <span data-priority={priority} />,
}));

describe("MissionIssueTree", () => {
  it("renders mission work items as embedded selectable rows", () => {
    const html = renderToStaticMarkup(
      <MissionIssueTree missionId="mission-1" selectedIssueId="old-parent" onSelectIssue={vi.fn()} />,
    );

    expect(html).toContain("Old parent");
    expect(html).toContain("PAP-1");
    expect(html).toContain('type="button"');
    expect(html).toContain("bg-accent/60");
    expect(html).not.toContain('href="/issues/old-parent"');
  });

  it("sorts root work items by creation date and shows live runs on todo items", () => {
    const html = renderToStaticMarkup(<MissionIssueTree missionId="mission-1" />);

    expect(html.indexOf("Old parent")).toBeLessThan(html.indexOf("New parent"));
    expect(html.indexOf("Todo child with live run")).toBeGreaterThan(html.indexOf("Old parent"));
    expect(html).toContain("Run running");
    expect(html).toContain("Run running by Executor");
  });
});
