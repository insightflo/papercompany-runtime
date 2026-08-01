import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySecrets,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missionAgentRuntimes,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const heartbeatWakeup = vi.fn();

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({
      wakeup: heartbeatWakeup,
    }),
  };
});

// Production path: executeWorkflowRun / syncWorkflowRunForIssue →
// wakeExistingWorkflowStepIssue / applyIssueCreatedSideEffects →
// queueIssueAssignmentWakeup({ heartbeat: heartbeatService(db) }) → heartbeat.wakeup(...).
// The heartbeatService mock alone does not always bind in this file's import graph, so the real
// wakeup runs enqueueWakeup → startNextQueuedRunForAgent → detached executeRun(), which inserts
// heartbeat_runs/heartbeat_run_events/mission_agent_runtimes/company_skills and races afterEach
// FK cleanup. Force the assignment-wakeup helper to use the test spy while keeping its real
// guards/payload shape so the three workProduct assertions stay valid.
vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (
      input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0],
    ) => actual.queueIssueAssignmentWakeup({
      ...input,
      heartbeat: { wakeup: heartbeatWakeup },
    }),
  };
});

import { issueService } from "../services/issues.ts";
import { executeWorkflowRun, syncWorkflowRunForIssue } from "../services/workflow/dag-engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow workProduct marker tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type StepDef = {
  id: string;
  name: string;
  agentId: string;
  dependencies: string[];
  description?: string;
  graphWorkProductRequired?: boolean;
  workProductRequired?: boolean;
  requiresWorkProduct?: boolean;
  autoApproveTools?: unknown;
};

