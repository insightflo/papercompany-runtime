import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, missions, missionSessions, agentTaskSessions } from "@paperclipai/db";
import { secretService } from "../../services/secrets.ts";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatBootstrapAndTokenAuthorityCases({ getDb, heartbeatService, executeSpy, waitForRunTerminal }: HeartbeatBudgetCaseContext) {
  it("still blocks bootstrap broad-scan prompts when a saved session exists but cwd mismatch prevents resume", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:broad-scan-mismatch";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PBS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scanning Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Stay focused on the assigned issue.",
        bootstrapPromptTemplate: "Please scan the entire repo before doing anything else.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey,
      sessionParamsJson: { sessionId: "sess-1", cwd: "/tmp/other-cwd" },
      sessionDisplayId: "sess-1",
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("manifest_broad_scan_blocked");
    expect(finalized.error).toContain("scan the entire repo");
  });

  it("reuses mission_sessions token authority across three heartbeats for the same mission", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Session Company",
      issuePrefix: "MSC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Session Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Continue mission session." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Reuse mission session authority",
      status: "active",
    });

    executeSpy.mockImplementation(async ({ runtime }) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: null,
      provider: "test",
      model: "test-model",
      resultJson: null,
      sessionId: runtime.sessionId ?? "mission-token-1",
    }));

    const heartbeat = heartbeatService(db);
    const runIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const run = await heartbeat.invoke(agentId, "on_demand", { missionId }, "manual", {
        actorType: "system",
        actorId: "test-suite",
      });
      expect(run).not.toBeNull();
      runIds.push(run!.id);
      const finalized = await waitForRunTerminal(heartbeat, run!.id);
      expect(finalized.status).toBe("succeeded");
    }

    // [주의] 전체 suite 병렬 실행에서 background/queued run 이 executeSpy 를 1회 추가로 부를 수 있어
    //   전역 카운트(3) 단정이 간헐 fail. 이 테스트가 직접 시작한 runId 로 필터링해 단정한다.
    const ownCalls = executeSpy.mock.calls.filter(
      (call) => runIds.includes((call[0] as { runId?: string }).runId ?? ""),
    );
    expect(ownCalls).toHaveLength(3);
    const runtimes = ownCalls.map(
      (call) => (call[0] as { runtime: { sessionId: string | null; sessionDisplayId: string | null } }).runtime,
    );
    expect(runtimes.map((runtime) => runtime.sessionId)).toEqual([null, "mission-token-1", "mission-token-1"]);
    expect(runtimes.map((runtime) => runtime.sessionDisplayId)).toEqual([null, "mission-token-1", "mission-token-1"]);

    const rows = await db.select().from(missionSessions).where(eq(missionSessions.missionId, missionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        companyId,
        missionId,
        agentId,
        adapterType: "codex_local",
        runCount: 3,
      }),
    );
    expect(rows[0]?.sessionSecretId).toBeTruthy();

    const secretValue = await secretService(db).resolveSecretValue(companyId, rows[0]!.sessionSecretId, "latest");
    expect(secretValue).toBe("mission-token-1");
  });

  it("counts agent and run placeholders before adapter execution", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent Name That Expands Budget",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "{{agent.name}} {{runId}} {{agent.name}} {{runId}}",
      },
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedChars: 20,
          },
        },
      },
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("context_budget_exceeded");
    expect(finalized.error).toContain("chars exceeds budget");
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}
