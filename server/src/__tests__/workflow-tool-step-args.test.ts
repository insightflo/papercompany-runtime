import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueWorkProducts,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("workflow tool step args", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-step-args-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resolves an ancestor step workProduct path and sibling assets directory", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const producerIssueId = randomUUID();
    const sourceHtmlPath = "/srv/papercompany/projects/research-company/produced_work/missions/m1/build/index.html";
    const steps = [
      { id: "build-html", dependencies: [], agentId, toolNames: [] },
      { id: "validate-html", dependencies: ["build-html"], agentId, toolNames: [] },
      {
        id: "publish",
        dependencies: ["validate-html"],
        agentId: "",
        toolNames: ["manual-onboarding-publish"],
        toolArgs: {
          id: "{$runDate}-tech-scout",
          sourceHtmlPath: "{$steps.build-html.workProductPath}",
          sourceAssetDir: "{$steps.build-html.siblingAssetsDir}",
        },
      },
    ];

    await db.insert(companies).values({
      id: companyId,
      name: "Tool Args",
      issuePrefix: `TA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "tech-scout", stepsJson: steps });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "running",
      runDate: "2026-07-14",
    });
    await db.insert(issues).values({ id: producerIssueId, companyId, title: "Build HTML" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "build-html", issueId: producerIssueId, status: "completed" },
      { workflowRunId: runId, stepId: "validate-html", status: "completed" },
      { workflowRunId: runId, stepId: "publish", status: "pending" },
    ]);
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: producerIssueId,
      title: "index.html",
      type: "document",
      provider: "local_file",
      status: "active",
      isPrimary: true,
      metadata: { path: sourceHtmlPath },
    });

    const args = await resolveWorkflowToolStepArgs({
      db,
      run: { id: runId, companyId, runDate: "2026-07-14" },
      step: steps[2]!,
      workflowSteps: steps,
    });

    expect(args).toEqual({
      id: "2026-07-14-tech-scout",
      sourceHtmlPath,
      sourceAssetDir: path.join(path.dirname(sourceHtmlPath), "assets"),
    });
  });

  it("renders {$runMetadata.<key>} tokens from run metadata and keeps unresolved tokens", async () => {
    const companyId = randomUUID();
    const runId = randomUUID();
    const steps = [
      {
        id: "summarize",
        dependencies: [],
        toolNames: ["manual-onboarding-summarize"],
        toolArgs: {
          url: "{$runMetadata.url}",
          missing: "{$runMetadata.notDeclared}",
          count: "count={$runMetadata.count}",
          payload: "{$runMetadata.payload}",
        },
      },
    ];

    await db.insert(companies).values({
      id: companyId,
      name: "Run Metadata Args",
      issuePrefix: `RM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const workflowId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "youtube-summary", stepsJson: steps });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "board",
      status: "running",
      runDate: "2026-08-27",
      metadata: { url: "https://example.com/watch?v=abc", count: 3, payload: { chapters: [1, 2] } },
    });

    const args = await resolveWorkflowToolStepArgs({
      db,
      run: {
        id: runId,
        companyId,
        runDate: "2026-08-27",
        metadata: { url: "https://example.com/watch?v=abc", count: 3, payload: { chapters: [1, 2] } },
      },
      step: steps[0]!,
      workflowSteps: steps,
    });

    expect(args).toEqual({
      url: "https://example.com/watch?v=abc",
      missing: "{$runMetadata.notDeclared}",
      count: "count=3",
      payload: '{"chapters":[1,2]}',
    });
  });
});