describeEmbeddedPostgres("workflow workProduct dependency marker contract", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-marker-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    await db.delete(heartbeatRunEvents);
    await db.delete(agentTaskSessions);
    await db.delete(missionAgentRuntimes);
    await db.delete(activityLog);
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null });
    await db.delete(heartbeatRuns);
    await db.delete(heartbeatRunEvents);
    await db.delete(agentWakeupRequests);
    await db.delete(issueWorkProducts);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    // Dual-written display comments must clear before issues (FK).
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  async function executeRun(opts: {
    companyId: string;
    companyName: string;
    missionId: string;
    workflowId: string;
    runId: string;
    agents: Array<{ id: string; name: string; role: string }>;
    steps: StepDef[];
  }): Promise<Record<string, typeof issues.$inferSelect>> {
    heartbeatWakeup.mockResolvedValue({ id: "marker-run" });
    await db.insert(companies).values({
      id: opts.companyId,
      name: opts.companyName,
      issuePrefix: `MK${opts.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      opts.agents.map((agent) => ({
        id: agent.id,
        companyId: opts.companyId,
        name: agent.name,
        role: agent.role,
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    const ownerAgent = opts.agents[0];
    if (!ownerAgent) throw new Error("executeRun requires at least one agent");
    await db.insert(missions).values({
      id: opts.missionId,
      companyId: opts.companyId,
      ownerAgentId: ownerAgent.id,
      title: opts.companyName,
      status: "planning",
    });
    await db.insert(workflowDefinitions).values({
      id: opts.workflowId,
      companyId: opts.companyId,
      name: opts.companyName,
      stepsJson: opts.steps,
    });
    await db.insert(workflowRuns).values({
      id: opts.runId,
      workflowId: opts.workflowId,
      companyId: opts.companyId,
      missionId: opts.missionId,
      triggeredBy: "system",
      status: "pending",
    });
    await executeWorkflowRun(db, opts.runId);

    const stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, opts.runId));
    const issuesByStep: Record<string, typeof issues.$inferSelect> = {};
    for (const stepRun of stepRuns) {
      if (!stepRun.issueId) continue;
      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, stepRun.issueId))
        .then((rows) => rows[0] ?? null);
      if (issue) issuesByStep[stepRun.stepId] = issue;
    }
    return issuesByStep;
  }

  async function completeIssue(issueId: string) {
    await issueService(db).update(issueId, { status: "done" });
    await syncWorkflowRunForIssue(db, issueId);
  }

  async function getStepIssue(runId: string, stepId: string) {
    const stepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)))
      .then((rows) => rows[0] ?? null);
    if (!stepRun?.issueId) return null;
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun.issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function getStepRun(runId: string, stepId: string) {
    return db
      .select()
      .from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)))
      .then((rows) => rows[0] ?? null);
  }

  it("does not hard-stop direct dependencies explicitly marked as not requiring workProducts", async () => {
    const companyId = randomUUID();
    const runId = randomUUID();
    const scopeAgentId = randomUUID();
    const contractAgentId = randomUUID();
    const upstream = await executeRun({
      companyId,
      companyName: "Explicit Non Artifact Dependency",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: scopeAgentId, name: "Scope Checker", role: "operator" },
        { id: contractAgentId, name: "Contract Checker", role: "operator" },
      ],
      steps: [
        { id: "scope-check", name: "Confirm scope", agentId: scopeAgentId, dependencies: [], graphWorkProductRequired: false },
        { id: "legacy-check", name: "Confirm legacy marker", agentId: scopeAgentId, dependencies: [], workProductRequired: false },
        { id: "alias-check", name: "Confirm alias marker", agentId: scopeAgentId, dependencies: [], requiresWorkProduct: false },
        { id: "contract-check", name: "Check prerequisites", agentId: contractAgentId, dependencies: ["scope-check", "legacy-check", "alias-check"], graphWorkProductRequired: false },
      ],
    });

    for (const stepId of ["scope-check", "legacy-check", "alias-check"]) {
      const issue = upstream[stepId];
      if (!issue) throw new Error(`${stepId} issue was not created`);
      await completeIssue(issue.id);
    }

    const contractIssue = await getStepIssue(runId, "contract-check");
    if (!contractIssue) throw new Error("contract-check issue was not created");
    const description = contractIssue.description ?? "";
    expect(description).toContain("scope-check:");
    expect(description).toContain("legacy-check:");
    expect(description).toContain("alias-check:");
    expect(description).toContain("workProducts: none registered");
    expect(description).not.toContain("Dependency workProduct hard-stop:");
    expect(description).not.toContain("has no registered dependency workProduct.");
  });

  it("does not hard-stop direct dependencies with no workProduct marker after normalized default false", async () => {
    const companyId = randomUUID();
    const runId = randomUUID();
    const analystAgentId = randomUUID();
    const editorAgentId = randomUUID();
    const upstream = await executeRun({
      companyId,
      companyName: "Comment Dependency",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: analystAgentId, name: "Signal Analyst", role: "analyst" },
        { id: editorAgentId, name: "Synthesis Editor", role: "editor" },
      ],
      steps: [
        { id: "signal-analysis", name: "Post signal analysis", agentId: analystAgentId, dependencies: [] },
        { id: "market-analysis", name: "Synthesize market report", agentId: editorAgentId, dependencies: ["signal-analysis"], graphWorkProductRequired: true },
      ],
    });

    const signalIssue = upstream["signal-analysis"];
    if (!signalIssue) throw new Error("signal-analysis issue was not created");
    await completeIssue(signalIssue.id);

    const marketIssue = await getStepIssue(runId, "market-analysis");
    if (!marketIssue) throw new Error("market-analysis issue was not created");
    const description = marketIssue.description ?? "";
    expect(description).toContain("signal-analysis:");
    expect(description).toContain("workProducts: none registered");
    expect(description).not.toContain("Dependency workProduct hard-stop:");
  });

  it("does not unlock downstream when a required producer is done without a registered workProduct", async () => {
    const companyId = randomUUID();
    const runId = randomUUID();
    const producerAgentId = randomUUID();
    const editorAgentId = randomUUID();
    const upstream = await executeRun({
      companyId,
      companyName: "Explicit Artifact Dependency",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: producerAgentId, name: "Evidence Producer", role: "researcher" },
        { id: editorAgentId, name: "Synthesis Editor", role: "editor" },
      ],
      steps: [
        { id: "produce-evidence", name: "Produce evidence packet", agentId: producerAgentId, dependencies: [], graphWorkProductRequired: true },
        { id: "synthesize", name: "Synthesize report", agentId: editorAgentId, dependencies: ["produce-evidence"], graphWorkProductRequired: true },
      ],
    });

    const evidenceIssue = upstream["produce-evidence"];
    if (!evidenceIssue) throw new Error("produce-evidence issue was not created");
    await expect(completeIssue(evidenceIssue.id)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("requires a registered workProduct"),
    });

    expect(await getStepIssue(runId, "synthesize")).toBeNull();
    expect((await getStepRun(runId, "produce-evidence"))?.status).not.toBe("completed");
    const runAfterMissingWorkProduct = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(runAfterMissingWorkProduct?.status).toBe("running");

    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: evidenceIssue.id,
      type: "file",
      provider: "local",
      title: "evidence-packet.md",
      url: "/tmp/evidence-packet.md",
      status: "active",
      isPrimary: true,
    });
    await completeIssue(evidenceIssue.id);

    expect((await getStepRun(runId, "produce-evidence"))?.status).toBe("completed");
    const synthIssue = await getStepIssue(runId, "synthesize");
    if (!synthIssue) throw new Error("synthesize issue was not created");
    const description = synthIssue.description ?? "";
    expect(description).toContain("produce-evidence:");
    expect(description).toContain("workProducts:");
    expect(description).not.toContain("Dependency workProduct hard-stop:");
    expect(description).not.toContain("has no registered dependency workProduct.");
  });
  it("injects assigneeAdapterOverrides autoApproveTools=true only for literal true steps", async () => {
    const companyId = randomUUID();
    const runId = randomUUID();
    const agentId = randomUUID();
    const upstream = await executeRun({
      companyId,
      companyName: "AutoApprove Marker",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [{ id: agentId, name: "Auto Agent", role: "operator" }],
      steps: [
        { id: "yolo-step", name: "Auto-approve run", agentId, dependencies: [], autoApproveTools: true },
        { id: "plain-step", name: "Normal run", agentId, dependencies: [] },
        { id: "string-step", name: "Legacy string", agentId, dependencies: [], autoApproveTools: "true" },
      ],
    });

    expect(upstream["yolo-step"]?.assigneeAdapterOverrides).toEqual({
      adapterConfig: { autoApproveTools: true },
    });
    expect(upstream["plain-step"]?.assigneeAdapterOverrides).toBeNull();
    // Malformed string is normalized to undefined at the step, so no override is injected.
    expect(upstream["string-step"]?.assigneeAdapterOverrides).toBeNull();
  });
});
