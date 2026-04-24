// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MissionIssueTree } from "./MissionIssueTree";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: [
      {
        id: "issue-1",
        parentId: null,
        status: "todo",
        priority: "medium",
        title: "Mission linked issue",
        identifier: "CMPAAA-1",
      },
    ],
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("./StatusIcon", () => ({
  StatusIcon: () => <span data-testid="status-icon" />,
}));

vi.mock("./PriorityIcon", () => ({
  PriorityIcon: () => <span data-testid="priority-icon" />,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, state, className, style, children }: {
    to: string;
    state?: unknown;
    className?: string;
    style?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a
      href={to}
      data-state={JSON.stringify(state ?? null)}
      className={className}
      style={style}
    >
      {children}
    </a>
  ),
}));

describe("MissionIssueTree", () => {
  it("emits absolute issue detail links and preserves mission breadcrumb state", () => {
    const html = renderToStaticMarkup(<MissionIssueTree missionId="mission-1" />);

    expect(html).toContain('href="/issues/issue-1"');
    expect(html).toContain('data-state="{&quot;issueDetailBreadcrumb&quot;:{&quot;label&quot;:&quot;Mission&quot;,&quot;href&quot;:&quot;/missions/mission-1&quot;}}"');
  });
});
