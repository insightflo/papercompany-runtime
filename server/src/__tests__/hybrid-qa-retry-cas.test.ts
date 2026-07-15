import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies, createDb, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  completeWorkflowToolStepFromResult,
  retryIssueLessToolWorkflowStep,
  syncWorkflowRunState,
  setWorkflowToolStepExecutor,
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

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  it("manual retry CAS: old callback during crash-window is a no-op", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const prodId = `p-${randomUUID().slice(0, 8)}`;
    const gateId = `g-${randomUUID().slice(0, 8)}`;
    const oldReq = `old-${randomUUID()}`;
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "Retry WF",
      stepsJson: [
        { id: prodId, name: "Producer", agentId: "a", dependencies: [], graphWorkProductRequired: true },
        { id: gateId, name: "Gate", agentId: "", type: "tool", qaType: "structural",
          toolNames: ["v"], dependencies: [prodId], graphWorkProductRequired: false },
      ],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    // Completed producer dependency so the gate can legally redispatch (it must
    // capture the exact current-generation producer token at dispatch).
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: prodId, status: "completed",
      issueId: null, iterationIndex: 0, completedAt: new Date(Date.now() - 1000),
    });
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateId, status: "failed",
      issueId: null, lastDispatchRequestId: oldReq, completedAt: new Date(),
      metadata: {
        structuralGateProducerToken: {
          producerStepId: prodId, iterationIndex: 0, completedAt: new Date(Date.now() - 1000).toISOString(),
        },
      },
    }).returning();

    // Set mock executor BEFORE retry so sync inside retry can dispatch
    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    // Retry: should clear lastDispatchRequestId, reset to pending
    const retryResult = await retryIssueLessToolWorkflowStep(db, { companyId, runId, stepId: gateId });
    expect(retryResult).not.toBeNull();

    // After retry+sync, the step was re-dispatched with a NEW requestId.
    // The old callback with the OLD requestId must be rejected by the CAS guard.
    const [afterRetry] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun[0].id));
    expect(afterRetry.status).not.toBe("failed"); // should be running or pending
    expect(afterRetry.completedAt).toBeNull();
    expect(afterRetry.lastDispatchErrorSummary).toBeNull();

    // Old callback arrives with the OLD requestId — must be rejected
    // (lastDispatchRequestId is now null, so the strict guard rejects non-null input)
    const oldCallbackResult = await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRun[0].id, success: true,
      requestId: oldReq, workflowRunId: runId,
      data: { verdict: "pass" },
    });
    expect(oldCallbackResult).toBeNull();

    // Step must NOT be completed by the old callback
    const [afterOldCb] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun[0].id));
    expect(afterOldCb.status).not.toBe("completed");
  });

  it("req-A request_changes plus req-B current/no verdict → no producer reset or cap", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const prodId = `p-${randomUUID().slice(0, 8)}`;
    const gateId = `g-${randomUUID().slice(0, 8)}`;
    const reqA = `reqA-${randomUUID()}`;
    const reqB = `reqB-${randomUUID()}`;
    const steps = [
      { id: prodId, name: "P", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
      { id: gateId, name: "G", agentId: "", type: "tool", qaType: "structural",
        toolNames: ["v"], dependencies: [prodId], graphWorkProductRequired: false },
    ];
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "ReqVerdict WF", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: prodId, status: "completed",
      issueId: null, iterationIndex: 0, completedAt: new Date(),
    });
    // Gate is now failed, currently carrying requestId B
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateId, status: "failed",
      issueId: null, lastDispatchRequestId: reqB,
      metadata: { structuralGateProducerGeneration: 0 },
    }).returning();
    // But the ONLY verdict in the ledger is from request A (request_changes)
    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRun[0].id,
      issueId: null, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0].id}:${reqA}`,
      payload: { kind: "structural_gate_verdict", verdict: "request_changes", requestId: reqA },
      createdAt: new Date(),
    });

    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);
    setWorkflowToolStepExecutor(null);

    // Producer must NOT be reset — the gate carries reqB but has no reqB verdict
    const [prod] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.stepId, prodId));
    expect(prod.status).toBe("completed");
    expect(prod.iterationIndex).toBe(0); // no cap consumed
  });
});
