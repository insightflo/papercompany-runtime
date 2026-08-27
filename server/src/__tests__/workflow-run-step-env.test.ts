import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  missions,
  workflowDefinitions,
  workflowRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveWorkflowRunStepEnv } from "../services/workflow/core-tool-executor.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("resolveWorkflowRunStepEnv (native tool-step env)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-step-env-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("injects PAPERCLIP_STEP_OUTPUT_DIR when the run has a mission and the company has a workProductRoot", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepId = "capture-frames";
    const workProductRoot = "/srv/papercompany/projects/research-company/produced_work";

    await db.insert(companies).values({
      id: companyId,
      name: "Run Step Env Co",
      issuePrefix: `RS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "YouTube summary" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "youtube-summary", stepsJson: [] });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      runDate: "2026-08-27",
    });

    const env = await resolveWorkflowRunStepEnv(db, { companyId, workflowRunId: runId, stepId });

    expect(env.PAPERCLIP_WORKFLOW_RUN_ID).toBe(runId);
    expect(env.PAPERCLIP_STEP_ID).toBe(stepId);
    expect(env.PAPERCLIP_MISSION_ID).toBe(missionId);
    expect(env.PAPERCLIP_STEP_OUTPUT_DIR).toBe(
      `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/${stepId}`,
    );
  });

  it("keeps RUN_ID/STEP_ID only and stays graceful when the run has no mission", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepId = "capture-frames";

    await db.insert(companies).values({
      id: companyId,
      name: "No Mission Co",
      issuePrefix: `NM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot: "/srv/papercompany/projects/research-company/produced_work",
    });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "ad-hoc", stepsJson: [] });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "board",
      status: "running",
      runDate: "2026-08-27",
    });

    const env = await resolveWorkflowRunStepEnv(db, { companyId, workflowRunId: runId, stepId });

    expect(env).toEqual({
      PAPERCLIP_WORKFLOW_RUN_ID: runId,
      PAPERCLIP_STEP_ID: stepId,
    });
  });

  it("stays graceful when the workflow run does not exist", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Missing Run Co",
      issuePrefix: `MR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const env = await resolveWorkflowRunStepEnv(db, { companyId, workflowRunId: randomUUID(), stepId: "capture-frames" });

    expect(env).toEqual({
      PAPERCLIP_WORKFLOW_RUN_ID: expect.any(String),
      PAPERCLIP_STEP_ID: "capture-frames",
    });
    expect(Object.keys(env)).toEqual(["PAPERCLIP_WORKFLOW_RUN_ID", "PAPERCLIP_STEP_ID"]);
  });
});
