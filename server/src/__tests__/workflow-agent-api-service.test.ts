import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import {
  activityLog,
  agents,
  heartbeatRuns,
  companies,
  createDb,
  issueWorkProducts,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { workflowAgentApiRoutes } from "../routes/workflow-agent-api.js";
import { registerWorkflowArtifact, submitWorkflowVerdict, type WorkflowApiActor } from "../services/workflow/agent-api.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type AgentActor = {
  type: "agent";
  source: "agent_jwt";
  companyId: string;
  agentId: string;
  runId: string;
};

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping workflow agent API service tests: ${embeddedPostgresSupport.reason ?? "unsupported host"}`);
}

function createApp(db: Db, actor: AgentActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: AgentActor }).actor = actor;
    next();
  });
  app.use("/api", workflowAgentApiRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("workflow agent API service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-agent-api-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
    tempDirs.clear();
    await db.delete(activityLog);
    await db.delete(workflowTransitionEvents);
    await db.delete(issueWorkProducts);
    await db.delete(heartbeatRuns);
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

  async function seedWorkflowIssue(input: { stepId: string; stepType?: string; title: string; workProductRoot?: string }) {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const issueId = randomUUID();
    const missionId = input.workProductRoot ? randomUUID() : null;
    await db.insert(companies).values({
      id: companyId,
      name: "Research Co",
      issuePrefix: "RES",
      requireBoardApprovalForNewAgents: false,
      workProductRoot: input.workProductRoot,
    });
    if (missionId) {
      const ownerAgentId = randomUUID();
      await db.insert(agents).values({
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(missions).values({
        id: missionId,
        companyId,
        ownerAgentId,
        title: "Workflow mission",
        status: "active",
      });
    }
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "structured-workflow-api",
      stepsJson: [{ id: input.stepId, name: input.title, type: input.stepType, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "RES-1",
      title: input.title,
      status: "in_progress",
      originKind: "workflow_execution",
      originRunId: workflowRunId,
      missionId,
      startedAt: new Date("2026-07-06T00:00:00.000Z"),
    });
    await db.insert(workflowStepRuns).values({
      id: randomUUID(),
      workflowRunId,
      stepId: input.stepId,
      issueId,
      status: "running",
      startedAt: new Date("2026-07-06T00:00:01.000Z"),
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return issue;
  }

  async function seedAssignedWorkflowIssue() {
    const issue = await seedWorkflowIssue({ stepId: "produce-report", title: "Produce report" });
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: issue.companyId,
      name: "Reporter",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: issue.companyId,
      agentId,
      issueId: issue.id,
      status: "running",
      startedAt: new Date("2026-07-06T00:00:02.000Z"),
    });
    await db.update(issues).set({ assigneeAgentId: agentId, checkoutRunId: runId }).where(eq(issues.id, issue.id));
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issue.id));
    return { issue: updatedIssue, agentId, runId };
  }

  const actor: WorkflowApiActor = {
    actorType: "agent",
    actorId: "agent-1",
    agentId: "agent-1",
    runId: null,
  };

  it("records workflow QA verdicts in the transition ledger", async () => {
    const issue = await seedWorkflowIssue({ stepId: "qa-readability", stepType: "qa", title: "[QA] Readability" });

    const result = await submitWorkflowVerdict({
      db,
      issue,
      actor,
      data: { verdict: "request_changes", reason: "Glossary missing" },
    });

    expect(result).toMatchObject({ satisfied: true, verdict: "request_changes" });
    const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, issue.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "workflow_validation_verdict",
      reason: "workflow_api",
      verdict: "request_changes",
    });
  });

  it("registers artifacts as official issue workProducts", async () => {
    const issue = await seedWorkflowIssue({ stepId: "produce-report", title: "Produce report" });
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-artifact-"));
    tempDirs.add(dir);
    const artifactPath = path.join(dir, "report.md");
    await writeFile(artifactPath, "# Report\n", "utf8");

    const product = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: artifactPath, title: "report.md", type: "document", isPrimary: true },
    });
    const duplicate = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: artifactPath, title: "report.md", type: "document", isPrimary: true },
    });

    expect(product).toMatchObject({ provider: "local_file", title: "report.md", type: "document", isPrimary: true });
    expect(duplicate.id).toBe(product.id);
    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issue.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ path: artifactPath, registeredVia: "workflow_api" });
  });

  it("rejects artifact paths outside the mission workProduct directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-outside-"));
    tempDirs.add(root);
    tempDirs.add(outside);
    const issue = await seedWorkflowIssue({ stepId: "produce-report", title: "Produce report", workProductRoot: root });
    const artifactPath = path.join(outside, "report.md");
    await writeFile(artifactPath, "# Outside\n", "utf8");

    await expect(registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: { path: artifactPath, title: "report.md", type: "document", isPrimary: true },
    })).rejects.toThrow("inside this mission");
  });

  it("routes agent artifact registration through the workflow API", async () => {
    const { issue, agentId, runId } = await seedAssignedWorkflowIssue();
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-route-artifact-"));
    tempDirs.add(dir);
    const artifactPath = path.join(dir, "route-report.md");
    await writeFile(artifactPath, "# Route Report\n", "utf8");

    const response = await request(createApp(db, {
      type: "agent",
      source: "agent_jwt",
      companyId: issue.companyId,
      agentId,
      runId,
    }))
      .post(`/api/issues/${issue.id}/workflow/artifacts`)
      .send({ path: artifactPath, title: "route-report.md", type: "document" });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({
      issueId: issue.id,
      provider: "local_file",
      title: "route-report.md",
      createdByRunId: runId,
    });
  });
});
