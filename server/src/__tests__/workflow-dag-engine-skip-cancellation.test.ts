import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentQueueAdmissionJobs,
  agentWakeupRequests,
  issues,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
// vi.mock registrations must precede the DAG engine graph pulled in by the fixture.
import "./helpers/workflow-control-node-boundary.js";
import {
  getStepRun,
  getStepRuns,
  installMechanicalQaExecutor,
  mirrorFixture,
  seedMirrorWorkflow,
  type MirrorSeed,
} from "./helpers/workflow-mirror-dag-fixture.js";
import { syncWorkflowRunStateWithOutcome } from "../services/workflow/dag-engine.js";

const { settleConditionalSkipBoundary } = vi.hoisted(() => ({
  settleConditionalSkipBoundary: vi.fn(),
}));

vi.mock("../services/workflow/conditional-skip-settlement.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workflow/conditional-skip-settlement.js")>();
  return { ...actual, settleConditionalSkip: settleConditionalSkipBoundary };
});

type SettleInput = Parameters<typeof import("../services/workflow/conditional-skip-settlement.js").settleConditionalSkip>[1];
type BoundaryEvidence = {
  baseline?: Awaited<ReturnType<typeof baseline>>;
  input?: SettleInput;
};

async function actualSettle(db: typeof mirrorFixture.db, input: SettleInput) {
  const actual = await vi.importActual<typeof import("../services/workflow/conditional-skip-settlement.js")>(
    "../services/workflow/conditional-skip-settlement.js",
  );
  return await actual.settleConditionalSkip(db, input);
}

function restoreDefaultSettleBoundary() {
  settleConditionalSkipBoundary.mockReset();
  settleConditionalSkipBoundary.mockImplementation(actualSettle);
}

restoreDefaultSettleBoundary();

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("conditional skip cancellation boundaries", () => {
  afterEach(async () => {
    restoreDefaultSettleBoundary();
    await mirrorFixture.db.delete(activityLog);
  });

  it("stops immediately at the pre-launch skip boundary after durable cancellation", async () => {
    const requests = installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    await resetFastPath(seed, ["validator", "mirror"]);
    const setupRows = await getStepRuns(seed.runId);
    const setupById = new Map(setupRows.map((row) => [row.stepId, row]));
    expect(setupById.get("validator")).toMatchObject({ status: "pending", issueId: null });
    expect(setupById.get("mirror")).toMatchObject({ status: "pending", issueId: null });
    const evidence: BoundaryEvidence = {};
    settleConditionalSkipBoundary.mockClear();
    settleConditionalSkipBoundary.mockImplementation(async (db, input) =>
      await cancelOnFirstBoundary(seed, evidence, false, db, input));

    const outcome = await syncWorkflowRunStateWithOutcome(mirrorFixture.db, seed.runId);

    expect(settleConditionalSkipBoundary).toHaveBeenCalledTimes(1);
    expect(evidence.baseline).toBeTruthy();
    expect(evidence.input?.observedRun.id).toBe(seed.runId);
    expect(evidence.input?.target.stepId).toBe("validator");
    await assertImmediateCancellation(seed, evidence.baseline!, outcome, requests);
  });

  it("stops immediately at the after-control-node skip boundary after durable cancellation", async () => {
    const requests = installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    await resetDecision(seed);
    await resetFastPath(seed, ["validator"]);
    const setupValidator = await getStepRun(seed.runId, "validator");
    expect(setupValidator).toMatchObject({ status: "pending", issueId: null });
    const evidence: BoundaryEvidence = {};
    settleConditionalSkipBoundary.mockClear();
    settleConditionalSkipBoundary.mockImplementation(async (db, input) =>
      await cancelOnFirstBoundary(seed, evidence, true, db, input));

    const outcome = await syncWorkflowRunStateWithOutcome(mirrorFixture.db, seed.runId);

    expect(settleConditionalSkipBoundary).toHaveBeenCalledTimes(1);
    expect(evidence.baseline).toBeTruthy();
    expect(evidence.input?.observedRun.id).toBe(seed.runId);
    expect(evidence.input?.target.stepId).toBe("validator");
    await assertImmediateCancellation(seed, evidence.baseline!, outcome, requests);
  });
});

