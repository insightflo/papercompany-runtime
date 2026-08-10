import { describe, expect, it, vi } from "vitest";
import { agents, companySkills, heartbeatRuns, issues } from "@paperclipai/db";
import { standaloneIssueExecutionContractService } from "../services/standalone-issue-execution-contract.js";

const activeRun = vi.hoisted(() => ({ current: null as { id: string } | null }));

vi.mock("@paperclipai/adapter-utils/server-utils", () => ({
  readPaperclipSkillSyncPreference: () => ({ desiredSkills: ["skill-a"] }),
}));
vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => ({
    resolveRequestedSkillKeys: vi.fn(async (_companyId: string, refs: string[]) => refs),
    listRuntimeSkillEntries: vi.fn(async () => [{ key: "skill-a" }]),
  }),
}));
vi.mock("../services/workflow/tool-catalog.js", () => ({
  listWorkflowToolCatalog: vi.fn(async () => ({
    tools: [
      { name: "tool-a", displayName: "tool-a", description: "", source: "core", enabled: true },
      { name: "tool-b", displayName: "tool-b", description: "", source: "core", enabled: true },
    ],
    grants: [{ agentId: "agent-1", agentName: "Agent", toolName: "tool-a", source: "core" }],
    sources: { core: { available: true, count: 1 }, toolRegistry: { available: false, installed: false, count: 0 } },
  })),
}));
vi.mock("../adapters/index.js", () => ({
  findServerAdapter: () => ({ listSkills: vi.fn() }),
}));

const issue = {
  id: "issue-1",
  companyId: "company-1",
  title: "Manual issue",
  description: "Do the work",
  assigneeAgentId: "agent-1",
  projectId: null,
  missionId: null,
  originKind: "manual",
  metadata: null,
};
const agent = { id: "agent-1", companyId: "company-1", adapterType: "codex_local", adapterConfig: {} };
const skill = { key: "skill-a", slug: "skill-a", compatibility: "compatible", status: "active" };

function fakeDb(issueRow = issue) {
  const db = {
    select: vi.fn(() => {
      let table: unknown;
      const query = {
        from(value: unknown) { table = value; return query; },
        where() { return query; },
        limit() { return query; },
        then(resolve: (value: unknown[]) => unknown) {
          const rows = table === issues ? [issueRow] : table === agents ? [agent] : table === companySkills ? [skill] : table === heartbeatRuns ? (activeRun.current ? [activeRun.current] : []) : [];
          return Promise.resolve(rows).then(resolve);
        },
      };
      return query;
    }),
    insert: vi.fn(() => ({
      values: () => ({
        onConflictDoUpdate: () => Promise.resolve(),
      }),
    })),
  };
  return db as any;
}

const body = {
  requiredSkillRefs: ["skill-a"],
  requiredToolNames: ["tool-a"],
  allowedToolNames: ["tool-a"],
  completionContract: { requiredEvidence: ["artifact"], independentQaRequired: true, approvalRequired: false },
};

describe("standalone issue execution contract service", () => {
  it("validates and persists the exact V2 contract fields", async () => {
    activeRun.current = null;
    const result = await standaloneIssueExecutionContractService(fakeDb()).put("company-1", "issue-1", body);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.response.contract).toEqual(expect.objectContaining({
      version: 2,
      executionMode: "standalone",
      issue: { id: "issue-1", companyId: "company-1", assigneeAgentId: "agent-1", originKind: "manual" },
      requiredSkillRefs: ["skill-a"],
      toolPermissionContract: { requiredToolNames: ["tool-a"], allowedToolNames: ["tool-a"] },
      completionContract: body.completionContract,
    }));
    expect(result.response.effective).toEqual({ skillRefs: ["skill-a"], toolNames: ["tool-a"] });
  });

  it("rejects writes for non-manual issue origins", async () => {
    const result = await standaloneIssueExecutionContractService(fakeDb({ ...issue, originKind: "workflow_execution" })).put("company-1", "issue-1", body);
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.response.blockers).toContain("issue_not_manual");
  });

  it("retains valid effective skills when a sibling reference is missing", async () => {
    const result = await standaloneIssueExecutionContractService(fakeDb()).put("company-1", "issue-1", { ...body, requiredSkillRefs: ["skill-a", "missing-skill"] });
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.response.effective.skillRefs).toEqual(["skill-a"]);
    expect(result.response.blockers).toContain("skill_not_found");
  });

  it("omits allowed tools that are not granted", async () => {
    const result = await standaloneIssueExecutionContractService(fakeDb()).put("company-1", "issue-1", { ...body, requiredToolNames: [], allowedToolNames: ["tool-b"] });
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.response.effective.toolNames).toEqual([]);
    expect(result.response.blockers).toContain("tool_not_granted:tool-b");
  });

  it("rejects writes while an issue has an active heartbeat run", async () => {
    activeRun.current = { id: "run-1" };
    const result = await standaloneIssueExecutionContractService(fakeDb()).put("company-1", "issue-1", body);
    expect(result).toEqual({ kind: "conflict", reason: "active_run", runId: "run-1" });
    activeRun.current = null;
  });
});
