import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import { pluginRoutes } from "../routes/plugins.js";
import { errorHandler } from "../middleware/index.js";
import { conflict } from "../errors.js";
const mocks = vi.hoisted(() => ({ getById: vi.fn(), getByKey: vi.fn(), trigger: vi.fn(), updateDefinition: vi.fn(), getDefinition: vi.fn(), precheck: vi.fn() }));
vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => mocks }));
vi.mock("../services/plugin-lifecycle.js", () => ({ pluginLifecycleManager: () => ({}) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));
vi.mock("../services/workflow/engine.js", () => ({ workflowService: mocks }));
vi.mock("../services/workflow/replacement-admission.js", () => ({ assertAgentReplacementRequired: mocks.precheck }));
function app() {
  const writes = vi.fn(() => { throw new Error("unexpected plugin database write"); });
  const worker = { call: vi.fn() };
  const a = express(); a.use(express.json()); a.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId: "operator", companyIds: ["company-1"] }; next();
  });
  a.use("/api", pluginRoutes({ update: writes, insert: writes, delete: writes } as never, {} as never, undefined, undefined, undefined, { workerManager: worker as never }));
  a.use(errorHandler); return { a, writes, worker };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.precheck.mockResolvedValue(undefined);
  const plugin = { id: "plugin-1", pluginKey: "insightflo.workflow-engine", packageName: "@insightflo/workflow-engine", status: "ready", manifestJson: {} };
  mocks.getById.mockResolvedValue(plugin); mocks.getByKey.mockResolvedValue(plugin);
});
it("replacement rejection uses approved native definition without refreshing plugin definition or writing", async () => {
  const { a, writes, worker } = app(); mocks.trigger.mockRejectedValue(conflict("replacement_operator_approval_required"));
  const res = await request(a).post("/api/plugins/plugin-1/actions/start-workflow").send({ companyId: "company-1", workflowId: "workflow-1", missionId: "mission-1", replacementIntent: { schemaVersion: 1 } });
  expect(res.status).toBe(409); expect(res.body.error).toBe("replacement_operator_approval_required");
  expect(mocks.trigger).toHaveBeenCalledOnce(); expect(mocks.getDefinition).not.toHaveBeenCalled();
  expect(mocks.updateDefinition).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(worker.call).not.toHaveBeenCalled();
});
it("missing-intent precheck refusal happens before plugin refresh", async () => {
  const { a, writes, worker } = app(); mocks.precheck.mockRejectedValue(conflict("replacement_authority_required"));
  const res = await request(a).post("/api/plugins/plugin-1/actions/start-workflow").send({ companyId: "company-1", workflowId: "workflow-1", missionId: "mission-1" });
  expect(res.status).toBe(409); expect(mocks.trigger).not.toHaveBeenCalled();
  expect(mocks.getDefinition).not.toHaveBeenCalled(); expect(mocks.updateDefinition).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(worker.call).not.toHaveBeenCalled();
});
