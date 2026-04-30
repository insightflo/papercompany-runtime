// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MissionIssueInspector } from "./MissionIssueInspector";

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "issues" && queryKey[1] === "detail") {
      return {
        data: {
          id: "issue-1",
          title: "Follow up on failed workflow step",
          description: "Investigate the failure and report back.",
          status: "blocked",
          priority: "high",
          identifier: "CMPA-1517",
          assigneeAgentId: "agent-1",
          startedAt: "2026-04-29T00:10:00.000Z",
          completedAt: null,
          updatedAt: "2026-04-29T00:12:00.000Z",
          ancestors: [{ id: "parent-1", title: "Gazua morning" }],
        },
        isLoading: false,
        error: null,
      };
    }

    if (queryKey[0] === "issues" && queryKey[1] === "comments") {
      return {
        data: [
          {
            id: "comment-1",
            companyId: "company-1",
            issueId: "issue-1",
            authorAgentId: "agent-1",
            authorUserId: null,
            body: "Tool failed because the blog markdown was missing.",
            createdAt: "2026-04-29T00:11:00.000Z",
            updatedAt: "2026-04-29T00:11:00.000Z",
          },
        ],
        isLoading: false,
        error: null,
      };
    }

    if (queryKey[0] === "issues" && queryKey[1] === "activity") {
      return {
        data: [],
        isLoading: false,
        error: null,
      };
    }

    if (queryKey[0] === "issues" && queryKey[1] === "runs") {
      return {
        data: [],
        isLoading: false,
        error: null,
      };
    }

    if (queryKey[0] === "agents") {
      return {
        data: [{ id: "agent-1", name: "Hulk" }],
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

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("./CommentThread", () => ({
  CommentThread: ({ comments, linkedRuns }: { comments: Array<{ body: string }>; linkedRuns?: Array<unknown> }) => (
    <section data-component="CommentThread">
      <div>Comments &amp; Runs ({comments.length + (linkedRuns?.length ?? 0)})</div>
      {comments.map((comment) => <div key={comment.body}>{comment.body}</div>)}
    </section>
  ),
}));

vi.mock("./PriorityIcon", () => ({
  PriorityIcon: ({ priority }: { priority: string }) => <span>{priority}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("lucide-react", () => ({
  ListTree: () => <span>ListTree</span>,
}));

describe("MissionIssueInspector", () => {
  it("renders the issue-style comments and runs thread inline", () => {
    const html = renderToStaticMarkup(<MissionIssueInspector issueId="issue-1" />);

    expect(html).toContain("Follow up on failed workflow step");
    expect(html).toContain('data-component="CommentThread"');
    expect(html).toContain("Comments &amp; Runs (1)");
    expect(html).toContain("Tool failed because the blog markdown was missing.");
    expect(html).toContain("Hulk");
  });
});
