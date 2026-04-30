// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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

describe("MissionIssueTree", () => {
  it("renders mission work items as embedded selectable rows", () => {
    const html = renderToStaticMarkup(
      <MissionIssueTree missionId="mission-1" selectedIssueId="issue-1" onSelectIssue={vi.fn()} />,
    );

    expect(html).toContain("Mission linked issue");
    expect(html).toContain("CMPAAA-1");
    expect(html).toContain('type="button"');
    expect(html).toContain("bg-accent/60");
    expect(html).not.toContain('href="/issues/issue-1"');
  });
});
