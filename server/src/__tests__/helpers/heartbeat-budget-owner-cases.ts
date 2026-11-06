import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, heartbeatRuns, issueComments, issueWorkProducts, issues, missions, type createDb } from "@paperclipai/db";
import type { heartbeatService } from "../../services/heartbeat.js";
import { seedMissionOwnerTaskContextFixture } from "./heartbeat-owner-context-fixture.js";
import type { createInstructionRotationFixture } from "./heartbeat-instruction-rotation-fixture.js";

export type HeartbeatAdapterFailureOverrides = Partial<{
  exitCode: number;
  signal: null;
  timedOut: boolean;
  errorMessage: null;
  usage: null;
  provider: string;
  model: string;
  resultJson: null;
  runtimeServices: never[];
  errorCode: string;
}>;

export type HeartbeatBudgetCaseContext = {
  getDb: () => ReturnType<typeof createDb>;
  heartbeatService: typeof heartbeatService;
  executeSpy: Mock;
  successfulAdapterResult: () => object;
  waitForRunTerminal: (heartbeat: ReturnType<typeof heartbeatService>, runId: string) => Promise<NonNullable<Awaited<ReturnType<ReturnType<typeof heartbeatService>["getRun"]>>>>;
  mockedAdapterOptions: { supportsLocalAgentJwt: boolean };
  waitForIssueStatus: (db: ReturnType<typeof createDb>, issueId: string, predicate: (issue: typeof issues.$inferSelect) => boolean) => Promise<typeof issues.$inferSelect>;
  waitForWakeupRequestStatus: (db: ReturnType<typeof createDb>, runId: string, predicate: (request: typeof agentWakeupRequests.$inferSelect) => boolean) => Promise<typeof agentWakeupRequests.$inferSelect>;
  mockRequestChangesOnce: (db: ReturnType<typeof createDb>, issueId: string, lines: string[]) => void;
  decisionComment: (decision: Record<string, unknown>) => string;
  validOwnerPlanDecision: (missionId: string, workflowDefinitionId: string) => Record<string, unknown>;
  failedAdapterResult: (overrides?: HeartbeatAdapterFailureOverrides) => object;
  waitForWakeupStatus: (db: ReturnType<typeof createDb>, wakeupRequestId: string, expected: string, deadlineMs?: number) => Promise<{ status: string } | null>;
  expectBroadScanInterception: (db: ReturnType<typeof createDb>, runId: string) => Promise<void>;
  seedInstructionRotationFixture: ReturnType<typeof createInstructionRotationFixture>;
};

export function registerHeartbeatOwnerContextCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal }: HeartbeatBudgetCaseContext) {
  it("injects the current control-plane API URL into heartbeat adapter context", async () => {
    const db = getDb();
    const previousPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
    const previousPaperclipListenHost = process.env.PAPERCLIP_LISTEN_HOST;
    const previousPaperclipListenPort = process.env.PAPERCLIP_LISTEN_PORT;
    const previousHost = process.env.HOST;
    const previousPort = process.env.PORT;
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "127.0.0.1";
    process.env.PAPERCLIP_LISTEN_PORT = "3100";
    delete process.env.HOST;
    delete process.env.PORT;

    const companyId = randomUUID();
    const agentId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: "PAP",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "API Context Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      executeSpy.mockImplementation(async ({ context }) => {
        invocationContext = structuredClone(context) as Record<string, unknown>;
        return successfulAdapterResult();
      });

      const heartbeat = heartbeatService(db);
      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual", {
        actorType: "system",
        actorId: "test-suite",
      });
      expect(run).not.toBeNull();

      const finalized = await waitForRunTerminal(heartbeat, run!.id);
      expect(finalized.status).toBe("succeeded");
      expect(invocationContext).toMatchObject({
        paperclipApiUrl: "http://127.0.0.1:3100",
        paperclipApiBaseUrl: "http://127.0.0.1:3100/api",
      });

      const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(persistedRun?.contextSnapshot).toMatchObject({
        paperclipApiUrl: "http://127.0.0.1:3100",
        paperclipApiBaseUrl: "http://127.0.0.1:3100/api",
      });
    } finally {
      if (previousPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
      else process.env.PAPERCLIP_API_URL = previousPaperclipApiUrl;
      if (previousPaperclipListenHost === undefined) delete process.env.PAPERCLIP_LISTEN_HOST;
      else process.env.PAPERCLIP_LISTEN_HOST = previousPaperclipListenHost;
      if (previousPaperclipListenPort === undefined) delete process.env.PAPERCLIP_LISTEN_PORT;
      else process.env.PAPERCLIP_LISTEN_PORT = previousPaperclipListenPort;
      if (previousHost === undefined) delete process.env.HOST;
      else process.env.HOST = previousHost;
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    }
  });

  it("attaches mission-owner-task context to mission_main_executor_unblock issues only by issue purpose", async () => {
    const db = getDb();
    const fixture = await seedMissionOwnerTaskContextFixture(db, "mission_main_executor_unblock");
    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "on_demand",
      { taskKey: "owner-action:unblock", issueId: fixture.ownerTaskIssueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMissionOwnerTaskContext).toEqual(
      expect.objectContaining({
        available: true,
        gating: "originKind",
        mission: expect.objectContaining({ id: fixture.missionId, title: "Mission owner context mission", status: "active" }),
        ownerTaskIssue: expect.objectContaining({ id: fixture.ownerTaskIssueId, originKind: "mission_main_executor_unblock" }),
        sourceIssue: expect.objectContaining({ id: fixture.sourceIssueId, status: "blocked", assigneeAgentId: fixture.agentId }),
        latestOwnerActionDecision: expect.objectContaining({ decision: "retry_source_issue" }),
      }),
    );
    const serialized = JSON.stringify(invocationContext?.paperclipMissionOwnerTaskContext);
    expect(serialized).toContain("Governance evidence: unavailable in this context builder");
    expect(serialized).toContain("owner_recovery_api");
    expect(serialized).toContain("display-only");
    expect(serialized).not.toContain("source issue private detail should stay bounded");
  });

  it("does not reconcile a mission-owner unblock ARTIFACT URL from stdout as source completion authority", async () => {
    const db = getDb();
    // Structured authority only: comment/stdout [ARTIFACT] URLs are display-only and must not
    // auto-register workProducts or mark the linked source issue done.
    const fixture = await seedMissionOwnerTaskContextFixture(db, "mission_main_executor_unblock");
    const artifactUrl = "https://manual-onboarding.pages.dev/onboarding/concepts/feynman-method-v2/index.html";
    executeSpy.mockResolvedValue({
      ...successfulAdapterResult(),
      resultJson: {
        stdout: [
          "### Mission owner decision",
          "Decision: retry_source_issue",
          "Source issue: PAP-SOURCE",
          "Reason: published directly after operations deferral",
          "",
          `[ARTIFACT]: ${artifactUrl}`,
        ].join("\n"),
      },
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "on_demand",
      { taskKey: "owner-action:unblock", issueId: fixture.ownerTaskIssueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
    expect(sourceIssue).toEqual(expect.objectContaining({
      status: "blocked",
      completedAt: null,
    }));

    const products = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, fixture.sourceIssueId));
    expect(products).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, fixture.sourceIssueId));
    expect(comments.some((comment) => comment.body.includes("Mission owner unblock result applied"))).toBe(false);
  });

  it("defers Hermes Ops mission issue execution to the mission main executor", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const opsAgentId = randomUUID();
    const missionId = randomUUID();
    const sourceIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Research Company",
      issuePrefix: "RES",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "operator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
      {
        id: opsAgentId,
        companyId,
        name: "Hermes Operations Manager",
        role: "pm",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: { operatingMode: "chief_of_staff_liaison" },
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Tech AI News",
      status: "active",
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      missionId,
      identifier: "RES-OPS",
      title: "Recover failed Telegram delivery",
      description: "Ops observed this but must not directly perform mission recovery.",
      status: "todo",
      assigneeAgentId: opsAgentId,
      originKind: "workflow_recovery",
    });

    executeSpy.mockReset();
    executeSpy.mockResolvedValue(successfulAdapterResult());

    const heartbeat = heartbeatService(db);
    // Clear any residual spy activity from prior-test async teardown races.
    executeSpy.mockClear();
    const run = await heartbeat.invoke(
      opsAgentId,
      "assignment",
      { taskKey: `issue:${sourceIssueId}`, issueId: sourceIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    expect(run).toBeNull();
    expect(executeSpy).not.toHaveBeenCalled();

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue).toEqual(expect.objectContaining({
      status: "todo",
      assigneeAgentId: opsAgentId,
      executionRunId: null,
    }));

    const ownerActions = await db.select().from(issues).where(eq(issues.originId, sourceIssueId));
    expect(ownerActions).toHaveLength(1);
    expect(ownerActions[0]).toEqual(expect.objectContaining({
      assigneeAgentId: ownerAgentId,
      missionId,
      originKind: "mission_main_executor_unblock",
      status: "todo",
    }));
    expect(ownerActions[0]?.description).toContain("Hermes Ops boundary");
    expect(ownerActions[0]?.description).toContain("signal the mission main executor");

    const requests = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: opsAgentId,
        status: "skipped",
        reason: "operations_mission_issue_deferred_to_main_executor",
      }),
      expect.objectContaining({
        agentId: ownerAgentId,
        status: "skipped",
        reason: "heartbeat.wakeOnDemand.disabled",
      }),
    ]));

    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "mission.ops_issue_deferred_to_main_executor",
        agentId: opsAgentId,
      }),
    ]));
  });
}
