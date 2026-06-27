import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  missionPlanArtifacts,
  missionPlanDecisionSubmissions,
  missionPlanQaVerdicts,
  missions,
  type Db,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { missionRoutes } from "../routes/missions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres mission runtime snapshot route tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

type Actor =
  | { type: "board"; source: "session"; userId: string; companyIds: string[]; isInstanceAdmin?: boolean }
  | { type: "board"; source: "local_implicit"; userId: string };

function createApp(db: Db, actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", missionRoutes(db));
  app.use(errorHandler);
  return app;
}

function prefix(id: string, marker: string) {
  return `${marker}${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("mission runtime snapshot route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runtime-snapshot-route-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(missionPlanQaVerdicts);
    await db.delete(missionPlanDecisionSubmissions);
    await db.delete(missionPlanArtifacts);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
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

  async function seedStructuredMission(marker = "RS") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const workflowStepRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const heartbeatRunId = randomUUID();
    const commentId = randomUUID();
    const planArtifactId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `${marker} Company`,
      issuePrefix: prefix(companyId, marker),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${marker} Owner`,
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
      ownerAgentId: agentId,
      title: `${marker} Structured Mission`,
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: `${marker} Structured Issue`,
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      originKind: "workflow_execution",
      originId: workflowRunId,
      originRunId: workflowRunId,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: `${marker} Workflow`,
      status: "active",
      stepsJson: [],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      status: "running",
      triggeredBy: "system",
      startedAt: new Date("2026-06-27T00:00:00.000Z"),
    });
    await db.insert(workflowStepRuns).values({
      id: workflowStepRunId,
      workflowRunId,
      stepId: "collect",
      issueId,
      status: "completed",
      agentName: `${marker} Owner`,
      completedAt: new Date("2026-06-27T00:05:00.000Z"),
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "workflow_step_runnable",
      payload: { issueId, missionId },
      status: "accepted",
      runId: heartbeatRunId,
      requestKind: "workflow_step",
      issueId,
      missionId,
      workflowRunId,
      workflowStepRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      issueId,
      wakeupRequestId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      startedAt: new Date("2026-06-27T00:01:00.000Z"),
      finishedAt: new Date("2026-06-27T00:04:00.000Z"),
      exitCode: 0,
      contextSnapshot: { issueId, missionId, workflowRunId, workflowStepRunId },
    });
    await db.insert(workflowTransitionEvents).values({
      id: randomUUID(),
      companyId,
      missionId,
      workflowRunId,
      workflowStepRunId,
      issueId,
      wakeupRequestId,
      heartbeatRunId,
      eventType: "queue_run_completed",
      layer: "queue",
      decision: "succeeded",
      reasonCode: "run_terminal",
      idempotencyKey: `queue-run-completed:${heartbeatRunId}:succeeded`,
      payload: { source: "test" },
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Legacy comment kept for display only.",
    });
    await db.insert(missionPlanArtifacts).values({
      id: planArtifactId,
      companyId,
      missionId,
      revision: 1,
      status: "active",
      ownerAgentId: agentId,
      missionGoal: "Deliver structured runtime snapshot.",
      refs: { planningIssueId: issueId },
      steps: [{ id: "collect", name: "Collect evidence" }],
    });
    await db.insert(missionPlanDecisionSubmissions).values({
      id: randomUUID(),
      companyId,
      missionId,
      planningIssueId: issueId,
      authorAgentId: agentId,
      sourceRunId: heartbeatRunId,
      sourceCommentId: commentId,
      decisionHash: `decision-${marker}`,
      decision: { selectedExecutionUnits: [{ id: "collect" }] },
      status: "accepted",
    });
    await db.insert(missionPlanQaVerdicts).values({
      id: randomUUID(),
      companyId,
      missionId,
      missionPlanArtifactId: planArtifactId,
      planQaIssueId: issueId,
      reviewerAgentId: agentId,
      sourceRunId: heartbeatRunId,
      sourceCommentId: commentId,
      decisionHash: `qa-${marker}`,
      verdict: "PASS",
      diagnostics: [{ code: "ok" }],
    });

    return {
      companyId,
      agentId,
      missionId,
      issueId,
      workflowRunId,
      workflowStepRunId,
      wakeupRequestId,
      heartbeatRunId,
      commentId,
      planArtifactId,
    };
  }

  it("returns a structured snapshot while keeping comments display-only", async () => {
    const seeded = await seedStructuredMission("RS");

    const res = await request(createApp(db, {
      type: "board",
      source: "session",
      userId: "board",
      companyIds: [seeded.companyId],
    })).get(`/api/missions/${seeded.missionId}/runtime-snapshot`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      missionId: seeded.missionId,
      companyId: seeded.companyId,
      snapshot: expect.objectContaining({
        missionId: seeded.missionId,
        comments: expect.objectContaining({ controlSource: "display_only" }),
        legacyFallbackDiagnostics: [],
      }),
    }));

    const snapshot = res.body.snapshot;
    expect(snapshot.dag.workflowRuns).toEqual([
      expect.objectContaining({ id: seeded.workflowRunId, missionId: seeded.missionId }),
    ]);
    expect(snapshot.dag.stepRuns).toEqual([
      expect.objectContaining({ id: seeded.workflowStepRunId, issueId: seeded.issueId }),
    ]);
    expect(snapshot.loop.transitionEvents).toEqual([
      expect.objectContaining({
        eventType: "queue_run_completed",
        heartbeatRunId: seeded.heartbeatRunId,
        decision: "succeeded",
      }),
    ]);
    expect(snapshot.queue.wakeupRequests).toEqual([
      expect.objectContaining({
        id: seeded.wakeupRequestId,
        missionId: seeded.missionId,
        workflowStepRunId: seeded.workflowStepRunId,
      }),
    ]);
    expect(snapshot.runs.heartbeatRuns).toEqual([
      expect.objectContaining({ id: seeded.heartbeatRunId, status: "succeeded" }),
    ]);
    expect(snapshot.domain.planSubmissions).toEqual([
      expect.objectContaining({ missionId: seeded.missionId, sourceRunId: seeded.heartbeatRunId }),
    ]);
    expect(snapshot.domain.planQaVerdicts).toEqual([
      expect.objectContaining({ missionId: seeded.missionId, verdict: "PASS" }),
    ]);
    expect(snapshot.domain.planArtifacts).toEqual([
      expect.objectContaining({ id: seeded.planArtifactId, status: "active" }),
    ]);
    expect(snapshot.comments.recentComments).toEqual([
      expect.objectContaining({ id: seeded.commentId, body: "Legacy comment kept for display only." }),
    ]);
  });

  it("does not leak runtime snapshot data across company access boundaries", async () => {
    const allowed = await seedStructuredMission("OK");
    const forbidden = await seedStructuredMission("NO");

    const res = await request(createApp(db, {
      type: "board",
      source: "session",
      userId: "board",
      companyIds: [allowed.companyId],
    })).get(`/api/missions/${forbidden.missionId}/runtime-snapshot`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "User does not have access to this company" });
    expect(res.body).not.toHaveProperty("snapshot");
    expect(JSON.stringify(res.body)).not.toContain(forbidden.heartbeatRunId);
  });
});
