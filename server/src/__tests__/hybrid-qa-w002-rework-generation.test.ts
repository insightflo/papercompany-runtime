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
if (!support.supported) console.warn(`Skip W002 rework tests: ${support.reason ?? "unsupported"}`);

// W002 regression — Task #2 (exact producerToken) and Task #3 (downstream
// semantic QA invalidation on producer rework). DB-backed, mirroring the
// rework-cas test harness. No new gates/features; ordinary workflows untouched.

describeEP("hybrid QA — W002 rework exact producerToken + downstream semantic reset", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-w002-rework-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "W002Rework", status: "active" });
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  // Seed a P->G->QA chain and return ids. ids use short suffixes for stability.
  async function seedChain(opts: {
    producerReq: string;
    producerCompletedAt: Date;
    gateReqId: string;
    gateIteration?: number;
    gateStatus?: "failed" | "completed";
    qa1Status?: "completed" | "pending";
    qa2Status?: "completed" | "pending";
    qa2DependsOnlyGate?: boolean; // when true QA2 depends only on the gate (single-side)
  }) {
    const wfId = randomUUID();
    const runId = randomUUID();
    const prodId = `p-${randomUUID().slice(0, 8)}`;
    const gateId = `g-${randomUUID().slice(0, 8)}`;
    const qa1Id = `qa1-${randomUUID().slice(0, 8)}`;
    const qa2Id = `qa2-${randomUUID().slice(0, 8)}`;
    const qa2Deps = opts.qa2DependsOnlyGate ? [gateId] : [prodId, gateId];
    const steps = [
      { id: prodId, name: "P", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
      { id: gateId, name: "G", agentId: "", type: "tool", qaType: "structural",
        toolNames: ["v"], dependencies: [prodId], graphWorkProductRequired: false },
      { id: qa1Id, name: "[QA] Semantic 1", agentId: "qa", qaType: "semantic",
        dependencies: [prodId, gateId], graphWorkProductRequired: false },
      { id: qa2Id, name: "[QA] Semantic 2", agentId: "qa", qaType: "semantic",
        dependencies: qa2Deps, graphWorkProductRequired: false },
    ];
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "WF", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: prodId, status: "completed", issueId: null,
        iterationIndex: 0, completedAt: opts.producerCompletedAt, lastDispatchRequestId: opts.producerReq },
      { workflowRunId: runId, stepId: gateId, status: opts.gateStatus ?? "failed", issueId: null,
        iterationIndex: opts.gateIteration ?? 0, lastDispatchRequestId: opts.gateReqId,
        metadata: { structuralGateProducerGeneration: 0,
          structuralGateProducerToken: {
            producerStepId: prodId, iterationIndex: 0,
            completedAt: opts.producerCompletedAt.toISOString(),
          } } },
      { workflowRunId: runId, stepId: qa1Id, status: opts.qa1Status ?? "completed", issueId: null,
        iterationIndex: 0, completedAt: new Date(),
        lastDispatchRequestId: `qa1-${randomUUID()}`,
        metadata: { structuralGateVerdict: { verdict: "pass" }, semanticQaVerdict: { verdict: "pass" } } },
      { workflowRunId: runId, stepId: qa2Id, status: opts.qa2Status ?? "completed", issueId: null,
        iterationIndex: 0, completedAt: new Date(),
        lastDispatchRequestId: `qa2-${randomUUID()}`,
        metadata: { structuralGateVerdict: { verdict: "pass" }, semanticQaVerdict: { verdict: "pass" } } },
    ]);
    return { wfId, runId, prodId, gateId, qa1Id, qa2Id, steps };
  }

  function seedVerdict(gateRunId: string, requestId: string, verdict: "pass" | "request_changes", producerToken: unknown) {
    return db.insert(workflowTransitionEvents).values({
      companyId, workflowStepRunId: gateRunId,
      issueId: null, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict, decision: verdict, reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRunId}:${requestId}`,
      payload: { kind: "structural_gate_verdict", verdict, producerToken },
      createdAt: new Date(),
    });
  }

  const stepRuns = async (runId: string) =>
    db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
  const byStep = async (runId: string, stepId: string) => {
    const all = await stepRuns(runId);
    return all.find((r) => r.stepId === stepId)!;
  };

  // ---- Task #2: producerToken exactness ----

  it("Task2: producerToken missing → no rework (null token is NOT current)", async () => {
    const prodReq = `p-${randomUUID()}`;
    const gateReq = `g-${randomUUID()}`;
    const { prodId, gateId, runId, steps } = await seedChain({
      producerReq: prodReq, producerCompletedAt: new Date(Date.now() - 1000),
      gateReqId: gateReq, gateStatus: "failed",
    });
    const gateRun = await byStep(runId, gateId);
    await seedVerdict(gateRun.id, gateReq, "request_changes", null /* no producerToken */);

    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: await stepRuns(runId) as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    const prod = await byStep(runId, prodId);
    expect(prod.status).toBe("completed"); // NOT reset
    expect(prod.iterationIndex).toBe(0);
  });

  it("Task2: producerToken same completedAt but different stepId → no rework", async () => {
    const prodReq = `p-${randomUUID()}`;
    const gateReq = `g-${randomUUID()}`;
    const completedAt = new Date(Date.now() - 1000);
    const { prodId, gateId, runId, steps } = await seedChain({
      producerReq: prodReq, producerCompletedAt: completedAt,
      gateReqId: gateReq, gateStatus: "failed",
    });
    const gateRun = await byStep(runId, gateId);
    // Token claims a DIFFERENT producer stepId (same completedAt). Must not rework.
    await seedVerdict(gateRun.id, gateReq, "request_changes", {
      producerStepId: "some-other-producer", iterationIndex: 0, completedAt: completedAt.toISOString(),
    });

    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: await stepRuns(runId) as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    const prod = await byStep(runId, prodId);
    expect(prod.status).toBe("completed"); // NOT reset
    expect(prod.iterationIndex).toBe(0);
  });

  it("Task2: producerToken same completedAt but different iterationIndex → no rework", async () => {
    const prodReq = `p-${randomUUID()}`;
    const gateReq = `g-${randomUUID()}`;
    const completedAt = new Date(Date.now() - 1000);
    const { prodId, gateId, runId, steps } = await seedChain({
      producerReq: prodReq, producerCompletedAt: completedAt,
      gateReqId: gateReq, gateStatus: "failed",
    });
    const gateRun = await byStep(runId, gateId);
    await seedVerdict(gateRun.id, gateReq, "request_changes", {
      producerStepId: prodId, iterationIndex: 5, completedAt: completedAt.toISOString(), // wrong iter
    });

    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: await stepRuns(runId) as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    const prod = await byStep(runId, prodId);
    expect(prod.status).toBe("completed");
    expect(prod.iterationIndex).toBe(0);
  });

  it("Task2: exact producerToken match → rework proceeds", async () => {
    const prodReq = `p-${randomUUID()}`;
    const gateReq = `g-${randomUUID()}`;
    const completedAt = new Date(Date.now() - 1000);
    const { prodId, gateId, runId, steps } = await seedChain({
      producerReq: prodReq, producerCompletedAt: completedAt,
      gateReqId: gateReq, gateStatus: "failed",
    });
    const gateRun = await byStep(runId, gateId);
    await seedVerdict(gateRun.id, gateReq, "request_changes", {
      producerStepId: prodId, iterationIndex: 0, completedAt: completedAt.toISOString(),
    });

    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: await stepRuns(runId) as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    const prod = await byStep(runId, prodId);
    expect(prod.status).toBe("pending"); // reset for rework
    expect(prod.iterationIndex).toBe(1);
  });

  // ---- Task #3: downstream semantic QA invalidation on producer rework ----

  it("Task3: P→G→QA1+QA2; QA1 request_changes → only QA on BOTH P and G reset, clean pending", async () => {
    const prodReq = `p-${randomUUID()}`;
    const gateReq = `g-${randomUUID()}`;
    const completedAt = new Date(Date.now() - 1000);
    const { prodId, gateId, qa1Id, qa2Id, runId, steps } = await seedChain({
      producerReq: prodReq, producerCompletedAt: completedAt,
      gateReqId: gateReq, gateStatus: "failed", qa1Status: "completed", qa2Status: "completed",
    });
    const gateRun = await byStep(runId, gateId);
    // Gate verdict is for QA1's request (so QA1 is the one requesting changes)
    await seedVerdict(gateRun.id, gateReq, "request_changes", {
      producerStepId: prodId, iterationIndex: 0, completedAt: completedAt.toISOString(),
    });

    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: await stepRuns(runId) as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    const qa1 = await byStep(runId, qa1Id);
    // QA1 depends on BOTH producer and gate → invalidated to clean pending
    expect(qa1.status).toBe("pending");
    expect(qa1.completedAt).toBeNull();
    expect(qa1.lastDispatchRequestId).toBeNull();
    const qa1Meta = qa1.metadata as Record<string, unknown>;
    expect(qa1Meta?.structuralGateVerdict).toBeUndefined();
    expect(qa1Meta?.semanticQaVerdict).toBeUndefined();

    const qa2 = await byStep(runId, qa2Id);
    // QA2 ALSO depends on BOTH producer and gate → must be reset too (old PASS
    // cannot satisfy the new generation).
    expect(qa2.status).toBe("pending");
    expect(qa2.lastDispatchRequestId).toBeNull();
  });

  it("Task3: QA2 depending on only the GATE (not producer) is PRESERVED on rework", async () => {
    const prodReq = `p-${randomUUID()}`;
    const gateReq = `g-${randomUUID()}`;
    const completedAt = new Date(Date.now() - 1000);
    // QA2 depends only on the gate → single-side dependent → ordinary, NOT reset.
    const { prodId, gateId, qa1Id, qa2Id, runId, steps } = await seedChain({
      producerReq: prodReq, producerCompletedAt: completedAt,
      gateReqId: gateReq, gateStatus: "failed", qa1Status: "completed",
      qa2Status: "completed", qa2DependsOnlyGate: true,
    });
    const gateRun = await byStep(runId, gateId);
    await seedVerdict(gateRun.id, gateReq, "request_changes", {
      producerStepId: prodId, iterationIndex: 0, completedAt: completedAt.toISOString(),
    });

    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: await stepRuns(runId) as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    const qa1 = await byStep(runId, qa1Id);
    expect(qa1.status).toBe("pending"); // depends on BOTH → reset
    const qa2 = await byStep(runId, qa2Id);
    expect(qa2.status).toBe("completed"); // depends on only GATE → preserved
    expect(qa2.lastDispatchRequestId).not.toBeNull();
  });

  it("Task3: ordinary downstream action depending on only the producer is PRESERVED", async () => {
    const wfId = randomUUID();
    const runId = randomUUID();
    const prodId = `p-${randomUUID().slice(0, 8)}`;
    const gateId = `g-${randomUUID().slice(0, 8)}`;
    const qaId = `qa-${randomUUID().slice(0, 8)}`;
    const actionId = `act-${randomUUID().slice(0, 8)}`; // ordinary action, depends only on producer
    const steps = [
      { id: prodId, name: "P", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
      { id: gateId, name: "G", agentId: "", type: "tool", qaType: "structural",
        toolNames: ["v"], dependencies: [prodId], graphWorkProductRequired: false },
      { id: qaId, name: "[QA] Semantic", agentId: "qa", qaType: "semantic",
        dependencies: [prodId, gateId], graphWorkProductRequired: false },
      { id: actionId, name: "Publish", agentId: "a2", dependencies: [prodId], graphWorkProductRequired: false },
    ];
    const prodReq = `p-${randomUUID()}`;
    const gateReq = `g-${randomUUID()}`;
    const completedAt = new Date(Date.now() - 1000);
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "WF", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: prodId, status: "completed", issueId: null,
        iterationIndex: 0, completedAt, lastDispatchRequestId: prodReq },
      { workflowRunId: runId, stepId: gateId, status: "failed", issueId: null,
        iterationIndex: 0, lastDispatchRequestId: gateReq,
        metadata: { structuralGateProducerGeneration: 0,
          structuralGateProducerToken: { producerStepId: prodId, iterationIndex: 0, completedAt: completedAt.toISOString() } } },
      { workflowRunId: runId, stepId: qaId, status: "completed", issueId: null,
        iterationIndex: 0, completedAt: new Date(), lastDispatchRequestId: `qa-${randomUUID()}`,
        metadata: { semanticQaVerdict: { verdict: "pass" } } },
      { workflowRunId: runId, stepId: actionId, status: "pending", issueId: null,
        iterationIndex: 0, lastDispatchRequestId: null },
    ]);
    const gateRun = await byStep(runId, gateId);
    await seedVerdict(gateRun.id, gateReq, "request_changes", {
      producerStepId: prodId, iterationIndex: 0, completedAt: completedAt.toISOString(),
    });

    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: await stepRuns(runId) as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    const qa = await byStep(runId, qaId);
    expect(qa.status).toBe("pending"); // depends on BOTH → reset
    const action = await byStep(runId, actionId);
    // Ordinary action depends only on producer (not the gate) → must NOT be reset.
    expect(action.status).toBe("pending"); // already pending, but crucially not completed/touched as a QA
    expect(action.lastDispatchRequestId).toBeNull();
    // Producer is reset (rework)
    const prod = await byStep(runId, prodId);
    expect(prod.status).toBe("pending");
  });

  it("Task3 end-to-end: after new P/G/QA1 pass, QA2 must be rerun (not stale PASS)", async () => {
    // Simulate the post-rework generation: producer re-completed (new request),
    // gate re-passed, QA1 re-passed; QA2 was reset by the rework and must be
    // rerun rather than serving its old completed PASS.
    const prodReq = `p-${randomUUID()}`;
    const gateReq = `g-${randomUUID()}`;
    const completedAt = new Date(Date.now() - 1000);
    const { prodId, gateId, qa1Id, qa2Id, runId, steps } = await seedChain({
      producerReq: prodReq, producerCompletedAt: completedAt,
      gateReqId: gateReq, gateStatus: "failed", qa1Status: "completed", qa2Status: "completed",
    });
    const gateRun = await byStep(runId, gateId);
    await seedVerdict(gateRun.id, gateReq, "request_changes", {
      producerStepId: prodId, iterationIndex: 0, completedAt: completedAt.toISOString(),
    });

    // First pass: rewind producer + reset downstream QA (QA1, QA2 → pending)
    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: await stepRuns(runId) as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });
    let qa2 = await byStep(runId, qa2Id);
    expect(qa2.status).toBe("pending"); // reset, awaiting rerun

    // New generation completes: producer iteration 1, gate passes, QA1 passes.
    const newProdReq = `p-new-${randomUUID()}`;
    await db.update(workflowStepRuns).set({
      status: "completed", iterationIndex: 1, completedAt: new Date(),
      lastDispatchRequestId: newProdReq,
    }).where(eq(workflowStepRuns.id, (await byStep(runId, prodId)).id));
    const newGateReq = `g-new-${randomUUID()}`;
    await db.update(workflowStepRuns).set({
      status: "completed", iterationIndex: 1, completedAt: new Date(),
      lastDispatchRequestId: newGateReq,
      metadata: { structuralGateProducerGeneration: 1,
        structuralGateProducerToken: { producerStepId: prodId, iterationIndex: 1, completedAt: new Date().toISOString() } },
    }).where(eq(workflowStepRuns.id, gateRun.id));
    await db.update(workflowStepRuns).set({
      status: "completed", iterationIndex: 1, completedAt: new Date(),
      lastDispatchRequestId: `qa1-new-${randomUUID()}`,
      metadata: { semanticQaVerdict: { verdict: "pass" } },
    }).where(eq(workflowStepRuns.stepId, qa1Id));

    // QA2 still pending/never rerun → it must NOT carry a completed PASS.
    qa2 = await byStep(runId, qa2Id);
    expect(qa2.status).toBe("pending");
    const qa2Meta = qa2.metadata as Record<string, unknown> | undefined;
    expect(qa2Meta?.semanticQaVerdict).toBeUndefined(); // old verdict cleared
  });

  it("Task3: a [QA] step with NO qaType (mission-level Verify) depends on BOTH P+G → reset", async () => {
    // Mirrors the real mission-level `[QA] Verify mission result` step, which has
    // no qaType but MUST be invalidated on producer rework via the shared
    // isQaLikeStep classifier (not qaType==="semantic" only).
    const wfId = randomUUID();
    const runId = randomUUID();
    const prodId = `p-${randomUUID().slice(0, 8)}`;
    const gateId = `g-${randomUUID().slice(0, 8)}`;
    const qaId = `qa-${randomUUID().slice(0, 8)}`;
    const steps = [
      { id: prodId, name: "P", agentId: "a1", dependencies: [], graphWorkProductRequired: true },
      { id: gateId, name: "G", agentId: "", type: "tool", qaType: "structural",
        toolNames: ["v"], dependencies: [prodId], graphWorkProductRequired: false },
      // NOTE: no qaType — classified QA-like by title "[QA] Verify mission result".
      { id: qaId, name: "[QA] Verify mission result", agentId: "qa",
        dependencies: [prodId, gateId], graphWorkProductRequired: false },
    ];
    const prodReq = `p-${randomUUID()}`;
    const gateReq = `g-${randomUUID()}`;
    const completedAt = new Date(Date.now() - 1000);
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "WF", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: prodId, status: "completed", issueId: null,
        iterationIndex: 0, completedAt, lastDispatchRequestId: prodReq },
      { workflowRunId: runId, stepId: gateId, status: "failed", issueId: null,
        iterationIndex: 0, lastDispatchRequestId: gateReq,
        metadata: { structuralGateProducerGeneration: 0,
          structuralGateProducerToken: { producerStepId: prodId, iterationIndex: 0, completedAt: completedAt.toISOString() } } },
      { workflowRunId: runId, stepId: qaId, status: "completed", issueId: null,
        iterationIndex: 0, completedAt: new Date(), lastDispatchRequestId: `qa-${randomUUID()}`,
        metadata: { semanticQaVerdict: { verdict: "pass" } } },
    ]);
    const gateRun = await byStep(runId, gateId);
    await seedVerdict(gateRun.id, gateReq, "request_changes", {
      producerStepId: prodId, iterationIndex: 0, completedAt: completedAt.toISOString(),
    });

    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running" },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: await stepRuns(runId) as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    // The qaType-less [QA] step must be reset to clean pending (old PASS cleared).
    const qa = await byStep(runId, qaId);
    expect(qa.status).toBe("pending");
    expect(qa.lastDispatchRequestId).toBeNull();
    const qaMeta = qa.metadata as Record<string, unknown> | undefined;
    expect(qaMeta?.semanticQaVerdict).toBeUndefined();
  });
});
