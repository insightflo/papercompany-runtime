import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const executeSpy = vi.fn();

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    supportsLocalAgentJwt: false,
    execute: executeSpy,
  })),
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitForRunTerminal(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

async function waitForIssueStatus(db: ReturnType<typeof createDb>, issueId: string, status: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    if (issue?.status === status) return issue;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
  const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  throw new Error([
    `Timed out waiting for issue ${issueId}; latest=${issue?.status ?? "missing"}`,
    comments.map((comment) => comment.body).join("\n---\n"),
  ].join("\n"));
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

async function invokeAndWaitForRun(heartbeat: ReturnType<typeof heartbeatService>, agentId: string, issueId: string) {
  const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", {
    actorType: "system",
    actorId: "test-suite",
  });
  expect(run).not.toBeNull();
  await waitForRunTerminal(heartbeat, run!.id);
}

describeEmbeddedPostgres("heartbeat artifact comment registration gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-artifact-comment-gate-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    executeSpy.mockReset();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.delete(issueWorkProducts);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedProducerIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const workProductRoot = `/tmp/paperclip-artifact-comment-gate/${companyId}/produced_work`;
    const missionOutputRoot = `${workProductRoot}/missions/${missionId}`;
    const artifactPath = `${missionOutputRoot}/runs/run-1/steps/draft/evidence.json`;

    await db.insert(companies).values({
      id: companyId,
      name: "Artifact Comment Gate Co",
      issuePrefix: `ACG${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Producer",
      role: "writer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "artifact comment gate mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "Draft report artifact",
      description: [
        "Deliverable output (use exactly this directory):",
        `- ${missionOutputRoot}`,
        "- Finish with `[ARTIFACT]: <absolute path>`.",
      ].join("\n"),
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    return { companyId, agentId, issueId, artifactPath };
  }

  it("auto-registers one explicit same-run comment artifact and completes the issue", async () => {
    const fixture = await seedProducerIssue();
    const sourceCommentId = randomUUID();
    executeSpy.mockImplementation(async () => {
      await db.insert(issueComments).values({
        id: sourceCommentId,
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        authorAgentId: fixture.agentId,
        body: `[ARTIFACT]: ${fixture.artifactPath}`,
      });
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    await invokeAndWaitForRun(heartbeat, fixture.agentId, fixture.issueId);

    const issue = await waitForIssueStatus(db, fixture.issueId, "done");
    const workProducts = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, fixture.issueId));
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, fixture.issueId));
    expect(issue?.status).toBe("done");
    expect(workProducts).toHaveLength(1);
    expect(workProducts[0]?.externalId).toBe(fixture.artifactPath);
    expect(workProducts[0]?.metadata).toEqual(expect.objectContaining({
      autoRegisteredFrom: "issue_comment_artifact_marker",
      path: fixture.artifactPath,
      commentClaimedArtifactPaths: [fixture.artifactPath],
      sourceCommentIds: [sourceCommentId],
    }));
    expect(activities).toContainEqual(expect.objectContaining({
      action: "issue.work_product_auto_registered_from_comment",
      details: expect.objectContaining({
        autoRegisteredFrom: "issue_comment_artifact_marker",
        commentClaimedArtifactPaths: [fixture.artifactPath],
        sourceCommentIds: [sourceCommentId],
      }),
    }));
  });

  it("auto-registers one prior claimed comment artifact only when the local file exists", async () => {
    const fixture = await seedProducerIssue();
    const sourceCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: sourceCommentId,
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      authorAgentId: fixture.agentId,
      body: `Done. Created the evidence bundle at ${fixture.artifactPath}.`,
      createdAt: new Date(Date.now() - 60_000),
    });
    executeSpy.mockImplementation(async () => {
      await fs.mkdir(path.dirname(fixture.artifactPath), { recursive: true });
      await fs.writeFile(fixture.artifactPath, "{\"ok\":true}\n", "utf8");
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    await invokeAndWaitForRun(heartbeat, fixture.agentId, fixture.issueId);

    const issue = await waitForIssueStatus(db, fixture.issueId, "done");
    const workProducts = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, fixture.issueId));
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, fixture.issueId));
    expect(issue?.status).toBe("done");
    expect(workProducts).toHaveLength(1);
    expect(workProducts[0]?.externalId).toBe(fixture.artifactPath);
    expect(workProducts[0]?.metadata).toEqual(expect.objectContaining({
      autoRegisteredFrom: "issue_comment_claimed_file",
      path: fixture.artifactPath,
      commentClaimedArtifactPaths: [fixture.artifactPath],
      sourceCommentIds: [sourceCommentId],
    }));
    expect(activities).toContainEqual(expect.objectContaining({
      action: "issue.work_product_auto_registered_from_comment",
      details: expect.objectContaining({
        autoRegisteredFrom: "issue_comment_claimed_file",
        commentClaimedArtifactPaths: [fixture.artifactPath],
        sourceCommentIds: [sourceCommentId],
      }),
    }));
  });

  it("blocks one prior claimed comment artifact when the local file is missing", async () => {
    const fixture = await seedProducerIssue();
    await db.insert(issueComments).values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      authorAgentId: fixture.agentId,
      body: `Done. Created the evidence bundle at ${fixture.artifactPath}.`,
      createdAt: new Date(Date.now() - 60_000),
    });
    executeSpy.mockImplementation(async () => successfulAdapterResult());

    const heartbeat = heartbeatService(db);
    await invokeAndWaitForRun(heartbeat, fixture.agentId, fixture.issueId);

    const issue = await waitForIssueStatus(db, fixture.issueId, "blocked");
    const workProducts = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, fixture.issueId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId));
    expect(issue?.status).toBe("blocked");
    expect(workProducts).toHaveLength(0);
    expect(comments.map((comment) => comment.body).join("\n")).toContain("workProduct registration missing");
    expect(comments.map((comment) => comment.body).join("\n")).toContain(fixture.artifactPath);
  });

  it("blocks when same-run comments expose multiple explicit artifact candidates", async () => {
    const fixture = await seedProducerIssue();
    const secondPath = fixture.artifactPath.replace("evidence.json", "appendix.json");
    executeSpy.mockImplementation(async () => {
      await db.insert(issueComments).values({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        authorAgentId: fixture.agentId,
        body: [`[ARTIFACT]: ${fixture.artifactPath}`, `[ARTIFACT]: ${secondPath}`].join("\n"),
      });
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    await invokeAndWaitForRun(heartbeat, fixture.agentId, fixture.issueId);

    const issue = await waitForIssueStatus(db, fixture.issueId, "blocked");
    const workProducts = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, fixture.issueId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId));
    expect(issue?.status).toBe("blocked");
    expect(workProducts).toHaveLength(0);
    expect(comments.map((comment) => comment.body).join("\n")).toContain("### Comment artifact paths");
  });
});
