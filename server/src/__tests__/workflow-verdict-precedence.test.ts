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
  console.warn(`Skipping workflow verdict precedence tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("workflow verdict precedence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-verdict-precedence-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    await db.delete(activityLog);
    await db.delete(workflowTransitionEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
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

  it("keeps official workflow API request_changes over a later heartbeat with no verdict", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-verdict-precedence" });
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const qaIssueId = randomUUID();
    const qaStepRunId = randomUUID();
    const qaHeartbeatRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Verdict Precedence",
      issuePrefix: `VP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer", role: "researcher", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "Validator", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: producerAgentId, title: "Verdict precedence mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "verdict-precedence",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          name: "Collect evidence",
          agentId: producerAgentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "audit-source-coverage", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }],
        },
        {
          id: "audit-source-coverage",
          name: "Audit source coverage",
          agentId: qaAgentId,
          dependencies: ["collect-ai-news-evidence"],
        },
      ],
    });
    await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-07-06T03:46:00.000Z") });
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "Collect evidence", status: "done", assigneeAgentId: producerAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-07-06T03:46:30.000Z"), completedAt: new Date("2026-07-06T03:49:24.000Z") },
      { id: qaIssueId, companyId, missionId, title: "Audit source coverage", status: "done", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-07-06T03:49:55.000Z"), completedAt: new Date("2026-07-06T03:50:34.000Z") },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "collect-ai-news-evidence", issueId: producerIssueId, status: "completed", startedAt: new Date("2026-07-06T03:46:30.000Z"), completedAt: new Date("2026-07-06T03:49:24.000Z") },
      { id: qaStepRunId, workflowRunId: runId, stepId: "audit-source-coverage", issueId: qaIssueId, status: "running", startedAt: new Date("2026-07-06T03:49:55.000Z") },
    ]);
    await db.insert(workflowTransitionEvents).values({
      companyId,
      missionId,
      workflowRunId: runId,
      workflowStepRunId: qaStepRunId,
      issueId: qaIssueId,
      heartbeatRunId: qaHeartbeatRunId,
      eventType: "workflow_validation_verdict",
      layer: "workflow_validation",
      verdict: "request_changes",
      decision: "request_changes",
      reason: "workflow_api",
      payload: { kind: "workflow_validation_verdict", workflowRunId: runId, stepRunId: qaStepRunId, issueId: qaIssueId, verdict: "request_changes" },
      createdAt: new Date("2026-07-06T03:50:28.000Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: qaHeartbeatRunId,
      companyId,
      agentId: qaAgentId,
      issueId: qaIssueId,
      status: "succeeded",
      resultJson: { note: "run succeeded after workflow API verdict side effect" },
      startedAt: new Date("2026-07-06T03:49:55.000Z"),
      finishedAt: new Date("2026-07-06T03:50:34.370Z"),
    });

    await syncWorkflowRunForIssue(db, qaIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(rows.find((row) => row.stepId === "collect-ai-news-evidence")).toMatchObject({ status: "pending", iterationIndex: 1 });
    expect(rows.find((row) => row.stepId === "audit-source-coverage")?.status).toBe("failed");
    expect(heartbeatWakeup).toHaveBeenCalled();
  });
});
