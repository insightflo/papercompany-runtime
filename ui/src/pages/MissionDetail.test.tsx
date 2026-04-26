// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MissionDetail } from "./MissionDetail";

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "missions" && queryKey[1] === "detail") {
      return {
        data: {
          id: "mission-1",
          companyId: "company-1",
          ownerAgentId: "agent-1",
          title: "Launch Mission",
          description: "Mission detail test",
          status: "active",
          createdAt: "2026-04-15T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
        },
        isLoading: false,
        error: null,
      };
    }

    if (queryKey[0] === "agents") {
      return {
        data: [{ id: "agent-1", name: "Planner" }],
        isLoading: false,
        error: null,
      };
    }

    return { data: undefined, isLoading: false, error: null };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ missionId: "mission-1" }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../components/MissionExecutionOverview", () => ({
  MissionExecutionOverview: ({ missionId }: { missionId: string }) => (
    <section data-component="MissionExecutionOverview">Overview for {missionId}</section>
  ),
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, placeholder }: { value?: string; placeholder?: string }) => (
    <span data-component="InlineEditor">{value || placeholder}</span>
  ),
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-component="PageSkeleton" />,
}));

vi.mock("../components/MissionIssueTree", () => ({
  MissionIssueTree: ({ missionId }: { missionId: string }) => (
    <section data-component="MissionIssueTree">Issue tree for {missionId}</section>
  ),
}));

vi.mock("../components/WorkflowDagPanel", () => ({
  WorkflowDagPanel: ({ missionId }: { missionId: string }) => (
    <section data-component="WorkflowDagPanel">Workflow DAG for {missionId}</section>
  ),
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value }: { value: string }) => <div data-testid="inline-editor">{value}</div>,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-testid="page-skeleton" />,
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span data-testid="status-badge">{status}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div data-testid="tabs">{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div data-testid="tabs-list">{children}</div>,
  TabsTrigger: ({ children, value }: { children: ReactNode; value: string }) => (
    <button data-testid={`tabs-trigger-${value}`}>{children}</button>
  ),
  TabsContent: ({ children, value }: { children: ReactNode; value: string }) => (
    <div data-testid={`tabs-content-${value}`}>{children}</div>
  ),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr data-testid="separator" />,
}));

vi.mock("lucide-react", () => ({
  Rocket: () => <span>Rocket</span>,
  ListTree: () => <span>ListTree</span>,
  GitBranch: () => <span>GitBranch</span>,
  Settings: () => <span>Settings</span>,
  User: () => <span>User</span>,
}));

describe("MissionDetail", () => {
  it("renders real mission issue and workflow panels, while execution rules remains coming soon", () => {
    const html = renderToStaticMarkup(<MissionDetail />);

    expect(html).toContain("Launch Mission");
    expect(html).toContain("Mission detail test");
    expect(html).toContain("Work");
    expect(html).toContain('data-component="MissionIssueTree"');
    expect(html).toContain("Issue tree for mission-1");
    expect(html).toContain("Execution Flow");
    expect(html).toContain('data-component="WorkflowDagPanel"');
    expect(html).toContain("Workflow DAG for mission-1");
    expect(html).toContain("Execution rules coming soon");
    expect(html).toContain("Open global execution rules");
  });
});
