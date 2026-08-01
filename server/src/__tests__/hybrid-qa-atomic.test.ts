import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies, createDb, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { completeWorkflowToolStepFromResult } from "../services/workflow/dag-engine.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip atomic tests: ${support.reason ?? "unsupported"}`);

describeEP("hybrid QA — atomic structural callback", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-atomic-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Atomic Co", status: "active" });
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  async function seedGate(opts?: { requestId?: string; status?: string }) {
    const wfId = randomUUID();
    const runId = randomUUID();
    const gateId = `g-${randomUUID().slice(0, 8)}`;
    const reqId = opts?.requestId ?? `req-${randomUUID()}`;
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "Atomic WF",
      stepsJson: [{ id: gateId, name: "Gate", agentId: "", type: "tool", qaType: "structural",
        toolNames: ["v"], dependencies: [], graphWorkProductRequired: false }],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: gateId, status: opts?.status ?? "running",
      issueId: null, lastDispatchRequestId: reqId,
      // Dispatch-time producer token snapshot (never recaptured at completion).
      metadata: {
        structuralGateProducerToken: {
          producerStepId: "producer", iterationIndex: 0, completedAt: new Date().toISOString(),
        },
      },
    }).returning();
    return { wfId, runId, gateId, reqId, gateRunId: gateRun[0].id };
  }

  it("stale callback cannot leave a ledger row or change newer step row", async () => {
    const { runId, reqId, gateRunId } = await seedGate({ status: "running" });

    // First callback completes the gate with PASS
    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRunId, success: true, requestId: reqId, workflowRunId: runId,
      data: { verdict: "pass" },
    });
    const [after1st] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRunId));
    expect(after1st.status).toBe("completed");

    // Simulate a stale concurrent callback arriving with the SAME requestId
    // but the step has already been updated (CAS will fail on completedAt)
    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRunId, success: true, requestId: reqId, workflowRunId: runId,
      data: { verdict: "request_changes" }, // conflicting verdict!
    });

    // Step should NOT be changed by the stale callback
    const [after2nd] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateRunId));
    expect(after2nd.status).toBe("completed"); // still completed from first
    expect(after2nd.completedAt?.getTime()).toBe(after1st.completedAt?.getTime());

    // Only ONE ledger row should exist (the stale callback's insert was rolled back)
    const events = await db.select().from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.workflowStepRunId, gateRunId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      ));
    expect(events).toHaveLength(1);
    expect(events[0].verdict).toBe("pass"); // original, not the stale request_changes
  });

  it("same-request duplicate uses original ledger verdict (not incoming)", async () => {
    const { runId, reqId, gateRunId } = await seedGate({ status: "running" });

    // First callback: PASS
    const result1 = await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRunId, success: true, requestId: reqId, workflowRunId: runId,
      data: { verdict: "pass", reason: "all checks passed" },
    });
    expect(result1?.status).toBe("completed");

    // Duplicate callback with same requestId but different verdict — already terminal, returns snapshot
    const result2 = await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: gateRunId, success: true, requestId: reqId, workflowRunId: runId,
      data: { verdict: "request_changes", reason: "second callback different" },
    });
    // Step is already terminal — returns snapshot without re-processing
    expect(result2?.status).toBe("completed");

    // Only the original PASS verdict exists
    const events = await db.select().from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.workflowStepRunId, gateRunId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      ));
    expect(events).toHaveLength(1);
    expect(events[0].verdict).toBe("pass");
    expect(events[0].reason).toBe("all checks passed");
  });
});
