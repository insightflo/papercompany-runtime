import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockContractService = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  validateAssigneeChange: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../services/standalone-issue-execution-contract.js", () => ({
  standaloneIssueExecutionContractService: () => mockContractService,
}));
vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  documentService: () => ({ getIssueDocumentPayload: vi.fn(async () => ({})) }),
  executionWorkspaceService: () => ({ getById: vi.fn() }),
  goalService: () => ({ getById: vi.fn(), getDefaultCompanyGoal: vi.fn() }),
  heartbeatService: () => ({ wakeup: vi.fn(), reportRunActivity: vi.fn() }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({ getById: vi.fn(), listByIds: vi.fn() }),
  routineService: () => ({ syncRunStatusForIssue: vi.fn() }),
  workflowService: { syncRunStatusForIssue: vi.fn() },
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
}));

function app(actor: Record<string, unknown>) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  server.use("/api", issueRoutes({} as any, {} as any));
  server.use(errorHandler);
  return server;
}

const contractInput = {
  requiredSkillRefs: ["skill-a"],
  requiredToolNames: ["tool-a"],
  allowedToolNames: ["tool-a"],
  completionContract: { requiredEvidence: ["artifact"], independentQaRequired: false, approvalRequired: false },
};

const contract = {
  contract: {
    version: 2,
    executionMode: "standalone",
    issue: { id: "issue-1", companyId: "company-1", assigneeAgentId: "agent-1", originKind: "manual" },
    requiredSkillRefs: ["skill-a"],
    toolPermissionContract: { requiredToolNames: ["tool-a"], allowedToolNames: ["tool-a"] },
    completionContract: { requiredEvidence: ["artifact"], independentQaRequired: false, approvalRequired: false },
  },
  effective: { skillRefs: ["skill-a"], toolNames: ["tool-a"] },
  blockers: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIssueService.getByIdentifier.mockResolvedValue(null);
  mockContractService.get.mockResolvedValue(contract);
  mockContractService.put.mockResolvedValue({ kind: "ok", response: contract, contentHash: "hash-1" });
  mockContractService.validateAssigneeChange.mockResolvedValue(null);
  mockLogActivity.mockResolvedValue(undefined);
});

describe("standalone issue execution contract routes", () => {
  it("gets the contract and writes it for a board actor", async () => {
    const actor = { type: "board", userId: "board-1", companyIds: ["company-1"], source: "local_implicit" };
    const getResponse = await request(app(actor)).get("/api/companies/company-1/issues/issue-1/execution-contract");
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.contract.executionMode).toBe("standalone");

    const putResponse = await request(app(actor)).put("/api/companies/company-1/issues/issue-1/execution-contract").send(contractInput);
    expect(putResponse.status).toBe(200);
    expect(mockContractService.put).toHaveBeenCalledWith("company-1", "issue-1", contractInput);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue_execution_contract.updated",
      entityId: "issue-1",
    }));
  });

  it("blocks agent PUT requests before calling the service", async () => {
    const response = await request(app({ type: "agent", agentId: "agent-1", companyId: "company-1" }))
      .put("/api/companies/company-1/issues/issue-1/execution-contract")
      .send(contractInput);
    expect(response.status).toBe(403);
    expect(mockContractService.put).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "not_found" }, 404],
    [{ kind: "conflict", reason: "active_run", runId: "run-1" }, 409],
    [{ kind: "invalid", response: { ...contract, blockers: ["skill_not_found"] } }, 422],
  ])("maps %j to HTTP %i", async (result, status) => {
    mockContractService.put.mockResolvedValue(result);
    const response = await request(app({ type: "board", userId: "board-1", companyIds: ["company-1"], source: "local_implicit" }))
      .put("/api/companies/company-1/issues/issue-1/execution-contract")
      .send(contractInput);
    expect(response.status).toBe(status);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects an invalid standalone assignee change before updating the issue", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      assigneeAgentId: "00000000-0000-0000-0000-000000000001",
      assigneeUserId: null,
      status: "todo",
    });
    mockContractService.validateAssigneeChange.mockResolvedValue({
      blockers: ["tool_not_granted:tool-a"],
      effective: { skillRefs: [], toolNames: [] },
    });

    const response = await request(app({
      type: "board",
      userId: "board-1",
      companyIds: ["company-1"],
      source: "local_implicit",
    }))
      .patch("/api/issues/issue-1")
      .send({ assigneeAgentId: "00000000-0000-0000-0000-000000000002" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "execution_contract_assignee_invalid",
      blockers: ["tool_not_granted:tool-a"],
    });
    expect(mockContractService.validateAssigneeChange).toHaveBeenCalledWith(
      "company-1",
      "issue-1",
      "00000000-0000-0000-0000-000000000002",
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
