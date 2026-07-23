import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
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
    heartbeatService: () => ({ wakeup: heartbeatWakeup }),
  };
});

import { syncWorkflowRunForIssue } from "../services/workflow/dag-engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping validation check race tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("workflow validation check race", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-validation-check-race-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    await db.delete(activityLog);
    await db.delete(workflowTransitionEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    // production may dual-write display comments during sync; clear before issues.
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function recordOfficialQaVerdict(input: {
    issueId: string;
    companyId: string;
    qaAgentId: string;
    workflowRunId: string;
    workflowStepRunId: string;
    verdict: "request_changes" | "pass";
    createdAt: string;
  }) {
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId: input.companyId,
      agentId: input.qaAgentId,
      issueId: input.issueId,
      status: "succeeded",
      startedAt: new Date(input.createdAt),
      finishedAt: new Date(input.createdAt),
    });
    await db.insert(workflowTransitionEvents).values({
      companyId: input.companyId,
      workflowRunId: input.workflowRunId,
      workflowStepRunId: input.workflowStepRunId,
      issueId: input.issueId,
      heartbeatRunId,
      eventType: "workflow_validation_verdict",
      layer: "workflow_validation",
      verdict: input.verdict,
      decision: input.verdict,
      reason: "workflow_api",
      reasonCode: "workflow_api",
      idempotencyKey: `race-verdict:${input.workflowStepRunId}:${input.verdict}:${input.createdAt}`,
      payload: {
        kind: "workflow_validation_verdict",
        workflowRunId: input.workflowRunId,
        stepRunId: input.workflowStepRunId,
        issueId: input.issueId,
        verdict: input.verdict,
      },
      createdAt: new Date(input.createdAt),
    });
  }

  async function stepRuns(runId: string) {
    return db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
  }

  it("keeps downstream pending until the current validation check has PASS", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-validation-check-race" });
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const auditAgentId = randomUUID();
    const writerAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const auditIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Validation Check Race",
      issuePrefix: `VR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Research Agent", role: "researcher", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: auditAgentId, companyId, name: "Audit Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: writerAgentId, companyId, name: "Writer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: producerAgentId,
      title: "Validation Check Race Mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "validation-check-race",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          name: "Collect bounded evidence",
          agentId: producerAgentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "audit-source-coverage", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }],
        },
        {
          id: "audit-source-coverage",
          name: "Audit source coverage and confidence",
          agentId: auditAgentId,
          dependencies: ["collect-ai-news-evidence"],
        },
        {
          id: "draft-beginner-report-outline",
          name: "Draft beginner report outline",
          agentId: writerAgentId,
          dependencies: ["audit-source-coverage"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date("2026-07-06T00:20:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: producerIssueId,
        companyId,
        missionId,
        title: "Collect bounded evidence",
        status: "done",
        assigneeAgentId: producerAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-07-06T00:20:30.000Z"),
        completedAt: new Date("2026-07-06T00:22:40.000Z"),
      },
      {
        id: auditIssueId,
        companyId,
        missionId,
        title: "Audit source coverage and confidence",
        status: "done",
        assigneeAgentId: auditAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-07-06T00:23:50.000Z"),
        completedAt: new Date("2026-07-06T00:24:12.000Z"),
      },
    ]);
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "collect-ai-news-evidence",
        issueId: producerIssueId,
        status: "completed",
        startedAt: new Date("2026-07-06T00:20:30.000Z"),
        completedAt: new Date("2026-07-06T00:22:40.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "audit-source-coverage",
        issueId: auditIssueId,
        status: "running",
        startedAt: new Date("2026-07-06T00:23:50.000Z"),
        completedAt: null,
      },
      { workflowRunId: runId, stepId: "draft-beginner-report-outline", status: "pending" },
    ]);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: auditAgentId,
      issueId: auditIssueId,
      status: "succeeded",
      resultJson: { note: "validator run succeeded before verdict side effect was persisted" },
      startedAt: new Date("2026-07-06T00:23:50.000Z"),
      finishedAt: new Date("2026-07-06T00:24:12.820Z"),
    });

    await syncWorkflowRunForIssue(db, auditIssueId);
    let rows = await stepRuns(runId);
    expect(rows.find((row) => row.stepId === "audit-source-coverage")).toMatchObject({ status: "running", completedAt: null });
    expect(rows.find((row) => row.stepId === "draft-beginner-report-outline")).toMatchObject({ status: "pending", issueId: null });
    expect(heartbeatWakeup).not.toHaveBeenCalled();

    const auditStepRunId = rows.find((row) => row.stepId === "audit-source-coverage")?.id;
    if (!auditStepRunId) throw new Error("missing audit step run");
    await recordOfficialQaVerdict({
      issueId: auditIssueId,
      companyId,
      qaAgentId: auditAgentId,
      workflowRunId: runId,
      workflowStepRunId: auditStepRunId,
      verdict: "request_changes",
      createdAt: "2026-07-06T00:24:13.083Z",
    });
    await syncWorkflowRunForIssue(db, auditIssueId);
    rows = await stepRuns(runId);
    expect(rows.find((row) => row.stepId === "collect-ai-news-evidence")).toMatchObject({ status: "pending", iterationIndex: 1 });
    expect(rows.find((row) => row.stepId === "audit-source-coverage")?.status).toBe("failed");
    expect(rows.find((row) => row.stepId === "draft-beginner-report-outline")).toMatchObject({ status: "pending", issueId: null });

    await db.update(issues).set({
      status: "done",
      startedAt: new Date("2026-07-06T00:25:20.000Z"),
      completedAt: new Date("2026-07-06T00:29:27.000Z"),
      cancelledAt: null,
    }).where(eq(issues.id, producerIssueId));
    await syncWorkflowRunForIssue(db, producerIssueId);
    const [auditIssueAfterProducerRework] = await db.select().from(issues).where(eq(issues.id, auditIssueId));
    expect(auditIssueAfterProducerRework.status).toBe("done");
    expect(heartbeatWakeup).toHaveBeenCalledWith(auditAgentId, expect.objectContaining({
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({
        issueId: auditIssueId,
        mutation: "workflow_resume",
        workflowRunId: runId,
        stepId: "audit-source-coverage",
        workflowStepRunId: expect.any(String),
      }),
      contextSnapshot: expect.objectContaining({
        issueId: auditIssueId,
        workflowRunId: runId,
        workflowStepId: "audit-source-coverage",
        workflowStepRunId: expect.any(String),
      }),
    }));
    rows = await stepRuns(runId);
    expect(rows.find((row) => row.stepId === "audit-source-coverage")?.status).toBe("failed");
    expect(rows.find((row) => row.stepId === "draft-beginner-report-outline")).toMatchObject({ status: "pending", issueId: null });

    heartbeatWakeup.mockClear();
    rows = await stepRuns(runId);
    const reopenedAuditStepRunId = rows.find((row) => row.stepId === "audit-source-coverage")?.id;
    if (!reopenedAuditStepRunId) throw new Error("missing reopened audit step run");
    await recordOfficialQaVerdict({
      issueId: auditIssueId,
      companyId,
      qaAgentId: auditAgentId,
      workflowRunId: runId,
      workflowStepRunId: reopenedAuditStepRunId,
      verdict: "pass",
      createdAt: "2026-07-06T00:40:00.000Z",
    });
    await db.update(issues).set({
      status: "done",
      startedAt: new Date("2026-07-06T00:39:00.000Z"),
      completedAt: new Date("2026-07-06T00:40:00.000Z"),
      cancelledAt: null,
    }).where(eq(issues.id, auditIssueId));
    await syncWorkflowRunForIssue(db, auditIssueId);

    rows = await stepRuns(runId);
    expect(rows.find((row) => row.stepId === "audit-source-coverage")?.status).toBe("completed");
    expect(rows.find((row) => row.stepId === "draft-beginner-report-outline")?.issueId).toBeTruthy();
    expect(heartbeatWakeup).toHaveBeenCalled();
  });
});
