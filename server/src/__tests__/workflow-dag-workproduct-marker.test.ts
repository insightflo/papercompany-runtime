import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueWorkProducts,
  issues,
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
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueWorkProducts);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
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
    await db.insert(missions).values({
      id: opts.missionId,
      companyId: opts.companyId,
      ownerAgentId: opts.agents[0]!.id,
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

  it("hard-stops a direct dependency explicitly marked as requiring a workProduct", async () => {
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
    await completeIssue(evidenceIssue.id);

    const synthIssue = await getStepIssue(runId, "synthesize");
    if (!synthIssue) throw new Error("synthesize issue was not created");
    const description = synthIssue.description ?? "";
    expect(description).toContain("Dependency workProduct hard-stop:");
    expect(description).toContain(`- produce-evidence: ${evidenceIssue.identifier ?? evidenceIssue.id} has no registered dependency workProduct.`);
  });
});
