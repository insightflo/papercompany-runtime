import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, workflowStepRuns, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

import { seedCompanyOnly, seedWorkflowDefinition } from "./helpers/workflow-execution-definition-fixture.js";
import {
  cleanupFrozenTables,
  createFrozenRun,
  editLiveDefinition,
  markRunStatus,
  seedToolDefinition,
  startExecutionDefinitionFixture,
  stepRunsOf,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";
import { setWorkflowToolStepExecutor, setWorkflowToolStepReadinessChecker } from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * [Task5a2a fix1] resume reset 은 캡처 control id 로만 한정됨을 증명하는 분리 파일.
 *   resume 파일 300 라인 cap 때문에 F1 에서 좁게 분리했다(narrowly named split).
 *   라이브 전용 failed control 행은 resume 전후 byte/deep-equal 이고, 그 실패 행이
 *   남아 있는 동안 launch gate(hasFailure) 가 동기 dispatch 를 보류한다는 실제 엔진
 *   동작도 함께 고정한다.
 */
describeEP("workflow frozen resume reset (bounded to captured control ids)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-resume-reset-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    setWorkflowToolStepReadinessChecker(null);
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  it("keeps a failed live-only control row byte-equal and clears only the captured IF control metadata", async () => {
    const dispatch = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(dispatch);
    const { companyId } = await seedCompanyOnly(fixture.sql, "FRR" + randomUUID().slice(0, 3));
    await seedToolDefinition(db, companyId, "captured-sync");
    const conditionGroup = {
      combinator: "all",
      conditions: [{
        source: { kind: "work_product_json", stepId: "collect", title: "decision.json", path: "$.status" },
        dataType: "string", operator: "equals", rightValue: "selected",
      }],
    } as const;
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId, name: "frozen-resume-reset",
      stepsJson: [
        { id: "collect", name: "Collect", agentId: "", dependencies: [], tools: ["captured-sync"], toolArgs: {} },
        { id: "if-decision", name: "Has selected target?", type: "if", agentId: "", dependencies: ["collect"], conditionGroup },
      ],
    });
    const run = await createFrozenRun(db, { workflowId, companyId });
    await markRunStatus(db, run.id, "failed");
    const failedAt = new Date(Date.now() - 60_000);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: run.id, stepId: "collect", status: "failed", completedAt: failedAt, metadata: {} },
      {
        workflowRunId: run.id, stepId: "if-decision", status: "failed", startedAt: failedAt, completedAt: failedAt,
        metadata: {
          controlNodeError: { message: "boom", failedAt: failedAt.toISOString() },
          controlNodeResult: { nodeType: "if", outcome: "condition_true", evaluatedAt: failedAt.toISOString() },
        },
      },
    ]);
    await editLiveDefinition(db, workflowId, {
      stepsJson: [
        { id: "collect", name: "Collect", agentId: "", dependencies: [], tools: ["live-unregistered-tool"], toolArgs: {} },
        { id: "live-if", name: "Live if", type: "if", agentId: "", dependencies: ["collect"], conditionGroup },
      ],
    });
    // Persisted failed live-only control row (startedAt non-null → not "unlaunched", stays failed).
    const [liveIfRow] = await db.insert(workflowStepRuns).values({
      workflowRunId: run.id, stepId: "live-if", status: "failed", startedAt: failedAt, completedAt: failedAt,
      lastDispatchErrorAt: failedAt, lastDispatchErrorSummary: "live control failed",
      metadata: { controlNodeError: { message: "live boom", failedAt: failedAt.toISOString() } },
    }).returning();
    setWorkflowToolStepReadinessChecker(async ({ toolNames }) =>
      toolNames.every((name) => name === "captured-sync")
        ? { available: true }
        : { available: false, reason: "live-only-tool referenced" });

    await workflowService.resumeRun(db, { runId: run.id, companyId });

    const rows = await stepRunsOf(db, run.id);
    // Live-only control row: byte/deep-equal — the reset never touches non-captured ids.
    expect(rows.find((candidate) => candidate.stepId === "live-if")).toEqual(liveIfRow);
    // Captured IF control: reset to pending, control metadata cleared (engine-synced marker remains).
    const ifRow = rows.find((candidate) => candidate.stepId === "if-decision")!;
    expect(ifRow.status).toBe("pending");
    expect(ifRow.startedAt).toBeNull();
    expect(ifRow.completedAt).toBeNull();
    expect(ifRow.metadata).toEqual({ graphWorkProductRequired: false });
    // The failed live-only row keeps the launch gate (hasFailure) closed, so the captured collect
    // dispatch is deferred: reset failed→pending (unlaunched recovery), no synchronous dispatch yet.
    // Source: dag-engine syncWorkflowRunState `if (!hasFailure || hasConditionalEdges || hasStructuralGates)`.
    const collectRow = rows.find((candidate) => candidate.stepId === "collect")!;
    expect(collectRow.status).toBe("pending");
    expect(collectRow.lastDispatchRequestId).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
