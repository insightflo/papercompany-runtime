import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, agents, approvals, companies, createDb, heartbeatRuns, issueApprovals, issues, missions,
  workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildWorkflowRetryMetadata } from "../services/workflow/retry-metadata.js";
import { evaluateMissionOversightCadence } from "../services/mission-oversight-cadence.js";
import * as shadow from "../services/mission-oversight-shadow.js";
import { createMissionOwnerSupervisionMonitor } from "../services/mission-owner-supervision-monitor.js";

const mocks = vi.hoisted(() => ({ sweep: vi.fn(async () => ({ missionIds: [], missions: [] })), warn: vi.fn() }));
vi.mock("../services/missions.js", () => ({ missionService: () => ({ runActiveMissionOwnerSupervision: mocks.sweep }) }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const at = (m: number) => new Date(Date.UTC(2026, 9, 14, 0, m));

describe("durable mission oversight shadow (isolated PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { pg = await startEmbeddedPostgresTestDatabase("paperclip-cadence-shadow-"); db = createDb(pg.connectionString); }, 60_000);
  afterAll(async () => { try { await db?.$client.end({ timeout: 5 }); } finally { await pg?.cleanup(); } });

  async function world(status = "active") {
    const [company] = await db.insert(companies).values({ name: "Shadow", issuePrefix: `S${randomUUID()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Builder" }).returning();
    const [mission] = await db.insert(missions).values({ companyId: company.id, ownerAgentId: agent.id, title: "Shadow", status, createdAt: at(0) }).returning();
    return { company, agent, mission };
  }
  async function workflow(f: Awaited<ReturnType<typeof world>>, status = "pending", dependencies: string[] = []) {
    const [definition] = await db.insert(workflowDefinitions).values({ companyId: f.company.id, name: "Build",
      stepsJson: [{ id: "build", type: "agent", name: "Build", dependencies, timeoutSeconds: 1800 }] }).returning();
    const [run] = await db.insert(workflowRuns).values({ companyId: f.company.id, missionId: f.mission.id, workflowId: definition.id,
      triggeredBy: "test", status: "running", createdAt: at(0), startedAt: at(0) }).returning();
    const [step] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "build", status,
      executionGeneration: 2, startedAt: status === "pending" ? null : at(0), completedAt: status === "failed" ? at(1) : null }).returning();
    return { definition, run, step };
  }
  const read = (f: Awaited<ReturnType<typeof world>>) => shadow.readMissionCadenceSnapshot(db, f.company.id, f.mission.id);
  async function rows(f: Awaited<ReturnType<typeof world>>) {
    return db.select().from(activityLog).where(and(eq(activityLog.companyId, f.company.id), eq(activityLog.action, shadow.OVERSIGHT_SHADOW_ACTION)));
  }

  it("stores queryable immutable JSON; concurrent same tick/generation dedupes, later ticks and generations survive", async () => {
    const f = await world(), w = await workflow(f);
    const before = await read(f);
    const v = evaluateMissionOversightCadence(before!, at(10));
    await Promise.all([shadow.persistMissionCadenceShadow(db, before!, at(10), v), shadow.persistMissionCadenceShadow(db, before!, at(10), v)]);
    await shadow.persistMissionCadenceShadow(db, before!, at(14), v);
    expect(await rows(f)).toHaveLength(1);
    expect((await rows(f))[0]).toMatchObject({ entityType: "mission_oversight_shadow", entityId: f.mission.id,
      details: { schemaVersion: 1, missionId: f.mission.id, state: "READY_NOT_STARTED", triggerKind: "ready_not_started",
        sweepTick: Math.floor(at(10).getTime() / 300_000), inputGeneration: v.inputGeneration } });
    expect(await read(f)).toEqual(before); // Observer never consumes its own records.
    await shadow.persistMissionCadenceShadow(db, before!, at(15), evaluateMissionOversightCadence(before!, at(15)));
    await db.update(workflowRuns).set({ dispatchAuthorityVersion: 3 }).where(eq(workflowRuns.id, w.run.id));
    const after = (await read(f))!, newer = evaluateMissionOversightCadence(after, at(10));
    expect(newer.inputGeneration.fingerprint).not.toBe(v.inputGeneration.fingerprint);
    await shadow.persistMissionCadenceShadow(db, after, at(10), newer);
    expect(await rows(f)).toHaveLength(3);
    expect((await rows(f)).find((row) => row.details?.inputGeneration && row.details.sweepAt === at(10).toISOString())?.details).toBeDefined();
  });

  it("maps a 26-minute build's existing heartbeat + step timeout, and rejects stale/wrong generation survival", async () => {
    const f = await world(), w = await workflow(f, "running");
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, missionId: f.mission.id, title: "Build", status: "in_progress", startedAt: at(0), createdAt: at(0) }).returning();
    await db.update(workflowStepRuns).set({ issueId: issue.id }).where(eq(workflowStepRuns.id, w.step.id));
    const [hb] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, issueId: issue.id,
      status: "running", workflowStepRunId: w.step.id, workflowExecutionGeneration: 2, startedAt: at(0), createdAt: at(0), updatedAt: at(25) }).returning();
    const s = (await read(f))!;
    expect(evaluateMissionOversightCadence(s, at(26))).toMatchObject({ state: "RUNNING", wouldTrigger: false });
    expect(s.heartbeats[0].allowedIntervalMs).toBe(1800_000);
    expect(evaluateMissionOversightCadence(s, at(26)).computedTimestamps.last_progress_at).toBe(at(0).toISOString());
    await db.update(heartbeatRuns).set({ updatedAt: at(0) }).where(eq(heartbeatRuns.id, hb.id));
    expect(evaluateMissionOversightCadence((await read(f))!, at(31)).triggerKind).toBe("liveness_ghost");
    await db.update(heartbeatRuns).set({ updatedAt: at(30), workflowExecutionGeneration: 1 }).where(eq(heartbeatRuns.id, hb.id));
    expect(evaluateMissionOversightCadence((await read(f))!, at(31)).triggerKind).toBe("liveness_ghost");
  });

  it("maps actual retry metadata and grace recheck deadlines; malformed retry never grants an exemption", async () => {
    const f = await world(), w = await workflow(f);
    await db.update(workflowStepRuns).set({ retryCount: 1, metadata: { workflowRetry: buildWorkflowRetryMetadata({ retryNumber: 1,
      maxRetries: 2, delaySeconds: 600, now: at(0), sourceRequestId: null, sourceCompletedAt: null, lastErrorSummary: null }) } }).where(eq(workflowStepRuns.id, w.step.id));
    expect(evaluateMissionOversightCadence((await read(f))!, at(9))).toMatchObject({ state: "WAITING_EXPLICIT", wouldTrigger: false });
    expect(evaluateMissionOversightCadence((await read(f))!, at(10)).triggerKind).toBe("wait_overdue");
    await db.update(workflowStepRuns).set({ metadata: { workflowRetry: { state: "waiting", nextEligibleAt: at(600).toISOString() } } }).where(eq(workflowStepRuns.id, w.step.id));
    expect(evaluateMissionOversightCadence((await read(f))!, at(10))).toMatchObject({ state: "READY_NOT_STARTED", wouldTrigger: true });
    await db.update(workflowStepRuns).set({ metadata: { controlNodeGraceWait: { reason: "work_product_pending", since: at(0).toISOString(), attempts: 1, nextEvaluateAt: at(10).toISOString() } } }).where(eq(workflowStepRuns.id, w.step.id));
    expect(evaluateMissionOversightCadence((await read(f))!, at(9))).toMatchObject({ state: "WAITING_EXPLICIT", wouldTrigger: false });
  });

  it("maps real pending approvals, then counts satisfaction; pending dependency is not ready", async () => {
    const f = await world(), w = await workflow(f, "pending", ["missing-predecessor"]);
    expect(evaluateMissionOversightCadence((await read(f))!, at(10)).state).toBe("IDLE_QUIET");
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, missionId: f.mission.id, title: "Approval", status: "in_progress", createdAt: at(0) }).returning();
    await db.update(workflowStepRuns).set({ issueId: issue.id }).where(eq(workflowStepRuns.id, w.step.id));
    const [approval] = await db.insert(approvals).values({ companyId: f.company.id, type: "approve_ceo_strategy", payload: {}, status: "pending" }).returning();
    await db.insert(issueApprovals).values({ companyId: f.company.id, issueId: issue.id, approvalId: approval.id });
    expect(evaluateMissionOversightCadence((await read(f))!, at(600))).toMatchObject({ state: "WAITING_EXPLICIT", wouldTrigger: false });
    await db.update(approvals).set({ status: "approved", decidedAt: at(10) }).where(eq(approvals.id, approval.id));
    expect(evaluateMissionOversightCadence((await read(f))!, at(11)).computedTimestamps.last_progress_at).toBe(at(10).toISOString());
  });

  it("ready age begins at approval release; machine tool results during a run advance progress", async () => {
    const f = await world(), w = await workflow(f);
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, missionId: f.mission.id, title: "Released", status: "todo", createdAt: at(0) }).returning();
    await db.update(workflowStepRuns).set({ issueId: issue.id }).where(eq(workflowStepRuns.id, w.step.id));
    const [approval] = await db.insert(approvals).values({ companyId: f.company.id, type: "approve_ceo_strategy", payload: {}, status: "approved", decidedAt: at(10) }).returning();
    await db.insert(issueApprovals).values({ companyId: f.company.id, issueId: issue.id, approvalId: approval.id });
    expect(evaluateMissionOversightCadence((await read(f))!, at(11))).toMatchObject({ state: "READY_NOT_STARTED", wouldTrigger: false });
    await db.update(workflowStepRuns).set({ status: "running", startedAt: at(10), lastDispatchRequestId: "tool-request",
      metadata: { toolResult: { requestId: "tool-request", success: true, completedAt: at(12).toISOString(), stdout: "not authority" } } }).where(eq(workflowStepRuns.id, w.step.id));
    const v = evaluateMissionOversightCadence((await read(f))!, at(13));
    expect(v.computedTimestamps.last_progress_at).toBe(at(12).toISOString());
  });

  it("dispatching retry does not hide its current heartbeat; a pending approval never hides an actual failed step", async () => {
    const f = await world(), w = await workflow(f, "running");
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, missionId: f.mission.id, title: "Retry", status: "in_progress", createdAt: at(0) }).returning();
    await db.update(workflowStepRuns).set({ issueId: issue.id, retryCount: 1, metadata: { workflowRetry: { ...buildWorkflowRetryMetadata({ retryNumber: 1,
      maxRetries: 2, delaySeconds: 0, now: at(0), sourceRequestId: null, sourceCompletedAt: null, lastErrorSummary: null }), state: "dispatching" } } }).where(eq(workflowStepRuns.id, w.step.id));
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, issueId: issue.id, status: "running",
      workflowStepRunId: w.step.id, workflowExecutionGeneration: 2, createdAt: at(1), startedAt: at(1), updatedAt: at(25) });
    expect(evaluateMissionOversightCadence((await read(f))!, at(26))).toMatchObject({ state: "RUNNING", wouldTrigger: false });
    const [approval] = await db.insert(approvals).values({ companyId: f.company.id, type: "approve_ceo_strategy", payload: {}, status: "pending" }).returning();
    await db.insert(issueApprovals).values({ companyId: f.company.id, issueId: issue.id, approvalId: approval.id });
    await db.update(workflowStepRuns).set({ status: "failed", completedAt: at(26) }).where(eq(workflowStepRuns.id, w.step.id));
    expect(evaluateMissionOversightCadence((await read(f))!, at(26)).triggerKind).toBe("immediate_failure");
  });

  it("desigma: review-only heartbeats/events and restamped terminal rows never reset progress", async () => {
    const f = await world(), w = await workflow(f, "failed");
    await db.update(workflowRuns).set({ status: "completed", completedAt: at(1) }).where(eq(workflowRuns.id, w.run.id));
    await db.update(workflowStepRuns).set({ status: "completed", completedAt: at(61) }).where(eq(workflowStepRuns.id, w.step.id));
    const [current] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.step.id));
    await db.insert(workflowTransitionEvents).values([
      { companyId: f.company.id, missionId: f.mission.id, workflowRunId: w.run.id, workflowStepRunId: w.step.id,
        eventType: "workflow_step_status_transition", layer: "workflow_sync", fromStatus: "running", toStatus: "completed", payload: { transitionVersion: current.statusTransitionVersion }, createdAt: at(1) },
      ...[31, 61].map((minute) => ({ companyId: f.company.id, missionId: f.mission.id, eventType: "mission_owner_periodic_review_wake",
        layer: "mission_owner_recovery", createdAt: at(minute) })),
    ]);
    const [reviewIssue] = await db.insert(issues).values({ companyId: f.company.id, missionId: f.mission.id, title: "Review",
      status: "in_progress", originKind: "mission_main_executor_oversight" }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, issueId: reviewIssue.id,
      status: "running", startedAt: at(60), updatedAt: at(61) });
    const v = evaluateMissionOversightCadence((await read(f))!, at(62));
    expect(v).toMatchObject({ state: "IDLE_QUIET", triggerKind: "stall_idle", computedTimestamps: {
      last_progress_at: at(1).toISOString(), last_event_at: at(61).toISOString(), last_observed_at: at(61).toISOString() } });
  });

  it("direct mission heartbeats and issue-less typed workflow heartbeats are real execution, not missing ghosts", async () => {
    const f = await world();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, missionId: f.mission.id,
      source: "assignment", reason: "issue_assigned", status: "claimed", requestedAt: at(0) }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, wakeupRequestId: wake.id,
      status: "running", startedAt: at(0), createdAt: at(0), updatedAt: at(25) });
    expect(evaluateMissionOversightCadence((await read(f))!, at(26))).toMatchObject({ state: "RUNNING", wouldTrigger: false });
    const w = await workflow(f, "running");
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, workflowStepRunId: w.step.id,
      workflowExecutionGeneration: 2, status: "running", startedAt: at(0), createdAt: at(0), updatedAt: at(25) });
    expect(evaluateMissionOversightCadence((await read(f))!, at(26))).toMatchObject({ state: "RUNNING", wouldTrigger: false });
  });

  it("direct mission periodic-review heartbeats affect observation/event time only, never progress or running exemption", async () => {
    const f = await world();
    await db.insert(workflowTransitionEvents).values({ companyId: f.company.id, missionId: f.mission.id, layer: "workflow_sync",
      eventType: "workflow_step_status_transition", fromStatus: "running", toStatus: "failed", createdAt: at(1) });
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, missionId: f.mission.id,
      source: "assignment", reason: "mission_owner_periodic_review", status: "claimed", requestedAt: at(60) }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, wakeupRequestId: wake.id,
      status: "running", startedAt: at(60), createdAt: at(60), updatedAt: at(61) });
    const v = evaluateMissionOversightCadence((await read(f))!, at(62));
    expect(v).toMatchObject({ state: "IDLE_QUIET", triggerKind: "stall_idle", computedTimestamps: {
      last_progress_at: at(1).toISOString(), last_event_at: at(61).toISOString(), last_observed_at: at(61).toISOString() } });
  });

  it("direct mission queued requests are ready work, but periodic review queueing is observation only", async () => {
    const f = await world();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, missionId: f.mission.id,
      source: "assignment", reason: "mission_owner_periodic_review", status: "queued", requestedAt: at(0) }).returning();
    expect(evaluateMissionOversightCadence((await read(f))!, at(10))).toMatchObject({ state: "IDLE_QUIET", triggerKind: "stall_idle" });
    await db.update(agentWakeupRequests).set({ reason: "issue_assigned" }).where(eq(agentWakeupRequests.id, wake.id));
    expect(evaluateMissionOversightCadence((await read(f))!, at(10))).toMatchObject({ state: "READY_NOT_STARTED", triggerKind: "ready_not_started" });
  });

  it("a requested pending run without materialized steps is ready; child-start deadline is an explicit wait", async () => {
    const f = await world(), w = await workflow(f);
    await db.delete(workflowStepRuns).where(eq(workflowStepRuns.id, w.step.id));
    await db.update(workflowRuns).set({ status: "pending", startedAt: null }).where(eq(workflowRuns.id, w.run.id));
    expect(evaluateMissionOversightCadence((await read(f))!, at(10))).toMatchObject({ state: "READY_NOT_STARTED", triggerKind: "ready_not_started" });
    await db.update(workflowRuns).set({ childStartDeadlineAt: at(15) }).where(eq(workflowRuns.id, w.run.id));
    expect(evaluateMissionOversightCadence((await read(f))!, at(10))).toMatchObject({ state: "WAITING_EXPLICIT", wouldTrigger: false });
    expect(evaluateMissionOversightCadence((await read(f))!, at(15)).triggerKind).toBe("wait_overdue");
  });

  it("read-only scope denial and shadow add only audit rows; all active missions including quiet/planning are observed", async () => {
    const f = await world(), planning = await world("planning"), paused = await world("paused");
    await workflow(f, "failed");
    expect(await shadow.readMissionCadenceSnapshot(db, planning.company.id, f.mission.id)).toBeNull();
    const before = await db.select().from(workflowTransitionEvents);
    const beforeMissions = await db.select().from(missions), beforeSteps = await db.select().from(workflowStepRuns);
    await shadow.recordActiveMissionCadenceShadow(db, at(10));
    expect(await rows(f)).toHaveLength(1);
    expect((await rows(f))[0].details).toMatchObject({ triggerKind: "immediate_failure" });
    expect(await rows(planning)).toHaveLength(1);
    expect(await rows(paused)).toHaveLength(0);
    expect(await db.select().from(workflowTransitionEvents)).toEqual(before);
    expect(await db.select().from(missions)).toEqual(beforeMissions);
    expect(await db.select().from(workflowStepRuns)).toEqual(beforeSteps);
  });

  it("monitor preserves exact action arguments and observes even missions omitted by the old sweep", async () => {
    const f = await world();
    mocks.sweep.mockClear();
    await createMissionOwnerSupervisionMonitor(db, { runImmediately: false }).run();
    expect(mocks.sweep.mock.calls.map((call) => [...call])).toEqual([[{ staleAfterMinutes: 30, applySafeActions: true,
      applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true, dispatchStaleSourceIssueWakeups: false }]]);
    expect(await rows(f)).toHaveLength(1);
  });

  it("shadow failure/latency never gates the original monitor or its next tick", async () => {
    mocks.sweep.mockClear();
    const spy = vi.spyOn(shadow, "recordActiveMissionCadenceShadow");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    spy.mockImplementation(() => held);
    const monitor = createMissionOwnerSupervisionMonitor(db, { runImmediately: false });
    const first = monitor.run();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const second = monitor.run();
    await vi.waitFor(() => expect(mocks.sweep).toHaveBeenCalledTimes(2));
    release(); await Promise.all([first, second]);
    spy.mockRejectedValueOnce(new Error("shadow insert failed"));
    await monitor.run();
    expect(mocks.sweep).toHaveBeenCalledTimes(3);
    expect(mocks.warn.mock.calls.some((call) => call[1] === "Mission oversight cadence shadow observation failed")).toBe(true);
    spy.mockRestore();
  });
});
