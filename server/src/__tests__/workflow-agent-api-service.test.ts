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
  issueComments,
  companies,
  createDb,
  issueWorkProducts,
  issues,
  missionPlanArtifacts,
  missionPlanQaVerdicts,
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
    await db.delete(issueComments);
    await db.delete(missionPlanQaVerdicts);
    await db.delete(heartbeatRuns);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(missionPlanArtifacts);
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

  async function seedMissionOwnerUnblockIssue(sourceIssue: typeof issues.$inferSelect) {
    if (!sourceIssue.missionId) throw new Error("source issue must belong to a mission");
    const [mission] = await db.select().from(missions).where(eq(missions.id, sourceIssue.missionId));
    const ownerAgentId = mission?.ownerAgentId;
    if (!ownerAgentId) throw new Error("mission owner agent is required");
    const ownerActionId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: ownerActionId,
      companyId: sourceIssue.companyId,
      missionId: sourceIssue.missionId,
      title: `[Unblock] ${sourceIssue.identifier}: ${sourceIssue.title}`,
      status: "in_progress",
      originKind: "mission_main_executor_unblock",
      originId: sourceIssue.id,
      assigneeAgentId: ownerAgentId,
      startedAt: new Date("2026-07-06T00:00:03.000Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: sourceIssue.companyId,
      agentId: ownerAgentId,
      issueId: ownerActionId,
      status: "running",
      startedAt: new Date("2026-07-06T00:00:04.000Z"),
    });
    await db
      .update(issues)
      .set({ checkoutRunId: runId, executionRunId: runId })
      .where(eq(issues.id, ownerActionId));
    const [ownerAction] = await db.select().from(issues).where(eq(issues.id, ownerActionId));
    return { ownerAction, ownerAgentId, runId };
  }

  async function seedAssignedPlanQaIssue() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const decisionHash = "plan-qa-hash";
    await db.insert(companies).values({
      id: companyId,
      name: "Research Co",
      issuePrefix: "RES",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "Report Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "PLAN-QA API mission",
      status: "planning",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "RES-PLANQA",
      title: "[PLAN-QA] Review active plan",
      status: "in_progress",
      originKind: "mission_plan_qa",
      originId: `plan-qa:${missionId}:${decisionHash}`,
      assigneeAgentId: qaAgentId,
      startedAt: new Date("2026-07-11T00:00:00.000Z"),
    });
    await db.insert(missionPlanArtifacts).values({
      companyId,
      missionId,
      ownerAgentId,
      missionGoal: "Verify a mission owner plan.",
      refs: { planQa: { issueId, status: "pending", decisionHash } },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: qaAgentId,
      issueId,
      status: "running",
      startedAt: new Date("2026-07-11T00:00:01.000Z"),
    });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return { issue, qaAgentId, runId, decisionHash };
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

  it("records workflow verdicts without requiring a QA step type", async () => {
    const issue = await seedWorkflowIssue({
      stepId: "audit-source-coverage",
      title: "Audit source coverage and confidence",
    });

    const result = await submitWorkflowVerdict({
      db,
      issue,
      actor,
      data: { verdict: "pass", reason: "Source coverage is sufficient" },
    });

    expect(result).toMatchObject({
      isCandidate: true,
      satisfied: true,
      verdict: "pass",
      stepId: "audit-source-coverage",
    });
    const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, issue.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "workflow_validation_verdict",
      reason: "workflow_api",
      verdict: "pass",
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

  it("registers public preview URLs as official issue workProducts", async () => {
    const issue = await seedWorkflowIssue({ stepId: "publish-entry", title: "[ACTION] Publish entry" });
    const publicUrl = "https://manual-onboarding.pages.dev/onboarding/concepts/260707-llm-document-search/index.html";

    const product = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: {
        type: "preview_url",
        url: publicUrl,
        title: "260707-llm-document-search",
        contentMarker: "260707-llm-document-search",
        isPrimary: true,
      },
    });
    const duplicate = await registerWorkflowArtifact({
      db,
      issue,
      actor,
      data: {
        type: "preview_url",
        url: publicUrl,
        title: "260707-llm-document-search",
        contentMarker: "260707-llm-document-search",
        isPrimary: true,
      },
    });

    expect(product).toMatchObject({
      provider: "manual_onboarding",
      title: "260707-llm-document-search",
      type: "preview_url",
      url: publicUrl,
      isPrimary: true,
    });
    expect(duplicate.id).toBe(product.id);
    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issue.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      registeredVia: "workflow_api",
      contentMarker: "260707-llm-document-search",
      deliveryReadback: { required: true, source: "workflow_preview_url" },
    });
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

  it("routes agent preview URL registration through the workflow API", async () => {
    const { issue, agentId, runId } = await seedAssignedWorkflowIssue();
    const publicUrl = "https://manual-onboarding.pages.dev/onboarding/concepts/260707-llm-document-search/index.html";

    const response = await request(createApp(db, {
      type: "agent",
      source: "agent_jwt",
      companyId: issue.companyId,
      agentId,
      runId,
    }))
      .post(`/api/issues/${issue.id}/workflow/artifacts`)
      .send({
        type: "preview_url",
        url: publicUrl,
        title: "260707-llm-document-search",
        contentMarker: "260707-llm-document-search",
      });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({
      issueId: issue.id,
      provider: "manual_onboarding",
      title: "260707-llm-document-search",
      type: "preview_url",
      url: publicUrl,
      createdByRunId: runId,
    });
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id));
    expect(rows[rows.length - 1]?.details).toMatchObject({ type: "preview_url", url: publicUrl });
  });

  it("allows a checked-out mission owner unblock run to register recovered source artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-source-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-recovered-"));
    tempDirs.add(root);
    tempDirs.add(outside);
    const sourceIssue = await seedWorkflowIssue({
      stepId: "materialize-html-report",
      title: "Materialize dashboard HTML",
      workProductRoot: root,
    });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssue.id));
    const artifactPath = path.join(outside, "KR_Market_Report_2026-07-08.html");
    await writeFile(artifactPath, "<html><title>KR Market Report</title></html>\n", "utf8");
    const { ownerAction, ownerAgentId, runId } = await seedMissionOwnerUnblockIssue(sourceIssue);

    const response = await request(createApp(db, {
      type: "agent",
      source: "agent_jwt",
      companyId: sourceIssue.companyId,
      agentId: ownerAgentId,
      runId,
    }))
      .post(`/api/issues/${sourceIssue.id}/workflow/artifacts`)
      .send({ path: artifactPath, title: "KR_Market_Report_2026-07-08.html", type: "document" });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({
      issueId: sourceIssue.id,
      provider: "local_file",
      title: "KR_Market_Report_2026-07-08.html",
      createdByRunId: runId,
      metadata: {
        path: artifactPath,
        delegatedWorkflowApi: "mission_owner_unblock_source",
        delegatedFromIssueId: ownerAction.id,
      },
    });
  });

  it("allows a checked-out mission owner unblock run to complete the source workflow issue", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-complete-root-"));
    tempDirs.add(root);
    const sourceIssue = await seedWorkflowIssue({
      stepId: "materialize-html-report",
      title: "Materialize dashboard HTML",
      workProductRoot: root,
    });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssue.id));
    const { ownerAgentId, runId } = await seedMissionOwnerUnblockIssue(sourceIssue);

    const response = await request(createApp(db, {
      type: "agent",
      source: "agent_jwt",
      companyId: sourceIssue.companyId,
      agentId: ownerAgentId,
      runId,
    }))
      .post(`/api/issues/${sourceIssue.id}/workflow/complete`)
      .send({ comment: "Recovered dashboard files and propagated completion from mission-owner unblock." });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [updatedSourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(updatedSourceIssue).toMatchObject({ id: sourceIssue.id, status: "done" });
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.issueId, sourceIssue.id));
    expect(step?.status).toBe("completed");
    const [ownerRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(ownerRun?.status).toBe("running");
  });

  it("does not allow mission owner unblock delegation to submit workflow verdicts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-verdict-root-"));
    tempDirs.add(root);
    const sourceIssue = await seedWorkflowIssue({
      stepId: "qa-dashboard-html",
      stepType: "qa",
      title: "QA dashboard HTML",
      workProductRoot: root,
    });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssue.id));
    const { ownerAgentId, runId } = await seedMissionOwnerUnblockIssue(sourceIssue);

    const response = await request(createApp(db, {
      type: "agent",
      source: "agent_jwt",
      companyId: sourceIssue.companyId,
      agentId: ownerAgentId,
      runId,
    }))
      .post(`/api/issues/${sourceIssue.id}/workflow/verdict`)
      .send({ verdict: "pass", reason: "Owner action cannot cast the QA verdict." });

    expect(response.status).toBe(409);
    const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, sourceIssue.id));
    expect(events).toHaveLength(0);
  });

  it("routes agent PLAN-QA verdicts through the official mission plan QA API", async () => {
    const { issue, qaAgentId, runId, decisionHash } = await seedAssignedPlanQaIssue();

    const response = await request(createApp(db, {
      type: "agent",
      source: "agent_jwt",
      companyId: issue.companyId,
      agentId: qaAgentId,
      runId,
    }))
      .post(`/api/issues/${issue.id}/mission-plan-qa/verdict`)
      .send({ verdict: "pass", diagnostics: [] });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      status: "recorded",
      planQaIssueId: issue.id,
      decisionHash,
      verdict: "pass",
    });
    const rows = await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, issue.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      decisionHash,
      verdict: "pass",
      reviewerAgentId: qaAgentId,
      sourceRunId: runId,
    });
  });
});
