import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, missions, workflowDefinitions, workflowRuns, workflowStepRuns,
  workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as shadow from "../services/mission-oversight-shadow.js";
import { buildWorkflowRetryMetadata } from "../services/workflow/retry-metadata.js";
import { createMissionOwnerSupervisionMonitor } from "../services/mission-owner-supervision-monitor.js";

const mocks = vi.hoisted(() => ({ sweep: vi.fn(async () => ({ missionIds: [], missions: [] })), warn: vi.fn() }));
vi.mock("../services/missions.js", () => ({ missionService: () => ({ runActiveMissionOwnerSupervision: mocks.sweep }) }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const laneModule = "../services/mission-oversight-liveness-lane.js";
// Keep missing implementation failures inside each named RED rather than suite collection.
const loadLane = () => import(/* @vite-ignore */ laneModule) as Promise<typeof import("../services/mission-oversight-liveness-lane.js")>;
const NOW = new Date("2026-10-16T02:30:00Z");
const BUCKET_MS = 2 * 60 * 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("mission oversight liveness lane (isolated PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { pg = await startEmbeddedPostgresTestDatabase("paperclip-liveness-lane-"); db = createDb(pg.connectionString); }, 60_000);
  afterAll(async () => { try { await db?.$client.end({ timeout: 5 }); } finally { await pg?.cleanup(); } });
  beforeEach(async () => {
    await db.update(missions).set({ status: "paused" });
    await db.delete(workflowTransitionEvents);
    mocks.warn.mockClear(); mocks.sweep.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  async function world(options: { status?: string; stepStatus?: string; observedAt?: Date; generation?: number;
    stepGeneration?: number; preStart?: boolean; waiting?: boolean } = {}) {
    const [company] = await db.insert(companies).values({ name: "Liveness lane", issuePrefix: `L${randomUUID()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Owner" }).returning();
    const [mission] = await db.insert(missions).values({ companyId: company.id, ownerAgentId: agent.id,
      title: "Liveness lane", status: options.status ?? "active", createdAt: ago(40 * 60_000) }).returning();
    const [definition] = await db.insert(workflowDefinitions).values({ companyId: company.id, name: "Build",
      stepsJson: [{ id: "build", type: "agent", name: "Build" }] }).returning();
    const [run] = await db.insert(workflowRuns).values({ companyId: company.id, missionId: mission.id, workflowId: definition.id,
      status: "running", triggeredBy: "test", createdAt: ago(40 * 60_000), startedAt: ago(40 * 60_000) }).returning();
    const [step] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "build",
      status: options.stepStatus ?? "running", executionGeneration: options.stepGeneration ?? 2,
      startedAt: ago(40 * 60_000), metadata: options.waiting ? { workflowRetry: buildWorkflowRetryMetadata({ retryNumber: 1,
        maxRetries: 2, delaySeconds: 600, now: NOW, sourceRequestId: null, sourceCompletedAt: null, lastErrorSummary: null }) } : {} }).returning();
    const [hb] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, workflowStepRunId: step.id,
      workflowExecutionGeneration: options.generation ?? 2, status: "running", createdAt: ago(40 * 60_000 + (options.preStart ? 26_000 : 0)),
      startedAt: ago(40 * 60_000), updatedAt: options.observedAt ?? ago(16 * 60_000) }).returning();
    return { company, agent, mission, run, step, hb };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const verdict = (f: World) => shadow.evaluateMissionOversightForMission(db, f.company.id, f.mission.id, new Date());
  const markers = (f: World) => db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, f.company.id), eq(workflowTransitionEvents.missionId, f.mission.id),
    eq(workflowTransitionEvents.eventType, "mission_oversight_liveness_wake")));
  async function lane(wake = vi.fn(async (_input: unknown) => {}), interval: number | undefined = 20) {
    const { createMissionOversightLivenessLane } = await loadLane();
    const result = createMissionOversightLivenessLane(db, { livenessLaneIntervalMs: interval, onMissionOversightLivenessGhostWakeRequested: wake });
    onTestFinished(() => result.stop());
    return { lane: result, wake };
  }

  it("wakes the owner within its interval when a genuine liveness ghost verdict occurs", async () => {
    const f = await world();
    const snapshot = (await shadow.readMissionCadenceSnapshot(db, f.company.id, f.mission.id))!;
    expect(snapshot.heartbeats).toContainEqual(expect.objectContaining({ id: f.hb.id, current: true, allowedIntervalMs: 900_000 }));
    expect(await verdict(f)).toMatchObject({ state: "RUNNING", triggerKind: "liveness_ghost", reasonCode: "heartbeat_stale_while_running" });
    const { lane: fast, wake } = await lane();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }); vi.setSystemTime(NOW);
    fast.start(); fast.start();
    await vi.advanceTimersByTimeAsync(19); expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const idempotencyKey = `mission-oversight-liveness:${f.mission.id}:${Math.floor(NOW.getTime() / BUCKET_MS)}`;
    expect(wake.mock.calls[0][0]).toMatchObject({ mission: { id: f.mission.id, companyId: f.company.id, ownerAgentId: f.agent.id },
      verdict: { state: "RUNNING", triggerKind: "liveness_ghost", reasonCode: "heartbeat_stale_while_running" }, idempotencyKey,
      computedTimestamps: { oldest_running_heartbeat_at: f.hb.updatedAt.toISOString() } });
    expect(await markers(f)).toMatchObject([{ idempotencyKey, layer: "mission_owner_recovery", payload: { schemaVersion: 1,
      state: "RUNNING", triggerKind: "liveness_ghost", reasonCode: "heartbeat_stale_while_running",
      computedTimestamps: { oldest_running_heartbeat_at: f.hb.updatedAt.toISOString() } } }]);
    fast.stop(); await vi.advanceTimersByTimeAsync(BUCKET_MS);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("the same ghost coalesces within the bucket: repeated ticks do not re-wake", async () => {
    const f = await world();
    const { lane: fast, wake } = await lane();
    await fast.run(); await fast.run(); await fast.run();
    expect(wake).toHaveBeenCalledTimes(1); expect(await markers(f)).toHaveLength(1);
    // Two independent processes must race on the PostgreSQL partial unique index.
    const fresh = await world(), other = await lane(wake);
    await Promise.all([fast.run(), other.lane.run()]);
    expect(wake).toHaveBeenCalledTimes(2); expect(await markers(fresh)).toHaveLength(1);
  });

  it("a persistent ghost re-wakes at most once per bucket window", async () => {
    const f = await world();
    const { lane: fast, wake } = await lane();
    await fast.run();
    const boundary = (Math.floor(NOW.getTime() / BUCKET_MS) + 1) * BUCKET_MS;
    vi.setSystemTime(boundary - 1); await fast.run(); expect(wake).toHaveBeenCalledTimes(1);
    vi.setSystemTime(boundary); await fast.run(); await fast.run();
    expect(wake).toHaveBeenCalledTimes(2);
    expect((await markers(f)).map((r) => r.idempotencyKey).sort()).toEqual([
      `mission-oversight-liveness:${f.mission.id}:${Math.floor(NOW.getTime() / BUCKET_MS)}`,
      `mission-oversight-liveness:${f.mission.id}:${Math.floor(boundary / BUCKET_MS)}`,
    ].sort());
  });

  it("fresh heartbeats and non-ghost verdicts never wake", async () => {
    const { lane: fast, wake } = await lane();
    const fresh = await world({ observedAt: ago(900_000 - 1) });
    const failure = await world({ stepStatus: "failed" });
    const ready = await world({ stepStatus: "pending" });
    const waiting = await world({ stepStatus: "pending", waiting: true });
    const idle = await world({ stepStatus: "completed" });
    for (const f of [failure, ready, waiting, idle]) await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.hb.id));
    const initial = await world({ generation: 0, stepGeneration: 0, preStart: true, observedAt: ago(60_000) });
    const assignment = await world({ generation: 0, stepGeneration: 3, observedAt: ago(60_000) });
    for (const f of [initial, assignment]) {
      expect((await shadow.readMissionCadenceSnapshot(db, f.company.id, f.mission.id))!.heartbeats)
        .toContainEqual(expect.objectContaining({ id: f.hb.id, current: true }));
    }
    expect((await Promise.all([fresh, failure, ready, waiting, idle, initial, assignment].map(verdict))).map((v) => [v?.state, v?.triggerKind]))
      .toEqual([["RUNNING", "none"], ["FAILURE_OR_RECOVERY_NEEDED", "immediate_failure"], ["READY_NOT_STARTED", "ready_not_started"],
        ["WAITING_EXPLICIT", "none"], ["IDLE_QUIET", "stall_idle"], ["RUNNING", "none"], ["RUNNING", "none"]]);
    const paused = await world({ status: "paused" });
    await fast.run();
    expect(wake).not.toHaveBeenCalled();
    for (const f of [fresh, failure, ready, waiting, idle, initial, assignment, paused]) expect(await markers(f)).toHaveLength(0);
  });

  it("restart-safe: a recreated lane with the same durable marker does not re-wake", async () => {
    const f = await world({ status: "planning" });
    const first = await lane(); await first.lane.run(); first.lane.stop();
    expect(first.wake).toHaveBeenCalledTimes(1);
    const second = await lane(); await second.lane.run();
    expect(second.wake).not.toHaveBeenCalled(); expect(await markers(f)).toHaveLength(1);
  });

  it("lane failure or latency never gates the monitor sweep", async () => {
    const f = await world(), current = await verdict(f);
    const evaluate = vi.spyOn(shadow, "evaluateMissionOversightForMission");
    const observe = vi.spyOn(shadow, "recordActiveMissionCadenceShadow").mockResolvedValue();
    onTestFinished(() => { evaluate.mockRestore(); observe.mockRestore(); });
    let release!: () => void;
    const held = new Promise<typeof current>((resolve) => { release = () => resolve(current); });
    evaluate.mockImplementationOnce(() => held);
    const wake = vi.fn(async () => {});
    const monitor = createMissionOwnerSupervisionMonitor(db, { runImmediately: false, livenessLaneIntervalMs: 20,
      onMissionOversightLivenessGhostWakeRequested: wake });
    onTestFinished(() => { monitor.stop(); release(); });
    monitor.start();
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await monitor.run(); await monitor.run();
    expect(mocks.sweep).toHaveBeenCalledTimes(2); expect(wake).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(evaluate).toHaveBeenCalledTimes(1); // In-flight ticks never overlap.
    monitor.stop(); release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(wake).not.toHaveBeenCalled(); expect(await markers(f)).toHaveLength(0);
    evaluate.mockRejectedValue(new Error("liveness evaluation unavailable"));
    monitor.start();
    await vi.waitFor(() => expect(mocks.warn.mock.calls.some(([data]) => data?.err?.message === "liveness evaluation unavailable")).toBe(true), { timeout: 5000 });
    await monitor.run(); expect(mocks.sweep).toHaveBeenCalledTimes(3);
    monitor.stop(); expect(wake).not.toHaveBeenCalled();
  });

  it("defaults to five minutes and keeps a durable claim when delivery fails", async () => {
    const f = await world();
    const wake = vi.fn(async () => { expect(await markers(f)).toHaveLength(1); throw new Error("delivery unavailable"); });
    const { createMissionOversightLivenessLane } = await loadLane();
    const fast = createMissionOversightLivenessLane(db, { onMissionOversightLivenessGhostWakeRequested: wake });
    onTestFinished(() => fast.stop());
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }); vi.setSystemTime(NOW);
    fast.start(); await vi.advanceTimersByTimeAsync(300_000 - 1); expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(mocks.warn.mock.calls.map(([data]) => data?.err?.message)).toContain("delivery unavailable"), { timeout: 5000 });
    await fast.run(); expect(wake).toHaveBeenCalledTimes(1); expect(await markers(f)).toHaveLength(1);
  });
});
