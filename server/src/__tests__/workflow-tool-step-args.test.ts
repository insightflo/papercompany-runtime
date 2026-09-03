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

  it("falls back to metadata.toolResult.artifactPath for native tool steps without issues (case D)", async () => {
    const companyId = randomUUID();
    const runId = randomUUID();
    const publishIssueId = null;
    const artifactPath = "/srv/papercompany/projects/research-company/produced_work/missions/m1/runs/r1/steps/publish/manual-onboarding-publish-result.json";
    const steps = [
      { id: "publish-onboarding-manual", dependencies: [], toolNames: ["manual-onboarding-publish"], toolArgs: {} },
      {
        id: "verify-publish",
        dependencies: ["publish-onboarding-manual"],
        toolNames: ["manual-onboarding-verify"],
        toolArgs: {
          publishResultPath: "{$steps.publish-onboarding-manual.workProductPath}",
          publishResultDir: "{$steps.publish-onboarding-manual.workProductDir}",
          siblingAssets: "{$steps.publish-onboarding-manual.siblingAssetsDir}",
        },
      },
    ];

    await db.insert(companies).values({
      id: companyId,
      name: "Native Fallback Co",
      issuePrefix: `NF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const workflowId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "youtube-report", stepsJson: steps });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "board",
      status: "running",
      runDate: "2026-08-27",
    });
    await db.insert(workflowStepRuns).values([
      // native tool step: no issue_id, artifact only in step-run metadata.toolResult
      {
        workflowRunId: runId,
        stepId: "publish-onboarding-manual",
        issueId: publishIssueId,
        status: "completed",
        metadata: {
          toolResult: {
            requestId: "req-1",
            toolName: "manual-onboarding-publish",
            success: true,
            stdout: "{}",
            stderr: null,
            exitCode: 0,
            error: null,
            completedAt: "2026-08-27T00:00:00.000Z",
            artifactPath,
          },
        },
      },
      { workflowRunId: runId, stepId: "verify-publish", status: "pending" },
    ]);

    const args = await resolveWorkflowToolStepArgs({
      db,
      run: { id: runId, companyId, runDate: "2026-08-27" },
      step: steps[1]!,
      workflowSteps: steps,
    });

    expect(args).toEqual({
      publishResultPath: artifactPath,
      publishResultDir: path.dirname(artifactPath),
      siblingAssets: path.join(path.dirname(artifactPath), "assets"),
    });
  });

  it("prefers the issueWorkProducts path over the metadata fallback when both exist (case E)", async () => {
    const companyId = randomUUID();
    const runId = randomUUID();
    const producerIssueId = randomUUID();
    const registeredPath = "/srv/papercompany/registered/build/index.html";
    const metadataOnlyPath = "/srv/papercompany/metadata-only/build/other.html";
    const steps = [
      { id: "build-html", dependencies: [], agentId: randomUUID(), toolNames: [] },
      {
        id: "publish",
        dependencies: ["build-html"],
        toolNames: ["manual-onboarding-publish"],
        toolArgs: { sourceHtmlPath: "{$steps.build-html.workProductPath}" },
      },
    ];

    await db.insert(companies).values({
      id: companyId,
      name: "Fallback Priority Co",
      issuePrefix: `FP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const workflowId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "mixed", stepsJson: steps });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "board",
      status: "running",
      runDate: "2026-08-27",
    });
    await db.insert(issues).values({ id: producerIssueId, companyId, title: "Build HTML" });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "build-html",
        issueId: producerIssueId,
        status: "completed",
        metadata: { toolResult: { artifactPath: metadataOnlyPath } },
      },
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
      metadata: { path: registeredPath },
    });

    const args = await resolveWorkflowToolStepArgs({
      db,
      run: { id: runId, companyId, runDate: "2026-08-27" },
      step: steps[1]!,
      workflowSteps: steps,
    });

    expect(args).toEqual({ sourceHtmlPath: registeredPath });
  });

  it("still errors when a native tool step has no artifactPath and no workProduct (case F)", async () => {
    const companyId = randomUUID();
    const runId = randomUUID();
    const steps = [
      { id: "publish-onboarding-manual", dependencies: [], toolNames: ["manual-onboarding-publish"], toolArgs: {} },
      {
        id: "verify-publish",
        dependencies: ["publish-onboarding-manual"],
        toolNames: ["manual-onboarding-verify"],
        toolArgs: { publishResultPath: "{$steps.publish-onboarding-manual.workProductPath}" },
      },
    ];

    await db.insert(companies).values({
      id: companyId,
      name: "No Artifact Co",
      issuePrefix: `NA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const workflowId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "youtube-report", stepsJson: steps });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "board",
      status: "running",
      runDate: "2026-08-27",
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "publish-onboarding-manual",
        status: "completed",
        metadata: { toolResult: { success: true, exitCode: 0 } },
      },
      { workflowRunId: runId, stepId: "verify-publish", status: "pending" },
    ]);

    await expect(resolveWorkflowToolStepArgs({
      db,
      run: { id: runId, companyId, runDate: "2026-08-27" },
      step: steps[1]!,
      workflowSteps: steps,
    })).rejects.toThrow('could not resolve an active local workProduct for ancestor step "publish-onboarding-manual"');
  });
});

describe("{$workflowRunId} token", () => {
  it("renders the current workflow run id inside tool args", async () => {
    const runId = randomUUID();
    const steps = [
      {
        id: "clips-gate-consumer",
        dependencies: [],
        toolNames: ["shorts-storage-list"],
        toolArgs: {
          action: "list",
          prefix: "shorts/runs/{$workflowRunId}/clips/",
          keep: "{$runMetadata.missing}",
        },
      },
    ];
    const args = await resolveWorkflowToolStepArgs({
      // No ancestor artifact references => the DB is never queried on this path.
      db: {} as Parameters<typeof resolveWorkflowToolStepArgs>[0]["db"],
      run: { id: runId, companyId: randomUUID(), runDate: "2026-09-05" },
      step: steps[0]!,
      workflowSteps: steps,
    });
    expect(args).toEqual({
      action: "list",
      prefix: `shorts/runs/${runId}/clips/`,
      keep: "{$runMetadata.missing}",
    });
  });
});