async function cancelOnFirstBoundary(
  seed: MirrorSeed,
  evidence: BoundaryEvidence,
  requireAfterControl: boolean,
  db: typeof mirrorFixture.db,
  input: SettleInput,
) {
  if (requireAfterControl) {
    const decision = await getStepRun(seed.runId, "decision");
    expect(decision.metadata).toMatchObject({
      controlNodeResult: { outcome: "condition_true" },
    });
  }
  evidence.input = input;
  evidence.baseline = await baseline(seed);
  await commitCancellation(db, input.observedRun.id);
  return await actualSettle(db, {
    ...input,
    observedRun: { ...input.observedRun, status: "cancelled" },
  });
}

async function resetFastPath(seed: MirrorSeed, stepIds: string[]) {
  const rows = await getStepRuns(seed.runId);
  const byStepId = new Map(rows.map((row) => [row.stepId, row]));
  for (const stepId of stepIds) {
    const row = byStepId.get(stepId)!;
    expect(row).toMatchObject({ status: "skipped", issueId: null });
    const metadata = { ...(row.metadata ?? {}) as Record<string, unknown> };
    delete metadata.controlFlowSkipped;
    await mirrorFixture.db.update(workflowStepRuns).set({
      status: "pending",
      issueId: null,
      startedAt: null,
      lastDispatchAttemptAt: null,
      completedAt: null,
      dispatchReadyAt: null,
      evidenceReadyAt: null,
      dispatchOwnerWakeupRequestId: null,
      dispatchOwnerHeartbeatRunId: null,
      metadata,
    }).where(eq(workflowStepRuns.id, row.id));
  }
}

async function resetDecision(seed: MirrorSeed) {
  const decision = await getStepRun(seed.runId, "decision");
  const metadata = { ...decision.metadata as Record<string, unknown> };
  delete metadata.controlNodeResult;
  delete metadata.controlNodeError;
  delete metadata.controlNodeGraceWait;
  await mirrorFixture.db.update(workflowStepRuns).set({
    status: "pending",
    startedAt: null,
    completedAt: null,
    dispatchReadyAt: null,
    lastDispatchErrorAt: null,
    lastDispatchErrorSummary: null,
    metadata,
  }).where(eq(workflowStepRuns.id, decision.id));
}

async function commitCancellation(db: typeof mirrorFixture.db, runId: string) {
  await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, runId));
}

async function baseline(seed: MirrorSeed) {
  return {
    steps: await getStepRuns(seed.runId),
    issues: await mirrorFixture.db.select({ id: issues.id }).from(issues)
      .where(eq(issues.originRunId, seed.runId)).orderBy(issues.id),
    wakeups: await scopedWakeups(seed),
    queueJobs: await scopedQueueJobs(seed),
    events: await scopedEvents(seed),
  };
}

async function assertImmediateCancellation(
  seed: MirrorSeed,
  boundary: Awaited<ReturnType<typeof baseline>>,
  outcome: Awaited<ReturnType<typeof syncWorkflowRunStateWithOutcome>>,
  requests: unknown[],
) {
  expect(outcome.kind).toBe("synced");
  expect(outcome.result.status).toBe("cancelled");
  const [run] = await mirrorFixture.db.select().from(workflowRuns).where(eq(workflowRuns.id, seed.runId));
  expect(run).toMatchObject({ id: seed.runId, companyId: seed.companyId, status: "cancelled" });
  expect(await getStepRuns(seed.runId)).toEqual(boundary.steps);
  expect(await mirrorFixture.db.select({ id: issues.id }).from(issues)
    .where(eq(issues.originRunId, seed.runId)).orderBy(issues.id)).toEqual(boundary.issues);
  expect(await scopedWakeups(seed)).toEqual(boundary.wakeups);
  expect(await scopedQueueJobs(seed)).toEqual(boundary.queueJobs);
  expect(await scopedEvents(seed)).toEqual(boundary.events);
  expect(requests).toHaveLength(0);
}

async function scopedWakeups(seed: MirrorSeed) {
  return await mirrorFixture.db.select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, seed.companyId))
    .orderBy(agentWakeupRequests.id);
}

async function scopedQueueJobs(seed: MirrorSeed) {
  return await mirrorFixture.db.select({ id: agentQueueAdmissionJobs.id })
    .from(agentQueueAdmissionJobs).where(eq(agentQueueAdmissionJobs.companyId, seed.companyId))
    .orderBy(agentQueueAdmissionJobs.id);
}

async function scopedEvents(seed: MirrorSeed) {
  return await mirrorFixture.db.select({ id: workflowTransitionEvents.id })
    .from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, seed.companyId))
    .orderBy(workflowTransitionEvents.id);
}
