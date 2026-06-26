// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OperationsAgentSetupNotice } from "./HermesChatPanel";

vi.mock("../lib/router", () => ({
  useLocation: () => ({ pathname: "/", search: "" }),
}));

vi.mock("./EmptyState", () => ({
  EmptyState: ({ message }: any) => <div>{message}</div>,
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("./PageSkeleton", () => ({
  PageSkeleton: () => <div />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: any) => <textarea {...props} />,
}));

describe("OperationsAgentSetupNotice", () => {
  it("checks Hermes CLI readiness before offering to create the Ops agent", () => {
    const html = renderToStaticMarkup(
      <OperationsAgentSetupNotice
        checking={false}
        creating={false}
        completed={false}
        environment={{
          adapterType: "hermes_local",
          status: "fail",
          checks: [{
            code: "hermes_cli_not_found",
            level: "error",
            message: "Hermes CLI \"hermes\" not found in PATH",
            hint: "Install Hermes Agent: pip install hermes-agent",
          }],
          testedAt: "2026-06-26T00:00:00.000Z",
        }}
        error={null}
        compact={false}
        onCreate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(html).toContain("Hermes CLI is not ready.");
    expect(html).toContain("Hermes CLI &quot;hermes&quot; not found in PATH");
    expect(html).toContain("pip install hermes-agent");
    expect(html).toContain("Check again");
    expect(html).not.toContain("Yes, create");
  });
});
