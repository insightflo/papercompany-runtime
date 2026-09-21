import { randomUUID } from "node:crypto";
import { beforeAll, afterEach, describe, expect, it } from "vitest";
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
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { settleConditionalSkip, type ConditionalStepObservation } from "../services/workflow/conditional-skip-settlement.js";

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

async function capturedFastPath(runId: string) {
  const seeded = await stepRunMap(runId);
  const seededMirror = seeded.get("mirror")!;
  const metadata = { ...(seededMirror.metadata ?? {}) };
  delete metadata.controlFlowSkipped;
  await mirrorFixture.db
    .update(workflowStepRuns)
    .set({
      status: "pending",
      issueId: null,
      startedAt: null,
      lastDispatchAttemptAt: null,
      completedAt: null,
      dispatchReadyAt: null,
      metadata,
    })
    .where(eq(workflowStepRuns.id, seededMirror.id));
  const rows = await stepRunMap(runId);
  const mirror = rows.get("mirror")!;
  return {
    mirror,
    predecessors: [...rows.values()]
      .filter((row) => row.id !== mirror.id)
      .map(observation),
  };
}

describeEmbeddedPostgres("engine-owned conditional skip settlement", () => {
  beforeAll(() => {
    resetControlNodeBoundary();
    mirrorFixture.db;
  });

  afterEach(async () => {
    await mirrorFixture.db.delete(heartbeatRunEvents);
    await mirrorFixture.db.delete(heartbeatRuns);
    await mirrorFixture.db.delete(agentWakeupRequests);
  });

  it("sets dispatchReadyAt when issue-less pending steps are proven unreachable", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");

    await syncWorkflowRunState(mirrorFixture.db, seed.runId, "workflow_sync");
    const rows = await stepRunMap(seed.runId);

    for (const stepId of ["validator", "mirror"]) {
      expect(rows.get(stepId)).toMatchObject({ status: "skipped", issueId: null });
      expect(rows.get(stepId)?.dispatchReadyAt).toBeInstanceOf(Date);
      expect(rows.get(stepId)?.metadata).toMatchObject({ controlFlowSkipped: true });
    }
  });

  it("refuses a stale target generation captured before a competing write", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    const run = await getRun(seed.runId);
    const captured = await capturedFastPath(seed.runId);

    await mirrorFixture.db
      .update(workflowStepRuns)
      .set({ executionGeneration: captured.mirror.executionGeneration + 1 })
      .where(eq(workflowStepRuns.id, captured.mirror.id));
    const result = await settleConditionalSkip(mirrorFixture.db, {
      observedRun: run,
      target: observation(captured.mirror),
      nextMetadata: { ...captured.mirror.metadata, controlFlowSkipped: true },
      observedPredecessors: captured.predecessors,
    });
    const rows = await stepRunMap(seed.runId);

    expect(result).toEqual({ kind: "no-op" });
    expect(rows.get("mirror")).toMatchObject({
      status: "pending",
      executionGeneration: captured.mirror.executionGeneration + 1,
      issueId: null,
      startedAt: null,
      lastDispatchAttemptAt: null,
      completedAt: null,
      dispatchReadyAt: null,
      metadata: captured.mirror.metadata,
    });
  });

  it("refuses a stale predecessor generation captured before a competing write", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    const run = await getRun(seed.runId);
    const captured = await capturedFastPath(seed.runId);
    const validator = captured.predecessors.find((row) => row.stepId === "validator")!;

    await mirrorFixture.db
      .update(workflowStepRuns)
      .set({ executionGeneration: validator.executionGeneration + 1 })
      .where(eq(workflowStepRuns.id, validator.id));
    const result = await settleConditionalSkip(mirrorFixture.db, {
      observedRun: run,
      target: observation(captured.mirror),
      nextMetadata: { ...captured.mirror.metadata, controlFlowSkipped: true },
      observedPredecessors: captured.predecessors,
    });
    const rows = await stepRunMap(seed.runId);

    expect(result).toEqual({ kind: "no-op" });
    expect(rows.get("mirror")).toMatchObject({
      status: "pending",
      executionGeneration: captured.mirror.executionGeneration,
      issueId: null,
      startedAt: null,
      lastDispatchAttemptAt: null,
      completedAt: null,
      dispatchReadyAt: null,
      metadata: captured.mirror.metadata,
    });
  });

  it("refuses a stale predecessor readiness fact captured before a competing write", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    const run = await getRun(seed.runId);
    const captured = await capturedFastPath(seed.runId);
    const validator = captured.predecessors.find((row) => row.stepId === "validator")!;
    await mirrorFixture.db
      .update(workflowStepRuns)
      .set({ dispatchReadyAt: new Date(validator.dispatchReadyAt!.getTime() + 1) })
      .where(eq(workflowStepRuns.id, validator.id));
    const result = await settleConditionalSkip(mirrorFixture.db, {
      observedRun: run,
      target: observation(captured.mirror),
      nextMetadata: { ...captured.mirror.metadata, controlFlowSkipped: true },
      observedPredecessors: captured.predecessors,
    });
    const rows = await stepRunMap(seed.runId);

    expect(result).toEqual({ kind: "no-op" });
    expect(rows.get("mirror")).toMatchObject({
      status: "pending",
      executionGeneration: captured.mirror.executionGeneration,
      dispatchReadyAt: null,
    });
  });

  it("refuses cancellation observed after settlement proof was captured", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    const run = await getRun(seed.runId);
    const captured = await capturedFastPath(seed.runId);
    await mirrorFixture.db
      .update(workflowRuns)
      .set({ status: "cancelled" })
      .where(eq(workflowRuns.id, seed.runId));

    const result = await settleConditionalSkip(mirrorFixture.db, {
      observedRun: run,
      target: observation(captured.mirror),
      nextMetadata: { ...captured.mirror.metadata, controlFlowSkipped: true },
      observedPredecessors: captured.predecessors,
    });
    const rows = await stepRunMap(seed.runId);

    expect(result).toEqual({ kind: "cancelled" });
    expect(rows.get("mirror")).toMatchObject({
      status: "pending",
      executionGeneration: captured.mirror.executionGeneration,
      issueId: null,
      startedAt: null,
      lastDispatchAttemptAt: null,
      completedAt: null,
      dispatchReadyAt: null,
      metadata: captured.mirror.metadata,
    });
  });

  it("refuses a run identity outside the target company", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    const run = await getRun(seed.runId);
    const captured = await capturedFastPath(seed.runId);

    const result = await settleConditionalSkip(mirrorFixture.db, {
      observedRun: { ...run, companyId: randomUUID() },
      target: observation(captured.mirror),
      nextMetadata: { ...captured.mirror.metadata, controlFlowSkipped: true },
      observedPredecessors: captured.predecessors,
    });
    const rows = await stepRunMap(seed.runId);

    expect(result).toEqual({ kind: "cancelled" });
    expect(rows.get("mirror")).toMatchObject({
      status: "pending",
      executionGeneration: captured.mirror.executionGeneration,
      issueId: null,
      startedAt: null,
      lastDispatchAttemptAt: null,
      completedAt: null,
      dispatchReadyAt: null,
      metadata: captured.mirror.metadata,
    });
  });
});
