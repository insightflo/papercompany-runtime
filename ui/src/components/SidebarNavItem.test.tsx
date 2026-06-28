// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { forwardRef, type ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { SidebarNavItem } from "./SidebarNavItem";

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: {
      id: "company-1",
      name: "Research Company",
      issuePrefix: "RES",
    },
  }),
}));

vi.mock("@/lib/router", async () => {
  const React = await import("react");
  const RouterDom = await import("react-router-dom");
  const { applyCompanyPrefix } = await import("../lib/company-routes");
  return {
    ...RouterDom,
    NavLink: React.forwardRef<
      HTMLAnchorElement,
      React.ComponentProps<typeof RouterDom.NavLink>
    >(function CompanyNavLink({ to, ...props }, ref) {
      const resolvedTo = typeof to === "string" ? applyCompanyPrefix(to, "RES") : to;
      return <RouterDom.NavLink ref={ref} to={resolvedTo} {...props} />;
    }),
  };
});

const Icon = forwardRef<SVGSVGElement, ComponentProps<LucideIcon>>(
  function Icon(props, ref) {
    return <svg ref={ref} data-icon="quality" {...props} />;
  },
) as LucideIcon;

describe("SidebarNavItem", () => {
  it("renders the Quality menu link with the active company prefix", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/RES/dashboard"]}>
        <SidebarNavItem to="/quality" label="Quality" icon={Icon} />
      </MemoryRouter>,
    );

    expect(html).toContain('href="/RES/quality"');
    expect(html).not.toContain('href="/quality"');
  });
});
