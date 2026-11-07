import { randomUUID } from "node:crypto";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, agents, companies, createDb, effectIntents, heartbeatRuns, instanceSettings, issues } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  afterEach(() => { vi.unstubAllEnvs(); });

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

  it("does not promote a queued run while shutdown is in progress", async () => {
    await db.update(instanceSettings).set({ experimental: {} }).where(eq(instanceSettings.singletonKey, "default"));
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Shutdown drain guard", issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    state.lifecycle = createRuntimeExecutionLifecycle(); state.stopAtLookup = false;
    let finish!: (value: ReturnType<typeof successfulAdapterResult>) => void;
    state.execute.mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const heartbeat = heartbeatService(db);
    const running = await heartbeat.invoke(agentId, "on_demand", {}, "manual", { actorType: "system", actorId: "test" });
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledTimes(1));
    // 같은 agent 의 유일한 슬롯을 점유한 채로 대기 run 을 하나 남긴다.
    const [queued] = await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "on_demand", status: "queued",
    }).returning();
    state.lifecycle.beginShutdown("SIGTERM");
    finish(successfulAdapterResult());
    await waitForHeartbeatExecutionsToDrain(db);
    expect(await heartbeat.getRun(running!.id)).toMatchObject({ status: "succeeded" });
    // 종료 중에는 성공한 정착 run 이 있어도 대기 run 을 승격하지 않는다.
    expect(await heartbeat.getRun(queued!.id)).toMatchObject({ status: "queued", startedAt: null });
    expect(state.execute).toHaveBeenCalledTimes(1);
  }, 60_000);

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "fails safely and retries a rejected first child once after restart (issue=%s, finalization=%s)", async (withIssue, finalization) => {
    vi.stubEnv("PAPERCLIP_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC", "300");
    await db.update(instanceSettings).set({ experimental: { enableHeartbeatFinalizationV1: finalization } }).where(eq(instanceSettings.singletonKey, "default"));
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Child boundary", issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const issueId = withIssue ? randomUUID() : null;
    if (issueId) await db.insert(issues).values({ id: issueId, companyId, title: "Retry linked issue", status: "todo", assigneeAgentId: agentId });
    state.lifecycle = createRuntimeExecutionLifecycle(); state.stopAtLookup = false;
    const onSpawn = vi.fn(async () => {});
    state.execute.mockReset().mockImplementationOnce(async () => {
      state.lifecycle!.beginShutdown("SIGTERM");
      await runChildProcess("boundary-integration", process.execPath, ["-e", "process.exit(0)"],
        { cwd: process.cwd(), env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {}, onSpawn });
      return successfulAdapterResult();
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", issueId ? { issueId } : {}, "manual", { actorType: "system", actorId: "test" });
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledOnce());
    await waitForHeartbeatExecutionsToDrain(db);
    expect(onSpawn).not.toHaveBeenCalled();
    expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "failed", errorCode: "child_process_start_rejected" });
    const retry = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({ status: "queued", processLossRetryCount: 1, issueId });
    state.lifecycle = createRuntimeExecutionLifecycle();
    state.execute.mockReset().mockImplementationOnce(async () => {
      await runChildProcess("boundary-restart", process.execPath, ["-e", "process.exit(0)"],
        { cwd: process.cwd(), env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {}, onSpawn });
      return successfulAdapterResult();
    });
    await heartbeat.resumeQueuedRuns(agentId);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(await heartbeat.getRun(retry[0]!.id)).toMatchObject({ status: "succeeded" });
    expect(onSpawn).toHaveBeenCalledOnce();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, retry[0]!.id))).toHaveLength(0);
  }, 60_000);

  it.each(["disabled", "exhausted", "expired"])("does not retry a rejected first child when the retry budget is %s", async (budget) => {
    vi.stubEnv("PAPERCLIP_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC", budget === "disabled" ? "0" : "300");
    await db.update(instanceSettings).set({ experimental: {} }).where(eq(instanceSettings.singletonKey, "default"));
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retry budget", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    state.lifecycle = createRuntimeExecutionLifecycle(); state.stopAtLookup = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onSpawn = vi.fn(async () => {});
    state.execute.mockReset().mockImplementationOnce(async () => {
      await gate; state.lifecycle!.beginShutdown("SIGTERM");
      await runChildProcess("budget-boundary", process.execPath, ["-e", "process.exit(0)"],
        { cwd: process.cwd(), env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {}, onSpawn });
      return successfulAdapterResult();
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual", { actorType: "system", actorId: "test" });
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledOnce());
    if (budget === "exhausted") await db.update(heartbeatRuns).set({ processLossRetryCount: 1 }).where(eq(heartbeatRuns.id, run!.id));
    if (budget === "expired") await db.update(heartbeatRuns).set({ startedAt: new Date(Date.now() - 301_000) }).where(eq(heartbeatRuns.id, run!.id));
    release(); await waitForHeartbeatExecutionsToDrain(db);
    expect(onSpawn).not.toHaveBeenCalled();
    expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "failed", errorCode: "child_process_start_rejected" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id))).toHaveLength(0);
  }, 60_000);

  it("does not retry after an earlier child already started", async () => {
    vi.stubEnv("PAPERCLIP_ADAPTER_FAILED_TRANSIENT_RETRY_MAX_SEC", "300");
    await db.update(instanceSettings).set({ experimental: {} }).where(eq(instanceSettings.singletonKey, "default"));
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Already started", issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    state.lifecycle = createRuntimeExecutionLifecycle(); state.stopAtLookup = false;
    const onSpawn = vi.fn(async () => {});
    state.execute.mockReset().mockImplementationOnce(async () => {
      const options = { cwd: process.cwd(), env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {}, onSpawn };
      await runChildProcess("started-first", process.execPath, ["-e", "process.exit(0)"], options);
      state.lifecycle!.beginShutdown("SIGTERM");
      await runChildProcess("blocked-second", process.execPath, ["-e", "process.exit(0)"], options);
      return successfulAdapterResult();
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual", { actorType: "system", actorId: "test" });
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledOnce());
    await waitForHeartbeatExecutionsToDrain(db);
    expect(onSpawn).toHaveBeenCalledOnce();
    expect(await heartbeat.getRun(run!.id)).toMatchObject({ status: "failed", errorCode: "child_process_start_rejected" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id))).toHaveLength(0);
  }, 60_000);

});
