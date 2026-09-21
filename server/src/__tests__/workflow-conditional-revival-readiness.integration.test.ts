import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { resetControlNodeBoundary } from "./helpers/workflow-control-node-boundary.js";
import { installMechanicalQaExecutor, mirrorFixture, seedMirrorWorkflow } from "./helpers/workflow-mirror-dag-fixture.js";
import { reviveConditionalSkip, type ConditionalStepObservation } from "../services/workflow/conditional-skip-settlement.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function observation(row: typeof workflowStepRuns.$inferSelect): ConditionalStepObservation {
  return {
    id: row.id,
    workflowRunId: row.workflowRunId,
    stepId: row.stepId,
    status: row.status,
    issueId: row.issueId,
    startedAt: row.startedAt,
    lastDispatchAttemptAt: row.lastDispatchAttemptAt,
    dispatchReadyAt: row.dispatchReadyAt,
    executionGeneration: row.executionGeneration,
    metadata: row.metadata,
  };
}

async function stepRunMap(runId: string) {
  const rows = await mirrorFixture.db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));
  return new Map(rows.map((row) => [row.stepId, row]));
}

async function getRun(runId: string) {
  const [row] = await mirrorFixture.db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId));
  expect(row).toBeTruthy();
  return row!;
}

async function capturedRevivable(runId: string) {
  const rows = await stepRunMap(runId);
  const mechanicalQa = rows.get("mechanical-qa")!;
  const publish = rows.get("publish")!;
  await mirrorFixture.db
    .update(workflowStepRuns)
    .set({
      status: "completed",
      issueId: null,
      completedAt: new Date(),
      dispatchReadyAt: new Date(),
      metadata: { ...mechanicalQa.metadata, controlFlowSkipped: false },
    })
    .where(eq(workflowStepRuns.id, mechanicalQa.id));
  await mirrorFixture.db
    .update(workflowStepRuns)
    .set({
      status: "skipped",
      issueId: null,
      startedAt: null,
      completedAt: new Date(),
      dispatchReadyAt: new Date(),
      executionGeneration: 7,
      dispatchOwnerWakeupRequestId: null,
      dispatchOwnerHeartbeatRunId: null,
      evidenceReadyAt: new Date(),
      metadata: { ...publish.metadata, controlFlowSkipped: true },
    })
    .where(eq(workflowStepRuns.id, publish.id));
  const refreshed = await stepRunMap(runId);
  const target = refreshed.get("publish")!;
  return {
    run: await getRun(runId),
    target,
    predecessors: [...refreshed.values()]
      .filter((row) => row.id !== target.id)
      .map(observation),
  };
}

