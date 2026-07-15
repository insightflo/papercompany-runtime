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
import { applyStructuralGatePass } from "../services/workflow/control-flow/structural-gate-rework.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip rework CAS tests: ${support.reason ?? "unsupported"}`);

describeEP("hybrid QA — rework-pass CAS losing-race", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-rework-cas-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "ReworkCAS", status: "active" });
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  it("gate CAS: same completed status+iteration, different requestId → no reset", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const prodId = `p-${randomUUID().slice(0, 8)}`;
    const gateId = `g-${randomUUID().slice(0, 8)}`;
    const oldReq = `req-old-${randomUUID()}`;
    const steps = [
      { id: prodId, name: "P", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
      { id: gateId, name: "G", agentId: "", type: "tool", qaType: "structural",
        toolNames: ["v"], dependencies: [prodId], graphWorkProductRequired: false },
    ];

    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "WF", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: prodId, status: "completed",
      issueId: null, iterationIndex: 1, completedAt: new Date(Date.now() - 60_000),
    });
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateId, status: "completed",
      issueId: null, iterationIndex: 0, completedAt: new Date(Date.now() - 120_000),
      lastDispatchRequestId: oldReq,
      metadata: { structuralGateProducerGeneration: 0 },
    }).returning();
    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRun[0].id,
      issueId: null, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "pass", decision: "pass", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0].id}:${oldReq}`,
      payload: { kind: "structural_gate_verdict", verdict: "pass" },
      createdAt: new Date(Date.now() - 120_000),
    });

    // Capture STALE in-memory snapshot (has oldReq)
    const staleRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));

    // Mutate live DB: change requestId but keep status=completed, iteration=0
    const newReq = `req-new-${randomUUID()}`;
    await db.update(workflowStepRuns).set({ lastDispatchRequestId: newReq })
      .where(eq(workflowStepRuns.id, gateRun[0].id));

    // Call pass directly with STALE snapshot
    const result = await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: staleRuns as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    // CAS should fail: live row has newReq, snapshot had oldReq
    const [live] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRun[0].id));
    expect(live.status).toBe("completed"); // NOT reset
    expect(live.lastDispatchRequestId).toBe(newReq); // preserved
  });

  it("producer CAS: same completed status+iteration, different requestId → no reset", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const prodId = `p2-${randomUUID().slice(0, 8)}`;
    const gateId = `g2-${randomUUID().slice(0, 8)}`;
    const oldReq = `p-req-old-${randomUUID()}`;
    const steps = [
      { id: prodId, name: "P", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
      { id: gateId, name: "G", agentId: "", type: "tool", qaType: "structural",
        toolNames: ["v"], dependencies: [prodId], graphWorkProductRequired: false },
    ];

    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "WF2", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    const prodRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: prodId, status: "completed",
      issueId: null, iterationIndex: 0, completedAt: new Date(),
      lastDispatchRequestId: oldReq,
    }).returning();
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateId, status: "failed",
      issueId: null, iterationIndex: 0,
      metadata: { structuralGateProducerGeneration: 0 },
      lastDispatchRequestId: `g-${randomUUID()}`,
    }).returning();
    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRun[0].id,
      issueId: null, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0].id}:${oldReq}`,
      payload: { kind: "structural_gate_verdict", verdict: "request_changes" },
      createdAt: new Date(),
    });

    // Capture stale snapshot
    const staleRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));

    // Mutate producer requestId in live DB (same status+iteration)
    const newReq = `p-req-new-${randomUUID()}`;
    await db.update(workflowStepRuns).set({ lastDispatchRequestId: newReq })
      .where(eq(workflowStepRuns.id, prodRun[0].id));

    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: staleRuns as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    // Producer CAS should fail — newer completion with different requestId survives
    const [live] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, prodRun[0].id));
    expect(live.status).toBe("completed");
    expect(live.lastDispatchRequestId).toBe(newReq);
    expect(live.iterationIndex).toBe(0); // NOT incremented
  });

  it("generation math: 0→1 producer reset records gate generation=1, not 0", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const prodId = `p3-${randomUUID().slice(0, 8)}`;
    const gateId = `g3-${randomUUID().slice(0, 8)}`;
    const prodReq = `p3-req-${randomUUID()}`;
    const steps = [
      { id: prodId, name: "P", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
      { id: gateId, name: "G", agentId: "", type: "tool", qaType: "structural",
        toolNames: ["v"], dependencies: [prodId], graphWorkProductRequired: false },
    ];

    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "WF3", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: prodId, status: "completed",
      issueId: null, iterationIndex: 0, completedAt: new Date(),
      lastDispatchRequestId: prodReq,
    });
    const gateReqId = `g3-${randomUUID()}`;
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateId, status: "failed",
      issueId: null, iterationIndex: 0,
      metadata: { structuralGateProducerGeneration: 0 },
      lastDispatchRequestId: gateReqId,
    }).returning();
    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRun[0].id,
      issueId: null, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0].id}:${gateReqId}`,
      createdAt: new Date(),
    });
    const freshRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const result = await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: freshRuns as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    // Producer should be reset (iteration 0→1)
    const [liveProd] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.stepId, prodId));
    expect(liveProd.status).toBe("pending");
    expect(liveProd.iterationIndex).toBe(1);

    // Gate should be reset with generation=1 (not stale 0)
    const [liveGate] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.stepId, gateId));
    expect(liveGate.status).toBe("pending");
    const meta = liveGate.metadata as Record<string, unknown>;
    expect(meta?.structuralGateProducerGeneration).toBe(1);
  });

  it("producer CAS: same requestId, different completedAt → stale reset loses", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const prodId = `p4-${randomUUID().slice(0, 8)}`;
    const gateId = `g4-${randomUUID().slice(0, 8)}`;
    const sameReq = `same-req-${randomUUID()}`;
    const oldCompletedAt = new Date(Date.now() - 30_000);
    const steps = [
      { id: prodId, name: "P", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
      { id: gateId, name: "G", agentId: "", type: "tool", qaType: "structural",
        toolNames: ["v"], dependencies: [prodId], graphWorkProductRequired: false },
    ];

    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "WF4", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    const prodRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: prodId, status: "completed",
      issueId: null, iterationIndex: 0, completedAt: oldCompletedAt,
      lastDispatchRequestId: sameReq,
    }).returning();
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateId, status: "failed",
      issueId: null, iterationIndex: 0,
      metadata: { structuralGateProducerGeneration: 0 },
      lastDispatchRequestId: `g4-${randomUUID()}`,
    }).returning();
    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRun[0].id,
      issueId: null, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0].id}:g4`,
      payload: { kind: "structural_gate_verdict", verdict: "request_changes" },
      createdAt: new Date(),
    });

    // Capture STALE snapshot (has oldCompletedAt, sameReq)
    const staleRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));

    // Mutate live DB: keep SAME requestId but change completedAt (newer completion)
    const newCompletedAt = new Date();
    await db.update(workflowStepRuns).set({ completedAt: newCompletedAt })
      .where(eq(workflowStepRuns.id, prodRun[0].id));

    // Call pass with STALE snapshot
    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: staleRuns as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    // Producer CAS should fail — same requestId but completedAt changed
    const [live] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, prodRun[0].id));
    expect(live.status).toBe("completed");
    expect(live.iterationIndex).toBe(0); // NOT incremented
    expect(live.completedAt?.getTime()).toBe(newCompletedAt.getTime());
  });
});
