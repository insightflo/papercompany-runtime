import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { applyCapAcceptancePass } from "../services/workflow/control-flow/qa-cap-acceptance.js";
import { loadDownstreamQaCapAcceptanceContext } from "../services/workflow/control-flow/qa-cap-acceptance-context.js";
import type { EdgeBearingStep, PredFacts } from "../services/workflow/control-flow/edge-condition.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip qa-cap tests: ${support.reason ?? "unsupported host"}`);

const PRODUCER = "producer";
const QA = "qa";
const MAX_ITER = 1;
const PRODUCER_COMPLETED = new Date("2026-07-10T00:00:00.000Z");
const QA_FAILED_AT = new Date("2026-07-10T00:05:00.000Z");

type StepRun = typeof workflowStepRuns.$inferSelect;

interface VerdictSeed {
  origin: "workflow_api" | "heartbeat_result";
  limitations: string[];
  observedAt: Date;
  heartbeatRunId: string;
}
/** workflowStepRunId defaults to the QA's current step run; override to bind elsewhere (wrong-run). */
interface HeartbeatSeed { runId: string; workflowStepRunId?: string }

async function seedScenario(db: Db, opts: {
  qaStatus?: "failed" | "completed";
  qaMetadata?: Record<string, unknown>;
  producerIteration?: number;
  verdict?: VerdictSeed | null;
  heartbeat?: HeartbeatSeed | null;
}): Promise<{ companyId: string; agentId: string; workflowRunId: string; producer: StepRun; qa: StepRun }> {
  const companyId = randomUUID();
  const issuePrefix = "C" + Math.random().toString(36).slice(2, 6).toUpperCase();
  const agentId = randomUUID();
  const workflowId = randomUUID();
  const workflowRunId = randomUUID();
  const producerIssueId = randomUUID();
  const qaIssueId = randomUUID();
  const producerStepRunId = randomUUID();
  const qaStepRunId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Cap Co", issuePrefix, requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values({ id: agentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  await db.insert(workflowDefinitions).values({
    id: workflowId, companyId, name: "cap-wf",
    stepsJson: [
      { id: PRODUCER, name: "Producer", type: "task", dependencies: [] },
      { id: QA, name: "[QA] semantic check", type: "qa", dependencies: [PRODUCER] },
    ],
  });
  await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, triggeredBy: "system", status: "running" });
  await db.insert(issues).values({ id: producerIssueId, companyId, identifier: `${issuePrefix}-1`, title: "Producer", status: "done", originKind: "workflow_execution", originRunId: workflowRunId, startedAt: new Date("2026-07-09T00:00:00.000Z") });
  await db.insert(issues).values({ id: qaIssueId, companyId, identifier: `${issuePrefix}-2`, title: "[QA] semantic check", status: "done", originKind: "workflow_execution", originRunId: workflowRunId, startedAt: new Date("2026-07-09T00:00:00.000Z") });
  await db.insert(workflowStepRuns).values({ id: producerStepRunId, workflowRunId, stepId: PRODUCER, issueId: producerIssueId, status: "completed", iterationIndex: opts.producerIteration ?? MAX_ITER, completedAt: PRODUCER_COMPLETED, lastDispatchRequestId: "prod-req-1", startedAt: new Date("2026-07-09T00:00:01.000Z") });
  await db.insert(workflowStepRuns).values({ id: qaStepRunId, workflowRunId, stepId: QA, issueId: qaIssueId, status: opts.qaStatus ?? "failed", iterationIndex: 0, completedAt: QA_FAILED_AT, lastDispatchRequestId: "qa-req-1", metadata: opts.qaMetadata ?? {}, startedAt: new Date("2026-07-10T00:00:01.000Z") });
  if (opts.verdict) {
    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId, workflowStepRunId: qaStepRunId, issueId: qaIssueId, heartbeatRunId: opts.verdict.heartbeatRunId,
      eventType: "workflow_validation_verdict", layer: "workflow_validation", verdict: "request_changes", decision: "request_changes",
      reason: opts.verdict.origin, reasonCode: opts.verdict.origin, createdAt: opts.verdict.observedAt,
      payload: { kind: "workflow_validation_verdict", workflowRunId, stepRunId: qaStepRunId, issueId: qaIssueId, verdict: "request_changes", diagnostics: [], nonblockingAcceptance: { classification: "nonblocking", limitations: opts.verdict.limitations } },
    });
  }
  if (opts.heartbeat) {
    const wakeupId = randomUUID();
    const boundStepRunId = opts.heartbeat.workflowStepRunId ?? qaStepRunId;
    await db.insert(agentWakeupRequests).values({ id: wakeupId, companyId, agentId, source: "workflow.dispatch", workflowStepRunId: boundStepRunId });
    await db.insert(heartbeatRuns).values({ id: opts.heartbeat.runId, companyId, agentId, issueId: qaIssueId, status: "succeeded", wakeupRequestId: wakeupId, startedAt: QA_FAILED_AT, finishedAt: QA_FAILED_AT, createdAt: QA_FAILED_AT });
  }
  const [producer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, producerStepRunId));
  const [qa] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, qaStepRunId));
  return { companyId, agentId, workflowRunId, producer, qa };
}

