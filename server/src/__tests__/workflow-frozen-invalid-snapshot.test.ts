import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const { heartbeatWakeup } = vi.hoisted(() => ({ heartbeatWakeup: vi.fn() }));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: () => ({ wakeup: heartbeatWakeup }) };
});
vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) =>
      actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup: heartbeatWakeup } }),
  };
});

import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  createFrozenRun,
  markRunStatus,
  seedCompanyOnly,
  seedToolDefinition,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  stepRunsOf,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./helpers/workflow-frozen-execution-fixture.js";
import {
  completeWorkflowToolStepFromResult,
  executeWorkflowRun,
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

const snapshotStates = ["missing", "corrupt"] as const;
type SnapshotState = (typeof snapshotStates)[number];

/** missing = snapshot row 삭제, corrupt = steps tamper(definition_hash 대조 실패). */
async function breakSnapshot(state: SnapshotState, sql: RawSql, runId: string): Promise<void> {
  if (state === "missing") {
    await sql`DELETE FROM workflow_run_definitions WHERE workflow_run_id = ${runId}`;
  } else {
    await corruptSnapshotSteps(sql, runId);
  }
}

// Requeue the captured row in place: (workflow_run_id, step_id) is unique.
// All setup writes precede the snapshot corruption and no-mutation baseline.
async function seedQueuedToolStepRun(db: Db, input: { runId: string; stepId: string; requestId: string }) {
  const [row] = await db.update(workflowStepRuns).set({
    status: "running",
    issueId: null,
    startedAt: null,
    completedAt: null,
    lastDispatchRequestId: input.requestId,
    lastDispatchAcceptedAt: null,
    lastDispatchErrorAt: null,
    metadata: { toolQueue: { status: "queued", queuedAt: new Date().toISOString() } },
  }).where(and(
    eq(workflowStepRuns.workflowRunId, input.runId),
    eq(workflowStepRuns.stepId, input.stepId),
  )).returning();
  if (!row) throw new Error("Expected captured step row to requeue");
  return row;
}

describeEP("workflow frozen invalid snapshots (durable no-mutation at all execution boundaries)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-invalid-snapshot-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    setWorkflowToolStepExecutor(null);
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  /** 실행 전체 run 행 + 모든 step 행 — full no-write 증명 기준. */
  async function runAndStepRows(runId: string) {
    return {
      run: (await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0] ?? null,
      stepRuns: await stepRunsOf(db, runId),
    };
  }

  /** 실제 createFrozenRun(capture 포함) + 실제 캡처된 failed IF control/collect 행. */
  async function seedFrozenRunWithFailedCapturedRows() {
    const { companyId } = await seedCompanyOnly(fixture.sql, "FV" + randomUUID().slice(0, 3));
    await seedToolDefinition(db, companyId, "captured-sync");
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId, name: "frozen-invalid-snapshot",
      stepsJson: [
        { id: "collect", name: "Collect", agentId: "", dependencies: [], tools: ["captured-sync"], toolArgs: { target: "hub" } },
        {
          id: "if-decision", name: "Has selected target?", type: "if", agentId: "", dependencies: ["collect"],
          conditionGroup: {
            combinator: "all",
            conditions: [{
              source: { kind: "work_product_json", stepId: "collect", title: "decision.json", path: "$.status" },
              dataType: "string", operator: "equals", rightValue: "selected",
            }],
          },
        },
      ],
    });
    const run = await createFrozenRun(db, { workflowId, companyId });
    await markRunStatus(db, run.id, "failed");
    const failedAt = new Date(Date.now() - 30_000);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: run.id, stepId: "collect", status: "failed", completedAt: failedAt, metadata: {} },
      {
        workflowRunId: run.id, stepId: "if-decision", status: "failed", startedAt: failedAt, completedAt: failedAt,
        metadata: { controlNodeError: { message: "boom", failedAt: failedAt.toISOString() } },
      },
    ]);
    await db.update(workflowRuns).set({ startedAt: failedAt }).where(eq(workflowRuns.id, run.id));
    return { companyId, runId: run.id };
  }

  it.each(snapshotStates)("resumeRun rejects a %s snapshot with 422 and zero mutation (full run+step proof)", async (state) => {
    const dispatch = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(dispatch);
    const { companyId, runId } = await seedFrozenRunWithFailedCapturedRows();
    await breakSnapshot(state, fixture.sql, runId);
    const before = await runAndStepRows(runId);

    const error = await captureHttpError(workflowService.resumeRun(db, { runId, companyId }));

    expect(error.status).toBe(422);
    expect(error.message).toBe("historical_definition_unproven");
    expect(await runAndStepRows(runId)).toEqual(before);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(snapshotStates)("executeWorkflowRun rejects a %s snapshot with 422 and zero mutation (full run+step proof)", async (state) => {
    const dispatch = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(dispatch);
    const { companyId, runId } = await seedFrozenRunWithFailedCapturedRows();
    await breakSnapshot(state, fixture.sql, runId);
    const before = await runAndStepRows(runId);

    const error = await captureHttpError(executeWorkflowRun(db, runId));

    expect(error.status).toBe(422);
    expect(error.message).toBe("historical_definition_unproven");
    expect(await runAndStepRows(runId)).toEqual(before);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(snapshotStates)("queue processor rejects a %s snapshot with 422 and zero mutation (full run+step proof)", async (state) => {
    const dispatch = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(dispatch);
    const { companyId, runId } = await seedFrozenRunWithFailedCapturedRows();
    await markRunStatus(db, runId, "running");
    const requestId = `${runId}:collect:${Date.now()}`;
    await seedQueuedToolStepRun(db, { runId, stepId: "collect", requestId });
    await breakSnapshot(state, fixture.sql, runId);
    const before = await runAndStepRows(runId);

    const error = await captureHttpError(processQueuedWorkflowToolStepRuns(db));

    expect(error.status).toBe(422);
    expect(error.message).toBe("historical_definition_unproven");
    expect(await runAndStepRows(runId)).toEqual(before);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(snapshotStates)("completion rejects a %s snapshot with 422 and zero mutation (full run+step proof)", async (state) => {
    const dispatch = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(dispatch);
    const { companyId, runId } = await seedFrozenRunWithFailedCapturedRows();
    await markRunStatus(db, runId, "running");
    const requestId = `${runId}:collect:${Date.now()}`;
    const queued = await seedQueuedToolStepRun(db, { runId, stepId: "collect", requestId });
    // Simulate the claim the completion boundary consumes (processor itself would 422 first).
    await db.update(workflowStepRuns).set({ lastDispatchAcceptedAt: new Date() })
      .where(eq(workflowStepRuns.id, queued.id));
    await breakSnapshot(state, fixture.sql, runId);
    const before = await runAndStepRows(runId);

    const error = await captureHttpError(completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: queued.id, requestId, toolName: "captured-sync",
      success: true, stdout: "published", data: { v: 1 }, exitCode: 0,
    }));

    expect(error.status).toBe(422);
    expect(error.message).toBe("historical_definition_unproven");
    expect(await runAndStepRows(runId)).toEqual(before);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
