/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CompanyContext } from "../context/CompanyContext";
import { koCompanyContext } from "../test-utils/koCompanyContext";
import { CompanyLanguageProvider } from "../lib/companyLanguage";
import { ApprovalDetail } from "./ApprovalDetail";
import { Approvals } from "./Approvals";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";

const { setBreadcrumbs } = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, toggleSidebar: vi.fn() }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(), useParams: () => ({ approvalId: "approval-1" }),
  useSearchParams: () => [new URLSearchParams()], useLocation: () => ({ pathname: "/approvals" }),
}));
const approval = {
  id: "approval-1", companyId: "company", type: "hire_agent" as const, status: "pending" as const,
  payload: { agentId: "agent-original", name: "Original name" }, requestedByAgentId: null,
  requestedByUserId: "board", requestedByPluginId: null, decisionNote: null,
  decidedByUserId: null, decidedAt: null, createdAt: new Date(), updatedAt: new Date(),
};
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
async function render(page: ReactNode, language: "ko" | "en" = "ko") {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><CompanyContext.Provider value={koCompanyContext}><CompanyLanguageProvider language={language}>{page}</CompanyLanguageProvider></CompanyContext.Provider></QueryClientProvider>);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === text)!;
  expect(button).toBeTruthy();
  await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
}
describe("approval page system chrome", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.spyOn(approvalsApi, "get").mockResolvedValue(approval);
    vi.spyOn(approvalsApi, "list").mockResolvedValue([]);
    vi.spyOn(approvalsApi, "listComments").mockResolvedValue([]);
    vi.spyOn(approvalsApi, "listIssues").mockResolvedValue([]);
    vi.spyOn(agentsApi, "list").mockResolvedValue([]);
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.restoreAllMocks(); setBreadcrumbs.mockClear(); });
  it("updates detail breadcrumbs on language changes and localizes revision fallback", async () => {
    vi.spyOn(approvalsApi, "requestRevision").mockRejectedValue("failure");
    await render(<ApprovalDetail />);
    expect(setBreadcrumbs.mock.lastCall?.[0][0]).toEqual({ label: "승인", href: "/approvals" });
    await click("수정 요청");
    expect(host.textContent).toContain("수정 요청을 보내지 못했습니다.");
    expect(host.textContent).toContain("Original name");
    await render(<ApprovalDetail />, "en");
    expect(setBreadcrumbs.mock.lastCall?.[0][0]).toEqual({ label: "Approvals", href: "/approvals" });
  });
  it("localizes resubmit fallback but preserves server Error text", async () => {
    vi.mocked(approvalsApi.get).mockResolvedValue({ ...approval, status: "revision_requested" });
    const resubmit = vi.spyOn(approvalsApi, "resubmit").mockRejectedValue("failure");
    await render(<ApprovalDetail />);
    await click("재제출로 표시");
    expect(host.textContent).toContain("재제출하지 못했습니다.");
    resubmit.mockRejectedValue(new Error("Raw server error"));
    await click("재제출로 표시");
    expect(host.textContent).toContain("Raw server error");
  });
  it("localizes comment fallback", async () => {
    vi.spyOn(approvalsApi, "addComment").mockRejectedValue("failure");
    await render(<ApprovalDetail />);
    await act(async () => {
      const input = host.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Original comment");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("댓글 게시");
    expect(host.textContent).toContain("댓글을 게시하지 못했습니다.");
    expect(approvalsApi.addComment).toHaveBeenCalledWith("approval-1", "Original comment");
  });
  it("localizes irreversible delete confirmation while retaining cancel gating and delete fallback", async () => {
    vi.mocked(approvalsApi.get).mockResolvedValue({ ...approval, status: "rejected" });
    const remove = vi.spyOn(agentsApi, "remove").mockRejectedValue("failure");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await render(<ApprovalDetail />);
    await click("거절된 에이전트 삭제");
    expect(confirm).toHaveBeenCalledWith("거절된 에이전트를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.");
    expect(remove).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await click("거절된 에이전트 삭제");
    expect(remove).toHaveBeenCalledWith("agent-original");
    expect(host.textContent).toContain("삭제하지 못했습니다.");
  });
  it("updates list breadcrumbs when company language changes", async () => {
    await render(<Approvals />);
    expect(setBreadcrumbs.mock.lastCall?.[0]).toEqual([{ label: "승인" }]);
    await render(<Approvals />, "en");
    expect(setBreadcrumbs.mock.lastCall?.[0]).toEqual([{ label: "Approvals" }]);
  });
});