describeEmbeddedPostgres("engine-owned conditional revival readiness", () => {
  beforeAll(() => {
    resetControlNodeBoundary();
    mirrorFixture.db;
  });

  afterEach(async () => {
    await mirrorFixture.db.delete(heartbeatRunEvents);
    await mirrorFixture.db.delete(heartbeatRuns);
    await mirrorFixture.db.delete(agentWakeupRequests);
  });

  it("clears readiness and advances the captured generation", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    const captured = await capturedRevivable(seed.runId);

    const result = await reviveConditionalSkip(mirrorFixture.db, {
      observedRun: captured.run,
      target: observation(captured.target),
      nextMetadata: { ...captured.target.metadata, controlFlowSkipped: false },
      observedPredecessors: captured.predecessors,
      invalidateGeneration: true,
    });
    const rows = await stepRunMap(seed.runId);
    const revived = rows.get("publish")!;

    expect(result).toMatchObject({
      kind: "settled",
      executionGeneration: captured.target.executionGeneration + 1,
    });
    expect(revived).toMatchObject({
      status: "pending",
      dispatchReadyAt: null,
      evidenceReadyAt: null,
      executionGeneration: captured.target.executionGeneration + 1,
      dispatchOwnerWakeupRequestId: null,
      dispatchOwnerHeartbeatRunId: null,
    });
    expect(revived.metadata).not.toMatchObject({ controlFlowSkipped: true });
  });

  it("refuses a stale target generation captured before a competing write", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    const captured = await capturedRevivable(seed.runId);
    await mirrorFixture.db
      .update(workflowStepRuns)
      .set({ executionGeneration: captured.target.executionGeneration + 1 })
      .where(eq(workflowStepRuns.id, captured.target.id));

    const result = await reviveConditionalSkip(mirrorFixture.db, {
      observedRun: captured.run,
      target: observation(captured.target),
      nextMetadata: { ...captured.target.metadata, controlFlowSkipped: false },
      observedPredecessors: captured.predecessors,
      invalidateGeneration: true,
    });
    const rows = await stepRunMap(seed.runId);

    expect(result).toEqual({ kind: "no-op" });
    expect(rows.get("publish")).toMatchObject({
      status: "skipped",
      executionGeneration: captured.target.executionGeneration + 1,
      dispatchReadyAt: expect.any(Date),
    });
  });

  it("refuses a stale predecessor generation captured before a competing write", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    const captured = await capturedRevivable(seed.runId);
    const mechanicalQa = captured.predecessors.find((row) => row.stepId === "mechanical-qa")!;
    await mirrorFixture.db
      .update(workflowStepRuns)
      .set({ executionGeneration: mechanicalQa.executionGeneration + 1 })
      .where(eq(workflowStepRuns.id, mechanicalQa.id));

    const result = await reviveConditionalSkip(mirrorFixture.db, {
      observedRun: captured.run,
      target: observation(captured.target),
      nextMetadata: { ...captured.target.metadata, controlFlowSkipped: false },
      observedPredecessors: captured.predecessors,
      invalidateGeneration: true,
    });
    const rows = await stepRunMap(seed.runId);

    expect(result).toEqual({ kind: "no-op" });
    expect(rows.get("publish")).toMatchObject({
      status: "skipped",
      executionGeneration: captured.target.executionGeneration,
      dispatchReadyAt: expect.any(Date),
    });
  });

  it("refuses a stale predecessor readiness fact captured before a competing write", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    const captured = await capturedRevivable(seed.runId);
    const mechanicalQa = captured.predecessors.find((row) => row.stepId === "mechanical-qa")!;
    await mirrorFixture.db
      .update(workflowStepRuns)
      .set({ dispatchReadyAt: null })
      .where(eq(workflowStepRuns.id, mechanicalQa.id));

    const result = await reviveConditionalSkip(mirrorFixture.db, {
      observedRun: captured.run,
      target: observation(captured.target),
      nextMetadata: { ...captured.target.metadata, controlFlowSkipped: false },
      observedPredecessors: captured.predecessors,
      invalidateGeneration: true,
    });
    const rows = await stepRunMap(seed.runId);

    expect(result).toEqual({ kind: "no-op" });
    expect(rows.get("publish")).toMatchObject({
      status: "skipped",
      executionGeneration: captured.target.executionGeneration,
      dispatchReadyAt: expect.any(Date),
    });
  });

  it("refuses cancellation observed after revival proof was captured", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    const captured = await capturedRevivable(seed.runId);
    await mirrorFixture.db
      .update(workflowRuns)
      .set({ status: "cancelled" })
      .where(eq(workflowRuns.id, seed.runId));

    const result = await reviveConditionalSkip(mirrorFixture.db, {
      observedRun: captured.run,
      target: observation(captured.target),
      nextMetadata: { ...captured.target.metadata, controlFlowSkipped: false },
      observedPredecessors: captured.predecessors,
      invalidateGeneration: true,
    });
    const rows = await stepRunMap(seed.runId);

    expect(result).toEqual({ kind: "cancelled" });
    expect(rows.get("publish")).toMatchObject({
      status: "skipped",
      executionGeneration: captured.target.executionGeneration,
      dispatchReadyAt: expect.any(Date),
    });
  });
});