function buildSteps(allowCap: boolean, qaOverride: Partial<EdgeBearingStep> = {}): EdgeBearingStep[] {
  return [
    { id: PRODUCER, dependencies: [], conditionalDependencies: [{ stepId: QA, when: "qa_request_changes", isBackEdge: true, maxIterations: MAX_ITER, allowCapAcceptance: allowCap }] },
    { id: QA, dependencies: [PRODUCER], ...qaOverride },
  ];
}

function buildPreds(qaStatus: "failed" | "completed"): Map<string, PredFacts> {
  return new Map<string, PredFacts>([
    [PRODUCER, { status: "completed", isQaGate: false, verdict: null, verdictChecked: true }],
    [QA, { status: qaStatus, isQaGate: true, verdict: "request_changes", verdictChecked: true }],
  ]);
}

async function reload(db: Db, runId: string, stepId: string): Promise<StepRun> {
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
  return rows.find((r) => r.stepId === stepId)!;
}

describeEP("qa-cap acceptance pass", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-qa-cap-acceptance-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterEach(async () => {
    await db.delete(workflowTransitionEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function runPass(seed: Awaited<ReturnType<typeof seedScenario>>, allowCap: boolean, observedAt: Date, qaOverride?: Partial<EdgeBearingStep>) {
    return applyCapAcceptancePass({
      db, run: { id: seed.workflowRunId, companyId: seed.companyId, status: "running" },
      steps: buildSteps(allowCap, qaOverride), stepRuns: [seed.producer, seed.qa],
      predsByStepId: buildPreds(seed.qa.status === "completed" ? "completed" : "failed"),
      validationVerdictsByIssueId: new Map([[seed.qa.issueId!, { observedAt }]]),
    });
  }

  it("accepts a valid current official verdict; producer not reset; records event + metadata", async () => {
    const runId = randomUUID();
    const seed = await seedScenario(db, {
      verdict: { origin: "workflow_api", limitations: ["minor doc gap"], observedAt: QA_FAILED_AT, heartbeatRunId: runId },
      heartbeat: { runId }, // bound to qa.id by default = current execution
    });
    const res = await runPass(seed, true, QA_FAILED_AT);
    expect(res.acceptedCount).toBe(1);
    expect((await reload(db, seed.workflowRunId, QA)).status).toBe("completed");
    const prodAfter = await reload(db, seed.workflowRunId, PRODUCER);
    expect(prodAfter.status).toBe("completed"); // producer untouched (no reset)
    expect(prodAfter.iterationIndex).toBe(MAX_ITER); // no extra iteration / no extra LLM
    expect((prodAfter.metadata as Record<string, unknown>).qaCapAcceptance).toBeTruthy();
    const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.eventType, "qa_cap_acceptance"));
    expect(events).toHaveLength(1);
  });

  it("default non-opt-in: no acceptance (route unchanged)", async () => {
    const runId = randomUUID();
    const seed = await seedScenario(db, {
      verdict: { origin: "workflow_api", limitations: ["x"], observedAt: QA_FAILED_AT, heartbeatRunId: runId },
      heartbeat: { runId },
    });
    expect((await runPass(seed, false, QA_FAILED_AT)).acceptedCount).toBe(0);
    expect((await reload(db, seed.workflowRunId, QA)).status).toBe("failed");
  });

  it("blocks stale / wrong-run / run-derived / completed-without-sentinel", async () => {
    const staleAt = new Date("2026-07-09T00:00:00.000Z");
    const r1 = randomUUID();
    const s1 = await seedScenario(db, { verdict: { origin: "workflow_api", limitations: ["x"], observedAt: staleAt, heartbeatRunId: r1 }, heartbeat: { runId: r1 } });
    expect((await runPass(s1, true, staleAt)).acceptedCount).toBe(0);
    const r2 = randomUUID();
    const s2 = await seedScenario(db, { verdict: { origin: "workflow_api", limitations: ["x"], observedAt: QA_FAILED_AT, heartbeatRunId: r2 }, heartbeat: { runId: r2, workflowStepRunId: randomUUID() } });
    expect((await runPass(s2, true, QA_FAILED_AT)).acceptedCount).toBe(0);
    const r3 = randomUUID();
    const s3 = await seedScenario(db, { verdict: { origin: "heartbeat_result", limitations: ["x"], observedAt: QA_FAILED_AT, heartbeatRunId: r3 }, heartbeat: { runId: r3 } });
    expect((await runPass(s3, true, QA_FAILED_AT)).acceptedCount).toBe(0);
    const r4 = randomUUID();
    const s4 = await seedScenario(db, { qaStatus: "completed", qaMetadata: {}, verdict: { origin: "workflow_api", limitations: ["x"], observedAt: QA_FAILED_AT, heartbeatRunId: r4 }, heartbeat: { runId: r4 } });
    expect((await runPass(s4, true, QA_FAILED_AT)).acceptedCount).toBe(0);
  });

  it("hard-blocks structural and delivery/readback QA steps (with otherwise-valid binding)", async () => {
    const structural = { type: "tool", qaType: "structural", toolNames: ["checkSchema"], agentId: "" } as Partial<EdgeBearingStep>;
    const r1 = randomUUID();
    const s1 = await seedScenario(db, { verdict: { origin: "workflow_api", limitations: ["x"], observedAt: QA_FAILED_AT, heartbeatRunId: r1 }, heartbeat: { runId: r1 } });
    expect((await runPass(s1, true, QA_FAILED_AT, structural)).acceptedCount).toBe(0);
    const delivery = { id: QA, name: "[QA] delivery readback verify publish", type: "qa", dependencies: [PRODUCER] } as Partial<EdgeBearingStep>;
    const r2 = randomUUID();
    const s2 = await seedScenario(db, { verdict: { origin: "workflow_api", limitations: ["x"], observedAt: QA_FAILED_AT, heartbeatRunId: r2 }, heartbeat: { runId: r2 } });
    expect((await runPass(s2, true, QA_FAILED_AT, delivery)).acceptedCount).toBe(0);
  });

  it("downstream loader surfaces accepted limitations (shared by create + resume paths)", async () => {
    const runId = randomUUID();
    const seed = await seedScenario(db, {
      verdict: { origin: "workflow_api", limitations: ["known cosmetic gap"], observedAt: QA_FAILED_AT, heartbeatRunId: runId },
      heartbeat: { runId },
    });
    await runPass(seed, true, QA_FAILED_AT);
    const ctx = await loadDownstreamQaCapAcceptanceContext({ db, workflowRunId: seed.workflowRunId, predecessorStepIds: [QA, PRODUCER] });
    expect(ctx.accepted.length).toBeGreaterThanOrEqual(1);
    expect(ctx.accepted.some((a) => a.limitations.includes("known cosmetic gap"))).toBe(true);
    const empty = await loadDownstreamQaCapAcceptanceContext({ db, workflowRunId: seed.workflowRunId, predecessorStepIds: ["nonexistent"] });
    expect(empty.accepted).toHaveLength(0);
  });

  it("a verdict superseded by a newer wakeup-bound QA heartbeat is NOT current => no accept", async () => {
    const runId = randomUUID();
    const seed = await seedScenario(db, {
      verdict: { origin: "workflow_api", limitations: ["x"], observedAt: QA_FAILED_AT, heartbeatRunId: runId },
      heartbeat: { runId },
    });
    // a NEWER heartbeat+wakeup for the same QA step appears after the verdict
    const newerWakeup = randomUUID();
    const newerRun = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: newerWakeup, companyId: seed.companyId, agentId: seed.agentId, source: "workflow.dispatch", workflowStepRunId: seed.qa.id });
    await db.insert(heartbeatRuns).values({ id: newerRun, companyId: seed.companyId, agentId: seed.agentId, issueId: seed.qa.issueId, status: "succeeded", wakeupRequestId: newerWakeup, startedAt: new Date("2026-07-10T00:20:00.000Z"), finishedAt: new Date("2026-07-10T00:20:00.000Z"), createdAt: new Date("2026-07-10T00:20:00.000Z") });
    expect((await runPass(seed, true, QA_FAILED_AT)).acceptedCount).toBe(0);
  });

  it("accepted limitations do not leak after a new producer generation (loader generation-aware)", async () => {
    const runId = randomUUID();
    const seed = await seedScenario(db, {
      verdict: { origin: "workflow_api", limitations: ["gap"], observedAt: QA_FAILED_AT, heartbeatRunId: runId },
      heartbeat: { runId },
    });
    await runPass(seed, true, QA_FAILED_AT); // accepted at producer iteration 1
    const before = await loadDownstreamQaCapAcceptanceContext({ db, workflowRunId: seed.workflowRunId, predecessorStepIds: [QA, PRODUCER] });
    expect(before.accepted.some((a) => a.limitations.includes("gap"))).toBe(true);
    // simulate a new producer generation (rework): producer re-completes at a higher iteration
    await db.update(workflowStepRuns).set({ iterationIndex: MAX_ITER + 1, status: "completed" }).where(eq(workflowStepRuns.id, seed.producer.id));
    const after = await loadDownstreamQaCapAcceptanceContext({ db, workflowRunId: seed.workflowRunId, predecessorStepIds: [QA, PRODUCER] });
    expect(after.accepted).toHaveLength(0); // stale sentinel+record filtered — no downstream leak
  });

  it("a newer official workflow_api PASS verdict supersedes the nonblocking request_changes => no accept", async () => {
    const runId = randomUUID();
    const seed = await seedScenario(db, {
      verdict: { origin: "workflow_api", limitations: ["x"], observedAt: QA_FAILED_AT, heartbeatRunId: runId },
      heartbeat: { runId },
    });
    // a NEWER official workflow_api PASS verdict for the same QA issue is the current verdict
    await db.insert(workflowTransitionEvents).values({
      companyId: seed.companyId, workflowRunId: seed.workflowRunId, workflowStepRunId: seed.qa.id, issueId: seed.qa.issueId, heartbeatRunId: runId,
      eventType: "workflow_validation_verdict", layer: "workflow_validation", verdict: "pass", decision: "pass",
      reason: "workflow_api", reasonCode: "workflow_api", createdAt: new Date("2026-07-10T00:30:00.000Z"),
      payload: { kind: "workflow_validation_verdict", verdict: "pass", diagnostics: [] },
    });
    expect((await runPass(seed, true, QA_FAILED_AT)).acceptedCount).toBe(0);
  });
});
