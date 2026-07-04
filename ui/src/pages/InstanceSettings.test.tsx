// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import type { InputHTMLAttributes } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  formatHeartbeatInterval,
  InstanceSettings,
  intervalMinutesValue,
  parseIntervalMinutesToSec,
} from "./InstanceSettings";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQuery: () => ({
    data: [{
      id: "agent-1",
      companyId: "company-1",
      companyName: "Research Company",
      companyIssuePrefix: "RES",
      agentName: "Hermes Operations Manager",
      agentUrlKey: "hermes-operations-manager",
      role: "pm",
      title: "Hermes Operations Manager",
      status: "idle",
      adapterType: "hermes_local",
      intervalSec: 1800,
      heartbeatEnabled: true,
      schedulerActive: true,
      lastHeartbeatAt: null,
    }],
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className, title }: {
    to: string;
    children: ReactNode;
    className?: string;
    title?: string;
  }) => <a href={to} className={className} title={title}>{children}</a>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => (
    <button disabled={disabled}>{children}</button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

describe("InstanceSettings heartbeat intervals", () => {
  it("formats heartbeat interval values for the settings screen", () => {
    expect(intervalMinutesValue(1800)).toBe("30");
    expect(parseIntervalMinutesToSec("30")).toBe(1800);
    expect(formatHeartbeatInterval(1800)).toBe("30 min");
  });

  it("renders Hermes Ops with a 30 minute editable interval", () => {
    const html = renderToStaticMarkup(<InstanceSettings />);

    expect(html).toContain("Hermes Operations Manager");
    expect(html).toContain("30 min");
    expect(html).toContain('value="30"');
    expect(html).toContain('aria-label="Hermes Operations Manager heartbeat interval minutes"');
  });
});
