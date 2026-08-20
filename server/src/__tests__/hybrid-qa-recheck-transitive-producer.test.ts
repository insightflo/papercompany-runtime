import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping QA recheck transitive-producer tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Reproduces the gazua-evening 2026-08-20 stall topology: the reworked producer
 * sits TWO hops above the semantic QA (producer → intermediate QA → semantic QA),
 * so the QA's direct dependencies never advance past the REQUEST_CHANGES verdict.
 * The validation-recheck must include the transitive producer's completion time,
 * or the QA re-fire chain dead-ends and the run finalizes failed.
 */
describeEP("validation recheck — transitive producer freshness", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let missionId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-recheck-transitive-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "QA Agent", role: "qa",
      status: "idle", adapterType: "process", adapterConfig: {},
    });
    await db.insert(missions).values({
      id: missionId, companyId, ownerAgentId: agentId,
      title: "Test Mission", status: "active",
    });
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
  });
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTwoHopTopology(input: { producerCompletedAt: Date }) {
    const wfId = randomUUID();
    const runId = randomUUID();
    const producerStepId = `produce-${randomUUID().slice(0, 8)}`;
    const midQaStepId = `mid-qa-${randomUUID().slice(0, 8)}`;
    const semanticQaStepId = `final-qa-${randomUUID().slice(0, 8)}`;

    // NOTE: semantic QA does NOT depend on the producer directly (the drift shape).
    const steps = [
      {
        id: producerStepId,
        name: "Produce report",
        agentId,
        dependencies: [],
        graphWorkProductRequired: true,
      },
      {
        id: midQaStepId,
        name: "[QA] Contract review",
        agentId,
        dependencies: [producerStepId],
        graphWorkProductRequired: false,
      },
      {
        id: semanticQaStepId,
        name: "[QA] Final inspection",
        agentId,
        dependencies: [midQaStepId],
        graphWorkProductRequired: false,
      },
    ];

    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: `recheck-wf-${wfId.slice(0, 8)}`,
      stepsJson: steps,
    });
    await db.insert(workflowRuns).values({
      id: runId, companyId, workflowId: wfId, missionId,
      status: "running", triggeredBy: "test",
    });

    const t0 = new Date(Date.now() - 3 * 60 * 60_000); // mid QA completed
    const tv = new Date(Date.now() - 2 * 60 * 60_000); // REQUEST_CHANGES verdict
    // producer rework completion — the caller decides whether it is fresh or stale

    const producerIssue = await db.insert(issues).values({
      companyId, missionId, title: "Produce report",
      status: "done", assigneeAgentId: agentId,
      originKind: "workflow_execution", originRunId: runId,
      startedAt: t0, completedAt: input.producerCompletedAt,
    }).returning();
    const midIssue = await db.insert(issues).values({
      companyId, missionId, title: "[QA] Contract review",
      status: "done", assigneeAgentId: agentId,
      originKind: "workflow_execution", originRunId: runId,
      startedAt: t0, completedAt: t0,
    }).returning();
    const qaIssue = await db.insert(issues).values({
      companyId, missionId, title: "[QA] Final inspection",
      status: "done", assigneeAgentId: agentId,
      originKind: "workflow_execution", originRunId: runId,
      startedAt: t0,
    }).returning();

    const stepRuns = await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId, stepId: producerStepId,
        status: "completed", issueId: producerIssue[0].id,
        iterationIndex: 1, completedAt: input.producerCompletedAt,
      },
      {
        workflowRunId: runId, stepId: midQaStepId,
        status: "completed", issueId: midIssue[0].id,
        iterationIndex: 0, completedAt: t0,
      },
      {
        // semantic QA: failed terminal step with a done issue (RC desired state)
        workflowRunId: runId, stepId: semanticQaStepId,
        status: "failed", issueId: qaIssue[0].id,
        iterationIndex: 0, completedAt: tv,
      },
    ]).returning();
    const semanticQaStepRunId = stepRuns.find((row) => row.stepId === semanticQaStepId)!.id;

    // The verdict authority contract requires the event to be bound to the exact
    // step run and a backing heartbeat scoped to this QA issue.
    const verdictHeartbeat = await db.insert(heartbeatRuns).values({
      companyId, missionId, issueId: qaIssue[0].id, agentId,
      invocationSource: "assignment", triggerDetail: "system",
      status: "succeeded", contextSnapshot: {},
      startedAt: new Date(tv.getTime() - 60_000), finishedAt: tv,
    }).returning();

    await db.insert(workflowTransitionEvents).values({
      companyId, missionId, workflowRunId: runId,
      issueId: qaIssue[0].id,
      workflowStepRunId: semanticQaStepRunId,
      heartbeatRunId: verdictHeartbeat[0].id,
      eventType: "workflow_validation_verdict",
      layer: "workflow_validation",
      reason: "workflow_api",
      verdict: "request_changes",
      createdAt: tv,
    });

    return { runId, semanticQaStepId, semanticQaStepRunId, qaIssueId: qaIssue[0].id };
  }

  it("re-fires the QA when the transitive producer re-completed after the verdict (2-hop topology)", async () => {
    // Producer rework completed AFTER the verdict → recheck must fire.
    const { runId, qaIssueId } = await seedTwoHopTopology({
      producerCompletedAt: new Date(Date.now() - 60 * 60_000),
    });

    await syncWorkflowRunState(db, runId, "workflow_sync");

    const recheckComments = await db.select().from(issueComments).where(eq(issueComments.issueId, qaIssueId));
    expect(recheckComments.some((comment) => comment.body.includes("### Workflow validation recheck"))).toBe(true);

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, qaIssueId));
    expect(wakes.length).toBeGreaterThanOrEqual(1);
    expect(wakes.some((wake) => wake.payload?.mutation === "workflow_resume")).toBe(true);
  });

  it("does not re-fire when the transitive producer completed before the verdict (stale)", async () => {
    // Producer completion predates the verdict → direct-dep max (mid QA) is also
    // stale → the recheck must stay skipped.
    const { runId, qaIssueId } = await seedTwoHopTopology({
      producerCompletedAt: new Date(Date.now() - 3 * 60 * 60_000 - 60_000),
    });

    await syncWorkflowRunState(db, runId, "workflow_sync");

    const recheckComments = await db.select().from(issueComments).where(eq(issueComments.issueId, qaIssueId));
    expect(recheckComments.some((comment) => comment.body.includes("### Workflow validation recheck"))).toBe(false);

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, qaIssueId));
    expect(wakes).toHaveLength(0);
  });

  it("does not re-fire again when the QA already re-checked after the producer completion", async () => {
    // Idempotency guard: a succeeded QA heartbeat after the newest producer
    // completion means this generation was already re-checked.
    const producerCompletedAt = new Date(Date.now() - 60 * 60_000);
    const { runId, qaIssueId } = await seedTwoHopTopology({ producerCompletedAt });

    await db.insert(heartbeatRuns).values({
      companyId, missionId, issueId: qaIssueId, agentId,
      invocationSource: "assignment", triggerDetail: "system",
      status: "succeeded", contextSnapshot: {},
      startedAt: producerCompletedAt,
      finishedAt: new Date(producerCompletedAt.getTime() + 60_000),
    });

    await syncWorkflowRunState(db, runId, "workflow_sync");

    const recheckComments = await db.select().from(issueComments).where(eq(issueComments.issueId, qaIssueId));
    expect(recheckComments.some((comment) => comment.body.includes("### Workflow validation recheck"))).toBe(false);
  });
});
