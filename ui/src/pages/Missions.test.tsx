// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { Missions } from "./Missions";

let currentSearchParams = new URLSearchParams();
const observedQueryKeys: unknown[][] = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    observedQueryKeys.push([...queryKey]);

    if (queryKey[0] === "missions") {
      return {
        data: [
          {
            id: "mission-1",
            companyId: "company-1",
            ownerAgentId: "agent-1",
            title: "Launch readiness",
            status: "planning",
            createdAt: "2026-04-26T12:34:00.000Z",
          },
        ],
        isLoading: false,
        error: null,
      };
    }

    if (queryKey[0] === "agents") {
      return {
        data: [{ id: "agent-1", name: "Rocket QA" }],
        isLoading: false,
        error: null,
      };
    }

    return { data: undefined, isLoading: false, error: null };
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useSearchParams: () => [currentSearchParams, vi.fn()],
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewMission: vi.fn() }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-testid="page-skeleton" />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => (
    <button>{children}</button>
  ),
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("lucide-react", () => ({
  Rocket: () => <span>Rocket</span>,
  Plus: () => <span>Plus</span>,
}));

describe("Missions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 30, 12, 0, 0));
    currentSearchParams = new URLSearchParams();
    observedQueryKeys.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("links mission rows to the company-relative mission detail route", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain("Launch readiness");
    expect(html).toContain('href="/missions/mission-1"');
    expect(html).not.toContain('href="missions/mission-1"');
  });

  it("labels the mission owner as the main executor", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain("Main executor");
    expect(html).toContain("Rocket QA");
  });

  it("shows mission creation date and time to distinguish repeated workflow-created titles", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain("Launch readiness");
    expect(html).toMatch(/\d{2}:\d{2}/);
  });

  it("includes paging, sorting, owner filtering, and date filters in the missions query key", () => {
    currentSearchParams = new URLSearchParams(
      "status=active&ownerAgentId=agent-1&from=2026-04-29&to=2026-04-30&sortBy=title&sortOrder=asc&pageSize=10&page=3",
    );

    renderToStaticMarkup(<Missions />);

    expect(observedQueryKeys).toContainEqual([
      "missions",
      "company-1",
      {
        status: "active",
        ownerAgentId: "agent-1",
        from: "2026-04-29",
        to: "2026-04-30",
        sortBy: "title",
        sortOrder: "asc",
        limit: 10,
        offset: 20,
      },
    ]);
  });

  it("defaults the created-from filter to yesterday when URL params are absent", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain('value="2026-04-29"');
    expect(observedQueryKeys).toContainEqual([
      "missions",
      "company-1",
      {
        from: "2026-04-29",
        sortBy: "updatedAt",
        sortOrder: "desc",
        limit: 25,
        offset: 0,
      },
    ]);
  });

  it("renders mission list controls for filtering, sorting, and paging", () => {
    currentSearchParams = new URLSearchParams("page=2&pageSize=10");

    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain("All executors");
    expect(html).toContain("Recently updated");
    expect(html).toContain("Page 2");
    expect(html).toContain("Previous");
    expect(html).toContain("Next");
  });
});
