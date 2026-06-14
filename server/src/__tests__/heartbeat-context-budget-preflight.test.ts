import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  companies,
  companySecrets,
  companySkills,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  knowledgeBases,
  issueComments,
  issueDocuments,
  issueWorkProducts,
  issues,
  missionPlanArtifacts,
  missions,
  missionSessions,
  projects,
  toolDefinitions,
  agentKbGrants,
  agentTaskSessions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workspaceRuntimeServices,
} from "@paperclipai/db";

const executeSpy = vi.fn();
const mockedAdapterOptions = vi.hoisted(() => ({ supportsLocalAgentJwt: false }));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    supportsLocalAgentJwt: mockedAdapterOptions.supportsLocalAgentJwt,
    execute: executeSpy,
  })),
  runningProcesses: new Map(),
}));

import { classifyHeartbeatRunFailure, heartbeatService } from "../services/heartbeat.ts";
import { secretService } from "../services/secrets.ts";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-heartbeat-budget-"));
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

async function waitForIssueStatus(
  db: ReturnType<typeof createDb>,
  issueId: string,
  predicate: (issue: typeof issues.$inferSelect) => boolean,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    if (issue && predicate(issue)) return issue;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
  throw new Error(`Timed out waiting for issue ${issueId}; latest status=${issue?.status ?? "missing"}`);
}

async function waitForActiveMissionPlanArtifact(
  db: ReturnType<typeof createDb>,
  missionId: string,
  predicate: (plan: typeof missionPlanArtifacts.$inferSelect) => boolean,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    const activePlan = plans.find((plan) => plan.status === "active") ?? null;
    if (activePlan && predicate(activePlan)) return activePlan;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
  throw new Error(`Timed out waiting for active mission plan ${missionId}; count=${plans.length}`);
}

