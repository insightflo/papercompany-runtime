import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, missions, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { atomicStructuralCompletion, planStructuralCompletion } from "../services/workflow/control-flow/structural-completion.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping structural CAS-loss tests: ${support.reason ?? "unsupported"}`);
}

// [ purpose ] The structural gate ledger verdict is recorded EXACTLY ONCE and
//   ONLY inside the atomic completion transaction. On a CAS loss the transaction
//   rolls back, so a fresh request that loses the race must leave NO ledger row
//   (no orphan verdict row without a matching step status update). The status
//   patch is derived purely (planStructuralCompletion) — there is no pre-tx write.
describeEP("hybrid QA — structural CAS loss leaves no orphan ledger row", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let missionId: string;
  let runId: string;
  let gateStepId: string;
  let gateRunId: string;
  const requestR1 = `req-r1-${randomUUID()}`;
  const producerToken = { producerStepId: "producer", iterationIndex: 0, completedAt: new Date().toISOString() };
  const gateStep = {
    id: "gate", name: "[QA] Structural gate", agentId: "",
    type: "tool", qaType: "structural", toolNames: ["validate-contract"],
    dependencies: ["producer"], graphWorkProductRequired: false,
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-casloss-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    missionId = randomUUID();
    runId = randomUUID();
    gateStepId = gateStep.id;
    const ownerAgentId = randomUUID();
    const wfId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "CAS Loss Co", status: "active" });
    await db.insert(agents).values({
      id: ownerAgentId, companyId, name: "Owner", role: "operator",
      status: "active", adapterType: "process", adapterConfig: {},
    });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "m", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "CAS Loss WF",
      stepsJson: [{ id: "producer", name: "Produce", agentId: "a", dependencies: [], graphWorkProductRequired: true }, gateStep],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, missionId, status: "running", triggeredBy: "test" });
    // Gate already COMPLETED under request R1, with an official verdict row.
    const [gr] = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateStepId, status: "completed", issueId: null,
      iterationIndex: 0, completedAt: new Date(), lastDispatchRequestId: requestR1,
    }).returning();
    gateRunId = gr.id;
    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRunId, issueId: null,
      eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "pass", decision: "pass", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRunId}:${requestR1}`,
      payload: { kind: "structural_gate_verdict", requestId: requestR1, verdict: "pass" },
    });
  }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function countGateVerdictRows(): Promise<number> {
    const rows = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, gateRunId));
    return rows.length;
  }

  it("planStructuralCompletion is pure (no ledger write) for the patch", async () => {
    const before = await countGateVerdictRows();
    // Calling the planner must NOT touch the DB.
    const plan = planStructuralCompletion({ step: gateStep, success: true, data: { verdict: "pass" } });
    expect(plan.verdict).toBe("pass");
    expect(plan.effectiveSuccess).toBe(true);
    expect(await countGateVerdictRows()).toBe(before);
  });

  it("CAS loss with a fresh request leaves no ledger row", async () => {
    const requestR2 = `req-r2-${randomUUID()}`;
    const before = await countGateVerdictRows(); // 1 (R1)
    expect(before).toBe(1);

    // Fresh request R2 observes STALE state (running/R2) that no longer matches
    // the committed row (completed/R1) → CAS loses. The in-tx R2 ledger insert
    // must roll back, leaving no orphan row for R2.
    const result = await atomicStructuralCompletion({
      db, step: gateStep, success: true, data: { verdict: "pass" },
      companyId, workflowRunId: runId, workflowStepRunId: gateRunId, missionId,
      requestId: requestR2,
      producerToken,
      observedStatus: "running",
      observedIterationIndex: 0,
      observedRequestId: requestR2,
      observedCompletedAt: null,
      patch: {
        startedAt: new Date(), completedAt: new Date(), metadata: {},
        fallbackFailureSummary: null,
      },
    });

    expect(result.casWon).toBe(false);
    expect(await countGateVerdictRows()).toBe(1); // still only R1 — no R2 orphan
  });

  it("CAS win records exactly one ledger row for the winning request", async () => {
    // New gate run that is still running, matching observed state → CAS wins.
    const [freshGate] = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: `gate-${randomUUID().slice(0, 6)}`, status: "running",
      issueId: null, iterationIndex: 0, lastDispatchRequestId: `req-win-${randomUUID()}`,
    }).returning();
    const winRequest = freshGate.lastDispatchRequestId!;

    const result = await atomicStructuralCompletion({
      db, step: gateStep, success: true, data: { verdict: "pass" },
      companyId, workflowRunId: runId, workflowStepRunId: freshGate.id, missionId,
      requestId: winRequest,
      producerToken,
      observedStatus: "running",
      observedIterationIndex: 0,
      observedRequestId: winRequest,
      observedCompletedAt: null,
      patch: {
        startedAt: new Date(), completedAt: new Date(), metadata: {},
        fallbackFailureSummary: null,
      },
    });

    expect(result.casWon).toBe(true);
    const rows = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, freshGate.id));
    expect(rows).toHaveLength(1); // exactly one — no pre-tx duplicate
  });

  it("uses the exact existing request verdict when a recovery callback conflicts", async () => {
    const requestId = `req-recover-${randomUUID()}`;
    const [gate] = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: `gate-${randomUUID().slice(0, 6)}`,
      status: "running", issueId: null, iterationIndex: 0,
      lastDispatchRequestId: requestId,
    }).returning();
    // Simulate recovery from a historical crash after ledger insert but before
    // the status CAS. An incoming contradictory callback must not turn the
    // official PASS into a failed step.
    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gate.id, issueId: null,
      eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "pass", decision: "pass", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gate.id}:${requestId}`,
      payload: { kind: "structural_gate_verdict", requestId, verdict: "pass" },
    });

    const result = await atomicStructuralCompletion({
      db, step: gateStep, success: true, data: { verdict: "request_changes" },
      companyId, workflowRunId: runId, workflowStepRunId: gate.id, missionId,
      requestId, observedStatus: "running", observedIterationIndex: 0,
      observedRequestId: requestId, observedCompletedAt: null,
      producerToken,
      patch: { startedAt: new Date(), completedAt: new Date(), metadata: {}, fallbackFailureSummary: null },
    });

    expect(result.casWon).toBe(true);
    expect(result.effectiveSuccess).toBe(true);
    const [stored] = await db.select({ status: workflowStepRuns.status }).from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, gate.id));
    expect(stored?.status).toBe("completed");
  });
});
