// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { WorkflowDagPanel } from "./WorkflowDagPanel";

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "agents") {
      return {
        data: [{ id: "agent-1", name: "Planner" }],
        isLoading: false,
        error: null,
      };
    }

    if (queryKey[0] === "missions" && queryKey[3] === "workflow-runs") {
      return {
        data: [
          {
            id: "run-1",
            workflowId: "workflow-1",
            companyId: "company-1",
            missionId: "mission-1",
            status: "running",
            triggeredBy: "system",
            startedAt: "2026-04-15T09:00:00",
            completedAt: "2026-04-15T10:30:00",
            createdAt: "2026-04-15T00:00:00.000Z",
            workflowName: "Mission Workflow",
            stepRuns: [],
            steps: [
              {
                stepId: "draft",
                name: "Draft",
                type: "agent",
                agentId: "",
                dependencies: [],
                description: "Prepare the mission brief",
                toolNames: ["search-docs"],
                knowledgeBaseIds: ["kb-product"],
                status: "running",
                issueId: "issue-1",
                issue: {
                  id: "issue-1",
                  identifier: "CMP-101",
                  title: "Draft mission brief",
                  status: "in_progress",
                  assigneeAgentId: "agent-1",
                },
                workProducts: [
                  {
                    id: "product-1",
                    title: "Mission brief draft",
                    type: "document",
                    url: "file:///tmp/mission-brief.md",
                    status: "ready_for_review",
                    summary: "Drafted workflow output",
                    isPrimary: true,
                    metadata: null,
                    createdAt: "2026-04-15T10:00:00.000Z",
                  },
                ],
                startedAt: "2026-04-15T09:10:00",
                completedAt: "2026-04-15T10:05:00",
              },
              {
                stepId: "review",
                name: "Review",
                type: "agent",
                agentId: "",
                dependencies: ["draft"],
                description: null,
                toolNames: [],
                knowledgeBaseIds: [],
                status: "pending",
                issueId: "issue-2",
                issue: {
                  id: "issue-2",
                  identifier: "CMP-102",
                  title: "Review brief",
                  status: "todo",
                  assigneeAgentId: "agent-1",
                },
                workProducts: [],
                startedAt: null,
                completedAt: null,
              },
            ],
            progress: {
              totalSteps: 2,
              pendingSteps: 1,
              runningSteps: 1,
              completedSteps: 0,
              failedSteps: 0,
              skippedSteps: 0,
            },
          },
        ],
        isLoading: false,
        error: null,
      };
    }

    return {
      data: {
        entries: [],
        endpointAvailable: true,
      },
      isLoading: false,
      error: null,
    };
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    to,
    state,
    className,
    children,
  }: {
    to: string;
    state?: unknown;
    className?: string;
    children: ReactNode;
  }) => (
    <a href={to} data-state={JSON.stringify(state ?? null)} className={className}>
      {children}
    </a>
  ),
}));

describe("WorkflowDagPanel", () => {
  it("renders mission workflow step detail with linked issue context", () => {
    const html = renderToStaticMarkup(<WorkflowDagPanel missionId="mission-1" defaultMode="text" />);

    expect(html).toContain("Mission Workflow");
    expect(html).toContain("Triggered by: system");
    expect(html).toContain("Started:");
    expect(html).toContain("Ended:");
    expect(html).toContain("9:00 AM");
    expect(html).toContain("10:30 AM");
    expect(html).toContain("9:10 AM");
    expect(html).toContain("10:05 AM");
    expect(html).toContain("Planner");
    expect(html).not.toContain("Assignee: tool");
    expect(html).toContain("Draft");
    expect(html).toContain("Prepare the mission brief");
    expect(html).toContain("search-docs");
    expect(html).toContain("kb:kb-product");
    expect(html).not.toContain("Workflow products · 1");
    expect(html).not.toContain("Registered deliverables from this run");
    expect(html).toContain("Work products · 1");
    expect(html).toContain("Mission brief draft");
    expect(html).toContain("Drafted workflow output");
    expect(html).toContain("Primary");
    expect(html).toContain("Open");
    expect(html).toContain("CMP-101");
    expect(html).toContain('href="/issues/CMP-101"');
    expect(html).toContain(
      'data-state="{&quot;issueDetailBreadcrumb&quot;:{&quot;label&quot;:&quot;Mission&quot;,&quot;href&quot;:&quot;/missions/mission-1&quot;}}"',
    );
    expect(html.indexOf("Prepare the mission brief")).toBeLessThan(html.indexOf("Work products · 1"));
    expect(html.indexOf("Work products · 1")).toBeLessThan(html.indexOf("CMP-101"));
  });

  it("renders graph mode by default with step nodes, entry marker, and view toggle", () => {
    const html = renderToStaticMarkup(<WorkflowDagPanel missionId="mission-1" />);

    // Graph/Text segmented control; Graph is the default active view.
    expect(html).toContain(">Graph<");
    expect(html).toContain(">Text<");
    expect(html).toContain('aria-pressed="true"');
    // Run header still present in graph mode.
    expect(html).toContain("Mission Workflow");
    expect(html).toContain("Triggered by: system");
    // Step node renders name + status label + entry marker (draft has no dependencies).
    expect(html).toContain("Draft");
    expect(html).toContain("Entry");
    expect(html).toContain("running");
    // No node selected in static render -> detail hint shown (selection needs a browser).
    expect(html).toContain("Select a step node");
  });

  it("renders dependency edges between levelled step nodes in graph mode", () => {
    const html = renderToStaticMarkup(<WorkflowDagPanel missionId="mission-1" />);

    // review depends on draft -> an SVG edge line is drawn between the two nodes.
    expect(html).toContain("Review");
    expect(html).toContain("<line");
    // draft stays the entry step (column 0); review is the downstream node.
    expect(html).toContain("Entry");
  });
});
