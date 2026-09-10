import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, heartbeatRuns, missionAgentRuntimes, missions, workflowResumeRequests, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { compileMissionRunContext } from "../services/missions/mission-context-compiler.js";
import { buildMissionRuntimeKey, ensureMissionAgentRuntime, markMissionRuntimeBootstrapInjected } from "../services/missions/mission-runtime-manager.js";
import { ensureResumeMissionRuntimes } from "../services/workflow/resume/mission-lifecycle.js";
import { runtimeContextFixture, seedRuntimeContext } from "./mission-resume-runtime-context-fixture.js";

// Filesystem working note only; persistence, validation, serialization and ensure are real.
vi.mock("../services/missions/mission-working-note.js", () => ({ ensureMissionWorkingNote: async () => null }));

describe("actual mission resume runtime context (PGlite)", () => {
  let fixture: Awaited<ReturnType<typeof runtimeContextFixture>>;
  beforeAll(async () => { fixture = await runtimeContextFixture(); }, 60_000);
  afterAll(async () => { await fixture?.close(); });

  it("preserves the old stopped runtime/session and gives each request a distinct row", async () => {
    const { db } = fixture;
    const g = await seedRuntimeContext(db);
    const old = await ensureMissionAgentRuntime(db, { ...g.input, sessionId: "old-session" });
    await markMissionRuntimeBootstrapInjected(db, old.runtime.id);
    await db.update(missionAgentRuntimes).set({ status: "stopped", stoppedAt: new Date(), stateJson: { keeper: "old" } }).where(eq(missionAgentRuntimes.id, old.runtime.id));
    const before = await g.rows();
    const request1 = randomUUID();
    const first = await ensureMissionAgentRuntime(db, { ...g.input, sessionId: "old-session", resumeContext: { resumeRequestId: request1 } });
    expect(first.runtime.id).not.toBe(old.runtime.id);
    expect(first.runtime.sessionId).toBeNull();
    expect(first.runtime.contextInjectedAt).toBeNull();
    expect(first.runtime.workspaceId).toBe(g.input.workspaceId);
    await markMissionRuntimeBootstrapInjected(db, first.runtime.id);
    await db.update(missionAgentRuntimes).set({ sessionId: "same-request-session", status: "stopped", stoppedAt: new Date() }).where(eq(missionAgentRuntimes.id, first.runtime.id));
    const again = await ensureMissionAgentRuntime(db, { ...g.input, sessionId: "old-session", resumeContext: { resumeRequestId: request1 } });
    expect(again.runtime.id).toBe(first.runtime.id);
    expect(again.bootstrapRequired).toBe(false);
    expect(again.runtime.sessionId).toBe("same-request-session");
    expect(again.runtime.stateJson).toMatchObject({ resumeRequestId: request1, workspaceKey: first.runtime.workspaceKey, runtimeKey: first.runtime.runtimeKey, bootstrapContextInjected: true });
    const second = await ensureMissionAgentRuntime(db, { ...g.input, resumeContext: { resumeRequestId: randomUUID() } });
    expect(second.runtime.id).not.toBe(first.runtime.id);
    expect(second.runtime.workspaceKey).not.toBe(first.runtime.workspaceKey);
    expect(second.bootstrapRequired).toBe(true);
    expect((await g.rows()).find((r) => r.id === old.runtime.id)).toEqual(before[0]);
    expect(await g.rows()).toHaveLength(3);
  });

  it("actual compiler uses the current request and real workspace, then stops bootstrapping after marking", async () => {
    const { db } = fixture;
    const g = await seedRuntimeContext(db);
    const requestId = await g.resume();
    await ensureResumeMissionRuntimes(db, g.lifecycle(requestId));
    const prepared = await g.rows();
    const first = await compileMissionRunContext(db, g.input);
    const runtime = first.missionAgentRuntimeForRun!.runtime;
    expect(runtime.stateJson.resumeRequestId).toBe(requestId);
    expect(runtime.workspaceKey).not.toBe(g.input.workspaceKey);
    expect(runtime.workspaceKey).toContain(g.input.workspaceKey);
    expect(runtime.id).not.toBe(prepared[0].id);
    expect(runtime.workspaceId).toBe(g.input.workspaceId);
    expect(runtime.sessionId).toBeNull();
    expect(first.paperclipMissionRuntime?.bootstrapRequired).toBe(true);
    await markMissionRuntimeBootstrapInjected(db, runtime.id);
    const second = await compileMissionRunContext(db, g.input);
    expect(second.missionAgentRuntimeForRun?.runtime.id).toBe(runtime.id);
    expect(second.paperclipMissionRuntime?.bootstrapRequired).toBe(false);
    expect(second.missionAgentRuntimeForRun?.runtime.stateJson.resumeRequestId).toBe(requestId);
    const nextRequest = await g.resume();
    const third = await compileMissionRunContext(db, g.input);
    expect(third.missionAgentRuntimeForRun?.runtime.id).not.toBe(runtime.id);
    expect(third.missionAgentRuntimeForRun?.runtime.stateJson.resumeRequestId).toBe(nextRequest);
    expect(third.paperclipMissionRuntime?.bootstrapRequired).toBe(true);
  });

  it.each(["ordinary", "outside"])("keeps the %s workspace key and session semantics unchanged", async (kind) => {
    const { db } = fixture;
    const g = await seedRuntimeContext(db);
    if (kind === "outside") {
      await g.resume();
      await db.update(workflowStepRuns).set({ metadata: {} }).where(eq(workflowStepRuns.id, g.step.id));
      await db.update(heartbeatRuns).set({ workflowStepRunId: null, workflowExecutionGeneration: null }).where(eq(heartbeatRuns.id, g.heartbeat.id));
    } else {
      await db.update(heartbeatRuns).set({ workflowStepRunId: null, workflowExecutionGeneration: null }).where(eq(heartbeatRuns.id, g.heartbeat.id));
      await db.delete(workflowStepRuns).where(eq(workflowStepRuns.id, g.step.id));
    }
    const result = await compileMissionRunContext(db, g.input);
    expect(result.missionAgentRuntimeForRun?.runtime.workspaceKey).toBe(g.input.workspaceKey);
    expect(result.missionAgentRuntimeForRun?.runtime.runtimeKey).toBe(buildMissionRuntimeKey(g.input));
    expect(result.missionAgentRuntimeForRun?.runtime.sessionId).toBe(g.input.missionSessionId);
    expect(result.missionAgentRuntimeForRun?.runtime.stateJson.resumeRequestId).toBeUndefined();
  });

  it.each(["generation", "negative", "missing-generation", "request", "missing-run-stamp", "missing-request", "missing-step", "missing-heartbeat", "agent", "company", "mission", "issue", "cancelled-request"])("rejects stale/missing %s before any runtime writes", async (kind) => {
    const { db } = fixture;
    const g = await seedRuntimeContext(db);
    const requestId = await g.resume();
    if (kind === "generation" || kind === "negative" || kind === "missing-generation") {
      await db.update(heartbeatRuns).set({ workflowExecutionGeneration: kind === "generation" ? 0 : kind === "negative" ? -1 : null }).where(eq(heartbeatRuns.id, g.heartbeat.id));
    }
    if (kind === "request") await db.update(workflowRuns).set({ metadata: { resumeRequestId: randomUUID() } }).where(eq(workflowRuns.id, g.run.id));
    if (kind === "missing-run-stamp") await db.update(workflowRuns).set({ metadata: {} }).where(eq(workflowRuns.id, g.run.id));
    if (kind === "missing-request") await db.delete(workflowResumeRequests).where(eq(workflowResumeRequests.id, requestId));
    if (kind === "missing-step") await db.update(heartbeatRuns).set({ workflowStepRunId: null, contextSnapshot: { workflowStepRunId: g.step.id, workflowExecutionGeneration: 1 } }).where(eq(heartbeatRuns.id, g.heartbeat.id));
    if (kind === "missing-heartbeat") g.input.runId = randomUUID();
    if (kind === "agent") g.input.agentId = randomUUID();
    if (kind === "company") g.input.companyId = (await seedRuntimeContext(db)).input.companyId;
    if (kind === "mission") g.input.missionId = (await seedRuntimeContext(db)).input.missionId;
    if (kind === "issue") await db.update(heartbeatRuns).set({ issueId: null }).where(eq(heartbeatRuns.id, g.heartbeat.id));
    if (kind === "cancelled-request") await db.update(workflowResumeRequests).set({ state: "cancelled" }).where(eq(workflowResumeRequests.id, requestId));
    const before = await g.rows();
    await expect(compileMissionRunContext(db, g.input)).rejects.toMatchObject({ status: 409 });
    expect(await g.rows()).toEqual(before);
  });

  it.each(["valid", "step-fallback", "wrong-run", "wrong-step", "foreign-company", "typed-stale"])("uses linked wakeup only for missing typed identity: %s", async (kind) => {
    const { db } = fixture;
    const g = await seedRuntimeContext(db);
    await g.resume();
    const foreign = await seedRuntimeContext(db);
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId: kind === "foreign-company" ? foreign.input.companyId : g.input.companyId,
      agentId: g.input.agentId, source: "on_demand", issueId: g.input.currentIssueId,
      workflowRunId: kind === "wrong-run" ? foreign.run.id : g.run.id,
      workflowStepRunId: kind === "wrong-step" ? foreign.step.id : g.step.id, workflowExecutionGeneration: 1,
    }).returning();
    await db.update(heartbeatRuns).set({
      wakeupRequestId: wake.id, workflowExecutionGeneration: kind === "typed-stale" ? 0 : null,
      workflowStepRunId: kind === "step-fallback" ? null : g.step.id,
    }).where(eq(heartbeatRuns.id, g.heartbeat.id));
    if (kind === "valid" || kind === "step-fallback") {
      expect((await compileMissionRunContext(db, g.input)).missionAgentRuntimeForRun?.runtime.stateJson.resumeRequestId).toBeTruthy();
    } else {
      await expect(compileMissionRunContext(db, g.input)).rejects.toMatchObject({ status: 409 });
      expect(await g.rows()).toEqual([]);
    }
  });

  it("rolls back all lifecycle ensures when a later agent insert fails (real SQL trigger)", async () => {
    const { db } = fixture;
    const g = await seedRuntimeContext(db);
    const requestId = await g.resume();
    const [owner] = await db.insert(agents).values({ companyId: g.input.companyId, name: "Later owner" }).returning();
    await db.update(missions).set({ ownerAgentId: owner.id }).where(eq(missions.id, g.input.missionId));
    await db.execute(sql.raw(`CREATE FUNCTION reject_later_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.agent_id = '${owner.id}'::uuid THEN RAISE EXCEPTION 'test later ensure failure'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw("CREATE TRIGGER reject_later_runtime BEFORE INSERT ON mission_agent_runtimes FOR EACH ROW EXECUTE FUNCTION reject_later_runtime()"));
    await expect(ensureResumeMissionRuntimes(db, g.lifecycle(requestId))).rejects.toThrow();
    expect(await g.rows()).toEqual([]);
  });

  it.each(["superseded", "cancelled", "inactive"])("lifecycle %s cannot create runtimes or reactivate the mission", async (kind) => {
    const { db } = fixture;
    const g = await seedRuntimeContext(db);
    const requestId = await g.resume();
    if (kind === "superseded") await g.resume();
    if (kind === "cancelled") await db.update(workflowResumeRequests).set({ state: "cancelled" }).where(eq(workflowResumeRequests.id, requestId));
    if (kind === "inactive") await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, g.input.missionId));
    const before = await db.select().from(missions).where(eq(missions.id, g.input.missionId));
    expect((await ensureResumeMissionRuntimes(db, g.lifecycle(requestId))).ensuredAgentIds).toEqual([]);
    expect(await g.rows()).toEqual([]);
    expect(await db.select().from(missions).where(eq(missions.id, g.input.missionId))).toEqual(before);
    if (kind === "inactive") {
      await expect(compileMissionRunContext(db, g.input)).rejects.toMatchObject({ code: "mission_not_accepting_work" });
      expect(await g.rows()).toEqual([]);
    }
  });
});
