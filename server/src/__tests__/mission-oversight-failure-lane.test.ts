import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { agents, companies, createDb, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns,
  workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as shadow from "../services/mission-oversight-shadow.js";
import { createMissionOwnerSupervisionMonitor } from "../services/mission-owner-supervision-monitor.js";

const mocks = vi.hoisted(() => ({ sweep: vi.fn(async () => ({ missionIds: [], missions: [] })), warn: vi.fn() }));
vi.mock("../services/missions.js", () => ({ missionService: () => ({ runActiveMissionOwnerSupervision: mocks.sweep }) }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// Runtime import lets every named RED reach its own assertion, not fail suite collection.
const laneModule = "../services/mission-oversight-failure-lane.js";
const loadLane = () => import(/* @vite-ignore */ laneModule) as Promise<typeof import("../services/mission-oversight-failure-lane.js")>;

describe("mission oversight failure lane (isolated PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { pg = await startEmbeddedPostgresTestDatabase("paperclip-failure-lane-"); db = createDb(pg.connectionString); }, 60_000);
  afterAll(async () => { try { await db?.$client.end({ timeout: 5 }); } finally { await pg?.cleanup(); } });
  beforeEach(async () => { await db.delete(workflowTransitionEvents); });
  afterEach(() => { vi.useRealTimers(); });

  async function world(status = "active", stepStatus = "failed") {
    const [company] = await db.insert(companies).values({ name: "Failure lane", issuePrefix: `F${randomUUID()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Owner" }).returning();
    const [mission] = await db.insert(missions).values({ companyId: company.id, ownerAgentId: agent.id, title: "Failure lane", status }).returning();
    const [oversightIssue] = await db.insert(issues).values({ companyId: company.id, missionId: mission.id,
      assigneeAgentId: agent.id, title: "[OVERSIGHT] Failure lane", status: "in_progress",
      originKind: "mission_main_executor_oversight" }).returning();
    const [definition] = await db.insert(workflowDefinitions).values({ companyId: company.id, name: "Build",
      stepsJson: [{ id: "build", type: "agent", name: "Build" }] }).returning();
    const [run] = await db.insert(workflowRuns).values({ companyId: company.id, missionId: mission.id, workflowId: definition.id,
      status: "running", triggeredBy: "test" }).returning();
    const [step] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "build", status: stepStatus }).returning();
    return { company, agent, mission, oversightIssue, run, step };
  }
  type World = Awaited<ReturnType<typeof world>>;
  async function event(f: World, toStatus = "failed", eventType = "workflow_step_status_transition", createdAt = new Date()) {
    await db.insert(workflowTransitionEvents).values({ companyId: f.company.id, missionId: f.mission.id,
      workflowRunId: f.run.id, workflowStepRunId: f.step.id, eventType, layer: "workflow_sync",
      fromStatus: "running", toStatus, createdAt });
  }
  const markers = (f: World) => db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, f.company.id), eq(workflowTransitionEvents.missionId, f.mission.id),
    eq(workflowTransitionEvents.eventType, "mission_oversight_failure_wake")));
  async function lane(wake = vi.fn(async (_input: unknown) => {}), interval = 20) {
    const { createMissionOversightFailureLane } = await loadLane();
    const result = createMissionOversightFailureLane(db, { failureLaneIntervalMs: interval, onMissionOversightFailureWakeRequested: wake });
    onTestFinished(() => result.stop());
    return { lane: result, wake };
  }

  it("fires within its interval on a new failure transition and wakes the owner once", async () => {
    const f = await world();
    const { lane: fast, wake } = await lane();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    fast.start(); fast.start();
    await event(f);
    const startedAt = Date.now();
    await vi.advanceTimersByTimeAsync(19);
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    expect(wake.mock.calls[0][0]).toMatchObject({ mission: { id: f.mission.id, companyId: f.company.id, ownerAgentId: f.agent.id },
      issueId: f.oversightIssue.id,
      verdict: { state: "FAILURE_OR_RECOVERY_NEEDED", reasonCode: "failure_event_present" },
      failureEntities: [{ kind: "step", id: f.step.id, status: "failed", version: f.step.statusTransitionVersion }],
      idempotencyKey: expect.stringMatching(new RegExp(`^mission-oversight-failure:${f.mission.id}:[a-f0-9]{16}$`)) });
    expect(await markers(f)).toMatchObject([{ layer: "mission_owner_recovery", payload: {
      schemaVersion: 1, kind: "mission_oversight_failure_wake", issueId: f.oversightIssue.id,
      state: "FAILURE_OR_RECOVERY_NEEDED",
      failureEntities: [{ kind: "step", id: f.step.id, status: "failed" }] } }]);
    fast.stop();
    await event(f); await vi.advanceTimersByTimeAsync(100);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("binds recovery to the canonical oversight issue even after that issue was reassigned", async () => {
    const f = await world();
    const [qa] = await db.insert(agents).values({ companyId: f.company.id, name: "QA" }).returning();
    await db.update(issues).set({ assigneeAgentId: qa.id, status: "in_progress" })
      .where(eq(issues.id, f.oversightIssue.id));
    const { lane: fast, wake } = await lane();
    await event(f); await fast.run();
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ ownerAgentId: f.agent.id }),
      issueId: f.oversightIssue.id,
    }));
    expect(await markers(f)).toMatchObject([{ issueId: f.oversightIssue.id }]);
  });

  it("same failureEntities coalesce: repeated ticks do not re-wake", async () => {
    const f = await world();
    const { lane: fast, wake } = await lane();
    await event(f); await fast.run();
    await event(f, "timed_out"); await fast.run();
    await event(f, "recovery_pending"); await fast.run();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await markers(f)).toHaveLength(1);
    // Racing processes use the durable unique claim, not a per-instance cache.
    const fresh = await world(), other = await lane(wake);
    await event(fresh);
    await Promise.all([fast.run(), other.lane.run()]);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(await markers(fresh)).toHaveLength(1);
  });

  it("a new failure (failureEntities hash change, e.g. version bump) re-wakes", async () => {
    const f = await world();
    const { lane: fast, wake } = await lane();
    await event(f); await fast.run();
    await db.update(workflowStepRuns).set({ status: "running" }).where(eq(workflowStepRuns.id, f.step.id));
    await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.step.id));
    await event(f); await fast.run();
    expect(wake).toHaveBeenCalledTimes(2);
    const rows = await markers(f);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2);
    const inputs = wake.mock.calls.map(([input]) => input as { failureEntities: Array<{ version: number }> });
    expect(inputs[1].failureEntities[0].version).toBeGreaterThan(inputs[0].failureEntities[0].version);
  });

  it("non-failure transitions never wake", async () => {
    const f = await world(), recovered = await world("active", "completed"), paused = await world("paused");
    const { lane: fast, wake } = await lane();
    const evaluate = vi.spyOn(shadow, "evaluateMissionOversightForMission");
    onTestFinished(() => evaluate.mockRestore());
    await event(f, "completed"); await event(f, "skipped"); await event(f, "failed", "workflow_validation_verdict");
    await event(f, "failed", "mission_owner_periodic_review_wake");
    await event(f, "failed", "workflow_step_status_transition", new Date(Date.now() - 11 * 60_000));
    await fast.run();
    expect(evaluate).not.toHaveBeenCalled();
    await event(recovered); await event(paused);
    // An event cannot cross a company boundary even if its mission FK is valid.
    await db.insert(workflowTransitionEvents).values({ companyId: recovered.company.id, missionId: f.mission.id,
      eventType: "workflow_step_status_transition", layer: "workflow_sync", toStatus: "failed" });
    await fast.run();
    expect(evaluate.mock.calls.map(([, companyId, missionId]) => ({ companyId, missionId })))
      .toEqual([{ companyId: recovered.company.id, missionId: recovered.mission.id }]);
    expect(await shadow.evaluateMissionOversightForMission(db, recovered.company.id, recovered.mission.id, new Date()))
      .not.toMatchObject({ state: "FAILURE_OR_RECOVERY_NEEDED" });
    expect(wake).not.toHaveBeenCalled();
    expect(await markers(f)).toHaveLength(0);
  });

  it("restart-safe: a recreated lane with the same durable marker does not re-wake", async () => {
    const f = await world("planning");
    const first = await lane();
    await event(f); await first.lane.run(); first.lane.stop();
    expect(first.wake).toHaveBeenCalledTimes(1);
    const second = await lane();
    await second.lane.run();
    expect(second.wake).not.toHaveBeenCalled();
    expect(await markers(f)).toHaveLength(1);
  });

  it("lane failure or latency never gates the monitor sweep", async () => {
    const f = await world(); await event(f);
    const current = await shadow.evaluateMissionOversightForMission(db, f.company.id, f.mission.id, new Date());
    const evaluate = vi.spyOn(shadow, "evaluateMissionOversightForMission");
    const observe = vi.spyOn(shadow, "recordActiveMissionCadenceShadow").mockResolvedValue();
    onTestFinished(() => { evaluate.mockRestore(); observe.mockRestore(); });
    let release!: () => void;
    const held = new Promise<typeof current>((resolve) => { release = () => resolve(current); });
    evaluate.mockImplementationOnce(() => held);
    const wake = vi.fn(async () => {});
    const monitor = createMissionOwnerSupervisionMonitor(db, { runImmediately: false, failureLaneIntervalMs: 20,
      onMissionOversightFailureWakeRequested: wake });
    onTestFinished(() => { monitor.stop(); release(); });
    mocks.sweep.mockClear(); mocks.warn.mockClear();
    monitor.start();
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalled(), { timeout: 5000 });
    await monitor.run(); await monitor.run();
    expect(mocks.sweep).toHaveBeenCalledTimes(2);
    expect(wake).not.toHaveBeenCalled();
    monitor.stop(); release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(wake).not.toHaveBeenCalled();
    expect(await markers(f)).toHaveLength(0);
    evaluate.mockRejectedValue(new Error("failure lane evaluation unavailable"));
    monitor.start();
    await vi.waitFor(() => expect(mocks.warn.mock.calls.some(([data]) =>
      data?.err?.message === "failure lane evaluation unavailable")).toBe(true), { timeout: 5000 });
    await monitor.run();
    expect(mocks.sweep).toHaveBeenCalledTimes(3);
    monitor.stop();
    expect(wake).not.toHaveBeenCalled();
  });

  it("bounded pages retain timestamp ties and PostgreSQL sub-millisecond precision", async () => {
    const f = await world(), tail = await world();
    const { lane: fast, wake } = await lane();
    const at = new Date(Date.now() - 1000);
    await db.insert(workflowTransitionEvents).values(Array.from({ length: 500 }, (_, index) => ({ companyId: f.company.id,
      id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      missionId: f.mission.id, layer: "workflow_sync", eventType: "workflow_step_status_transition", toStatus: "failed", createdAt: at })));
    await db.insert(workflowTransitionEvents).values({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff", companyId: tail.company.id,
      missionId: tail.mission.id, layer: "workflow_sync", eventType: "workflow_step_status_transition", toStatus: "failed", createdAt: at });
    await fast.run();
    expect(await markers(tail)).toHaveLength(0);
    await fast.run();
    expect(await markers(f)).toHaveLength(1); expect(await markers(tail)).toHaveLength(1);
    expect(wake).toHaveBeenCalledTimes(2);
    const evaluate = vi.spyOn(shadow, "evaluateMissionOversightForMission");
    onTestFinished(() => evaluate.mockRestore());
    await db.execute(sql`insert into workflow_transition_events (company_id, mission_id, layer, event_type, to_status, created_at)
      values (${f.company.id}, ${f.mission.id}, 'workflow_sync', 'workflow_step_status_transition', 'failed',
        date_trunc('milliseconds', clock_timestamp()) + interval '123 microseconds')`);
    await fast.run();
    expect(evaluate).toHaveBeenCalledTimes(1);
    await fast.run();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(2);
  });
});
