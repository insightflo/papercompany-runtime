import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "@paperclipai/shared";
import { approvalsApi } from "./approvals";
import { api } from "./client";
vi.mock("./client", () => ({ api: { post: vi.fn().mockResolvedValue({}), get: vi.fn() } }));
describe("replacement approval routing", () => {
  const approval = { id: "approval", companyId: "company", type: "workflow_replacement" } as Approval;
  beforeEach(() => vi.clearAllMocks());
  it.each([["approve", "approve"], ["reject", "reject"], ["requestRevision", "request-revision"], ["resubmit", "resubmit"]] as const)("%s uses the board endpoint", async (method, route) => {
    await approvalsApi[method](approval);
    expect(api.post).toHaveBeenCalledWith(`/companies/company/workflow-replacements/approval/${route}`, expect.any(Object));
  });
  it("ordinary approvals keep the existing API", async () => {
    await approvalsApi.approve({ ...approval, type: "hire_agent" });
    expect(api.post).toHaveBeenCalledWith("/approvals/approval/approve", expect.any(Object));
  });
});
