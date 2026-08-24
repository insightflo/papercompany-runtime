import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  heartbeatRunEvents,
  heartbeatRunFinalizations,
  heartbeatRunFinalizationSteps,
  missionAgentRuntimes,
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
    `Skipping QA recheck prior-findings tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Recheck priority contract: when a producer re-completes after a REQUEST_CHANGES
 * that carried structured findings, the re-check wake and re-check comment must
 * carry those findings so the QA verifies the previous fixes FIRST (then the full
 * checklist). Legacy verdicts without findings keep the previous behavior.
 */
describeEP("validation recheck — prior findings injection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let missionId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-recheck-prior-");
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
    await db.delete(missionAgentRuntimes);
    await db.delete(heartbeatRunFinalizationSteps);
    await db.delete(heartbeatRunFinalizations);
    await db.delete(heartbeatRunEvents);
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

  async function seed(input: { findings?: Array<{ id: string; summary: string; layer: string }> }) {
    const wfId = randomUUID();
    const runId = randomUUID();
    const producerStepId = `produce-${randomUUID().slice(0, 8)}`;
    const qaStepId = `qa-${randomUUID().slice(0, 8)}`;

    const steps = [
      { id: producerStepId, name: "Produce report", agentId, dependencies: [], graphWorkProductRequired: true },
      { id: qaStepId, name: "[QA] Inspection", agentId, dependencies: [producerStepId], graphWorkProductRequired: false },
    ];
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: `wf-${wfId.slice(0, 8)}`, stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, missionId, status: "running", triggeredBy: "test" });

    const t0 = new Date(Date.now() - 3 * 60 * 60_000);
    const tv = new Date(Date.now() - 2 * 60 * 60_000);
    const producerCompletedAt = new Date(Date.now() - 60 * 60_000); // after verdict → recheck fires

    const producerIssue = await db.insert(issues).values({
      companyId, missionId, title: "Produce report", status: "done", assigneeAgentId: agentId,
      originKind: "workflow_execution", originRunId: runId, startedAt: t0, completedAt: producerCompletedAt,
    }).returning();
    const qaIssue = await db.insert(issues).values({
      companyId, missionId, title: "[QA] Inspection", status: "done", assigneeAgentId: agentId,
      originKind: "workflow_execution", originRunId: runId, startedAt: t0,
    }).returning();

    const stepRuns = await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: producerStepId, status: "completed", issueId: producerIssue[0].id, iterationIndex: 1, completedAt: producerCompletedAt },
      { workflowRunId: runId, stepId: qaStepId, status: "failed", issueId: qaIssue[0].id, iterationIndex: 0, completedAt: tv },
    ]).returning();
    const qaStepRunId = stepRuns.find((row) => row.stepId === qaStepId)!.id;

    const verdictHeartbeat = await db.insert(heartbeatRuns).values({
      companyId, missionId, issueId: qaIssue[0].id, agentId,
      invocationSource: "assignment", triggerDetail: "system", status: "succeeded", contextSnapshot: {},
      startedAt: new Date(tv.getTime() - 60_000), finishedAt: tv,
    }).returning();

    await db.insert(workflowTransitionEvents).values({
      companyId, missionId, workflowRunId: runId, issueId: qaIssue[0].id,
      workflowStepRunId: qaStepRunId, heartbeatRunId: verdictHeartbeat[0].id,
      eventType: "workflow_validation_verdict", layer: "workflow_validation", reason: "workflow_api",
      verdict: "request_changes", createdAt: tv,
      ...(input.findings ? { payload: { findings: input.findings } } : {}),
    });

    return { runId, qaIssueId: qaIssue[0].id };
  }

  it("injects structured prior findings into the recheck wake and comment", async () => {
    const { runId, qaIssueId } = await seed({
      findings: [
        { id: "kr-data-missing", summary: "observations.kr_index absent in source data", layer: "source_data" },
        { id: "mobile-overflow", summary: "Narrative s05 table overflows 328px", layer: "artifact" },
      ],
    });

    await syncWorkflowRunState(db, runId, "workflow_sync");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, qaIssueId));
    const resumeWake = wakes.find((wake) => wake.requestKind === "workflow_resume"
      || (wake.payload as Record<string, unknown> | null)?.mutation === "workflow_resume");
    expect(resumeWake).toBeDefined();
    const wakePayload = resumeWake!.payload as Record<string, unknown>;
    const injected = wakePayload.priorQaFindings as Array<{ id: string; layer: string }> | undefined;
    expect(injected).toBeDefined();
    expect(injected!.map((finding) => finding.id).sort()).toEqual(["kr-data-missing", "mobile-overflow"]);
    expect(injected!.find((finding) => finding.id === "kr-data-missing")?.layer).toBe("source_data");

    const contextSnapshot = (resumeWake!.contextSnapshot ?? {}) as Record<string, unknown>;
    const snapshotFindings = contextSnapshot.priorQaFindings as unknown;
    expect(snapshotFindings === undefined || Array.isArray(snapshotFindings)).toBe(true);
    if (Array.isArray(snapshotFindings)) {
      expect((snapshotFindings as Array<{ id: string }>).map((finding) => finding.id).sort()).toEqual(["kr-data-missing", "mobile-overflow"]);
    }

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, qaIssueId));
    const recheckComment = comments.find((comment) => comment.body.includes("### Workflow validation recheck"));
    expect(recheckComment).toBeDefined();
    expect(recheckComment!.body).toContain("Verify these previous REQUEST_CHANGES findings FIRST");
    expect(recheckComment!.body).toContain("[source_data] kr-data-missing");
    expect(recheckComment!.body).toContain("[artifact] mobile-overflow");
  });

  it("omits prior-findings injection for legacy verdicts without findings", async () => {
    const { runId, qaIssueId } = await seed({ findings: undefined });

    await syncWorkflowRunState(db, runId, "workflow_sync");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, qaIssueId));
    const resumeWake = wakes.find((wake) => wake.requestKind === "workflow_resume"
      || (wake.payload as Record<string, unknown> | null)?.mutation === "workflow_resume");
    expect(resumeWake).toBeDefined();
    expect((resumeWake!.payload as Record<string, unknown>).priorQaFindings).toBeUndefined();
    expect(((resumeWake!.contextSnapshot ?? {}) as Record<string, unknown>).priorQaFindings).toBeUndefined();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, qaIssueId));
    const recheckComment = comments.find((comment) => comment.body.includes("### Workflow validation recheck"));
    expect(recheckComment).toBeDefined();
    expect(recheckComment!.body).not.toContain("findings FIRST");
  });
});
