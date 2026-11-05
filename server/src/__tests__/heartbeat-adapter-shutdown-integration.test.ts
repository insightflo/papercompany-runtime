import { randomUUID } from "node:crypto";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, agents, companies, createDb, effectIntents, instanceSettings, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { successfulAdapterResult } from "./heartbeat-raw-provider-session-rotation.helpers.js";

const state = vi.hoisted(() => ({ lifecycle: null as RuntimeExecutionLifecycle | null, stopAtLookup: false, execute: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => {
    if (state.stopAtLookup) state.lifecycle!.beginShutdown("SIGTERM");
    return { supportsLocalAgentJwt: false, execute: state.execute };
  },
  runningProcesses: new Map(),
}));
vi.mock("../services/runtime-execution-lifecycle.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/runtime-execution-lifecycle.js")>();
  return { ...actual, runtimeExecutionLifecycle: {
    createScope: (...args: Parameters<RuntimeExecutionLifecycle["createScope"]>) => state.lifecycle!.createScope(...args),
    beginShutdown: (...args: Parameters<RuntimeExecutionLifecycle["beginShutdown"]>) => state.lifecycle!.beginShutdown(...args),
    shutdownState: () => state.lifecycle!.shutdownState(),
  } };
});
import { heartbeatService } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { createRuntimeExecutionLifecycle } from "../services/runtime-execution-lifecycle.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("heartbeat adapter shutdown integration", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-adapter-shutdown-integration-");
    db = createDb(tempDb.connectionString);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: {} }).onConflictDoNothing();
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it.each([[false, false], [true, false], [false, true], [true, true]])("leaves an unstarted run queued and executes it once after restart (issue=%s, finalization=%s)", async (withIssue, finalization) => {
    await db.update(instanceSettings).set({ experimental: { enableHeartbeatFinalizationV1: finalization } }).where(eq(instanceSettings.singletonKey, "default"));
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Shutdown integration", issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const issueId = withIssue ? randomUUID() : null;
    if (issueId) await db.insert(issues).values({ id: issueId, companyId, title: "Shutdown linked issue", status: "todo", assigneeAgentId: agentId });
    state.lifecycle = createRuntimeExecutionLifecycle();
    state.stopAtLookup = true;
    state.execute.mockReset().mockResolvedValue(successfulAdapterResult());
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", issueId ? { issueId } : {}, "manual", { actorType: "system", actorId: "test" });
    expect(run).toBeTruthy();
    await waitForHeartbeatExecutionsToDrain(db);
    expect(state.execute).not.toHaveBeenCalled();
    expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "queued", startedAt: null, errorCode: null, processLossRetryCount: 0 });
    const [intent] = await db.select().from(effectIntents).where(eq(effectIntents.attemptRunId, run!.id));
    expect(intent).toMatchObject({ status: "intent", resultSummary: null, appliedAt: null });
    if (issueId) {
      const [issue] = await db.select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId }).from(issues).where(eq(issues.id, issueId));
      expect(issue).toMatchObject({ executionRunId: run!.id, checkoutRunId: run!.id });
    }
    const [wakeBefore] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, run!.id));
    expect(wakeBefore).toMatchObject({ status: "queued", claimedAt: null });
    state.stopAtLookup = false;
    state.lifecycle = createRuntimeExecutionLifecycle();
    await heartbeat.resumeQueuedRuns(agentId);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "succeeded" });
    if (issueId) {
      const [issue] = await db.select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId }).from(issues).where(eq(issues.id, issueId));
      expect(issue).toMatchObject({ executionRunId: null, checkoutRunId: null });
    }
  }, 60_000);
  it("preserves a result that started before shutdown without a duplicate invocation", async () => {
    await db.update(instanceSettings).set({ experimental: {} }).where(eq(instanceSettings.singletonKey, "default"));
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Started result", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    state.lifecycle = createRuntimeExecutionLifecycle();
    state.stopAtLookup = false;
    let finish!: (value: ReturnType<typeof successfulAdapterResult>) => void;
    state.execute.mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual", { actorType: "system", actorId: "test" });
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledTimes(1));
    state.lifecycle.beginShutdown("SIGTERM");
    finish(successfulAdapterResult());
    await waitForHeartbeatExecutionsToDrain(db);
    expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "succeeded" });
    expect(state.execute).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("requeues when shutdown arrives inside adapter preparation before its first child", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Child boundary", issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    state.lifecycle = createRuntimeExecutionLifecycle(); state.stopAtLookup = false;
    const onSpawn = vi.fn(async () => {});
    state.execute.mockReset().mockImplementation(async () => {
      state.lifecycle!.beginShutdown("SIGTERM");
      await runChildProcess("boundary-integration", process.execPath, ["-e", "process.exit(0)"],
        { cwd: process.cwd(), env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {}, onSpawn });
      return successfulAdapterResult();
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual", { actorType: "system", actorId: "test" });
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledOnce());
    await waitForHeartbeatExecutionsToDrain(db);
    expect(onSpawn).not.toHaveBeenCalled();
    expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "queued", errorCode: null });
  }, 60_000);

});
