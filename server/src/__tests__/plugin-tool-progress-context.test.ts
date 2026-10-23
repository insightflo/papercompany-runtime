import express from "express";
import type { Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import { resetToolErrorHygieneForTests } from "../services/tool-result-hygiene.js";
import type { RunToolAuthorizationRun } from "../services/workflow/plugin-tool-authorization.js";

const core = vi.hoisted(() => ({
  executeCoreWorkflowTool: vi.fn(),
  resolveRunStepEnv: vi.fn(),
}));
const catalog = vi.hoisted(() => ({ listWorkflowToolCatalog: vi.fn() }));
vi.mock("../services/workflow/core-tool-executor.js", () => core);
vi.mock("../services/workflow/tool-catalog.js", () => catalog);
vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => ({}) }));
vi.mock("../services/plugin-lifecycle.js", () => ({ pluginLifecycleManager: () => ({}) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));
vi.mock("../services/workflow/engine.js", () => ({ workflowService: {} }));
vi.mock("../services/issues.js", () => ({ issueService: () => ({}) }));
vi.mock("../services/work-products.js", () => ({ workProductService: () => ({}) }));
vi.mock("../services/workflow/dag-engine.js", () => ({ completeWorkflowToolStepFromResult: vi.fn() }));

const tool = "daily-tech-scout";
const runContext = { companyId: "company-1", agentId: "agent-1", runId: "target-run" };
const stepEnv = {
  PAPERCLIP_WORKFLOW_RUN_ID: "workflow-1",
  PAPERCLIP_WORKFLOW_STEP_ID: "step-1",
  PAPERCLIP_RUN_ID: "env-is-not-the-actor",
};
const target: RunToolAuthorizationRun = {
  id: runContext.runId,
  companyId: runContext.companyId,
  agentId: runContext.agentId,
  status: "running",
  contextSnapshot: { paperclipWorkflowStepToolContract: { toolNames: [tool] } },
};
const states = [
  { label: "matching", runId: runContext.runId },
  { label: "different", runId: "authenticated-other-run" },
  { label: "absent", runId: undefined },
];
function agent(runId: string | undefined, source: "agent_key" | "agent_jwt" = "agent_key"): Request["actor"] {
  return { type: "agent", source, companyId: "company-1", agentId: "agent-1", runId, keyId: "private-key-id" };
}
function fixture(actor: Request["actor"], run: RunToolAuthorizationRun | null = target) {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(async () => run ? [run] : []),
  };
  const db = { select: vi.fn(() => query) };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", pluginRoutes(db as never, {} as never));
  app.use(errorHandler);
  return { app, db };
}
function post(app: ReturnType<typeof fixture>["app"], extra: Record<string, unknown> = {}) {
  return request(app).post("/api/plugins/tools/execute").send({ tool, runContext, ...extra });
}
function expectCall(db: ReturnType<typeof fixture>["db"], actor: Request["actor"], parameters: unknown = {}) {
  expect(core.resolveRunStepEnv).toHaveBeenCalledExactlyOnceWith(db, runContext.runId);
  expect(core.executeCoreWorkflowTool).toHaveBeenCalledExactlyOnceWith({
    db,
    companyId: runContext.companyId,
    agentId: runContext.agentId,
    issueId: null,
    heartbeatRunId: actor.type === "agent" ? runContext.runId : undefined,
    toolName: tool,
    parameters,
    requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    workflowRunId: "workflow-1",
    stepId: "step-1",
    stepEnv,
    progressEvidenceContext: {
      actor: {
        type: actor.type, source: actor.source, companyId: actor.companyId,
        agentId: actor.agentId, runId: actor.runId,
      },
      targetRunId: runContext.runId,
    },
  });
  expect(core.resolveRunStepEnv.mock.invocationCallOrder[0])
    .toBeLessThan(core.executeCoreWorkflowTool.mock.invocationCallOrder[0]!);
  expect(core.executeCoreWorkflowTool.mock.calls[0]![0].progressEvidenceContext.actor).not.toBe(actor);
}

