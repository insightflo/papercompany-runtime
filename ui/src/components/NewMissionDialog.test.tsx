// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NewMissionDialog } from "./NewMissionDialog";

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
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

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ newMissionOpen: true, closeNewMission: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Gazua" },
  }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div data-testid="dialog">{children}</div>,
  DialogContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="dialog-content" className={className}>{children}</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({
    className,
    contentClassName,
  }: {
    className?: string;
    contentClassName?: string;
  }) => (
    <textarea
      data-testid="markdown-editor"
      className={className}
      data-content-class-name={contentClassName}
    />
  ),
}));

vi.mock("./StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("lucide-react", () => ({
  Maximize2: () => <span>Maximize2</span>,
  Minimize2: () => <span>Minimize2</span>,
  Rocket: () => <span>Rocket</span>,
  User: () => <span>User</span>,
}));

describe("NewMissionDialog", () => {
  it("labels ownerAgentId selection as main executor", () => {
    const html = renderToStaticMarkup(<NewMissionDialog />);

    expect(html).toContain("Main executor");
    expect(html).not.toContain("Owner agent");
  });

  it("keeps long mission descriptions scrollable inside the dialog", () => {
    const html = renderToStaticMarkup(<NewMissionDialog />);

    expect(html).toContain("max-h-[calc(100dvh-2rem)]");
    expect(html).toContain("overflow-hidden");
    expect(html).not.toContain("overflow-x-auto");
    expect(html).toContain("overflow-x-hidden");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("overscroll-contain");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("break-words");
  });
});
