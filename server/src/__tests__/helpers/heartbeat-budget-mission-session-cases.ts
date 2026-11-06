import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, companySecretVersions, companySecrets, missions, missionSessions, agentTaskSessions } from "@paperclipai/db";
import { secretService } from "../../services/secrets.ts";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatMissionSessionCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal }: HeartbeatBudgetCaseContext) {
  it("preserves scheduler mission context and reuses the mission-scoped session path before execution", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Scheduler",
      issuePrefix: `PSC${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scheduled Agent",
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
      title: "Scheduled mission",
      status: "planning",
    }).returning().then((rows) => rows[0]!.id);
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: `mission:${missionId}`,
      sessionParamsJson: { sessionId: "mission-session-1" },
      sessionDisplayId: "mission-session-1",
    });

    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementationOnce(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "scheduler",
      triggerDetail: "schedule:daily-sync",
      payload: { missionId },
      reason: "scheduled_wakeup",
    });

    expect(run).not.toBeNull();
    expect(run?.invocationSource).toBe("scheduler");
    expect(run?.sessionIdBefore).toBe("mission-session-1");
    expect(run?.contextSnapshot).toEqual(
      expect.objectContaining({
        missionId,
        wakeSource: "scheduler",
        wakeTriggerDetail: "schedule:daily-sync",
      }),
    );
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMissionWorkingNote).toEqual(expect.objectContaining({
      available: true,
      missionId,
      fileName: "working.md",
      role: "shared_mission_working_note",
    }));
    const workingNote = invocationContext?.paperclipMissionWorkingNote as { path?: string } | undefined;
    expect(workingNote?.path).toBe(path.join(
      process.env.PAPERCLIP_HOME!,
      "instances",
      "heartbeat-test",
      "mission-working-notes",
      companyId,
      missionId,
      "working.md",
    ));
    expect(fs.readFileSync(workingNote!.path!, "utf8")).toContain(`- Mission ID: ${missionId}`);
  });

  it("creates a mission-session binding from an existing mission task session on wakeup", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Mission Session",
      issuePrefix: `PMS${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
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
      title: "Mission binding",
      status: "planning",
    }).returning().then((rows) => rows[0]!.id);
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: `mission:${missionId}`,
      sessionParamsJson: { sessionId: "legacy-mission-session" },
      sessionDisplayId: "legacy-mission-session",
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "scheduler",
      triggerDetail: "schedule:mission-session",
      payload: { missionId },
      reason: "scheduled_wakeup",
    });

    expect(run?.sessionIdBefore).toBe("legacy-mission-session");

    const [session] = await db
      .select()
      .from(missionSessions)
      .where(eq(missionSessions.missionId, missionId))
      .limit(1);
    expect(session).toBeTruthy();
    expect(session?.agentId).toBe(agentId);

    const [secret] = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, session!.sessionSecretId))
      .limit(1);
    expect(secret?.name).toContain(`mission-session:${missionId}:${agentId}:codex_local`);

    const resolved = await secretService(db).resolveSecretValue(companyId, session!.sessionSecretId, "latest");
    expect(resolved).toBe("legacy-mission-session");
  });

  it("resets an unreadable mission-session secret instead of dropping the wakeup", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    let runtimeSessionIdSeen: string | null | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Corrupt Mission Session",
      issuePrefix: `PCM${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
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
      title: "Mission binding recovery",
      status: "planning",
    }).returning().then((rows) => rows[0]!.id);

    const secret = await db.insert(companySecrets).values({
      companyId,
      name: `mission-session:${missionId}:${agentId}:codex_local`,
      provider: "local_encrypted",
      latestVersion: 1,
      description: "corrupt test mission session",
    }).returning().then((rows) => rows[0]!);
    await db.insert(companySecretVersions).values({
      secretId: secret.id,
      version: 1,
      material: {
        scheme: "local_encrypted_v1",
        iv: Buffer.alloc(12).toString("base64"),
        tag: Buffer.alloc(16).toString("base64"),
        ciphertext: Buffer.from("not-valid-for-this-tag").toString("base64"),
      },
      valueSha256: "corrupt-mission-session",
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
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "scheduler",
      triggerDetail: "schedule:corrupt-mission-session",
      payload: { missionId },
      reason: "scheduled_wakeup",
    });

    expect(run).not.toBeNull();
    expect(run?.sessionIdBefore).toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(runtimeSessionIdSeen).toBeNull();

    const [updatedSecret] = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id))
      .limit(1);
    expect(updatedSecret?.latestVersion).toBe(2);
    const resolved = await secretService(db).resolveSecretValue(companyId, secret.id, "latest");
    expect(resolved).toBe("");
  });
}
