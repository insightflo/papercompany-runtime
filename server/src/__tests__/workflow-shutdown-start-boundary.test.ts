import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import {
  cleanupFrozenTables,
  createFrozenRun,
  markRunStatus,
  seedCompanyOnly,
  seedCompanyWithMission,
  seedQueuedToolStepRun,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  stepRunsOf,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";
import {
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
  type WorkflowToolStepExecutionRequest,
} from "../services/workflow/dag-engine.js";

describe("workflow shutdown start boundary", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("shutdown-tool-boundary-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  async function seedQueuedRun(withMission: boolean) {
    const prefix = `SB${randomUUID().replace(/-/gu, "").slice(0, 6).toUpperCase()}`;
    const owner = withMission
      ? await seedCompanyWithMission(fixture.sql, prefix)
      : { ...(await seedCompanyOnly(fixture.sql, prefix)), missionId: undefined };
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId: owner.companyId,
      stepsJson: [{ id: "publish", name: "Publish", agentId: "", dependencies: [], tools: ["publish"], toolArgs: {} }],
    });
    const run = await createFrozenRun(db, {
      workflowId,
      companyId: owner.companyId,
      ...(owner.missionId ? { missionId: owner.missionId } : {}),
    });
    await markRunStatus(db, run.id, "running");
    const requestId = `${run.id}:publish:${Date.now()}`;
    const queued = await seedQueuedToolStepRun(db, { runId: run.id, stepId: "publish", requestId });
    return { runId: run.id, requestId, queued };
  }

  function deferred(request: WorkflowToolStepExecutionRequest, generation: number) {
    return {
      deferredBeforeStart: {
        kind: "deferred_before_start" as const,
        version: 1 as const,
        reasonCode: "runtime_shutting_down" as const,
        externalStarted: false as const,
        requestId: request.requestId,
        executionId: request.workflowRunId,
        attemptId: request.stepRunId,
        executionGeneration: generation,
      },
    };
  }

  it("restores the same durable request and dispatches it once on the next tick", async () => {
    const seeded = await seedQueuedRun(true);
    const execute = vi.fn(async (request: WorkflowToolStepExecutionRequest) =>
      deferred(request, seeded.queued.executionGeneration));
    setWorkflowToolStepExecutor(execute);

    const first = await processQueuedWorkflowToolStepRuns(db);
    const [restored] = await stepRunsOf(db, seeded.runId);

    expect(first).toMatchObject({ claimedCount: 1, executedCount: 0, failedCount: 0, skippedCount: 1 });
    expect(restored).toMatchObject({
      id: seeded.queued.id,
      status: "running",
      lastDispatchRequestId: seeded.requestId,
      lastDispatchAcceptedAt: null,
      lastDispatchErrorAt: null,
    });
    expect(restored!.metadata).toMatchObject({
      toolQueue: { status: "queued" },
      toolInvocation: { requestId: seeded.requestId, toolName: "publish", args: {} },
    });
    expect(restored!.metadata.toolQueue).not.toHaveProperty("claimedAt");
    expect(restored!.metadata.toolInvocation).not.toHaveProperty("dispatchedAt");

    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    const second = await processQueuedWorkflowToolStepRuns(db);
    expect(second).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
    expect((await stepRunsOf(db, seeded.runId))[0]!.lastDispatchAcceptedAt).toBeInstanceOf(Date);
  });

  it("fails closed when the deferred control identity does not match the claimed generation", async () => {
    const seeded = await seedQueuedRun(false);
    setWorkflowToolStepExecutor(async (request) =>
      deferred(request, seeded.queued.executionGeneration + 1));

    const result = await processQueuedWorkflowToolStepRuns(db);
    const [current] = await stepRunsOf(db, seeded.runId);

    expect(result).toMatchObject({ claimedCount: 1, executedCount: 0, failedCount: 1, skippedCount: 0 });
    expect(current!.lastDispatchErrorAt).toBeInstanceOf(Date);
    expect(current!.metadata.toolQueue).toMatchObject({ status: "settled" });
  });

  it.each(["cancelled_run", "new_generation", "new_owner"] as const)(
    "does not revive a deferred claim after the %s race",
    async (race) => {
      const seeded = await seedQueuedRun(false);
      setWorkflowToolStepExecutor(async (request) => {
        if (race === "cancelled_run") {
          await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, seeded.runId));
        } else if (race === "new_generation") {
          await db.update(workflowStepRuns).set({
            executionGeneration: sql`${workflowStepRuns.executionGeneration} + 1`,
          }).where(eq(workflowStepRuns.id, seeded.queued.id));
        } else {
          await db.update(workflowStepRuns).set({
            lastDispatchRequestId: `${seeded.requestId}:replacement`,
            lastDispatchAcceptedAt: new Date(Date.now() + 5_000),
          }).where(eq(workflowStepRuns.id, seeded.queued.id));
        }
        return deferred(request, seeded.queued.executionGeneration);
      });

      const result = await processQueuedWorkflowToolStepRuns(db);
      const [current] = await stepRunsOf(db, seeded.runId);

      expect(result).toMatchObject({ claimedCount: 1, executedCount: 0, failedCount: 0, skippedCount: 1 });
      expect(current!.lastDispatchAcceptedAt).toBeInstanceOf(Date);
      expect(current!.metadata.toolQueue).toMatchObject({ status: "claimed" });
    },
  );
});
