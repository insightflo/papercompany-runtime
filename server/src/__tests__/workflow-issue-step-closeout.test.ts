import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  agents,
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
import { completeLinkedWorkflowStepRunsForIssue } from "../services/workflow/issue-step-closeout.js";
import { issueService } from "../services/issues.js";

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
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  async function seedLinkedWorkflowIssue(input?: {
    issueStatus?: string;
    stepMetadata?: Record<string, unknown>;
  }) {
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
      status: input?.issueStatus ?? "done",
      originKind: "workflow_execution",
      originRunId: workflowRunId,
      completedAt: input?.issueStatus === "done" || input?.issueStatus == null ? completedAt : null,
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
      metadata: input?.stepMetadata ?? {},
    });

    return { companyId, issueId, stepRunId, startedAt, completedAt };
  }

  it("completes active workflow step runs when their issue is closed externally", async () => {
    const { issueId, stepRunId, startedAt, completedAt } = await seedLinkedWorkflowIssue();

    const completedIds = await completeLinkedWorkflowStepRunsForIssue({ db, issueId, completedAt });

    expect(completedIds).toEqual([stepRunId]);
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(stepRun).toEqual(expect.objectContaining({
      status: "completed",
      startedAt,
      completedAt,
    }));
  });

  it("blocks direct issue completion when a linked required workProduct is missing", async () => {
    const { issueId, stepRunId } = await seedLinkedWorkflowIssue({
      issueStatus: "todo",
      stepMetadata: { graphWorkProductRequired: true },
    });

    await expect(issueService(db).update(issueId, { status: "done" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("requires a registered workProduct"),
    });

    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(stepRun?.status).toBe("running");
  });

  it("completes the linked workflow step when direct issue completion has a workProduct", async () => {
    const { companyId, issueId, stepRunId } = await seedLinkedWorkflowIssue({
      issueStatus: "todo",
      stepMetadata: { graphWorkProductRequired: true },
    });
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "artifact",
      provider: "local",
      title: "Sector_Rotation_Analysis_2026-07-05.md",
      url: "/srv/papercompany/projects/gazua-addon/produced_work/sector.md",
      status: "active",
      isPrimary: true,
    });

    const updated = await issueService(db).update(issueId, { status: "done" });

    expect(updated?.status).toBe("done");
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(stepRun?.status).toBe("completed");
    expect(stepRun?.completedAt).toBeInstanceOf(Date);
  });
});
