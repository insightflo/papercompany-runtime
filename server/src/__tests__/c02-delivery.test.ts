import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, heartbeatRuns, issueComments, issueWorkProducts, issues, missions,
  workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

const { heartbeatWakeup } = vi.hoisted(() => ({ heartbeatWakeup: vi.fn() }));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: () => ({ wakeup: heartbeatWakeup }) };
});
vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) =>
      actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup: heartbeatWakeup } }),
  };
});

import {
  cleanupFrozenTables, createFrozenRun, markRunStatus, seedCompanyWithMission,
  seedWorkflowDefinition, startExecutionDefinitionFixture, stepRunsOf,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";
import { syncWorkflowRunForIssue } from "../services/workflow/dag-engine.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

if (!support.supported) console.warn(`Skipping C02 extraction test: ${support.reason ?? "unsupported environment"}`);

describeEP("C02 stage 1: preserve validation recheck delivery boundary", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("c02-delivery-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = fixture.db;
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    await db.delete(heartbeatRuns);
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  // C02 stage-1 extraction map and workflow-dag-engine.test.ts recheck/current-workProduct/
  // succeeded-heartbeat cases define these preservation expectations; no queue/claim/QA proof is asserted.
  it("preserves fresh-session wake arguments, current artifact comments, activity and repeated sync behavior", async () => {
    const { companyId, agentId, missionId } = await seedCompanyWithMission(fixture.sql, "C02D");
    await db.update(missions).set({ status: "active" }).where(eq(missions.id, missionId));
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId,
      name: "c02-validation-recheck",
      stepsJson: [
        { id: "produce", name: "Produce artifact", agentId, dependencies: [] },
        { id: "qa", type: "qa", qaType: "semantic", name: "[QA] Validate artifact", agentId, dependencies: ["produce"] },
        { id: "approve", name: "Approve artifact", agentId, dependencies: ["qa"] },
      ],
    });
    const run = await createFrozenRun(db, { workflowId, companyId, missionId });
    await markRunStatus(db, run.id, "running");
    const startedAt = new Date("2026-06-18T07:01:00.000Z");
    const oldCompletedAt = new Date("2026-06-18T07:05:00.000Z");
    const rejectedAt = new Date("2026-06-18T07:10:00.000Z");
    const producerCompletedAt = new Date("2026-06-18T07:15:00.000Z");
    const producerIssueId = randomUUID();
    const qaIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: producerIssueId, companyId, missionId, title: "Produce artifact",
        status: "done", assigneeAgentId: agentId, originKind: "workflow_execution",
        originId: run.id, originRunId: run.id, startedAt, completedAt: oldCompletedAt,
      },
      {
        id: qaIssueId, companyId, missionId, title: "[QA] Validate artifact",
        status: "blocked", assigneeAgentId: agentId, originKind: "workflow_execution",
        originId: run.id, originRunId: run.id, startedAt,
        description: "Dependency workProducts: none registered",
      },
    ]);
    const stepRows = await db.insert(workflowStepRuns).values([
      { workflowRunId: run.id, stepId: "produce", issueId: producerIssueId, status: "completed", startedAt, completedAt: oldCompletedAt },
      { workflowRunId: run.id, stepId: "qa", issueId: qaIssueId, status: "failed", startedAt, completedAt: rejectedAt },
      { workflowRunId: run.id, stepId: "approve", status: "pending" },
    ]).returning();
    const qaStepRunId = stepRows.find((row) => row.stepId === "qa")!.id;
    const verdictHeartbeatId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: verdictHeartbeatId, companyId, agentId, issueId: qaIssueId,
      status: "succeeded", startedAt, finishedAt: rejectedAt,
    });
    const priorFindings = [{ id: "refresh-source", summary: "Verify the revised source", layer: "artifact" }];
    // Structured workflow_api authority bound to this exact company/issue/run/step and QA heartbeat.
    await db.insert(workflowTransitionEvents).values({
      companyId, missionId, workflowRunId: run.id, workflowStepRunId: qaStepRunId,
      issueId: qaIssueId, heartbeatRunId: verdictHeartbeatId,
      eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
      idempotencyKey: `c02-rejection:${qaStepRunId}`, createdAt: rejectedAt,
      payload: {
        kind: "workflow_validation_verdict", workflowRunId: run.id, stepRunId: qaStepRunId,
        issueId: qaIssueId, verdict: "request_changes", diagnostics: [], findings: priorFindings,
      },
    });
    heartbeatWakeup.mockResolvedValue({ id: "c02-boundary-only" });
    const recheckComments = async () => (await db.select().from(issueComments)
      .where(eq(issueComments.issueId, qaIssueId)))
      .filter((comment) => comment.body.includes("Workflow validation recheck"));
    const recheckActivities = async () => db.select().from(activityLog).where(and(
      eq(activityLog.entityId, qaIssueId),
      eq(activityLog.action, "workflow.validation_recheck_queued"),
    ));

    // Counterexample: completion predates the official rejection, so no fresh-input recheck.
    await syncWorkflowRunForIssue(db, producerIssueId);
    expect(heartbeatWakeup).not.toHaveBeenCalled();
    expect(await recheckComments()).toHaveLength(0);
    expect(await recheckActivities()).toHaveLength(0);

    const reportPath = "/srv/papercompany/produced_work/c02-current-report.md";
    await db.insert(issueWorkProducts).values({
      companyId, issueId: producerIssueId, type: "file", provider: "local",
      externalId: reportPath, title: "c02-current-report.md", status: "active",
      isPrimary: true, metadata: { path: reportPath },
    });
    await db.update(issues).set({ completedAt: producerCompletedAt }).where(eq(issues.id, producerIssueId));

    const result = await syncWorkflowRunForIssue(db, producerIssueId);
    expect(result?.status).toBe("running");
    expect(heartbeatWakeup).toHaveBeenCalledTimes(1);
    expect(heartbeatWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      source: "assignment", triggerDetail: "system", reason: "workflow_step_runnable",
      requestedByActorType: "system", requestedByActorId: `workflow:${workflowId}`,
      payload: expect.objectContaining({
        issueId: qaIssueId, mutation: "workflow_resume", missionId,
        workflowRunId: run.id, workflowDefinitionId: workflowId,
        stepId: "qa", workflowStepRunId: qaStepRunId, forceFreshSession: true,
        priorQaFindings: priorFindings,
      }),
      contextSnapshot: expect.objectContaining({
        issueId: qaIssueId, taskId: qaIssueId, source: "workflow.resume", missionId,
        workflowRunId: run.id, workflowDefinitionId: workflowId,
        workflowStepId: "qa", stepId: "qa", workflowStepRunId: qaStepRunId,
        wakeReason: "workflow_step_runnable", forceFreshSession: true,
      }),
    }));
    const [comment] = await recheckComments();
    expect(await recheckComments()).toHaveLength(1);
    expect(comment!.body).toContain("c02-current-report.md [file/active]");
    expect(comment!.body).toContain(reportPath);
    expect(comment!.body).toContain("[artifact] refresh-source: Verify the revised source");
    expect(comment!.body).not.toContain("has no registered dependency workProduct");
    const [activity] = await recheckActivities();
    expect(await recheckActivities()).toHaveLength(1);
    expect(activity).toMatchObject({
      companyId, actorType: "system", actorId: "workflow:validation-recheck",
      entityType: "issue", entityId: qaIssueId,
      details: {
        workflowRunId: run.id, workflowStepRunId: qaStepRunId, stepId: "qa",
        dependencyStepIds: ["produce"], reason: "dependency_completed_after_request_changes",
        requestChangesObservedAt: rejectedAt.toISOString(),
      },
    });
    const [qaIssue] = await db.select().from(issues).where(eq(issues.id, qaIssueId));
    expect(qaIssue).toMatchObject({ status: "blocked", description: "Dependency workProducts: none registered" });
    expect((await stepRunsOf(db, run.id)).find((row) => row.stepId === "qa")?.status).toBe("failed");

    // Preserve today's boundary: a returned wake result alone does not suppress the next sync.
    await syncWorkflowRunForIssue(db, producerIssueId);
    expect(heartbeatWakeup).toHaveBeenCalledTimes(2);
    expect(await recheckComments()).toHaveLength(2);
    expect(await recheckActivities()).toHaveLength(2);

    // Existing succeeded-heartbeat suppression is preserved; it is not proof of current-input QA.
    await db.insert(heartbeatRuns).values({
      companyId, agentId, issueId: qaIssueId, status: "succeeded",
      startedAt: producerCompletedAt, finishedAt: new Date("2026-06-18T07:16:00.000Z"),
    });
    await syncWorkflowRunForIssue(db, producerIssueId);
    expect(heartbeatWakeup).toHaveBeenCalledTimes(2);
    expect(await recheckComments()).toHaveLength(2);
    expect(await recheckActivities()).toHaveLength(2);
  });
});
