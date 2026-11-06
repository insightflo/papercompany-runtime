import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, agentRuntimeState, companies, missions, missionSessions, agentTaskSessions } from "@paperclipai/db";
import { secretService } from "../../services/secrets.ts";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatSessionAuthorityCases({ getDb, heartbeatService, executeSpy, waitForRunTerminal }: HeartbeatBudgetCaseContext) {
  it("persists an early adapter session update on the heartbeat run before final result canonicalization", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Early Session",
      issuePrefix: `PES${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Early Session Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    executeSpy.mockImplementationOnce(async ({ onSessionUpdate }) => {
      await onSessionUpdate?.({
        sessionId: "early-session-1",
        sessionParams: { sessionId: "early-session-1", cwd: "/tmp/workspace" },
        sessionDisplayId: "early-session-1",
        source: "stdout",
        confidence: "provider_reported",
        observedAt: "2026-04-25T15:00:00.000Z",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(finalized.sessionIdAfter).toBe("early-session-1");
  });

  it("persists the latest adapter session id back into the mission-session binding", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    let runtimeSessionIdSeen: string | null = null;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Mission Session",
      issuePrefix: `PMR${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const missionId = await db.insert(missions).values({
      companyId,
      ownerAgentId: agentId,
      title: "Mission rotation",
      status: "planning",
    }).returning().then((rows) => rows[0]!.id);

    const secret = await secretService(db).create(companyId, {
      name: `mission-session:${missionId}:${agentId}:codex_local`,
      provider: "local_encrypted",
      value: "mission-session-old",
      description: "test mission session",
    });
    await db.insert(missionSessions).values({
      missionId,
      agentId,
      companyId,
      sessionSecretId: secret.id,
      adapterType: "codex_local",
    });

    executeSpy.mockImplementationOnce(async ({ runtime }) => {
      runtimeSessionIdSeen = runtime.sessionId ?? null;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        sessionId: "mission-session-new",
        resultJson: null,
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { missionId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(runtimeSessionIdSeen).toBe("mission-session-old");

    const [session] = await db
      .select()
      .from(missionSessions)
      .where(eq(missionSessions.missionId, missionId))
      .limit(1);
    const resolved = await secretService(db).resolveSecretValue(companyId, session!.sessionSecretId, "latest");
    expect(resolved).toBe("mission-session-new");
  });

  it("reports mission-session authority in runtime state when an active mission binding exists", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionSessionId = "mission-session-visible";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Mission State",
      issuePrefix: `PMS${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission State Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      sessionId: "runtime-fallback-session",
      stateJson: {},
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: "manual:legacy",
      sessionParamsJson: { sessionId: "legacy-task-session" },
      sessionDisplayId: "legacy-task-session",
    });

    const missionId = await db.insert(missions).values({
      companyId,
      ownerAgentId: agentId,
      title: "Mission state surface",
      status: "planning",
    }).returning().then((rows) => rows[0]!.id);

    const secret = await secretService(db).create(companyId, {
      name: `mission-session:${missionId}:${agentId}:codex_local`,
      provider: "local_encrypted",
      value: missionSessionId,
      description: "test runtime state mission session",
    });
    await db.insert(missionSessions).values({
      missionId,
      agentId,
      companyId,
      sessionSecretId: secret.id,
      adapterType: "codex_local",
      runCount: 3,
    });

    const state = await heartbeatService(db).getRuntimeState(agentId);

    expect(state).toBeTruthy();
    expect(state?.sessionAuthority).toBe("mission_session");
    expect(state?.sessionDisplayId).toBe(missionSessionId);
    expect(state?.sessionParamsJson).toBeNull();
    expect(state?.activeMissionSessionCount).toBe(1);
    expect(state?.latestMissionSession).toEqual(
      expect.objectContaining({
        missionId,
        sessionId: missionSessionId,
        runCount: 3,
      }),
    );
  });
}
