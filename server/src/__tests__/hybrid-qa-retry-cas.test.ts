import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  completeWorkflowToolStepFromResult,
  retryIssueLessToolWorkflowStep,
  setWorkflowToolStepExecutor,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry CAS tests: ${support.reason ?? "unsupported"}`);

describeEP("hybrid QA — retry CAS and current-request verdict", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-retry-cas-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RetryCo", status: "active" });
  }, 60_000);

  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });
  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await db.delete(workflowTransitionEvents);
    await db.delete(issueComments);
    await db.update(activityLog).set({ runId: null });
    await db.delete(activityLog);
    await db.delete(workflowStepRuns);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
  });

  it("manual retry CAS: old callback during crash-window is a no-op", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const prodId = `p-${randomUUID().slice(0, 8)}`;
    const gateId = `g-${randomUUID().slice(0, 8)}`;
    const oldReq = `old-${randomUUID()}`;
    await db.insert(workflowDefinitions).values({
      id: wfId,
      companyId,
      name: "Retry WF",
      stepsJson: [
        { id: prodId, name: "Producer", agentId: "a", dependencies: [], graphWorkProductRequired: true },
        { id: gateId, name: "Gate", agentId: "", type: "tool", qaType: "structural", toolNames: ["v"], dependencies: [prodId], graphWorkProductRequired: false },
      ],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: prodId,
      status: "completed",
      issueId: null,
      iterationIndex: 0,
      completedAt: new Date(Date.now() - 1000),
    });
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: gateId,
      status: "failed",
      issueId: null,
      lastDispatchRequestId: oldReq,
      completedAt: new Date(),
      metadata: { structuralGateProducerToken: { producerStepId: prodId, iterationIndex: 0, completedAt: new Date(Date.now() - 1000).toISOString() } },
    }).returning();

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    const retryResult = await retryIssueLessToolWorkflowStep(db, { companyId, runId, stepId: gateId });
    expect(retryResult).not.toBeNull();

    const [afterRetry] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun[0]!.id));
    expect(afterRetry.status).toBe("running");
    expect(afterRetry.completedAt).toBeNull();
    expect(afterRetry.lastDispatchErrorSummary).toBeNull();
    expect(typeof afterRetry.lastDispatchRequestId).toBe("string");
    expect(afterRetry.lastDispatchRequestId).not.toBeNull();
    expect(afterRetry.lastDispatchRequestId).not.toBe(oldReq);

    const oldCallbackResult = await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: gateRun[0]!.id,
      success: true,
      requestId: oldReq,
      workflowRunId: runId,
      data: { verdict: "pass" },
    });
    expect(oldCallbackResult).toBeNull();

    const [afterOldCb] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun[0]!.id));
    expect(afterOldCb.status).toBe("running");
    expect(afterOldCb.lastDispatchRequestId).toBe(afterRetry.lastDispatchRequestId);
  });

  it("req-A request_changes plus req-B current/no verdict → no producer reset or cap", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const prodId = `p-${randomUUID().slice(0, 8)}`;
    const gateId = `g-${randomUUID().slice(0, 8)}`;
    const reqA = `reqA-${randomUUID()}`;
    const reqB = `reqB-${randomUUID()}`;
    await db.insert(workflowDefinitions).values({
      id: wfId,
      companyId,
      name: "ReqVerdict WF",
      stepsJson: [
        { id: prodId, name: "P", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
        { id: gateId, name: "G", agentId: "", type: "tool", qaType: "structural", toolNames: ["v"], dependencies: [prodId], graphWorkProductRequired: false },
      ],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: prodId, status: "completed", issueId: null, iterationIndex: 0, completedAt: new Date() });
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: gateId,
      status: "failed",
      issueId: null,
      lastDispatchRequestId: reqB,
      metadata: { structuralGateProducerGeneration: 0 },
    }).returning();
    await db.insert(workflowTransitionEvents).values({
      companyId,
      workflowRunId: runId,
      workflowStepRunId: gateRun[0]!.id,
      issueId: null,
      eventType: "workflow_validation_verdict",
      layer: "workflow_validation",
      verdict: "request_changes",
      decision: "request_changes",
      reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0]!.id}:${reqA}`,
      payload: { kind: "structural_gate_verdict", verdict: "request_changes", requestId: reqA },
      createdAt: new Date(),
    });

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);

    const [prod] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.stepId, prodId));
    expect(prod.status).toBe("completed");
    expect(prod.iterationIndex).toBe(0);
  });

  it("semantic QA request_changes suppresses generic retry without conditional edges", async () => {
    const agentId = randomUUID();
    const wfId = randomUUID();
    const runId = randomUUID();
    const qaId = `qa-${randomUUID().slice(0, 8)}`;
    await db.insert(agents).values({ id: agentId, companyId, name: `QA-${qaId}`, role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Semantic QA retry guard", stepsJson: [{ id: qaId, name: "[QA] Semantic", agentId, qaType: "semantic", onFailure: "retry", maxRetries: 2 }] });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });

    await syncWorkflowRunState(db, runId);
    const [qaRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    if (!qaRun.issueId) throw new Error("Expected issue-backed QA step run");
    await db.update(issues).set({ status: "done", completedAt: new Date("2026-07-22T12:00:00.000Z"), updatedAt: new Date("2026-07-22T12:00:00.000Z") }).where(eq(issues.id, qaRun.issueId));
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      issueId: qaRun.issueId,
      status: "succeeded",
      startedAt: new Date("2026-07-22T12:00:00.000Z"),
      finishedAt: new Date("2026-07-22T12:00:01.000Z"),
    });
    await db.insert(workflowTransitionEvents).values({
      companyId,
      workflowRunId: runId,
      workflowStepRunId: qaRun.id,
      issueId: qaRun.issueId,
      heartbeatRunId,
      eventType: "workflow_validation_verdict",
      layer: "workflow_validation",
      verdict: "request_changes",
      decision: "request_changes",
      reason: "workflow_api",
      reasonCode: "workflow_api",
      idempotencyKey: `semantic-verdict:${qaRun.id}`,
      payload: { kind: "workflow_validation_verdict", workflowRunId: runId, stepRunId: qaRun.id, issueId: qaRun.issueId, verdict: "request_changes" },
    });

    await syncWorkflowRunState(db, runId);
    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, qaRun.id));
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(0);
    const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, qaRun.id));
    expect(events.filter((event) => event.eventType === "workflow_step_retry_scheduled")).toHaveLength(0);
  });

  it("structural request_changes suppresses generic retry for issue-less gates", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const gateId = `gate-${randomUUID().slice(0, 8)}`;
    const requestId = `req-${randomUUID()}`;
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "Structural QA retry guard", stepsJson: [{ id: gateId, name: "Gate", agentId: "", type: "tool", qaType: "structural", toolNames: ["v"], onFailure: "retry", maxRetries: 2 }] });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    const [gateRun] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: gateId, status: "running", lastDispatchRequestId: requestId, startedAt: new Date("2026-07-22T13:00:00.000Z") }).returning();

    await completeWorkflowToolStepFromResult(db, { companyId, stepRunId: gateRun.id, success: true, requestId, data: { verdict: "request_changes" } });
    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun.id));
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(0);
    const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, gateRun.id));
    expect(events.filter((event) => event.eventType === "workflow_step_retry_scheduled")).toHaveLength(0);
  });

  it("structural contract failure suppresses generic retry for issue-less gates", async () => {
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = `gate-${randomUUID().slice(0, 8)}`;
    const requestId = `req-${randomUUID()}`;
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Structural contract retry guard", stepsJson: [{ id: stepId, type: "tool", qaType: "structural", toolNames: ["validate"], onFailure: "retry", maxRetries: 2 }] });
    await db.insert(workflowRuns).values({ id: workflowRunId, companyId, workflowId, status: "running", triggeredBy: "test" });
    const [stepRun] = await db.insert(workflowStepRuns).values({ workflowRunId, stepId, status: "running", lastDispatchRequestId: requestId, startedAt: new Date("2026-07-22T14:00:00.000Z") }).returning();

    await completeWorkflowToolStepFromResult(db, { companyId, stepRunId: stepRun.id, success: true, requestId, data: { malformed: true } });
    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(0);
    expect(after.lastDispatchErrorSummary).toBe("structural_gate_contract_failure");
    const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, stepRun.id));
    expect(events.filter((event) => event.eventType === "workflow_step_retry_scheduled")).toHaveLength(0);
  });
});
