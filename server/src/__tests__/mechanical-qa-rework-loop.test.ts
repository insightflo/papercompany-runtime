// server/src/__tests__/mechanical-qa-rework-loop.test.ts
//
// [purpose] Stage 1 of the mechanical QA rejection→rework loop (plan
//   2026-10-17-mechanical-qa-rejection-loop-stage1): an issue-less mechanical QA
//   tool step whose completion re-verification failed with a WHITELISTED content
//   rejection signature (qa_artifact_verdict_failed /
//   qa_artifact_runtime_checks_failed:<ids>) must flow into the existing
//   qa_request_changes back-edge rework loop exactly like an Agent QA verdict:
//   derived verdict (buildPredFactsMap wiring), producer reset, rejected-QA
//   requeue (CAS failed→pending + stale dispatch/receipt metadata clear),
//   mechanical rework feedback fallback, freshness guard, and — critically —
//   the P4 infra guard must stay intact for non-whitelisted signatures.
//
// [incident class] kenfold 780dada3: content rejection recorded only as a
//   qa_artifact_* failure on an issue-less QA tool step never fired the
//   back-edge (no verdict source) and the run ended in owner-card escalation.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueWorkProducts,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  deriveMechanicalQaRejection,
  type PredFacts,
} from "../services/workflow/control-flow/edge-condition.js";
import { applyBackEdgeReworkPass } from "../services/workflow/control-flow/loop-driver.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";

// Same wakeup-mock preamble as workflow-failure-cascade-skip-sticky.test.ts: the
// issue creation/wake path enqueues assignment wakeups; bind it to a spy.
const { heartbeatWakeup } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn(),
}));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({
      wakeup: heartbeatWakeup,
    }),
  };
});

vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (
      input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0],
    ) => actual.queueIssueAssignmentWakeup({
      ...input,
      heartbeat: { wakeup: heartbeatWakeup },
    }),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skip mechanical QA rework loop tests: ${support.reason ?? "unsupported host"}`);
}

type StepRun = typeof workflowStepRuns.$inferSelect;

function readContract(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const c = m.workflowReworkContract;
  return c && typeof c === "object" && !Array.isArray(c) ? c as Record<string, unknown> : null;
}

describe("deriveMechanicalQaRejection (pure)", () => {
  // Live service-onboarding QA shape: type "tool", qaType "action", no issue.
  const qaStep = { id: "qa-mech", name: "Mechanical QA gate", type: "tool", qaType: "action" };
  const baseRun = { issueId: null as string | null, status: "failed", lastDispatchErrorSummary: null as string | null, metadata: null as unknown };

  it("derives a rejection for the tool-verdict failure signature", () => {
    expect(deriveMechanicalQaRejection({
      step: qaStep,
      run: { ...baseRun, lastDispatchErrorSummary: "qa_artifact_verdict_failed" },
    })).toBe(true);
  });

  it("derives a rejection for the runtime content-rules failure signature (check ids)", () => {
    expect(deriveMechanicalQaRejection({
      step: qaStep,
      run: { ...baseRun, lastDispatchErrorSummary: "qa_artifact_runtime_checks_failed:https-links,secure-links" },
    })).toBe(true);
  });

  it("reads metadata.toolInvocation.dispatchError when the summary column is empty", () => {
    expect(deriveMechanicalQaRejection({
      step: qaStep,
      run: {
        ...baseRun,
        metadata: { toolInvocation: { requestId: "r1", toolName: "qa", args: {}, dispatchedAt: "t", dispatchError: "qa_artifact_verdict_failed" } },
      },
    })).toBe(true);
  });

  it("does NOT derive for infra/unknown signatures (P4 guard whitelist)", () => {
    for (const signature of [
      "workproduct_selector_stale_producer",
      "qa_artifact_receipt_scope_mismatch",
      "qa_artifact_receipt_contract_mismatch",
      "qa_artifact_input_changed",
      "qa_artifact_request_stale",
      "qa_artifact_input_digest_mismatch",
      "Workflow tool step executor is not configured.",
      "",
    ]) {
      expect(deriveMechanicalQaRejection({
        step: qaStep,
        run: { ...baseRun, lastDispatchErrorSummary: signature },
      })).toBe(false);
    }
  });

  it("does not derive for issue-backed, non-failed, or non-QA steps", () => {
    expect(deriveMechanicalQaRejection({
      step: qaStep,
      run: { ...baseRun, issueId: "issue-1", lastDispatchErrorSummary: "qa_artifact_verdict_failed" },
    })).toBe(false);
    expect(deriveMechanicalQaRejection({
      step: qaStep,
      run: { ...baseRun, status: "completed", lastDispatchErrorSummary: "qa_artifact_verdict_failed" },
    })).toBe(false);
    expect(deriveMechanicalQaRejection({
      step: { id: "produce", name: "Produce", type: "agent" },
      run: { ...baseRun, lastDispatchErrorSummary: "qa_artifact_verdict_failed" },
    })).toBe(false);
  });
});

describeDb("mechanical QA rejection → rework loop (integration)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mech-qa-loop-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  /** Producer + issue-less mechanical QA tool step with an explicit back-edge (kenfold shape). */
  function mechanicalSteps(agentId: string) {
    return [
      {
        id: "produce", name: "Produce service report", type: "agent", agentId, dependencies: [],
        graphWorkProductRequired: true,
        conditionalDependencies: [
          { stepId: "qa-mech", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 },
        ],
      },
      {
        id: "qa-mech", name: "Mechanical QA gate", type: "tool", qaType: "action", agentId: "",
        toolNames: ["qa-content-gate"], dependencies: ["produce"],
      },
    ];
  }

  async function seedRun(options: {
    errorSummary: string;
    /** QA rejection observation time; null leaves both observation timestamps unknown. */
    qaCompletedAt: Date | null;
    producerCompletedAt: Date;
    producerIteration?: number;
  }): Promise<{ runId: string; companyId: string; missionId: string; producerIssueId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `MechQaCo-${companyId.slice(0, 8)}`, issuePrefix: `MQ${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "worker", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "mech qa mission", status: "active" });
    const producerIssueId = (await db.insert(issues).values({
      companyId, missionId, title: "produce-service-report", description: "Produce the service onboarding report.",
      status: "done", assigneeAgentId: agentId, completedAt: options.producerCompletedAt,
    }).returning({ id: issues.id }))[0]!.id;
    // Registered work product keeps the graph-work-product dependency gate from
    // demoting the completed producer step run (live kenfold shape).
    await db.insert(issueWorkProducts).values({
      companyId, issueId: producerIssueId, type: "file", provider: "local",
      title: "service-report-v1", status: "active", url: "/srv/out/service-report.html",
    });

    const steps = mechanicalSteps(agentId);
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "mech-qa-wf", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, missionId, status: "running", triggeredBy: "test" });

    const requestId = `req-${randomUUID()}`;
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId, companyId, stepId: "produce", issueId: producerIssueId,
        status: "completed", iterationIndex: options.producerIteration ?? 0, completedAt: options.producerCompletedAt,
      },
      {
        workflowRunId: runId, companyId, stepId: "qa-mech", issueId: null, status: "failed",
        startedAt: options.producerCompletedAt,
        lastDispatchAttemptAt: options.producerCompletedAt,
        completedAt: options.qaCompletedAt, lastDispatchErrorAt: options.qaCompletedAt,
        lastDispatchErrorSummary: options.errorSummary, lastDispatchRequestId: requestId,
        metadata: {
          toolInvocation: { requestId, toolName: "qa-content-gate", args: {}, dispatchedAt: options.producerCompletedAt.toISOString(), dispatchError: options.errorSummary },
          toolResult: { requestId, success: false, error: options.errorSummary },
          toolQueue: { status: "queued" },
          artifactExecution: { stale: true },
          toolArtifactRequest: { stale: true },
          toolArtifactReceipt: { stale: true },
          cacheHit: true,
        },
      },
    ]);
    return { runId, companyId, missionId, producerIssueId };
  }

  it("① flows a whitelisted content rejection into back-edge rework: producer reset + QA requeue + mechanical feedback", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-mech-qa-1" });
    const now = Date.now();
    const seed = await seedRun({
      errorSummary: "qa_artifact_runtime_checks_failed:https-links",
      qaCompletedAt: new Date(now - 5 * 60_000),   // observed AFTER the producer completion
      producerCompletedAt: new Date(now - 10 * 60_000),
    });

    await syncWorkflowRunState(db, seed.runId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, seed.runId));
    const producer = rows.find((r) => r.stepId === "produce")!;
    const qa = rows.find((r) => r.stepId === "qa-mech")!;

    // Derived verdict fired the back-edge rework: producer reset for rework.
    expect(producer.iterationIndex).toBe(1);
    expect(["pending", "running"]).toContain(producer.status);
    const contract = readContract(producer.metadata);
    expect(contract).not.toBeNull();
    const fbs = contract!.qaFeedbacks as readonly { qaStepId: string; feedback: string | null }[];
    expect(fbs.some((f) => f.qaStepId === "qa-mech")).toBe(true);
    expect(fbs.some((f) => f.feedback?.includes("Mechanical QA gate feedback: qa-mech"))).toBe(true);
    expect(fbs.some((f) => f.feedback?.includes("REQUEST_CHANGES (mechanical content rules)"))).toBe(true);
    expect(fbs.some((f) => f.feedback?.includes("https-links"))).toBe(true);

    // ② Rejected issue-less QA requeued: CAS failed→pending, dispatch/receipt
    // metadata cleared, iteration NOT bumped (cap stays producer-dominated).
    expect(qa.status).toBe("pending");
    expect(qa.iterationIndex).toBe(0);
    expect(qa.lastDispatchRequestId).toBeNull();
    expect(qa.lastDispatchErrorSummary).toBeNull();
    expect(qa.completedAt).toBeNull();
    const meta = (qa.metadata ?? {}) as Record<string, unknown>;
    expect(meta.toolInvocation).toBeUndefined();
    expect(meta.toolResult).toBeUndefined();
    expect(meta.toolQueue).toBeUndefined();
    expect(meta.cacheHit).toBeUndefined();
    expect(meta.artifactExecution).toBeUndefined();
    expect(meta.toolArtifactRequest).toBeUndefined();
    expect(meta.toolArtifactReceipt).toBeUndefined();

    // Audit trail for the requeue.
    const [requeueEntry] = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, qa.id),
      eq(activityLog.action, "workflow.mechanical_qa_requeue"),
    ));
    expect(requeueEntry).toBeTruthy();

    // Producer issue received the rendered rework comment with the mechanical feedback.
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seed.producerIssueId));
    expect(comments.some((c) => c.body.includes("Mechanical QA gate feedback"))).toBe(true);
  });

  it("④ excludes a mechanical rejection observed before the producer's current completion (stale, no rework)", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-mech-qa-4" });
    const now = Date.now();
    // Producer RE-completed (iteration 1) at -10m; the mechanical rejection was
    // observed at -20m — it belongs to the previous generation.
    const seed = await seedRun({
      errorSummary: "qa_artifact_verdict_failed",
      qaCompletedAt: new Date(now - 20 * 60_000),
      producerCompletedAt: new Date(now - 10 * 60_000),
      producerIteration: 1,
    });

    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, seed.runId));
    const predsByStepId = new Map<string, PredFacts>([
      ["produce", { status: "completed", isQaGate: false, verdict: null }],
      // Simulates the engine-derived verdict for the whitelisted signature.
      ["qa-mech", { status: "failed", isQaGate: true, verdict: "request_changes" }],
    ]);
    const result = await applyBackEdgeReworkPass({
      db,
      run: { id: seed.runId, companyId: seed.companyId, status: "running", missionId: seed.missionId },
      steps: mechanicalSteps(randomUUID()) as Parameters<typeof applyBackEdgeReworkPass>[0]["steps"],
      stepRuns,
      predsByStepId,
    });

    expect(result.reworkedCount).toBe(0);
    const [producer] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "produce")));
    expect(producer!.status).toBe("completed");
    expect(producer!.iterationIndex).toBe(1);
    const [qa] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "qa-mech")));
    expect(qa!.status).toBe("failed"); // stale rejection → no requeue either
  });

  it("④b treats an issue-less rejection with unknown observation timing as fresh (conservative)", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-mech-qa-4b" });
    const now = Date.now();
    const seed = await seedRun({
      errorSummary: "qa_artifact_verdict_failed",
      qaCompletedAt: null, // no completedAt / lastDispatchErrorAt on the QA run
      producerCompletedAt: new Date(now - 10 * 60_000),
    });

    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, seed.runId));
    const predsByStepId = new Map<string, PredFacts>([
      ["produce", { status: "completed", isQaGate: false, verdict: null }],
      ["qa-mech", { status: "failed", isQaGate: true, verdict: "request_changes" }],
    ]);
    const result = await applyBackEdgeReworkPass({
      db,
      run: { id: seed.runId, companyId: seed.companyId, status: "running", missionId: seed.missionId },
      steps: mechanicalSteps(randomUUID()) as Parameters<typeof applyBackEdgeReworkPass>[0]["steps"],
      stepRuns,
      predsByStepId,
    });

    expect(result.reworkedCount).toBe(1);
    const [producer] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "produce")));
    expect(producer!.status).toBe("pending");
    expect(producer!.iterationIndex).toBe(1);
    const [qa] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "qa-mech")));
    expect(qa!.status).toBe("pending"); // fresh rejection → requeued with the producer
  });

  it("⑤ keeps the P4 infra guard: a non-whitelisted signature on an issue-less QA fires no rework and no requeue", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-mech-qa-5" });
    const now = Date.now();
    const seed = await seedRun({
      errorSummary: "workproduct_selector_stale_producer",
      qaCompletedAt: new Date(now - 5 * 60_000),
      producerCompletedAt: new Date(now - 10 * 60_000),
    });

    await syncWorkflowRunState(db, seed.runId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, seed.runId));
    const producer = rows.find((r) => r.stepId === "produce")!;
    const qa = rows.find((r) => r.stepId === "qa-mech")!;

    // Infra failure: no derived verdict → hard-failure convergence (P4), not rework.
    expect(producer.status).toBe("completed");
    expect(producer.iterationIndex).toBe(0);
    expect(readContract(producer.metadata)).toBeNull();
    expect(qa.status).toBe("failed");
    expect(qa.lastDispatchErrorSummary).toBe("workproduct_selector_stale_producer");
    const [requeueEntry] = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, qa.id),
      eq(activityLog.action, "workflow.mechanical_qa_requeue"),
    ));
    expect(requeueEntry).toBeUndefined();
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seed.producerIssueId));
    expect(comments.length).toBe(0);
  });
});
