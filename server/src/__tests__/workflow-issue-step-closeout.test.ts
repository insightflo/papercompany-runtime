import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  agents,
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
import { completeLinkedWorkflowStepRunsForIssue } from "../services/workflow/issue-step-closeout.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping workflow issue step closeout tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workflow issue step closeout", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-step-closeout-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
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

  it("completes active workflow step runs when their issue is closed externally", async () => {
    const companyId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const ownerAgentId = randomUUID();
    const issueId = randomUUID();
    const stepRunId = randomUUID();
    const startedAt = new Date("2026-07-05T05:20:00.000Z");
    const completedAt = new Date("2026-07-05T05:24:12.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Gazua",
      issuePrefix: "GAZ",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Conan",
      role: "operator",
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
      title: "gazua-morning",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "GAZ-155",
      title: "Sector rotation",
      status: "done",
      originKind: "workflow_execution",
      originRunId: workflowRunId,
      completedAt,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "gazua-morning",
      stepsJson: [{ id: "sector-rotation", name: "Sector rotation", dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "sector-rotation",
      issueId,
      status: "running",
      startedAt,
    });

    const completedIds = await completeLinkedWorkflowStepRunsForIssue({ db, issueId, completedAt });

    expect(completedIds).toEqual([stepRunId]);
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(stepRun).toEqual(expect.objectContaining({
      status: "completed",
      startedAt,
      completedAt,
    }));
  });
});
