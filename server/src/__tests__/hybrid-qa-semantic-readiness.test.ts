import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies, createDb, workflowDefinitions, workflowRuns, workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  evaluateSemanticStructuralReadiness,
  renderStructuralGateCoverageLines,
} from "../services/workflow/control-flow/structural-semantic-readiness.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

describeEP("hybrid QA — semantic structural evidence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-semantic-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  async function fixture(options: { currentRequest?: string; eventRequest?: string; tokenOffsetMs?: number; includeEvent?: boolean } = {}) {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const producerCompletedAt = new Date(Date.now() - 5_000);
    const tokenCompletedAt = new Date(producerCompletedAt.getTime() + (options.tokenOffsetMs ?? 0));
    const token = { producerStepId: "producer", iterationIndex: 0, completedAt: tokenCompletedAt.toISOString() };
    const currentRequest = options.currentRequest ?? "request-b";
    const steps = [
      { id: "producer", name: "Build", agentId: "producer", dependencies: [], graphWorkProductRequired: true },
      { id: "gate", name: "Structural", agentId: "", type: "tool", qaType: "structural", toolNames: ["validate"], dependencies: ["producer"] },
      { id: "qa", name: "[QA] Semantic", agentId: "qa", dependencies: ["producer", "gate"] },
    ];
    await db.insert(companies).values({ id: companyId, name: `semantic-${companyId}`, status: "active", issuePrefix: `SM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "semantic", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "producer", status: "completed", iterationIndex: 0, completedAt: producerCompletedAt },
      { workflowRunId: runId, stepId: "gate", status: "completed", iterationIndex: 0, completedAt: new Date(), lastDispatchRequestId: currentRequest, metadata: { structuralGateProducerToken: token } },
      { workflowRunId: runId, stepId: "qa", status: "pending", iterationIndex: 0 },
    ]);
    const [gateRun] = await db.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, "gate"),
    ));
    if (options.includeEvent !== false) {
      const eventRequest = options.eventRequest ?? currentRequest;
      await db.insert(workflowTransitionEvents).values({
        companyId, workflowRunId: runId, workflowStepRunId: gateRun!.id, issueId: null,
        eventType: "workflow_validation_verdict", layer: "workflow_validation",
        verdict: "pass", decision: "pass", reasonCode: "workflow_tool_result",
        idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun!.id}:${eventRequest}`,
        payload: { kind: "structural_gate_verdict", requestId: eventRequest, verdict: "pass", producerToken: token },
      });
    }
    return { companyId, runId, steps };
  }

  it("does not unlock QA from a completed gate with no official PASS", async () => {
    const input = await fixture({ includeEvent: false });
    const result = await evaluateSemanticStructuralReadiness({ db, ...input, workflowRunId: input.runId, step: input.steps[2]!, steps: input.steps });
    expect(result.ready).toBe(false);
  });

  it("does not reuse a PASS from an older request", async () => {
    const input = await fixture({ currentRequest: "request-b", eventRequest: "request-a" });
    const result = await evaluateSemanticStructuralReadiness({ db, ...input, workflowRunId: input.runId, step: input.steps[2]!, steps: input.steps });
    expect(result.ready).toBe(false);
  });

  it("requires the exact current request and matching producer generation", async () => {
    const input = await fixture();
    const result = await evaluateSemanticStructuralReadiness({ db, ...input, workflowRunId: input.runId, step: input.steps[2]!, steps: input.steps });
    expect(result.ready).toBe(true);
    expect(result.coverage).toHaveLength(1);
    expect(result.coverage[0]?.gateStepId).toBe("gate");
  });

  it("blocks a PASS bound to an older producer completion in the same iteration", async () => {
    const input = await fixture({ tokenOffsetMs: -1_000 });
    const result = await evaluateSemanticStructuralReadiness({ db, ...input, workflowRunId: input.runId, step: input.steps[2]!, steps: input.steps });
    expect(result.ready).toBe(false);
  });

  it("leaves QA without structural dependencies unchanged and bounds the summary", async () => {
    const input = await fixture();
    const ordinaryQa = { ...input.steps[2]!, dependencies: ["producer"] };
    const result = await evaluateSemanticStructuralReadiness({ db, ...input, workflowRunId: input.runId, step: ordinaryQa, steps: input.steps });
    expect(result).toEqual({ ready: true, coverage: [] });
    const lines = renderStructuralGateCoverageLines(Array.from({ length: 10 }, (_, index) => ({
      gateStepId: `gate-${index}`, toolName: "validate", producerStepId: "producer", producerIterationIndex: 0, producerCompletedAt: "2026-07-15T00:00:00.000Z",
    })));
    expect(lines.filter((line) => line.startsWith("- gate="))).toHaveLength(8);
  });
});
