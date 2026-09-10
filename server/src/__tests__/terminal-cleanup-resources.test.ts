import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { runMissionTerminalCleanup } from "../services/missions/terminal-cleanup-fence.js";
import { missionService } from "../services/missions.js";
import { readTerminal, schema, seedTerminal, terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

describe("terminal cleanup bounded DB resources", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => { ({ db, close } = await terminalDatabase()); }, 60_000);
  afterAll(async () => { await close?.(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(["queued", "claimed", "deferred_issue_execution"])("cancels exact heartbeat/%s wakeup and independently clears only owned issue references", async (status) => {
    const f = await seedTerminal(db);
    const [wake] = await db.insert(schema.agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, source: "manual", status,
      runId: status === "queued" ? null : f.heartbeat.id }).returning();
    await db.update(schema.heartbeatRuns).set({ wakeupRequestId: wake.id }).where(eq(schema.heartbeatRuns.id, f.heartbeat.id));
    const [replacementRun] = await db.insert(schema.heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "succeeded" }).returning();
    const replacement = replacementRun.id;
    await db.update(schema.issues).set({ checkoutRunId: f.heartbeat.id, executionRunId: f.heartbeat.id, executionAgentNameKey: "worker", executionLockedAt: f.input.now }).where(eq(schema.issues.id, f.issue.id));
    const extra = await db.insert(schema.issues).values([
      { companyId: f.company.id, missionId: f.mission.id, title: "checkout only", checkoutRunId: f.heartbeat.id, executionRunId: replacement, executionAgentNameKey: "replacement", executionLockedAt: f.input.now },
      { companyId: f.company.id, missionId: f.mission.id, title: "execution only", checkoutRunId: replacement, executionRunId: f.heartbeat.id, executionAgentNameKey: "worker", executionLockedAt: f.input.now },
    ]).returning();
    const [deferred] = await db.insert(schema.agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, source: "manual", status: "deferred_issue_execution", issueId: f.issue.id }).returning();
    const result = await runMissionTerminalCleanup(db, { ...f.input, status: "cancelled" });
    expect(result.stoppedRuntimeIds).toEqual([f.runtime.id]);
    expect((await readTerminal(db, f)).heartbeat).toMatchObject({ status: "cancelled", finishedAt: f.input.now, errorCode: "cancelled", error: "Cancelled because mission was cancelled", updatedAt: f.input.now });
    const [settledWake] = await db.select().from(schema.agentWakeupRequests).where(eq(schema.agentWakeupRequests.id, wake.id));
    expect(settledWake).toMatchObject({ status: "cancelled", finishedAt: f.input.now, updatedAt: f.input.now });
    const [issue] = await db.select().from(schema.issues).where(eq(schema.issues.id, f.issue.id));
    expect(issue).toMatchObject({ status: "cancelled", checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null });
    const [checkoutOnly] = await db.select().from(schema.issues).where(eq(schema.issues.id, extra[0].id));
    expect(checkoutOnly).toMatchObject({ checkoutRunId: null, executionRunId: replacement, executionAgentNameKey: "replacement", executionLockedAt: f.input.now });
    const [executionOnly] = await db.select().from(schema.issues).where(eq(schema.issues.id, extra[1].id));
    expect(executionOnly).toMatchObject({ checkoutRunId: replacement, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null });
    expect((await db.select().from(schema.agentWakeupRequests).where(eq(schema.agentWakeupRequests.id, deferred.id)))[0]).toEqual(deferred);
    expect(f.input.cancelHeartbeatRun).not.toHaveBeenCalled();
  });

  it.each(["terminal", "other_run", "other_agent", "other_company"])("preserves %s linked wakeup despite heartbeat cancellation", async (kind) => {
    const f = await seedTerminal(db);
    const foreign = await seedTerminal(db);
    const [wake] = await db.insert(schema.agentWakeupRequests).values({ companyId: kind === "other_company" ? foreign.company.id : f.company.id,
      agentId: kind === "other_agent" ? foreign.agent.id : f.agent.id, source: "manual", status: kind === "terminal" ? "completed" : "claimed",
      runId: kind === "other_run" ? foreign.heartbeat.id : f.heartbeat.id, error: "keep", finishedAt: f.input.now }).returning();
    await db.update(schema.heartbeatRuns).set({ wakeupRequestId: wake.id }).where(eq(schema.heartbeatRuns.id, f.heartbeat.id));
    await runMissionTerminalCleanup(db, f.input);
    expect((await readTerminal(db, f)).heartbeat.status).toBe("cancelled");
    expect((await db.select().from(schema.agentWakeupRequests).where(eq(schema.agentWakeupRequests.id, wake.id)))[0]).toEqual(wake);
  });

  it("preserves company/mission unrelated rows, terminal heartbeat/runtime and replacement references", async () => {
    const f = await seedTerminal(db);
    const foreign = await seedTerminal(db);
    const [otherMission] = await db.insert(schema.missions).values({ companyId: f.company.id, ownerAgentId: f.agent.id, title: "Other mission" }).returning();
    const [otherIssue] = await db.insert(schema.issues).values({ companyId: f.company.id, missionId: otherMission.id, title: "Other work", checkoutRunId: f.heartbeat.id, executionRunId: f.heartbeat.id }).returning();
    // Deliberately inconsistent FK-compatible company/mission links must still fail closed.
    const [foreignIssue] = await db.insert(schema.issues).values({ companyId: foreign.company.id, missionId: f.mission.id, title: "Foreign work", checkoutRunId: f.heartbeat.id, executionRunId: f.heartbeat.id }).returning();
    const heartbeats = await db.insert(schema.heartbeatRuns).values([
      { companyId: f.company.id, agentId: f.agent.id, issueId: otherIssue.id, status: "queued" },
      { companyId: f.company.id, agentId: f.agent.id, issueId: foreignIssue.id, status: "running" },
      { companyId: foreign.company.id, agentId: foreign.agent.id, issueId: f.issue.id, status: "running" },
      { companyId: f.company.id, agentId: f.agent.id, issueId: f.issue.id, status: "succeeded" },
    ]).returning();
    const [stopped] = await db.insert(schema.missionAgentRuntimes).values({ companyId: f.company.id, missionId: f.mission.id, agentId: f.agent.id,
      adapterType: "process", workspaceKey: "other", runtimeKey: randomUUID(), status: "stopped", stopReason: "keep", stateJson: { resumeRequestId: "keep" } }).returning();
    await db.update(schema.issues).set({ checkoutRunId: foreign.heartbeat.id, executionRunId: foreign.heartbeat.id, executionAgentNameKey: "replacement", executionLockedAt: f.input.now }).where(eq(schema.issues.id, f.issue.id));
    const foreignBefore = await readTerminal(db, foreign);
    const result = await runMissionTerminalCleanup(db, { ...f.input, status: "cancelled" });
    expect(result.stoppedRuntimeIds).toEqual([f.runtime.id]);
    expect(await readTerminal(db, foreign)).toEqual(foreignBefore);
    for (const issue of [otherIssue, foreignIssue]) expect((await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)))[0]).toEqual(issue);
    for (const run of heartbeats) expect((await db.select().from(schema.heartbeatRuns).where(eq(schema.heartbeatRuns.id, run.id)))[0]).toEqual(run);
    expect((await db.select().from(schema.missionAgentRuntimes).where(eq(schema.missionAgentRuntimes.id, stopped.id)))[0]).toEqual(stopped);
    expect((await db.select().from(schema.issues).where(eq(schema.issues.id, f.issue.id)))[0]).toMatchObject({ checkoutRunId: foreign.heartbeat.id, executionRunId: foreign.heartbeat.id, executionAgentNameKey: "replacement", executionLockedAt: f.input.now });
  });

  it("runtime raw PID is never killed; JSONB resume/unrelated keys and lastError survive", async () => {
    const f = await seedTerminal(db);
    await db.update(schema.missionAgentRuntimes).set({ processPid: 87654 }).where(eq(schema.missionAgentRuntimes.id, f.runtime.id));
    const rawKill = vi.spyOn(process, "kill").mockReturnValue(true);
    await runMissionTerminalCleanup(db, f.input);
    const { runtime } = await readTerminal(db, f);
    expect(runtime).toMatchObject({ status: "stopped", currentIssueId: null, queueDepth: 0, stopReason: "mission.completed", stoppedAt: f.input.now, updatedAt: f.input.now, lastError: "keep error" });
    expect(runtime.stateJson).toMatchObject({ ...f.runtime.stateJson, processTermination: [{ id: f.runtime.id, attempted: false, reason: "unverified_process_identity" }] });
    expect(rawKill).not.toHaveBeenCalled();
  });

  it.each(["heartbeat_queued", "heartbeat_running", "runtime", "none"])("%s remaining work controls global agent/session reset without touching other mission sessions", async (kind) => {
    const f = await seedTerminal(db);
    const [mission] = await db.insert(schema.missions).values({ companyId: f.company.id, ownerAgentId: f.agent.id, title: "Other mission" }).returning();
    const [secret] = await db.insert(schema.companySecrets).values({ companyId: f.company.id, name: randomUUID() }).returning();
    const sessions = await db.insert(schema.missionSessions).values([f.mission.id, mission.id].map((missionId) => ({ companyId: f.company.id, missionId, agentId: f.agent.id, sessionSecretId: secret.id, adapterType: "process", status: "active" }))).returning();
    if (kind.startsWith("heartbeat")) await db.insert(schema.heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: kind.endsWith("queued") ? "queued" : "running" });
    const runtimes = kind === "runtime" ? await db.insert(schema.missionAgentRuntimes).values({ companyId: f.company.id, missionId: mission.id,
      agentId: f.agent.id, adapterType: "process", runtimeKey: randomUUID(), status: "ready", sessionId: "other session" }).returning() : [];
    const [before] = await db.select().from(schema.agentRuntimeState).where(eq(schema.agentRuntimeState.agentId, f.agent.id));
    await runMissionTerminalCleanup(db, f.input);
    const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    const [state] = await db.select().from(schema.agentRuntimeState).where(eq(schema.agentRuntimeState.agentId, f.agent.id));
    if (kind === "none") {
      expect(agent.status).toBe("idle");
      expect(state).toMatchObject({ sessionId: null, lastError: null });
    } else {
      expect(agent).toEqual(f.agent);
      expect(state).toEqual(before);
    }
    for (const runtime of runtimes) expect((await db.select().from(schema.missionAgentRuntimes).where(eq(schema.missionAgentRuntimes.id, runtime.id)))[0]).toEqual(runtime);
    expect((await db.select().from(schema.missionSessions).where(eq(schema.missionSessions.id, sessions[0].id)))[0].status).toBe("closed");
    expect((await db.select().from(schema.missionSessions).where(eq(schema.missionSessions.id, sessions[1].id)))[0]).toEqual(sessions[1]);
  });

  it("real missionService completion uses transaction-bound oversight and settles its DB row", async () => {
    const f = await seedTerminal(db);
    await db.update(schema.issues).set({ originKind: "mission_main_executor_oversight" }).where(eq(schema.issues.id, f.issue.id));
    const result = await missionService(db, { cancelHeartbeatRun: f.input.cancelHeartbeatRun }).update(f.mission.id, { status: "completed" });
    expect(result?.status).toBe("completed");
    const [oversight] = await db.select().from(schema.issues).where(and(eq(schema.issues.companyId, f.company.id), eq(schema.issues.id, f.issue.id)));
    expect(oversight.status).toBe("done");
    expect(oversight.completedAt).not.toBeNull();
    expect((await readTerminal(db, f)).heartbeat.status).toBe("cancelled");
    expect(f.input.cancelHeartbeatRun).not.toHaveBeenCalled();
  }, 3000);
});
