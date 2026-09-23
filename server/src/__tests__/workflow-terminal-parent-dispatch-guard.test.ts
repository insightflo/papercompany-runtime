// [purpose] terminal-parent dispatch guard — 종결 부모 run 아래 late sync 가 issue-less tool
//   후속 단계를 running+queued 로 materialize 하는 좀비 큐 행 결함(2026-09-23 RCA
//   tool-queue-claim-starvation)을 차단한다. 큐 selector 는 parent running 만 보므로,
//   종결 부모 아래 생성된 큐 행은 공식 재개 전까지 무기한 claim 되지 않았다(26.2h 사례).
//   가드는 reopen guard 플래그에 게이트된다 — off 는 legacy 동작을 유지한다.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, createDb, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  cleanupFrozenTables,
  createFrozenRun,
  markRunStatus,
  seedCompanyOnly,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  stepRunsOf,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";
import { setRunReopenGuardFlag } from "./helpers/run-reopen-guard-fixture.js";
import {
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";
import { resumeWorkflowRun } from "../services/workflow/workflow-store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("terminal-parent dispatch guard (failed run sync must not enqueue downstream tool work)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;
  const dispatch = vi.fn().mockResolvedValue({ accepted: true });

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("terminal-parent-dispatch-guard-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    dispatch.mockClear();
    setWorkflowToolStepExecutor(null);
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  async function seedFailedRunWithPendingQa(): Promise<{ companyId: string; runId: string }> {
    const { companyId } = await seedCompanyOnly(fixture.sql, "TP" + randomUUID().slice(0, 4));
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId,
      name: "single-qa-wf",
      stepsJson: [
        { id: "qa", name: "QA", agentId: "", dependencies: [], tools: ["captured-qa"], toolArgs: {} },
      ],
    });
    const run = await createFrozenRun(db, { workflowId, companyId });
    await markRunStatus(db, run.id, "failed");
    await db.insert(workflowStepRuns).values({
      workflowRunId: run.id,
      stepId: "qa",
      status: "pending",
      issueId: null,
      metadata: {},
    });
    return { companyId, runId: run.id };
  }

  const qaRowOf = async (runId: string) =>
    (await stepRunsOf(db, runId)).find((row) => row.stepId === "qa")!;

  it("keeps downstream tool work pending when reopen guard is on and the parent is already terminal", async () => {
    setWorkflowToolStepExecutor(dispatch);
    await setRunReopenGuardFlag(db, true);
    const { companyId, runId } = await seedFailedRunWithPendingQa();

    const result = await syncWorkflowRunState(db, runId);

    expect(result.status).toBe("failed");
    const qa = await qaRowOf(runId);
    expect(qa.status).toBe("pending");
    expect(qa.lastDispatchRequestId).toBeNull();
    expect(qa.lastDispatchAcceptedAt).toBeNull();
    expect(qa.lastDispatchErrorAt).toBeNull();
    const metadata = (qa.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.toolQueue).toBeUndefined();
    expect(metadata.toolInvocation).toBeUndefined();

    const queue = await processQueuedWorkflowToolStepRuns(db);
    expect(queue.claimedCount).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();

    const deferred = (await db.select().from(activityLog).where(eq(activityLog.entityId, runId)))
      .filter((row) => row.action === "workflow_run.terminal_parent_sync_deferred");
    expect(deferred).toHaveLength(1);
    const run = (await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;
    expect(run.status).toBe("failed");
    expect(companyId).toBeTruthy();
  });

  it("materializes and dispatches exactly once after the official resume restores the failed parent", async () => {
    setWorkflowToolStepExecutor(dispatch);
    await setRunReopenGuardFlag(db, true);
    const { companyId, runId } = await seedFailedRunWithPendingQa();

    await syncWorkflowRunState(db, runId);
    expect((await qaRowOf(runId)).status).toBe("pending");

    const resumed = await resumeWorkflowRun(db, runId, companyId);
    expect(resumed?.status).toBe("running");

    await syncWorkflowRunState(db, runId);
    const relaunched = await qaRowOf(runId);
    expect(relaunched.status).toBe("running");
    const metadata = (relaunched.metadata ?? {}) as Record<string, unknown>;
    expect((metadata.toolQueue as Record<string, unknown> | undefined)?.status).toBe("queued");

    const queue = await processQueuedWorkflowToolStepRuns(db);
    expect(queue).toMatchObject({ claimedCount: 1, executedCount: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      stepId: "qa",
      toolName: "captured-qa",
    }));
  });

  it("preserves legacy enqueue behavior when the reopen guard flag is off", async () => {
    setWorkflowToolStepExecutor(dispatch);
    await setRunReopenGuardFlag(db, false);
    const { runId } = await seedFailedRunWithPendingQa();

    await syncWorkflowRunState(db, runId);

    const qa = await qaRowOf(runId);
    expect(qa.status).toBe("running");
    const metadata = (qa.metadata ?? {}) as Record<string, unknown>;
    expect((metadata.toolQueue as Record<string, unknown> | undefined)?.status).toBe("queued");
  });
});