// Independent contract: c07-minimum-plan-adopted.md:7–23,44–46 requires context
// transport with unchanged execution, including mismatched/missing actor runs.
// Authorization below is the real authorizeRunToolExecution used by pluginRoutes.
describe("plugin route progress evidence context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetToolErrorHygieneForTests();
    core.resolveRunStepEnv.mockReset().mockResolvedValue(stepEnv);
    core.executeCoreWorkflowTool.mockReset().mockResolvedValue({ status: 200, body: { content: "ok", source: "core" } });
    catalog.listWorkflowToolCatalog.mockReset().mockResolvedValue({
      tools: [{ name: tool, source: "core", enabled: true }],
      grants: [{ agentId: runContext.agentId, toolName: tool }],
    });
  });

  describe.each(states)("$label actor run", ({ runId }) => {
    it.each(["agent_key", "agent_jwt"] as const)("copies only authenticated fields for %s despite forged body/env/parameters", async (source) => {
      const actor = agent(runId, source);
      const { app, db } = fixture(actor);
      const forged = { type: "board", source: "session", companyId: "forged-company", agentId: "forged-agent", runId: "forged-run" };
      const parameters = { actor: forged, runId: "forged-run", env: { PAPERCLIP_RUN_ID: "forged-run" } };
      const res = await post(app, {
        parameters, actor: forged, env: parameters.env,
        progressEvidenceContext: { actor: forged, targetRunId: "forged-run" },
        runContext: { ...runContext, actor: forged, progressEvidenceContext: { actor: forged } },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ content: "ok", source: "core" });
      expectCall(db, actor, parameters);
    });

    it("preserves returned core errors", async () => {
      core.executeCoreWorkflowTool.mockResolvedValue({ status: 422, body: { error: "tool_progress_invalid", source: "core" } });
      const actor = agent(runId);
      const { app, db } = fixture(actor);
      const res = await post(app);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: "tool_progress_invalid", source: "core" });
      expectCall(db, actor);
    });

    it("preserves thrown core errors", async () => {
      core.executeCoreWorkflowTool.mockRejectedValue(new Error("core unavailable"));
      const actor = agent(runId);
      const { app, db } = fixture(actor);
      const res = await post(app);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "core unavailable" });
      expectCall(db, actor);
    });

    it("preserves env lookup failure before core execution", async () => {
      core.resolveRunStepEnv.mockRejectedValue(new Error("step env unavailable"));
      const { app, db } = fixture(agent(runId));
      const res = await post(app);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "step env unavailable" });
      expect(core.resolveRunStepEnv).toHaveBeenCalledExactlyOnceWith(db, runContext.runId);
      expect(core.executeCoreWorkflowTool).not.toHaveBeenCalled();
    });
  });

  it("keeps board heartbeatRunId absent and never borrows body identity", async () => {
    const actor: Request["actor"] = { type: "board", source: "session", userId: "user-1", companyIds: ["company-1"] };
    const { app, db } = fixture(actor);
    const res = await post(app, { actor: agent(runContext.runId), parameters: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ content: "ok", source: "core" });
    expectCall(db, actor);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("keeps a fresh requestId per invocation and null workflow defaults", async () => {
    core.resolveRunStepEnv.mockResolvedValue({});
    const { app } = fixture(agent(undefined));
    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(200);
    const inputs = core.executeCoreWorkflowTool.mock.calls.map(([input]) => input);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].requestId).not.toBe(inputs[1].requestId);
    for (const input of inputs) {
      expect(input.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(input.workflowRunId).toBeNull();
      expect(input.stepId).toBeNull();
      expect(input.stepEnv).toEqual({});
      expect(input.heartbeatRunId).toBe(runContext.runId);
      expect(input.progressEvidenceContext.actor.runId).toBeUndefined();
    }
  });

  it.each([
    { label: "missing run", run: null, error: "Agent run context is not valid for tool execution" },
    { label: "wrong agent", run: { ...target, agentId: "another-agent" }, error: "Agent run context is not valid for tool execution" },
    { label: "stopped run", run: { ...target, status: "succeeded" }, error: "Agent run context is not running" },
    { label: "disallowed tool", run: { ...target, contextSnapshot: { paperclipWorkflowStepToolContract: { toolNames: ["other-tool"] } } }, error: `Workflow tool "${tool}" is not allowed for this agent run` },
  ])("preserves authorization denial: $label", async ({ run, error }) => {
    const { app } = fixture(agent(runContext.runId), run);
    const res = await post(app, { progressEvidenceContext: { actor: agent(runContext.runId) } });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error });
    expect(core.resolveRunStepEnv).not.toHaveBeenCalled();
    expect(core.executeCoreWorkflowTool).not.toHaveBeenCalled();
  });

  it.each(["grant", "enabled"])("preserves missing %s denial", async (missing) => {
    catalog.listWorkflowToolCatalog.mockResolvedValue({
      tools: [{ name: tool, source: "core", enabled: missing !== "enabled" }],
      grants: missing === "grant" ? [] : [{ agentId: runContext.agentId, toolName: tool }],
    });
    const { app } = fixture(agent(undefined));
    const res = await post(app);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: missing === "grant"
      ? `Workflow tool "${tool}" is not granted to this agent run`
      : `Workflow tool "${tool}" is not registered or enabled` });
    expect(core.resolveRunStepEnv).not.toHaveBeenCalled();
    expect(core.executeCoreWorkflowTool).not.toHaveBeenCalled();
  });
});
