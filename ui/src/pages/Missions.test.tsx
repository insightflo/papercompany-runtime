// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { Missions } from "./Missions";

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "missions") {
      return {
        data: [
          {
            id: "mission-1",
            companyId: "company-1",
            ownerAgentId: "agent-1",
            title: "Launch readiness",
            status: "planning",
            createdAt: "2026-04-26T00:00:00.000Z",
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
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
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
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("lucide-react", () => ({
  Rocket: () => <span>Rocket</span>,
  Plus: () => <span>Plus</span>,
}));

describe("Missions", () => {
  it("links mission rows to the company-relative mission detail route", () => {
    const html = renderToStaticMarkup(<Missions />);

    expect(html).toContain("Launch readiness");
    expect(html).toContain('href="/missions/mission-1"');
    expect(html).not.toContain('href="missions/mission-1"');
  });
});
