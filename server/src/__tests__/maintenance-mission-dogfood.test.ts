import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";
import {
  activityLog,
  agentKbGrants,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  companies,
  companySecrets,
  companySkills,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  knowledgeBases,
  missions,
  worktreeRules,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const executeSpy = vi.fn();

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    supportsLocalAgentJwt: false,
    execute: executeSpy,
  })),
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.ts";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-maintenance-dogfood-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, instance, dataDir };
}

async function waitForRunTerminal(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

async function cleanupHeartbeatRunRecords(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(agentTaskSessions);
    try {
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object record");
  }
  return value as Record<string, unknown>;
}

describe("maintenance mission dogfood", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    executeSpy.mockReset();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await cleanupHeartbeatRunRecords(db);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agentKbGrants);
    await db.delete(knowledgeBases);
    await db.delete(worktreeRules);
    await db.delete(missions);
    await db.delete(agentRuntimeState);
    await db.delete(companySecrets);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedMissionDogfood(input: {
    title: string;
    description: string;
    status?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const knowledgeBaseId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Papercompany Maintenance Dogfood",
      issuePrefix: `PMD${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Maintenance Dogfood Agent",
      role: "maintenance",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Follow the Paperclip runtime brief and maintenance guidance." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Maintenance dogfood mission",
      status: "planning",
    });
    await db.insert(worktreeRules).values([
      {
        id: randomUUID(),
        companyId,
        name: "Collect missing maintenance intake before repair",
        severity: "MUST",
        action: "request_missing_input",
        predicate: { scope: "maintenance_issue" },
        decisionMap: { suggestedStatus: "blocked" },
        message: "If affected system, symptom, or time window is missing, request clarification before repair.",
        enabled: true,
        createdBy: "test-suite",
      },
      {
        id: randomUUID(),
        companyId,
        name: "Prepare vendor handoff evidence",
        severity: "SHOULD",
        action: "vendor_handoff",
        predicate: { dependency: "external" },
        decisionMap: { handoffTarget: "vendor" },
        message: "For external dependencies, collect evidence and prepare vendor handoff before self-repair.",
        enabled: true,
        createdBy: "test-suite",
      },
    ]);
    await db.insert(knowledgeBases).values({
      id: knowledgeBaseId,
      companyId,
      name: "Maintenance SOP KB",
      type: "static",
      description: "Maintenance workflow SOP",
      maxTokenBudget: 1024,
      configJson: {
        content:
          "Maintenance SOP: first identify affected system, symptom, time window, customer impact, vendor dependency, evidence, and verification before closing.",
      },
    });
    await db.insert(agentKbGrants).values({
      id: randomUUID(),
      agentId,
      kbId: knowledgeBaseId,
      grantedBy: "test-suite",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: input.title,
      description: input.description,
      status: input.status ?? "todo",
      assigneeAgentId: agentId,
    });

    return { companyId, agentId, missionId, issueId, knowledgeBaseId };
  }

  async function runDogfoodScenario(input: {
    title: string;
    description: string;
    status?: string;
    requestedStatus?: string;
  }) {
    const seeded = await seedMissionDogfood(input);
    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
        runtimeServices: [],
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      seeded.agentId,
      "on_demand",
      {
        issueId: seeded.issueId,
        missionId: seeded.missionId,
        note: "maintenance dogfood runtime path",
        ...(input.requestedStatus ? { requestedStatus: input.requestedStatus } : {}),
      },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext).toBeDefined();
    if (!invocationContext) throw new Error("Expected adapter invocation context");

    const brief = buildPaperclipRuntimeBrief(invocationContext);
    const [auditRow] = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(auditRow).toEqual(expect.objectContaining({ action: "maintenance_decision_evaluated" }));

    return {
      ...seeded,
      runId: run!.id,
      context: invocationContext,
      decision: readRecord(invocationContext.paperclipMaintenanceDecision),
      manifestInputs: readRecord(readRecord(invocationContext.paperclipStepInputManifest).inputs),
      brief,
      auditDetails: readRecord(auditRow!.details),
    };
  }

  it("shows guidance, decision, runtime brief, and audit for representative mission scenarios", async () => {
    const scenarios = [
      {
        name: "missing input",
        issue: {
          title: "확인 요청",
          description: "고객이 처리 요청함. 자세한 대상과 증상, 발생 시각은 아직 전달되지 않음.",
        },
        expected: {
          action: "request_missing_input",
          status: "blocked",
          requiredInputs: ["affectedSystem", "symptom", "timeWindow"],
          warnings: [],
          brief: ["Maintenance decision: request_missing_input", "Required inputs:", "affectedSystem"],
        },
      },
      {
        name: "customer-impact outage",
        issue: {
          title: "Production outage customer impact",
          description: "결제 시스템 고객 전체 결제 불가. 오늘 11:00부터 symptom: approval failed.",
        },
        expected: {
          action: "escalate_incident",
          status: "in_progress",
          requiredInputs: [],
          warnings: [],
          brief: ["Maintenance decision: escalate_incident", "Required inputs: none"],
        },
      },
      {
        name: "vendor dependency",
        issue: {
          title: "PG사 external API timeout",
          description: "결제 시스템 vendor timeout. 오늘 11:00부터 symptom: approval failed.",
        },
        expected: {
          action: "vendor_handoff",
          status: "in_progress",
          requiredInputs: [],
          warnings: [],
          handoffTarget: "vendor",
          brief: ["Maintenance decision: vendor_handoff", "Handoff target: vendor"],
        },
      },
      {
        name: "done without evidence",
        issue: {
          title: "키오스크 프린터 오류 조치 완료 처리",
          description: "프린터 시스템 symptom: 출력 실패. 오늘 10:30부터 발생. 완료 처리를 요청함.",
          requestedStatus: "done",
        },
        expected: {
          action: "verify_and_close",
          status: "in_review",
          requiredInputs: [],
          warnings: ["completion_evidence_missing"],
          brief: ["Maintenance decision: verify_and_close", "Decision warnings: completion_evidence_missing"],
        },
      },
    ];

    for (const scenario of scenarios) {
      const result = await runDogfoodScenario({
        title: scenario.issue.title,
        description: scenario.issue.description,
        requestedStatus: scenario.issue.requestedStatus,
      });

      expect(result.context.paperclipMaintenanceGuidance).toEqual(
        expect.objectContaining({
          version: 1,
          rules: expect.arrayContaining([
            expect.objectContaining({ name: "Collect missing maintenance intake before repair" }),
            expect.objectContaining({ name: "Prepare vendor handoff evidence" }),
          ]),
          knowledge: expect.arrayContaining([
            expect.objectContaining({ name: "Maintenance SOP KB", content: expect.stringContaining("Maintenance SOP") }),
          ]),
        }),
      );
      expect(result.manifestInputs.maintenanceGuidance).toEqual(
        expect.objectContaining({
          available: true,
          ruleCount: 2,
          knowledgeCount: 1,
          ruleNames: expect.arrayContaining(["Collect missing maintenance intake before repair"]),
          knowledgeNames: ["Maintenance SOP KB"],
        }),
      );
      expect(result.manifestInputs.maintenanceDecision).toEqual(
        expect.objectContaining({
          available: true,
          recommendedNextAction: scenario.expected.action,
          suggestedStatus: scenario.expected.status,
          requiredInputs: scenario.expected.requiredInputs,
          warnings: scenario.expected.warnings,
        }),
      );
      if ("handoffTarget" in scenario.expected) {
        expect(result.decision.handoffTarget).toBe(scenario.expected.handoffTarget);
        expect(result.auditDetails.handoffTarget).toBe(scenario.expected.handoffTarget);
      }
      for (const briefFragment of scenario.expected.brief) {
        expect(result.brief, scenario.name).toContain(briefFragment);
      }
      expect(result.brief).toContain("Maintenance guidance: 2 rules, 1 KB references");
      expect(result.brief).toContain("Guidance KB: Maintenance SOP KB");
      expect(result.auditDetails).toEqual(
        expect.objectContaining({
          issueId: result.issueId,
          runId: result.runId,
          recommendedNextAction: scenario.expected.action,
          suggestedStatus: scenario.expected.status,
          requiredInputs: scenario.expected.requiredInputs,
          warnings: scenario.expected.warnings,
          kbReferences: expect.arrayContaining([
            expect.objectContaining({ id: result.knowledgeBaseId, name: "Maintenance SOP KB" }),
          ]),
          matchedRules: expect.arrayContaining([expect.objectContaining({ action: scenario.expected.action })]),
        }),
      );

    }
  }, 15_000);
});
