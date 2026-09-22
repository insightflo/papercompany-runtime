import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
// The boundary module registers the heartbeat/adapters vi.mocks for this test module,
// so it must be imported before the mirror fixture/lifecycle helpers: those pull in
// the DAG engine graph, and a vi.mock only applies to modules imported after it.
import "./helpers/workflow-control-node-boundary.js";
import {
  getStepRun,
  installMechanicalQaExecutor,
  mirrorFixture,
  seedMirrorWorkflow,
  type MirrorSeed,
} from "./helpers/workflow-mirror-dag-fixture.js";
import { completeWorkflowStepIssue } from "./helpers/workflow-mirror-dag-lifecycle.js";
import { syncWorkflowRunStateWithOutcome } from "../services/workflow/dag-engine.js";

const { reviveConditionalSkipBoundary } = vi.hoisted(() => ({
  reviveConditionalSkipBoundary: vi.fn(),
}));

vi.mock("../services/workflow/conditional-skip-settlement.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workflow/conditional-skip-settlement.js")>();
  return { ...actual, reviveConditionalSkip: reviveConditionalSkipBoundary };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("engine revival proof loss", () => {
  afterEach(async () => {
    reviveConditionalSkipBoundary.mockReset();
    // The shared heartbeat fixture hook runs before the shared general cleanup and
    // cannot delete runs still referenced by activity_log. Clear that audit edge first.
    await mirrorFixture.db.delete(activityLog);
  });

  it("does not dispatch from a stale snapshot when revival cancellation is proven", async () => {
    const requests = installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("false");
    await arrangeStalePublish(seed);
    const seededWakeupIds = await scopedWakeupIds(seed);
    reviveConditionalSkipBoundary.mockImplementation(async (db: typeof mirrorFixture.db, input: {
      observedRun: { id: string };
      target: { id: string };
    }) => {
      await db.update(workflowRuns).set({ status: "cancelled" })
        .where(eq(workflowRuns.id, input.observedRun.id));
      await db.update(workflowStepRuns).set({
        status: "pending",
        completedAt: null,
        metadata: { controlFlowSkipped: false },
      }).where(eq(workflowStepRuns.id, input.target.id));
      return { kind: "cancelled" } as const;
    });

    const outcome = await syncWorkflowRunStateWithOutcome(mirrorFixture.db, seed.runId);

    expect(outcome.kind).toBe("synced");
    expect(outcome.result.status).toBe("cancelled");
    expect(reviveConditionalSkipBoundary).toHaveBeenCalledTimes(1);
    const mirror = await getStepRun(seed.runId, "mirror");
    expect(mirror.status).toBe("pending");
    const publish = await getStepRun(seed.runId, "publish");
    expect(publish).toMatchObject({ status: "pending", issueId: null, lastDispatchRequestId: null });
    const durableRun = await mirrorFixture.db.select({ status: workflowRuns.status })
      .from(workflowRuns).where(eq(workflowRuns.id, seed.runId));
    expect(durableRun).toEqual([{ status: "cancelled" }]);
    expect(requests).toHaveLength(0);
  await assertNoNewScopedWakeups(seed, seededWakeupIds);
  });

  it("does not dispatch from a stale snapshot when revival CAS is lost", async () => {
    const requests = installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("false");
    await arrangeStalePublish(seed);
    const seededWakeupIds = await scopedWakeupIds(seed);
    reviveConditionalSkipBoundary.mockImplementation(async (db: typeof mirrorFixture.db, input: {
      target: { id: string };
    }) => {
      await db.update(workflowStepRuns).set({
        status: "pending",
        completedAt: null,
        metadata: { controlFlowSkipped: false },
      }).where(eq(workflowStepRuns.id, input.target.id));
      return { kind: "no-op" } as const;
    });

    const outcome = await syncWorkflowRunStateWithOutcome(mirrorFixture.db, seed.runId);

    expect(outcome.kind).toBe("synced");
    expect(reviveConditionalSkipBoundary).toHaveBeenCalledTimes(1);
    const mirror = await getStepRun(seed.runId, "mirror");
    expect(mirror.status).toBe("pending");
    const publish = await getStepRun(seed.runId, "publish");
    expect(publish).toMatchObject({ status: "pending", issueId: null, lastDispatchRequestId: null });
    expect(requests).toHaveLength(0);
  await assertNoNewScopedWakeups(seed, seededWakeupIds);
  });
});

async function arrangeStalePublish(seed: MirrorSeed) {
  const db = mirrorFixture.db;
  // The validator is a QA gate: engine-owned revival consumes only an officially
  // submitted pass verdict. Raw issue/step mutations leave that authority absent.
  await completeWorkflowStepIssue(seed, "validator", { requireVerdictPass: true });
  const validator = await getStepRun(seed.runId, "validator");
  expect(validator).toMatchObject({ status: "completed" });
  await db.update(workflowStepRuns).set({
    status: "skipped",
    completedAt: new Date(),
    metadata: { controlFlowSkipped: true },
  }).where(and(
    eq(workflowStepRuns.workflowRunId, seed.runId),
    eq(workflowStepRuns.stepId, "mirror"),
  ));
  await db.update(workflowStepRuns).set({
    status: "completed",
    completedAt: new Date(),
    dispatchReadyAt: new Date(),
    metadata: { toolResult: { success: true } },
  }).where(and(
    eq(workflowStepRuns.workflowRunId, seed.runId),
    eq(workflowStepRuns.stepId, "mechanical-qa"),
  ));
}

async function scopedWakeupIds(seed: MirrorSeed) {
  return await mirrorFixture.db.select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.companyId, seed.companyId))
    .orderBy(agentWakeupRequests.id);
}

async function assertNoNewScopedWakeups(
  seed: MirrorSeed,
  seeded: Array<{ id: string }>,
) {
  const current = await scopedWakeupIds(seed);
  // The boundary mock keeps real heartbeat writers out, so the shared fixture cleanup
  // owns wakeup row deletion; heartbeat_runs may legitimately reference these rows.
  expect(current, "no new scoped wakeup queue rows may appear without dispatch").toEqual(seeded);
}