async function cleanupHeartbeatRunRecords(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(agentTaskSessions);
    try {
      await db.delete(heartbeatRuns);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function successfulAdapterResult() {
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
}

function failedAdapterResult(overrides: Partial<ReturnType<typeof successfulAdapterResult> & { errorCode: string }> = {}) {
  return {
    ...successfulAdapterResult(),
    exitCode: 1,
    timedOut: false,
    errorMessage: "Adapter failed",
    errorCode: "adapter_failed",
    ...overrides,
  };
}

function decisionComment(decision: Record<string, unknown>) {
  return `### Mission owner plan decision
\`\`\`json
${JSON.stringify(decision)}
\`\`\``;
}

function validOwnerPlanDecision(missionId: string, workflowDefinitionId: string) {
  return {
    missionId,
    missionGoal: "Ship controlled rollout",
    selectedExecutionUnits: [
      {
        id: `wf:${workflowDefinitionId}:step:smoke`,
        kind: "workflow_definition_step",
        title: "Run smoke",
        selectionState: "selected",
        reason: "Required for validation",
        sourceRef: { type: "workflow_definition_step", id: workflowDefinitionId, stepId: "smoke" },
      },
    ],
    requiredInputs: ["stagingUrl"],
    successCriteria: ["smoke passes"],
    steps: [{ id: "step-1", title: "Verify staging" }],
  };
}

async function seedMissionOwnerTaskContextFixture(db: ReturnType<typeof createDb>, issueKind: string, description?: string) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  const sourceIssueId = randomUUID();
  const ownerTaskIssueId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix: "PAP",
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Shared Worker",
    role: "engineer",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: { promptTemplate: "Follow the issue." },
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(missions).values({
    id: missionId,
    companyId,
    ownerAgentId: agentId,
    title: "Mission owner context mission",
    status: "active",
  });
  await db.insert(issues).values({
    id: sourceIssueId,
    companyId,
    missionId,
    identifier: "PAP-SOURCE",
    title: "Blocked source issue",
    description: "source issue private detail should stay bounded",
    status: "blocked",
    assigneeAgentId: agentId,
    originKind: "workflow_execution",
  });
  await db.insert(issues).values({
    id: ownerTaskIssueId,
    companyId,
    missionId,
    identifier: `PAP-${issueKind.toUpperCase().slice(0, 8)}`,
    title: `${issueKind} current issue`,
    description: description ?? "Mission owner task description",
    status: "todo",
    assigneeAgentId: agentId,
    originKind: issueKind,
    originId: issueKind === "mission_main_executor_unblock" ? sourceIssueId : null,
  });
  await db.insert(issueComments).values({
    companyId,
    issueId: ownerTaskIssueId,
    authorAgentId: agentId,
    body: [
      "### Mission owner decision",
      "Decision: retry_source_issue",
      `Source issue: ${sourceIssueId}`,
      "Reason: source is now unblockable",
      "Next action: re-dispatch later after approval",
      "Evidence: bounded owner comment",
    ].join("\n"),
  });

  return { companyId, agentId, missionId, sourceIssueId, ownerTaskIssueId };
}

describe("heartbeat context budget preflight", () => {
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
    mockedAdapterOptions.supportsLocalAgentJwt = false;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    delete process.env.PAPERCLIP_AGENT_JWT_ISSUER;
    delete process.env.PAPERCLIP_AGENT_JWT_AUDIENCE;
    await new Promise((resolve) => setTimeout(resolve, 150));
    await db.delete(agentTaskSessions);
    await cleanupHeartbeatRunRecords(db);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(missionPlanArtifacts);
    await db.delete(issues);
    await db.delete(toolDefinitions);
    await db.delete(agentKbGrants);
    await db.delete(knowledgeBases);
    await db.delete(missionSessions);
    await db.delete(missions);
    await db.delete(companySecrets);
    await db.delete(agentRuntimeState);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("attaches mission-owner-task context to mission_main_executor_unblock issues only by issue purpose", async () => {
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
    expect(serialized).toContain("### Mission owner decision");
    expect(serialized).not.toContain("source issue private detail should stay bounded");
  });

  it("attaches mission-owner-task context to mission_main_executor_oversight issues", async () => {
    const fixture = await seedMissionOwnerTaskContextFixture(db, "mission_main_executor_oversight");
    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "on_demand",
      { taskKey: "owner-action:oversight", issueId: fixture.ownerTaskIssueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMissionOwnerTaskContext).toEqual(
      expect.objectContaining({
        available: true,
        gating: "originKind",
        mission: expect.objectContaining({ id: fixture.missionId }),
        ownerTaskIssue: expect.objectContaining({ id: fixture.ownerTaskIssueId, originKind: "mission_main_executor_oversight" }),
        sourceIssue: null,
      }),
    );
  });

  it("does not attach mission-owner-task context to normal workflow_execution issues assigned to the same agent", async () => {
    const fixture = await seedMissionOwnerTaskContextFixture(db, "workflow_execution");
    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "on_demand",
      { taskKey: "worker:normal", issueId: fixture.ownerTaskIssueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMissionOwnerTaskContext).toBeUndefined();
  });

  it("attaches mission-owner-task context from a valid mission-owner-action marker", async () => {
    const fixture = await seedMissionOwnerTaskContextFixture(db, "manual", "placeholder");
    const marker = `<!-- mission-owner-action:{"missionId":"${fixture.missionId}","sourceIssueId":"${fixture.sourceIssueId}","actionType":"unblock","status":"decision_required"} -->`;
    await db.update(issues).set({ description: marker }).where(eq(issues.id, fixture.ownerTaskIssueId));
    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "on_demand",
      { taskKey: "owner-action:marker", issueId: fixture.ownerTaskIssueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMissionOwnerTaskContext).toEqual(
      expect.objectContaining({
        available: true,
        gating: "mission-owner-action-marker",
        mission: expect.objectContaining({ id: fixture.missionId }),
        sourceIssue: expect.objectContaining({ id: fixture.sourceIssueId }),
      }),
    );
  });

  it("injects the checked-out issue task into adapter config even when the agent uses a custom prompt template", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    let invocationConfig: Record<string, unknown> | undefined;
    let invocationAgentConfig: Record<string, unknown> | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Custom Prompt Hermes Agent",
      role: "researcher",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: { promptTemplate: "Route research requests only." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-TASK",
      title: "Plan today Tech Scout run",
      description: "Create the concrete source plan and first research request for today.",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ config, agent }) => {
      invocationConfig = structuredClone(config) as Record<string, unknown>;
      invocationAgentConfig = structuredClone(agent.adapterConfig) as Record<string, unknown>;
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${issueId}`, issueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationAgentConfig).toEqual(expect.objectContaining(invocationConfig ?? {}));
    expect(invocationConfig).toEqual(
      expect.objectContaining({
        promptTemplate: expect.stringContaining("## Assigned Task"),
        taskId: issueId,
        taskTitle: "Plan today Tech Scout run",
        taskBody: "Create the concrete source plan and first research request for today.",
      }),
    );
    const injectedPromptTemplate = String(invocationConfig?.promptTemplate);
    expect(injectedPromptTemplate).toContain(`Issue ID: ${issueId}`);
    expect(injectedPromptTemplate).toContain("Title: Plan today Tech Scout run");
    expect(injectedPromptTemplate).toContain("Create the concrete source plan and first research request for today.");
    expect(injectedPromptTemplate).not.toContain("{{taskId}}");
    expect(injectedPromptTemplate).not.toContain("{{#taskId}}");
    expect(injectedPromptTemplate).toContain("Use Paperclip API env vars for lifecycle updates or evidence/blocker comments when needed.");
    expect(injectedPromptTemplate).toContain("Mark this issue done after its scoped evidence is posted");
  });

  it("injects a direct execution contract for delegated mission child issues", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();
    let invocationConfig: Record<string, unknown> | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Domain Research Agent",
      role: "researcher",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {
        promptTemplate: "For broad work, create bounded child issues with parentId and goalId where available.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Mission child prompt contract",
      status: "active",
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      missionId,
      identifier: "PAP-PLAN",
      title: "Mission plan",
      description: "Create the first execution wave.",
      status: "done",
      assigneeAgentId: agentId,
      originKind: "mission_main_executor_plan",
    });
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      missionId,
      parentId: parentIssueId,
      identifier: "PAP-SOURCE",
      title: "Source dossier",
      description: "Post a source-backed issue comment. Do not produce HTML.",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "director_plan_source",
      requestDepth: 1,
    });

    executeSpy.mockImplementation(async ({ config }) => {
      invocationConfig = structuredClone(config) as Record<string, unknown>;
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, childIssueId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${childIssueId}`, issueId: childIssueId, missionId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    const injectedPromptTemplate = String(invocationConfig?.promptTemplate);
    expect(injectedPromptTemplate).toContain("## Mission Child Issue Contract");
    expect(injectedPromptTemplate).toContain("This is a bounded mission child issue.");
    expect(injectedPromptTemplate).toContain("Work only this issue's scoped deliverable.");
    expect(injectedPromptTemplate).toContain("Do not create downstream, sibling, recovery, QA, synthesis, validator, or director-gate work unless this issue explicitly asks for it.");
    expect(injectedPromptTemplate).toContain("Treat the mission final output as mission context unless this issue explicitly asks you to create it.");
  });

  it("injects local agent JWT as PAPERCLIP_API_KEY for adapters that support local agent auth", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    let invocationConfig: Record<string, unknown> | undefined;
    let invocationAgentConfig: Record<string, unknown> | undefined;

    mockedAdapterOptions.supportsLocalAgentJwt = true;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-local-agent-jwt-secret";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Hermes API Agent",
      role: "researcher",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-AUTH",
      title: "Finalize through Paperclip API",
      description: "Use Paperclip API to comment and complete this issue.",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ config, agent, authToken }) => {
      invocationConfig = structuredClone(config) as Record<string, unknown>;
      invocationAgentConfig = structuredClone(agent.adapterConfig) as Record<string, unknown>;
      expect(authToken).toEqual(expect.any(String));
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${issueId}`, issueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    const configEnv = invocationConfig?.env as Record<string, unknown> | undefined;
    const agentEnv = invocationAgentConfig?.env as Record<string, unknown> | undefined;
    expect(configEnv?.PAPERCLIP_API_KEY).toEqual(expect.any(String));
    expect(agentEnv?.PAPERCLIP_API_KEY).toBe(configEnv?.PAPERCLIP_API_KEY);
    expect(String(configEnv?.PAPERCLIP_API_KEY).split(".")).toHaveLength(3);
  });

  it("auto-completes a successful checked-out issue when the run exits without PATCHing status", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Lifecycle Agent",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Work the checked out issue." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-LIFE",
      title: "Issue lifecycle must be explicit",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ runId }) => {
      await db
        .update(issues)
        .set({
          checkoutRunId: runId,
          executionRunId: runId,
        })
        .where(eq(issues.id, issueId));
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        body: "I completed this in the run, but did not PATCH the issue status.",
      });
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${issueId}`, issueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(
      expect.objectContaining({
        status: "done",
        checkoutRunId: null,
        executionRunId: null,
      }),
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("checked-out run succeeded"))).toBe(true);

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "issue.run_succeeded_auto_completed",
          entityType: "issue",
          entityId: issueId,
        }),
      ]),
    );
  });

  it("syncs workflow step runs after auto-completing a successful workflow execution issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const qaAgentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const completedStepRunId = randomUUID();
    const followupStepRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Workflow Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Work the checked out issue." },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "Workflow QA Agent",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Review the completed workflow step." },
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Two step workflow",
      stepsJson: [
        { id: "draft", name: "Draft", agentId, dependencies: [] },
        { id: "review", name: "Review", agentId: qaAgentId, dependencies: ["draft"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-WF-1",
      title: "Draft workflow output",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originRunId: workflowRunId,
    });
    await db.insert(workflowStepRuns).values([
      {
        id: completedStepRunId,
        workflowRunId,
        stepId: "draft",
        issueId,
        status: "running",
        startedAt: new Date(),
      },
      {
        id: followupStepRunId,
        workflowRunId,
        stepId: "review",
        issueId: null,
        status: "pending",
      },
    ]);

    executeSpy.mockImplementation(async ({ runId }) => {
      await db
        .update(issues)
        .set({ checkoutRunId: runId, executionRunId: runId })
        .where(eq(issues.id, issueId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${issueId}`, issueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );

    const deadline = Date.now() + 5_000;
    let stepRuns: (typeof workflowStepRuns.$inferSelect)[] = [];
    while (Date.now() < deadline) {
      stepRuns = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, workflowRunId));
      const draft = stepRuns.find((stepRun) => stepRun.id === completedStepRunId);
      const review = stepRuns.find((stepRun) => stepRun.id === followupStepRunId);
      if (draft?.status === "completed" && review?.issueId) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const draftStep = stepRuns.find((stepRun) => stepRun.id === completedStepRunId);
    const reviewStep = stepRuns.find((stepRun) => stepRun.id === followupStepRunId);

    expect(draftStep).toEqual(
      expect.objectContaining({
        status: "completed",
        issueId,
      }),
    );
    expect(draftStep?.completedAt).toBeInstanceOf(Date);
    expect(reviewStep).toEqual(
      expect.objectContaining({
        status: "pending",
        issueId: expect.any(String),
      }),
    );
    const reviewIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, reviewStep!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(reviewIssue).toEqual(
      expect.objectContaining({
        assigneeAgentId: qaAgentId,
        originKind: "workflow_execution",
        originRunId: workflowRunId,
        status: "todo",
      }),
    );
  });

  it("records a mission owner PLAN decision when heartbeat auto-completes the checked-out planning issue", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    const sourceWorkflowDefinitionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Plan the mission." },
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Planning mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: sourceWorkflowDefinitionId,
      companyId,
      name: "Source smoke workflow",
    });
    await db.insert(issues).values({
      id: planningIssueId,
      companyId,
      missionId,
      identifier: "PAP-PLAN",
      title: "[PLAN] Planning mission",
      status: "in_progress",
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
    });

    const decision = validOwnerPlanDecision(missionId, sourceWorkflowDefinitionId);
    executeSpy.mockImplementation(async ({ runId }) => {
      await db
        .update(issues)
        .set({ checkoutRunId: runId, executionRunId: runId })
        .where(eq(issues.id, planningIssueId));
      await db.insert(issueComments).values({
        companyId,
        issueId: planningIssueId,
        authorAgentId: ownerAgentId,
        body: decisionComment(decision),
      });
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      ownerAgentId,
      "timer",
      { taskKey: `issue:${planningIssueId}`, issueId: planningIssueId, missionId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    await waitForIssueStatus(
      db,
      planningIssueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );

    const plan = await waitForActiveMissionPlanArtifact(
      db,
      missionId,
      (candidate) => {
        const refs = candidate.refs as { paqoWorkflow?: unknown } | null;
        return !!refs && typeof refs === "object" && !!refs.paqoWorkflow;
      },
    );
    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans.filter((candidate) => candidate.status === "active")).toHaveLength(1);
    expect(plan.refs).toMatchObject({
      selectedExecutionUnits: decision.selectedExecutionUnits,
      ownerPlanDecision: {
        planningIssueId,
        commentId: expect.any(String),
        decisionHash: expect.any(String),
      },
      paqoWorkflow: {
        workflowDefinitionId: expect.any(String),
        workflowRunId: expect.any(String),
        dependencyModel: "workflow_dag_intra_mission",
      },
    });

    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Ship controlled rollout"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, paqoDefinitions[0]!.id));
    expect(paqoRuns).toHaveLength(1);
    expect(paqoRuns[0]).toMatchObject({ companyId, missionId, status: "running" });
    const paqoStepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, paqoRuns[0]!.id));
    expect(paqoStepRuns).toHaveLength(2);
    const qaStepRun = paqoStepRuns.find((stepRun) => stepRun.stepId.startsWith("qa-"));
    expect(qaStepRun).toMatchObject({ issueId: null, status: "pending" });
  });

  it("records a mission owner PLAN decision captured from adapter result output", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    const sourceWorkflowDefinitionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Plan the mission." },
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Planning mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: sourceWorkflowDefinitionId,
      companyId,
      name: "Source smoke workflow",
    });
    await db.insert(issues).values({
      id: planningIssueId,
      companyId,
      missionId,
      identifier: "PAP-PLAN",
      title: "[PLAN] Planning mission",
      status: "in_progress",
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
    });

    const decision = validOwnerPlanDecision(missionId, sourceWorkflowDefinitionId);
    executeSpy.mockImplementation(async ({ runId, onLog }) => {
      await db
        .update(issues)
        .set({ checkoutRunId: runId, executionRunId: runId })
        .where(eq(issues.id, planningIssueId));
      await onLog("stdout", `${JSON.stringify({
        type: "result",
        subtype: "success",
        result: `Planning complete.\n\n${decisionComment(decision)}\n\nSummary: proceed.`,
      })}\n`);
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      ownerAgentId,
      "timer",
      { taskKey: `issue:${planningIssueId}`, issueId: planningIssueId, missionId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    await waitForIssueStatus(
      db,
      planningIssueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, planningIssueId));
    const commentBodies = comments.map((comment) => comment.body).join("\n\n");
    expect(commentBodies).toContain("### Captured PLAN decision output");
    expect(commentBodies).toContain("### Mission owner plan decision");

    const plan = await waitForActiveMissionPlanArtifact(
      db,
      missionId,
      (candidate) => {
        const refs = candidate.refs as { paqoWorkflow?: unknown } | null;
        return !!refs && typeof refs === "object" && !!refs.paqoWorkflow;
      },
    );
    expect(plan.refs).toMatchObject({
      selectedExecutionUnits: decision.selectedExecutionUnits,
      ownerPlanDecision: {
        planningIssueId,
        commentId: expect.any(String),
        decisionHash: expect.any(String),
      },
      paqoWorkflow: {
        workflowDefinitionId: expect.any(String),
        workflowRunId: expect.any(String),
        dependencyModel: "workflow_dag_intra_mission",
      },
    });
  });

  it("classifies quota/auth/command provider failures for oversight", () => {
    expect(
      classifyHeartbeatRunFailure({
        status: "failed",
        errorCode: "provider_403",
        errorMessage: "HTTP 403: Kimi quota exceeded for this account",
        provider: "kimi",
        model: "kimi-k2",
        command: "mimo25pro",
      }),
    ).toEqual(
      expect.objectContaining({
        category: "quota",
        reasonCode: "PROVIDER_QUOTA_OR_AUTH_403",
        fallbackCandidates: expect.arrayContaining([expect.stringContaining("mimo26pro")]),
      }),
    );
    expect(
      classifyHeartbeatRunFailure({ status: "failed", errorMessage: "401 Unauthorized: invalid API key" }),
    ).toEqual(expect.objectContaining({ category: "auth", reasonCode: "PROVIDER_AUTH_FAILURE" }));
    expect(
      classifyHeartbeatRunFailure({ status: "failed", errorMessage: "spawn /missing/agent ENOENT" }),
    ).toEqual(expect.objectContaining({ category: "command", reasonCode: "COMMAND_EXECUTION_FAILURE" }));
  });

  it("auto-completes a successful root/plan issue after its planning run succeeds", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const rootIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Director",
      role: "owner",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: { command: "mimo25pro", promptTemplate: "Plan and delegate only." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Root closeout mission",
      status: "planning",
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      missionId,
      identifier: "PAP-PLAN",
      title: "[Plan] Root planning issue",
      description: "Create child issues and stop.",
      status: "todo",
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
    });

    executeSpy.mockImplementation(async () => successfulAdapterResult());
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      ownerAgentId,
      "assignment",
      { taskKey: `issue:${rootIssueId}`, issueId: rootIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    const updatedIssue = await waitForIssueStatus(
      db,
      rootIssueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(expect.objectContaining({ status: "done", completedAt: expect.any(Date) }));
  });

  it("blocks a failed mission worker issue and leaves observable oversight/fallback evidence", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Director",
        role: "owner",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: { command: "mimo26pro" },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Kimi Worker",
        role: "researcher",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: { command: "mimo25pro", promptTemplate: "Do bounded source work." },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Failure oversight mission", status: "active" });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        missionId,
        identifier: "PAP-PLAN",
        title: "[Plan] Failure oversight",
        status: "done",
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
      },
      {
        id: childIssueId,
        companyId,
        missionId,
        parentId: parentIssueId,
        identifier: "PAP-SOURCE",
        title: "[Source] Kimi quota case",
        status: "todo",
        assigneeAgentId: workerAgentId,
        originKind: "director_plan_source",
      },
    ]);

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stderr", "HTTP 403: Kimi provider quota exceeded. Try another model.\n");
      return failedAdapterResult({
        errorCode: "provider_403",
        errorMessage: "HTTP 403: Kimi provider quota exceeded",
        provider: "kimi",
        model: "kimi-k2",
      });
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      workerAgentId,
      "assignment",
      { taskKey: `issue:${childIssueId}`, issueId: childIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");
    const updatedIssue = await waitForIssueStatus(
      db,
      childIssueId,
      (issue) => issue.status === "blocked" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue.status).toBe("blocked");

    const childComments = await db.select().from(issueComments).where(eq(issueComments.issueId, childIssueId));
    expect(childComments.some((comment) => comment.body.includes("PROVIDER_QUOTA_OR_AUTH_403"))).toBe(true);
    expect(childComments.some((comment) => comment.body.includes("mimo26pro"))).toBe(true);
    const parentComments = await db.select().from(issueComments).where(eq(issueComments.issueId, parentIssueId));
    expect(parentComments.some((comment) => comment.body.includes("Mission oversight: worker run failure observed"))).toBe(true);

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "issue.run_failure_auto_blocked", entityId: childIssueId }),
        expect.objectContaining({ action: "mission.worker_run_failure_observed", entityType: "mission", entityId: missionId }),
      ]),
    );
    expect(JSON.stringify(activities.map((activity) => activity.details))).toContain("PROVIDER_QUOTA_OR_AUTH_403");
  });

  it("blocks a timed-out checked-out issue with a reason comment", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timeout Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Do the work." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-TIMEOUT",
      title: "Timeout lifecycle",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async () =>
      failedAdapterResult({ timedOut: true, errorCode: "timeout", errorMessage: "Timed out after test budget" }),
    );
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("timed_out");
    await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "blocked" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("RUN_TIMED_OUT"))).toBe(true);
  });

  it("releases timed-out mission oversight back to todo instead of blocking the supervisor", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Owner",
      role: "owner",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Check the mission." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Oversight timeout mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-OVERSIGHT",
      title: "[OVERSIGHT] Timeout lifecycle",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "mission_main_executor_oversight",
    });

    executeSpy.mockImplementation(async () =>
      failedAdapterResult({ timedOut: true, errorCode: "timeout", errorMessage: "Timed out after test budget" }),
    );
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("timed_out");
    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "todo" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue.status).toBe("todo");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("Mission oversight run failed but the supervisor issue remains open"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("RUN_TIMED_OUT"))).toBe(true);

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "mission.oversight_run_failure_observed",
          entityType: "mission",
          entityId: missionId,
        }),
      ]),
    );
    expect(activities).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "issue.run_failure_auto_blocked", entityId: issueId }),
      ]),
    );
  });

  it("keeps successful active mission oversight open instead of auto-completing it", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Owner",
      role: "owner",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Check the mission." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Oversight success mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-OVERSIGHT",
      title: "[OVERSIGHT] Success lifecycle",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "mission_main_executor_oversight",
    });

    executeSpy.mockImplementation(async ({ runId }) => {
      await db
        .update(issues)
        .set({
          status: "in_progress",
          checkoutRunId: runId,
          executionRunId: runId,
        })
        .where(eq(issues.id, issueId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "todo" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue.completedAt).toBeNull();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("supervisor issue remains open"))).toBe(true);

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "mission.oversight_run_succeeded_released",
          entityType: "mission",
          entityId: missionId,
        }),
      ]),
    );
    expect(activities).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "issue.run_succeeded_auto_completed", entityId: issueId }),
      ]),
    );
  });

  it("captures successful mission child run output and completes the issue when lifecycle updates were not posted", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentId,
        companyId,
        name: "Technology Research Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Work the delegated source issue." },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        missionId,
        identifier: "PAP-PLAN",
        title: "[Plan] Research mission",
        status: "done",
        assigneeAgentId: ownerAgentId,
        originKind: "research_director_plan",
      },
      {
        id: childIssueId,
        companyId,
        missionId,
        parentId: parentIssueId,
        identifier: "PAP-SOURCE",
        title: "[Source] Evidence packet",
        status: "todo",
        assigneeAgentId: agentId,
        originKind: "research_director_plan_child",
      },
    ]);

    executeSpy.mockImplementation(async ({ runId, onLog }) => {
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, childIssueId));
      await onLog("stdout", "Evidence packet ready: source URLs and claim matrix are complete.\n");
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${childIssueId}`, issueId: childIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      childIssueId,
      (issue) => issue.status === "done" && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(
      expect.objectContaining({
        status: "done",
        checkoutRunId: null,
        executionRunId: null,
      }),
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, childIssueId));
    expect(comments.some((comment) => comment.body.includes("자동 캡처: delegated run output"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("Evidence packet ready"))).toBe(true);
  });

  it("blocks an artifact-producing mission child run when no workProduct is registered", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Synthesis Editor",
      role: "writer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Create the required artifact and register it as a workProduct." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        missionId,
        identifier: "PAP-PLAN",
        title: "[Plan] Research mission",
        status: "done",
        assigneeAgentId: agentId,
        originKind: "research_director_plan",
      },
      {
        id: childIssueId,
        companyId,
        missionId,
        parentId: parentIssueId,
        identifier: "PAP-SYN",
        title: "[Synthesis] Draft note artifact",
        status: "todo",
        assigneeAgentId: agentId,
        originKind: "research_director_plan_child",
      },
    ]);

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stdout", "Output: /Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260608.md\n");
      return {
        ...successfulAdapterResult(),
        resultJson: { outputPath: "/Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260608.md" },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${childIssueId}`, issueId: childIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      childIssueId,
      (issue) => issue.status === "blocked" && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(expect.objectContaining({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      completedAt: null,
    }));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, childIssueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("20260608.md"))).toBe(true);
  });

  it("blocks missing workProduct registration even when the agent marks the issue done before run finalization", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Synthesis Editor",
      role: "writer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Create the required artifact and register it as a workProduct." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      missionId,
      identifier: "PAP-SYN",
      title: "[Synthesis] Draft note artifact",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stdout", "Output: /Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260609.md\n");
      await db
        .update(issues)
        .set({
          status: "done",
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, childIssueId));
      return {
        ...successfulAdapterResult(),
        resultJson: { outputPath: "/Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260609.md" },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${childIssueId}`, issueId: childIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      childIssueId,
      (issue) => issue.status === "blocked" && issue.executionRunId === null,
    );
    expect(updatedIssue.completedAt).toBeNull();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, childIssueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("20260609.md"))).toBe(true);
  });

  it("auto-registers a workProduct when an agent mistakenly records the artifact as an issue work-product document", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const documentId = randomUUID();
    const outputPath = "/Users/kwak/Personal/obsidian/600. Improvements/602.Tech/202606/20260610.md";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Synthesis Editor",
      role: "writer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Create the required artifact and register it as a workProduct." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-SYN",
      title: "tech-scout: 기존 양식으로 Tech Scout 노트 작성",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stdout", `Output: ${outputPath}\n`);
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Tech Scout — 2026-06-10 TrendShift Top25",
        format: "markdown",
        latestBody: `Work product: ${outputPath}`,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: "work-product",
      });
      return {
        ...successfulAdapterResult(),
        resultJson: { outputPath },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "done" && issue.executionRunId === null,
    );
    expect(updatedIssue.completedAt).not.toBeNull();

    const workProducts = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(workProducts).toHaveLength(1);
    expect(workProducts[0]).toEqual(expect.objectContaining({
      type: "document",
      provider: "local",
      externalId: outputPath,
      isPrimary: true,
      createdByRunId: finalized.id,
    }));
    expect(workProducts[0]?.metadata).toEqual(expect.objectContaining({
      path: outputPath,
      autoRegisteredFrom: "issue_document_work_product",
      issueDocumentId: documentId,
    }));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(false);
  });

  it("ignores prompt and instruction paths when checking registered workProducts", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const outputPath = "/Users/kwak/Projects/ai/gazua-dashboard/reports/beginner_html/dashboard/deep_dive/202606/Narrative_Deep_Dive_2026-06-12_US.html";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Report Writer",
      role: "writer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Create the required report and register workProducts." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Gazua report mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-HTML",
      title: "gazua-evening: report-for-beginners HTML 패키지 작성",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "document",
        provider: "local",
        title: "Narrative Deep Dive 2026-06-12 US",
        status: "active",
        isPrimary: true,
        metadata: { path: outputPath },
      });
      await onLog(
        "stdout",
        [
          "=== Narrative_Deep_Dive_2026-06-12_US.html ===",
          "/table: 4\\nkpi-grid: 2\\nrisk-grid: 2\\nscenario-grid: 2\\nreferences: 4",
          "/Users/kwak/Projects/ai/papercompany/papercompany-runtime/skills/report-for-beginners/SKILL.md",
          "/Users/kwak/Projects/ai/papercompany/papercompany-operations/scripts/paperclip-addon/agents/gazua/harry.md",
          "/Users/kwak/Projects/ai/gazua-dashboard/reports/beginner_html/dashboard/deep_dive/YYYYMM/Narrative_Deep_Dive_2026-06-12_US.html",
        ].join("\n"),
      );
      return {
        ...successfulAdapterResult(),
        resultJson: { result: "3 workProducts registered and verified." },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "done" && issue.executionRunId === null,
    );
    expect(updatedIssue.completedAt).not.toBeNull();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(false);
  });

  it("blocks Korean artifact issues when a workProduct exists but does not reference the claimed file", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Technology Research Agent",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "HTML 학습 자료를 작성하고 workProduct로 등록하세요." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-HTML",
      title: "[ACTION] 초보자용 에이전틱 RAG HTML 학습 자료 작성",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      const outputPath = "/Users/kwak/Downloads/google_agentic_rag_for_beginners.html";
      await onLog("stdout", `Deliverable: ${outputPath}\n`);
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "document",
        provider: "local",
        title: "초보자용 에이전틱 RAG HTML 학습 자료",
        status: "active",
      });
      return {
        ...successfulAdapterResult(),
        resultJson: { outputPath },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "blocked" && issue.executionRunId === null,
    );
    expect(updatedIssue.completedAt).toBeNull();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("google_agentic_rag_for_beginners.html"))).toBe(true);
  });

  it("does not block when a registered workProduct satisfies the issue-declared artifact despite unrelated logged paths", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const declaredOutputPath = "/Users/kwak/Projects/ai/gazua-dashboard/reports/deep_dive/202606/Sector_Rotation_Analysis_2026-06-14.md";
    const unrelatedLoggedPath = "/ai/gazua-dashboard/reports/daily/202606/KR_Market_Report_2026-06-14.md";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Sector Rotation Analyst",
      role: "analyst",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "작성한 리포트를 workProduct로 등록하세요." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Gazua report mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-SECTOR",
      title: "gazua-morning: 섹터 로테이션 리포트 작성",
      description: [
        "섹터 로테이션 분석 리포트를 작성한다.",
        "출력 파일:",
        "- reports/deep_dive/YYYYMM/Sector_Rotation_Analysis_YYYY-MM-DD.md",
      ].join("\n"),
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "document",
        provider: "local",
        title: "Sector Rotation Analysis 2026-06-14",
        status: "active",
        isPrimary: true,
        metadata: { path: declaredOutputPath },
      });
      await onLog("stdout", `Daily report path: ${unrelatedLoggedPath}\n`);
      return {
        ...successfulAdapterResult(),
        resultJson: { outputPath: unrelatedLoggedPath },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "done" && issue.executionRunId === null,
    );
    expect(updatedIssue.completedAt).not.toBeNull();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(false);
  });

  it("does not apply missing workProduct registration gate to lead approval issues", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Research Director",
      role: "owner",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Approve the already registered artifacts." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-LEAD",
      title: "tech-ai-news: Lead approval for TechCrunch AI note",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stdout", "Approved existing artifact path: /Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260609.md\n");
      return {
        ...successfulAdapterResult(),
        resultJson: { result: "Lead approval: APPROVED. Existing artifact path reviewed." },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "done" && issue.executionRunId === null,
    );
    expect(updatedIssue.status).toBe("done");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(false);
  });

  it("blocks a succeeded mission validator run with REQUEST_CHANGES and wakes the mission owner", async () => {
    const companyId = randomUUID();
    const validatorAgentId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();
    const validatorIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validatorAgentId,
        companyId,
        name: "Artifact Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Validate the delegated artifact." },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        missionId,
        identifier: "PAP-PLAN",
        title: "[Plan] Research mission",
        status: "done",
        assigneeAgentId: ownerAgentId,
        originKind: "research_director_plan",
      },
      {
        id: validatorIssueId,
        companyId,
        missionId,
        parentId: parentIssueId,
        identifier: "PAP-QA",
        title: "[QA] Validate artifact before delivery",
        status: "todo",
        assigneeAgentId: validatorAgentId,
        originKind: "research_director_plan_child",
      },
    ]);

    executeSpy.mockImplementation(async ({ runId, onLog }) => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (run?.agentId === validatorAgentId) {
        await onLog("stdout", "REQUEST_CHANGES\n- fix hallucinated label before Telegram delivery\n");
        await db
          .update(issues)
          .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(issues.id, validatorIssueId));
        return {
          ...successfulAdapterResult(),
          resultJson: { result: "REQUEST_CHANGES\n- fix hallucinated label before Telegram delivery" },
        };
      }
      await onLog("stdout", "Mission owner received validation recovery action.\n");
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      validatorAgentId,
      "assignment",
      { taskKey: `issue:${validatorIssueId}`, issueId: validatorIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      validatorIssueId,
      (issue) => issue.status === "blocked" && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(
      expect.objectContaining({
        status: "blocked",
        checkoutRunId: null,
        executionRunId: null,
      }),
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, validatorIssueId));
    expect(comments.some((comment) => comment.body.includes("REQUEST_CHANGES"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("validation gate"))).toBe(true);

    let ownerActions: Array<typeof issues.$inferSelect> = [];
    const ownerActionDeadline = Date.now() + 5_000;
    while (Date.now() < ownerActionDeadline) {
      ownerActions = await db.select().from(issues).where(eq(issues.originId, validatorIssueId));
      if (ownerActions.some((issue) => issue.originKind === "mission_main_executor_unblock")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(ownerActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assigneeAgentId: ownerAgentId,
        missionId,
        originKind: "mission_main_executor_unblock",
        title: expect.stringContaining("[Unblock] PAP-QA"),
      }),
    ]));
    const ownerAction = ownerActions.find((issue) => issue.originKind === "mission_main_executor_unblock")!;

    let ownerWakeups: Array<typeof agentWakeupRequests.$inferSelect> = [];
    const wakeupDeadline = Date.now() + 5_000;
    while (Date.now() < wakeupDeadline) {
      ownerWakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, ownerAgentId));
      if (ownerWakeups.some((request) => {
        const payload = request.payload as Record<string, unknown> | null;
        return payload?.issueId === ownerAction.id && payload?.sourceIssueId === validatorIssueId;
      })) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const ownerWakeup = ownerWakeups.find((request) => {
      const payload = request.payload as Record<string, unknown> | null;
      return payload?.issueId === ownerAction.id && payload?.sourceIssueId === validatorIssueId;
    });
    expect(ownerWakeup).toEqual(expect.objectContaining({
      payload: expect.objectContaining({ issueId: ownerAction.id, sourceIssueId: validatorIssueId }),
    }));
    if (ownerWakeup?.runId) {
      const ownerRun = await waitForRunTerminal(heartbeat, ownerWakeup.runId);
      expect(ownerRun.status).toBe("succeeded");
    }
  });

  it("does not block a validator PASS result that contains caveat text", async () => {
    const companyId = randomUUID();
    const validatorAgentId = randomUUID();
    const missionId = randomUUID();
    const validatorIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: validatorAgentId,
      companyId,
      name: "Artifact Validator",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Validate the delegated artifact." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: validatorAgentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: validatorIssueId,
      companyId,
      missionId,
      identifier: "PAP-QA",
      title: "[QA] Validate artifact before delivery",
      status: "todo",
      assigneeAgentId: validatorAgentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stdout", "Claim: Shopify integration - Need to verify\nVerdict: PASS\n");
      return {
        ...successfulAdapterResult(),
        resultJson: {
          result:
            "**Validation Complete: PASS**\n\nShopify integration - Need to verify.\n\n**Verdict: PASS** — caveat is documented and does not require changes.",
        },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      validatorAgentId,
      "assignment",
      { taskKey: `issue:${validatorIssueId}`, issueId: validatorIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      validatorIssueId,
      (issue) => issue.status === "done" && issue.executionRunId === null,
    );
    expect(updatedIssue.status).toBe("done");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, validatorIssueId));
    expect(comments.some((comment) => comment.body.includes("Mission validation gate: REQUEST_CHANGES"))).toBe(false);
  });

  it("does not apply the REQUEST_CHANGES validation gate to mission owner control issues", async () => {
    for (const [index, originKind] of (
      ["mission_main_executor_plan", "mission_main_executor_oversight", "mission_main_executor_unblock"] as const
    ).entries()) {
      const companyId = randomUUID();
      const ownerAgentId = randomUUID();
      const missionId = randomUUID();
      const sourceIssueId = randomUUID();
      const ownerIssueId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: `Paperclip ${originKind}`,
        issuePrefix: `PC${index}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Plan and coordinate the mission." },
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(missions).values({
        id: missionId,
        companyId,
        ownerAgentId,
        title: "Research mission",
        status: "active",
      });
      await db.insert(issues).values({
        id: sourceIssueId,
        companyId,
        missionId,
        identifier: `PC${index}-SOURCE`,
        title: "Source issue awaiting owner action",
        status: "blocked",
        assigneeAgentId: ownerAgentId,
        originKind: "research_director_plan_child",
      });
      await db.insert(issues).values({
        id: ownerIssueId,
        companyId,
        missionId,
        identifier: originKind === "mission_main_executor_plan" ? `PC${index}-PLAN` : `PC${index}-UNBLOCK`,
        title: originKind === "mission_main_executor_plan"
          ? "[Plan] Research mission"
          : originKind === "mission_main_executor_oversight"
            ? "[Oversight] Research mission"
            : "[Unblock] PAP-SOURCE: Source issue awaiting owner action",
        description: "Mission owner control issue that may mention validation outcomes while giving instructions.",
        status: "todo",
        assigneeAgentId: ownerAgentId,
        originKind,
        originId: originKind === "mission_main_executor_unblock" ? sourceIssueId : null,
      });

      executeSpy.mockImplementationOnce(async ({ onLog }) => {
        await onLog("stdout", "Owner action complete. Downstream QA may later return PASS or REQUEST_CHANGES.\n");
        await db
          .update(issues)
          .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(issues.id, ownerIssueId));
        return {
          ...successfulAdapterResult(),
          resultJson: {
            result: "Mission owner action complete. Allowed downstream validator outcomes include PASS or REQUEST_CHANGES.",
          },
        };
      });

      const heartbeat = heartbeatService(db);
      const run = await heartbeat.invoke(
        ownerAgentId,
        "assignment",
        { taskKey: `issue:${ownerIssueId}`, issueId: ownerIssueId, missionId },
        "system",
        { actorType: "system", actorId: "test-suite" },
      );

      const finalized = await waitForRunTerminal(heartbeat, run!.id);
      expect(finalized.status).toBe("succeeded");

      const updatedIssue = await waitForIssueStatus(db, ownerIssueId, (issue) => issue.status === "done");
      expect(updatedIssue.status).toBe("done");

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ownerIssueId));
      expect(comments.some((comment) => comment.body.includes("Mission validation gate: REQUEST_CHANGES"))).toBe(false);

      const issueActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, ownerIssueId));
      expect(issueActivity.some((entry) => entry.action === "issue.validation_request_changes_auto_blocked")).toBe(false);

      const nestedOwnerActions = await db.select().from(issues).where(eq(issues.originId, ownerIssueId));
      expect(nestedOwnerActions.some((issue) => issue.originKind === "mission_main_executor_unblock")).toBe(false);
    }
  });

  it("does not apply the REQUEST_CHANGES validation gate to workflow lead approval issues", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const leadIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Lead Approval",
      issuePrefix: "PLA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Research Director",
      role: "owner",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Approve corrected workflow output." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: leadIssueId,
      companyId,
      missionId,
      identifier: "PLA-LEAD",
      title: "Lead approval for corrected note",
      status: "in_progress",
      assigneeAgentId: ownerAgentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementationOnce(async ({ runId, onLog }) => {
      await onLog("stdout", "APPROVED after checking prior REQUEST_CHANGES findings. Downstream may proceed.\n");
      await db
        .update(issues)
        .set({
          status: "done",
          checkoutRunId: runId,
          executionRunId: runId,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, leadIssueId));
      return {
        ...successfulAdapterResult(),
        resultJson: {
          result: "APPROVED. Prior REQUEST_CHANGES findings are fixed; do not re-block this lead approval.",
        },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      ownerAgentId,
      "assignment",
      { taskKey: `issue:${leadIssueId}`, issueId: leadIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      leadIssueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(expect.objectContaining({
      status: "done",
      checkoutRunId: null,
      executionRunId: null,
    }));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, leadIssueId));
    expect(comments.some((comment) => comment.body.includes("Mission validation gate: REQUEST_CHANGES"))).toBe(false);

    const issueActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, leadIssueId));
    expect(issueActivity.some((entry) => entry.action === "issue.validation_request_changes_auto_blocked")).toBe(false);

    const nestedOwnerActions = await db.select().from(issues).where(eq(issues.originId, leadIssueId));
    expect(nestedOwnerActions.some((issue) => issue.originKind === "mission_main_executor_unblock")).toBe(false);
  });

  it("captures tool-limit blocked mission child output as done", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentId,
        companyId,
        name: "Technology Research Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Work the delegated source issue." },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        missionId,
        identifier: "PAP-PLAN",
        title: "[Plan] Research mission",
        status: "done",
        assigneeAgentId: ownerAgentId,
        originKind: "research_director_plan",
      },
      {
        id: childIssueId,
        companyId,
        missionId,
        parentId: parentIssueId,
        identifier: "PAP-SOURCE",
        title: "[Source] Evidence packet",
        status: "todo",
        assigneeAgentId: agentId,
        originKind: "research_director_plan_child",
      },
    ]);

    executeSpy.mockImplementation(async ({ runId, onLog }) => {
      await db
        .update(issues)
        .set({ status: "blocked", executionRunId: runId })
        .where(eq(issues.id, childIssueId));
      await onLog(
        "stdout",
        "Evidence matrix is ready.\nReached maximum iterations (60). I could not post the issue comment before the tool-call limit hit.\n",
      );
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${childIssueId}`, issueId: childIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      childIssueId,
      (issue) => issue.status === "done" && issue.executionRunId === null,
    );
    expect(updatedIssue?.status).toBe("done");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, childIssueId));
    expect(comments.some((comment) => comment.body.includes("Evidence matrix is ready"))).toBe(true);
  });

  it("blocks execution before adapter.execute when the estimated context budget is exceeded", async () => {
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
      name: "Budgeted Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "x".repeat(400),
      },
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 5,
          },
        },
      },
      permissions: {},
    });

    executeSpy.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: null,
      provider: "test",
      model: "test-model",
      resultJson: null,
      runtimeServices: [{ serviceName: "api", url: "http://localhost:4100", scopeType: "run", lifecycle: "ephemeral" }],
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { note: "y".repeat(100) }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("context_budget_exceeded");
    expect(finalized.error).toContain("exceeds budget");
    expect(finalized.wakeupRequestId).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, finalized.wakeupRequestId!))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("failed");
  });

  it("blocks explicit broad-scan prompts when the manifest forbids them", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:broad-scan";
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
        promptTemplate: "Please scan the entire repo and summarize everything.",
      },
      runtimeConfig: {},
      permissions: {},
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

  it("blocks a live broad-scan tool call before adapter execution can continue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:runtime-broad-scan";

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
      },
      runtimeConfig: {},
      permissions: {},
    });

    executeSpy.mockImplementationOnce(async ({ onLog }) => {
      await onLog("stdout", `${JSON.stringify({
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "find . -type f",
          status: "in_progress",
        },
      })}\n`);
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
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("manifest_broad_scan_tool_blocked");
    expect(finalized.error).toContain("find .");
  });

  it("blocks a chunk-split live tool call after the full JSON line is reconstructed", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:runtime-broad-scan-split";

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
      adapterType: "gemini_local",
      adapterConfig: {
        promptTemplate: "Stay focused on the assigned issue.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "call_1",
      tool_call: {
        shell: {
          command: "find . -type f",
        },
      },
    });

    executeSpy.mockImplementationOnce(async ({ onLog }) => {
      const midpoint = Math.floor(line.length / 2);
      await onLog("stdout", line.slice(0, midpoint));
      await onLog("stdout", `${line.slice(midpoint)}\n`);
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
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("manifest_broad_scan_tool_blocked");
    expect(finalized.error).toContain("find .");
  });

  it("blocks a cursor shell tool call when normalized JSONL arrives on stderr", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:runtime-broad-scan-cursor-stderr";

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
      adapterType: "cursor",
      adapterConfig: {
        promptTemplate: "Stay focused on the assigned issue.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    executeSpy.mockImplementationOnce(async ({ onLog }) => {
      await onLog(
        "stderr",
        `${JSON.stringify({
          type: "tool_call",
          subtype: "started",
          call_id: "call_1",
          tool_call: {
            shellToolCall: {
              command: "find . -type f",
            },
          },
        })}\n`,
      );
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
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("manifest_broad_scan_tool_blocked");
    expect(finalized.error).toContain("find .");
  });

  it("still blocks bootstrap broad-scan prompts when a saved session exists but cwd mismatch prevents resume", async () => {
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
    for (let i = 0; i < 3; i += 1) {
      const run = await heartbeat.invoke(agentId, "on_demand", { missionId }, "manual", {
        actorType: "system",
        actorId: "test-suite",
      });
      expect(run).not.toBeNull();
      const finalized = await waitForRunTerminal(heartbeat, run!.id);
      expect(finalized.status).toBe("succeeded");
    }

    expect(executeSpy).toHaveBeenCalledTimes(3);
    const runtimes = executeSpy.mock.calls.map((call) => call[0].runtime as { sessionId: string | null; sessionDisplayId: string | null });
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

  it("attaches a server-computed step input manifest before adapter execution", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:manifest";
    const runtimeServiceId = randomUUID();
    const issueId = randomUUID();
    const wakeCommentId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Manifest Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Follow the heartbeat.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Manifest issue",
      description: "사용자가 불편하다고만 전달했고 대상 시스템, 증상, 발생 시간이 빠짐",
      status: "todo",
    });
    await db.insert(issueComments).values({
      id: wakeCommentId,
      companyId,
      issueId,
      authorUserId: "user-1",
      body: "Please inspect src/server.ts and ../secret.env",
    });

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
        runtimeServices: [{
          id: runtimeServiceId,
          scopeType: "run",
          scopeId: "run-scope",
          serviceName: "api",
          status: "running",
          lifecycle: "ephemeral",
          port: 4100,
          url: "http://localhost:4100",
          healthStatus: "healthy",
        }],
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey, issueId, wakeCommentId, note: "hello" }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const executionContext = executeSpy.mock.calls[0]?.[0] as { runtime: { taskKey: string | null } };
    expect(executionContext.runtime.taskKey).toBe(taskKey);
    expect(invocationContext).toBeDefined();
    if (!invocationContext) {
      throw new Error("Expected adapter invocation context to be captured");
    }
    const adapterVisibleContext = invocationContext;
    expect(adapterVisibleContext.paperclipMaintenanceDecision).toEqual(
      expect.objectContaining({
        recommendedNextAction: "request_missing_input",
        suggestedStatus: "blocked",
        requiredInputs: expect.arrayContaining(["symptom", "timeWindow"]),
        roleContext: expect.objectContaining({
          roles: expect.arrayContaining([
            expect.objectContaining({ id: "customer_response" }),
            expect.objectContaining({ id: "maintenance_triage" }),
            expect.objectContaining({ id: "vendor_handoff" }),
            expect.objectContaining({ id: "approver" }),
            expect.objectContaining({ id: "incident_owner" }),
            expect.objectContaining({ id: "srb_sync", kind: "system" }),
          ]),
          questions: expect.arrayContaining([
            expect.stringMatching(/role/i),
            expect.stringMatching(/responsibility\/authority/i),
            expect.stringMatching(/rationale|override/i),
            expect.stringMatching(/hard-stop|observation|escalation/i),
          ]),
        }),
      }),
    );
    const missingInputAuditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.runId, run!.id));
    expect(missingInputAuditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "maintenance_decision_evaluated",
          entityType: "issue",
          entityId: issueId,
          agentId,
          runId: run!.id,
          details: expect.objectContaining({
            issueId,
            runId: run!.id,
            recommendedNextAction: "request_missing_input",
            suggestedStatus: "blocked",
            requiredInputs: expect.arrayContaining(["symptom", "timeWindow"]),
          }),
        }),
      ]),
    );
    expect(adapterVisibleContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        version: 1,
        taskKey,
        issueId,
        allowedContextKeys: Object.keys(adapterVisibleContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
        guardrails: { broadScanAllowed: false },
        inputs: expect.objectContaining({
          workspace: {
            available: true,
            source: "agent_home",
            workspaceId: null,
            projectId: null,
          },
          workspaceHints: { available: false, count: 0 },
          runtimeServiceIntents: { available: false, count: 0 },
          runtimeServices: { available: false, count: 0, primaryUrl: null },
          fileViews: { available: true, count: 1, source: "wake_comment" },
          maintenanceDecision: expect.objectContaining({
            available: true,
            recommendedNextAction: "request_missing_input",
            suggestedStatus: "blocked",
            requiredInputs: expect.arrayContaining(["symptom", "timeWindow"]),
            roleContext: expect.objectContaining({
              roles: expect.arrayContaining([expect.objectContaining({ id: "srb_sync", kind: "system" })]),
              questions: expect.arrayContaining([expect.stringMatching(/rationale|override/i)]),
            }),
          }),
          sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
        }),
      }),
    );
    expect(adapterVisibleContext.paperclipFileViews).toEqual([
      {
        workspaceId: null,
        relativePath: "src/server.ts",
        source: "wake_comment",
        exists: false,
      },
    ]);
    const persistedContext = finalized.contextSnapshot ?? {};
    expect(finalized.contextSnapshot?.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        taskKey,
        allowedContextKeys: Object.keys(persistedContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
        inputs: expect.objectContaining({
          runtimeServices: {
            available: true,
            count: 1,
            primaryUrl: "http://localhost:4100",
          },
          fileViews: {
            available: true,
            count: 1,
            source: "wake_comment",
          },
        }),
      }),
    );
  });

  it("does not attach maintenance decision preflight to mission-scoped research issues", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;
    await db.insert(companies).values({
      id: companyId,
      name: "Research Company",
      issuePrefix: "RES",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Research Agent",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Follow the research issue." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Oklo SMR research mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "RES-RESEARCH",
      title: "[Research] Oklo corporate valuation and AI power demand",
      description: "Research Oklo valuation, business model, and AI data center demand with source-backed evidence.",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "manual",
    });

    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId, note: "research retry" }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMaintenanceDecision).toBeUndefined();

    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.runId, run!.id));
    expect(auditRows.some((row) => row.action === "maintenance_decision_evaluated")).toBe(false);
  });

  it("records vendor maintenance decisions as heartbeat audit activity", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Vendor Audit Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Follow the heartbeat." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "PG사 external API 오류",
      description: "오늘 11:00부터 결제 vendor timeout, 증상: approval failed",
      status: "todo",
    });

    executeSpy.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: null,
      provider: "test",
      model: "test-model",
      resultJson: null,
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId, note: "vendor check" }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.runId, run!.id));
    expect(auditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "maintenance_decision_evaluated",
          entityType: "issue",
          entityId: issueId,
          agentId,
          runId: run!.id,
          details: expect.objectContaining({
            issueId,
            runId: run!.id,
            recommendedNextAction: "vendor_handoff",
            suggestedStatus: "in_progress",
            requiredInputs: [],
            warnings: [],
            handoffTarget: "vendor",
            matchedRules: expect.arrayContaining([
              expect.objectContaining({ id: "maintenance-vendor-handoff", action: "vendor_handoff" }),
            ]),
          }),
        }),
      ]),
    );
  });

  it("attaches workflow step tool contracts to the runtime context", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    const toolId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFT",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Tool Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Use the workflow tool contract.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Workflow step issue",
      status: "todo",
    });
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "search-docs",
      description: "Search project documentation",
      inputSchema: {},
      adapterType: "builtin",
      adapterConfig: {},
      enabled: true,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Tool Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          agentId,
          dependencies: [],
          toolNames: ["search-docs"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId: null,
      triggeredBy: "system",
      status: "running",
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "draft",
      issueId,
      status: "running",
    });

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
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipWorkflowStepToolContract).toEqual({
      workflowRunId,
      workflowId,
      stepId: "draft",
      stepName: "Draft",
      toolNames: ["search-docs"],
      tools: [
        {
          name: "search-docs",
          description: "Search project documentation",
          adapterType: "builtin",
        },
      ],
    });
    expect(invocationContext?.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        inputs: expect.objectContaining({
          tools: {
            available: true,
            count: 1,
            names: ["search-docs"],
          },
        }),
      }),
    );
    const persistedComments = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(persistedComments).toHaveLength(0);
  });

  it("fails before adapter execution when a workflow step references missing tools", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFT",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Tool Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Use the workflow tool contract.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Workflow step issue",
      status: "todo",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Tool Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          agentId,
          dependencies: [],
          toolNames: ["missing-tool"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId: null,
      triggeredBy: "system",
      status: "running",
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "draft",
      issueId,
      status: "running",
    });

    executeSpy.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: null,
      provider: "test",
      model: "test-model",
      resultJson: null,
      runtimeServices: [],
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("workflow_step_tool_contract_invalid");
    expect(finalized.error).toContain("missing tools: missing-tool");
  });

  it("attaches workflow step knowledge contracts to the runtime context", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    const knowledgeBaseId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFK",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Knowledge Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Use the workflow knowledge contract.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review production deployment policy",
      description: "We need the latest deployment checklist for production changes.",
      status: "todo",
    });
    await db.insert(knowledgeBases).values({
      id: knowledgeBaseId,
      companyId,
      name: "Deployment KB",
      type: "rag",
      description: "Deployment procedures",
      maxTokenBudget: 1024,
      configJson: {
        documents: [
          {
            id: "doc-1",
            title: "Production Deployment Checklist",
            content: "Production changes require a checklist, approvals, rollback notes, and smoke tests.",
          },
        ],
      },
    });
    await db.insert(agentKbGrants).values({
      id: randomUUID(),
      agentId,
      kbId: knowledgeBaseId,
      grantedBy: "board-user",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Knowledge Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          agentId,
          dependencies: [],
          knowledgeBaseIds: [knowledgeBaseId],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId: null,
      triggeredBy: "system",
      status: "running",
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "draft",
      issueId,
      status: "running",
    });

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
      agentId,
      "on_demand",
      { issueId, note: "Need the production checklist." },
      "manual",
      {
        actorType: "system",
        actorId: "test-suite",
      },
    );

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipWorkflowStepKnowledgeContext).toEqual({
      workflowRunId,
      workflowId,
      stepId: "draft",
      stepName: "Draft",
      knowledgeBaseIds: [knowledgeBaseId],
      entries: [
        expect.objectContaining({
          id: knowledgeBaseId,
          name: "Deployment KB",
          type: "rag",
          source: "Deployment KB",
          content: expect.stringContaining("Production Deployment Checklist"),
        }),
      ],
    });
    expect(invocationContext?.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        inputs: expect.objectContaining({
          knowledge: {
            available: true,
            count: 1,
            names: ["Deployment KB"],
          },
        }),
      }),
    );
    const persistedComments = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(persistedComments).toHaveLength(0);
  });

  it("fails before adapter execution when a workflow step references inaccessible knowledge bases", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    const knowledgeBaseId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFK",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Knowledge Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Use the workflow knowledge contract.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review deployment policy",
      status: "todo",
    });
    await db.insert(knowledgeBases).values({
      id: knowledgeBaseId,
      companyId,
      name: "Restricted KB",
      type: "static",
      description: "Restricted knowledge",
      maxTokenBudget: 1024,
      configJson: {
        content: "Restricted deployment policy",
      },
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Knowledge Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          agentId,
          dependencies: [],
          knowledgeBaseIds: [knowledgeBaseId],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId: null,
      triggeredBy: "system",
      status: "running",
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "draft",
      issueId,
      status: "running",
    });

    executeSpy.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: null,
      provider: "test",
      model: "test-model",
      resultJson: null,
      runtimeServices: [],
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("workflow_step_kb_contract_invalid");
    expect(finalized.error).toContain("missing or inaccessible KBs");
  });

  it("does not attach file views when wakeCommentId belongs to a different issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:file-view-mismatch";
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const wakeCommentId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFV",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Manifest Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Follow the heartbeat.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Target issue",
        status: "todo",
      },
      {
        id: otherIssueId,
        companyId,
        title: "Other issue",
        status: "todo",
      },
    ]);
    await db.insert(issueComments).values({
      id: wakeCommentId,
      companyId,
      issueId: otherIssueId,
      authorUserId: "user-1",
      body: "Please inspect src/server.ts",
    });

    executeSpy.mockImplementationOnce(async ({ context }) => {
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
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey, issueId, wakeCommentId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipFileViews).toBeUndefined();
    expect(finalized.contextSnapshot?.paperclipFileViews).toBeUndefined();
    expect(finalized.contextSnapshot?.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        inputs: expect.objectContaining({
          fileViews: {
            available: false,
            count: 0,
            source: null,
          },
        }),
      }),
    );
  });

  it("persists executionWorkspaceId in the manifest before adapter execution", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workspace",
      issuePrefix: "PWX",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace Project",
      status: "backlog",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workspace Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Follow the heartbeat.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Workspace issue",
      status: "todo",
    });

    const heartbeat = heartbeatService(db);
    executeSpy.mockImplementation(async ({ runId, context }) => {
      const persisted = await heartbeat.getRun(runId);
      expect(persisted?.issueId).toBe(issueId);
      const persistedContext = persisted?.contextSnapshot ?? {};
      expect(persistedContext.executionWorkspaceId).toBeTruthy();
      expect(persistedContext.paperclipStepInputManifest).toEqual(
        expect.objectContaining({
          allowedContextKeys: expect.arrayContaining(["executionWorkspaceId"]),
        }),
      );
      expect(context.paperclipStepInputManifest).toEqual(
        expect.objectContaining({
          allowedContextKeys: expect.arrayContaining(["executionWorkspaceId"]),
        }),
      );
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

    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
  });

  it("refreshes the manifest after a same-task wake is coalesced into a running run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "issue:coalesced";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coalesced Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Follow the heartbeat.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const existingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: existingRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      contextSnapshot: {
        taskKey,
        paperclipStepInputManifest: {
          version: 1,
          taskKey,
          issueId: null,
          projectId: null,
          allowedContextKeys: ["taskKey"],
          guardrails: { broadScanAllowed: false },
          inputs: {
            workspace: { available: false, source: null, workspaceId: null, projectId: null },
            workspaceHints: { available: false, count: 0 },
            runtimeServiceIntents: { available: false, count: 0 },
            runtimeServices: { available: false, count: 0, primaryUrl: null },
            sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
          },
        },
      },
      startedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const mergedRun = await heartbeat.invoke(agentId, "on_demand", { taskKey, note: "coalesced note" }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(mergedRun).not.toBeNull();
    expect(mergedRun?.id).toBe(existingRunId);
    expect(executeSpy).not.toHaveBeenCalled();
    const mergedContext = mergedRun?.contextSnapshot ?? {};
    expect(mergedContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        taskKey,
        allowedContextKeys: Object.keys(mergedContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
      }),
    );
    expect(mergedContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        allowedContextKeys: expect.arrayContaining(["note", "taskKey", "wakeSource", "wakeTriggerDetail"]),
      }),
    );
  });

  it("refreshes the manifest for issue-execution same-agent coalesced wakes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Execution Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const existingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: existingRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
        issueId,
        paperclipStepInputManifest: {
          version: 1,
          taskKey: issueId,
          issueId,
          projectId: null,
          allowedContextKeys: ["issueId"],
          guardrails: { broadScanAllowed: false },
          inputs: {
            workspace: { available: false, source: null, workspaceId: null, projectId: null },
            workspaceHints: { available: false, count: 0 },
            runtimeServiceIntents: { available: false, count: 0 },
            runtimeServices: { available: false, count: 0, primaryUrl: null },
            sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
          },
        },
      },
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Locked issue",
      status: "todo",
      executionRunId: existingRunId,
      executionAgentNameKey: "execution agent",
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const mergedRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId, note: "issue-exec note" },
    });

    expect(mergedRun?.id).toBe(existingRunId);
    const mergedContext = mergedRun?.contextSnapshot ?? {};
    expect(mergedContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        issueId,
        allowedContextKeys: Object.keys(mergedContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
      }),
    );
    expect(mergedContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        allowedContextKeys: expect.arrayContaining(["issueId", "note", "wakeSource", "wakeTriggerDetail"]),
      }),
    );
  });

  it("retries a failed issue run on the issue's current assignee instead of the original run agent", async () => {
    const companyId = randomUUID();
    const originalAgentId = randomUUID();
    const currentAssigneeId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: originalAgentId,
        companyId,
        name: "Scout Agent",
        role: "researcher",
        status: "active",
        adapterType: "antigravity_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: currentAssigneeId,
        companyId,
        name: "Hermes Research Agent",
        role: "researcher",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry should follow reassignment",
      status: "todo",
      assigneeAgentId: currentAssigneeId,
    });

    executeSpy.mockResolvedValue(successfulAdapterResult());

    const heartbeat = heartbeatService(db);
    const retriedRun = await heartbeat.wakeup(originalAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
      payload: { issueId },
    });

    expect(retriedRun?.agentId).toBe(currentAssigneeId);
    const request = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, retriedRun!.id))
      .then((rows) => rows[0] ?? null);
    expect(request?.agentId).toBe(currentAssigneeId);
    const issue = await db
      .select({ executionRunId: issues.executionRunId, executionAgentNameKey: issues.executionAgentNameKey })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toEqual(
      expect.objectContaining({
        executionRunId: retriedRun!.id,
        executionAgentNameKey: "hermes research agent",
      }),
    );
    await waitForRunTerminal(heartbeat, retriedRun!.id);
  });

  it("refreshes the manifest inside deferred issue-execution wake payloads", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runningRunId = randomUUID();
    const deferredId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Deferred Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deferred issue",
      status: "todo",
      executionRunId: runningRunId,
      executionAgentNameKey: "someone-else",
      executionLockedAt: new Date(),
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: {
          issueId,
          paperclipStepInputManifest: {
            version: 1,
            taskKey: issueId,
            issueId,
            projectId: null,
            allowedContextKeys: ["issueId"],
            guardrails: { broadScanAllowed: false },
            inputs: {
              workspace: { available: false, source: null, workspaceId: null, projectId: null },
              workspaceHints: { available: false, count: 0 },
              runtimeServiceIntents: { available: false, count: 0 },
              runtimeServices: { available: false, count: 0, primaryUrl: null },
              sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
            },
          },
        },
      },
      status: "deferred_issue_execution",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId, note: "deferred note" },
    });

    expect(result).toBeNull();
    const deferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredId))
      .then((rows) => rows[0] ?? null);
    expect(deferred).not.toBeNull();
    expect(deferred?.coalescedCount).toBe(1);
    const deferredContext = (deferred?.payload as Record<string, unknown>)._paperclipWakeContext as Record<string, unknown>;
    expect(deferredContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        issueId,
        allowedContextKeys: Object.keys(deferredContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
      }),
    );
    expect(deferredContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        allowedContextKeys: expect.arrayContaining(["issueId", "note", "wakeSource", "wakeTriggerDetail"]),
      }),
    );
  });

  it("attaches a structured session handoff artifact alongside markdown when compaction rotates the session", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "issue:handoff";
    const previousRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Handoff",
      issuePrefix: "PHO",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Handoff Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Continue the assigned work.",
      },
      runtimeConfig: {
        heartbeat: {
          sessionCompaction: {
            enabled: true,
            maxRawInputTokens: 1,
          },
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: previousRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      contextSnapshot: { taskKey },
      sessionIdAfter: "sess-1",
      usageJson: { rawInputTokens: 100 },
      resultJson: { summary: "Last run summarized the issue state" },
      startedAt: new Date("2026-04-10T00:00:00.000Z"),
      finishedAt: new Date("2026-04-10T00:05:00.000Z"),
      createdAt: new Date("2026-04-10T00:05:00.000Z"),
      updatedAt: new Date("2026-04-10T00:05:00.000Z"),
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey,
      sessionParamsJson: { sessionId: "sess-1", cwd: process.cwd() },
      sessionDisplayId: "sess-1",
      lastRunId: previousRunId,
    });

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
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipSessionHandoffMarkdown).toContain("Previous session: sess-1");
    expect(invocationContext?.paperclipSessionHandoff).toEqual({
      version: 1,
      previousSessionId: "sess-1",
      previousRunId,
      issueId: null,
      rotationReason: "session raw input reached 100 tokens (threshold 1)",
      lastRunSummaryText: "Last run summarized the issue state",
    });
    expect(finalized.contextSnapshot?.paperclipSessionHandoff).toEqual(invocationContext?.paperclipSessionHandoff);

    await db
      .update(agents)
      .set({
        runtimeConfig: {
          heartbeat: {
            sessionCompaction: {
              enabled: true,
              maxRawInputTokens: 0,
            },
          },
        },
      })
      .where(eq(agents.id, agentId));

    let secondInvocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementationOnce(async ({ context }) => {
      secondInvocationContext = structuredClone(context) as Record<string, unknown>;
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

    const secondRun = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(secondRun).not.toBeNull();
    const secondFinalized = await waitForRunTerminal(heartbeat, secondRun!.id);
    expect(secondFinalized.status).toBe("succeeded");
    expect(secondInvocationContext?.paperclipSessionHandoffMarkdown).toBeUndefined();
    expect(secondInvocationContext?.paperclipSessionHandoff).toBeUndefined();
    expect(secondFinalized.contextSnapshot?.paperclipSessionHandoffMarkdown).toBeUndefined();
    expect(secondFinalized.contextSnapshot?.paperclipSessionHandoff).toBeUndefined();
  });

  it("preserves scheduler mission context and reuses the mission-scoped session path before execution", async () => {
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
  });

  it("creates a mission-session binding from an existing mission task session on wakeup", async () => {
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

  it("persists an early adapter session update on the heartbeat run before final result canonicalization", async () => {
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

  it("attaches mission-owner-planning context when the heartbeat issue originKind is mission_main_executor_plan", async () => {
    const fixture = await seedMissionOwnerTaskContextFixture(db, "mission_main_executor_plan");
    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "on_demand",
      { taskKey: "owner-plan:plan", issueId: fixture.ownerTaskIssueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMissionOwnerPlanningContext).toEqual(
      expect.objectContaining({
        mission: expect.objectContaining({
          id: fixture.missionId,
          title: "Mission owner context mission",
          status: "active",
          companyId: fixture.companyId,
          ownerAgentId: fixture.agentId,
        }),
        planningIssueId: fixture.ownerTaskIssueId,
        activePlan: expect.objectContaining({ available: false }),
        executionSourceSnapshot: {
          missionId: fixture.missionId,
          companyId: fixture.companyId,
          units: [],
        },
        ruleRefs: [],
        workflowCandidates: [],
        kbRefs: [],
        agentRoster: [],
        todoMarkers: [],
        sourceRefVocabulary: expect.arrayContaining(["native_workflow_run", "native_workflow_step_run"]),
      }),
    );
    // mission_main_executor_plan does not satisfy isMissionOwnerTaskIssue, so task context must be absent
    expect(invocationContext?.paperclipMissionOwnerTaskContext).toBeUndefined();
  });

  it("does not attach mission-owner-planning context for normal workflow_execution issues", async () => {
    const fixture = await seedMissionOwnerTaskContextFixture(db, "workflow_execution");
    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "on_demand",
      { taskKey: "worker:normal", issueId: fixture.ownerTaskIssueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMissionOwnerPlanningContext).toBeUndefined();
    // Existing test already covers task context absence; included for symmetry
    expect(invocationContext?.paperclipMissionOwnerTaskContext).toBeUndefined();
  });
});
