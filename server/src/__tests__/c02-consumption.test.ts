import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, companies, createDb, instanceSettings, workflowRuns, workflowStepRuns,
  workflowTerminalDecisions, workflowTerminalEffectIntents, workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { setupWorkflow } from "./helpers/workflow-step-retry-fixtures.js";
import { cleanupTerminalBoundaryTables } from "./helpers/run-terminal-boundary-fixture.js";
import { setRunTerminalBoundaryFlag } from "./helpers/run-terminal-boundary-integration-fixtures.js";
import {
  completeWorkflowToolStepFromResult,
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
  syncWorkflowRunState,
  type WorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping C02 consumption tests: ${support.reason ?? "unsupported host"}`);

describeEP("C02 stage 2: existing tool result acceptance and run finalization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("c02-consumption-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await db.delete(workflowTransitionEvents);
    await db.delete(instanceSettings);
    await cleanupTerminalBoundaryTables(db);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  // Stage-2 preservation contract: workflow-dag-engine.test.ts:5764,5788,5828
  // requires public completion, durable success and duplicate no-op behavior.
  // run-terminal-boundary-integration.test.ts:81 defines flag-gated decision ownership.
  it.each([false, true])("boundary=%s: persists success once through the public completion path", async (enabled) => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "C02ConsumptionCo", status: "active" });
    await setRunTerminalBoundaryFlag(db, enabled);
    const { runId } = await setupWorkflow(db, companyId, [{
      id: "collect", name: "Collect", type: "tool", agentId: "", dependencies: [],
      toolNames: ["collect-data"], toolArgs: { source: "c02" },
    }]);
    // Only external execution is replaced; queue claim, acceptance and final writers remain real.
    const executeToolStep = vi.fn<WorkflowToolStepExecutor>().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(executeToolStep);

    expect((await syncWorkflowRunState(db, runId)).status).toBe("running");
    expect(executeToolStep).not.toHaveBeenCalled();
    expect(await processQueuedWorkflowToolStepRuns(db)).toMatchObject({
      claimedCount: 1, executedCount: 1, failedCount: 0,
    });
    expect(executeToolStep).toHaveBeenCalledTimes(1);
    const request = executeToolStep.mock.calls[0]![0];
    const [dispatched] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(dispatched).toMatchObject({
      stepId: "collect", status: "running", issueId: null,
      lastDispatchRequestId: request.requestId,
    });
    expect(dispatched!.lastDispatchAcceptedAt).toBeInstanceOf(Date);
    expect(request).toMatchObject({
      companyId, workflowRunId: runId, stepRunId: dispatched!.id,
      stepId: "collect", toolName: "collect-data", args: { source: "c02" },
    });
    expect(await db.select().from(workflowTerminalDecisions)
      .where(eq(workflowTerminalDecisions.workflowRunId, runId))).toHaveLength(0);

    const data = { ok: true, records: [{ id: "c02-record", value: 7 }] };
    const input = {
      companyId, stepRunId: dispatched!.id, requestId: request.requestId,
      workflowRunId: runId, stepId: "collect", toolName: "collect-data",
      success: true, data, stdout: JSON.stringify(data), stderr: "", exitCode: 0,
    };
    const result = await completeWorkflowToolStepFromResult(db, input);
    expect(result?.status).toBe("completed");
    const [completedStep] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, dispatched!.id));
    const [completedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(completedStep).toMatchObject({
      status: "completed", issueId: null,
      metadata: { toolResult: {
        requestId: request.requestId, toolName: "collect-data", success: true,
        data, stdout: JSON.stringify(data), stderr: "", exitCode: 0, error: null,
      } },
    });
    expect(completedStep!.completedAt).toBeInstanceOf(Date);
    expect(completedStep!.metadata).toMatchObject({
      toolResult: { completedAt: completedStep!.completedAt!.toISOString() },
    });
    expect(completedRun).toMatchObject({ status: "completed" });
    expect(completedRun!.completedAt).toBeInstanceOf(Date);
    const decisions = await db.select().from(workflowTerminalDecisions)
      .where(eq(workflowTerminalDecisions.workflowRunId, runId));
    expect(decisions).toHaveLength(enabled ? 1 : 0);
    if (enabled) expect(decisions[0]).toMatchObject({
      decision: "completed", policyCause: "outcome_convergence",
      discoveryPath: "engine_recompute", origin: "dag_engine",
    });
    const intents = await db.select().from(workflowTerminalEffectIntents)
      .where(eq(workflowTerminalEffectIntents.companyId, companyId)).orderBy(workflowTerminalEffectIntents.id);
    const transitions = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowRunId, runId)).orderBy(workflowTransitionEvents.id);
    const activities = await db.select().from(activityLog)
      .where(eq(activityLog.companyId, companyId)).orderBy(activityLog.id);

    const duplicate = await completeWorkflowToolStepFromResult(db, input);
    expect(duplicate).toEqual(result);
    expect(await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, dispatched!.id))).toEqual([completedStep]);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId))).toEqual([completedRun]);
    expect(await db.select().from(workflowTerminalDecisions)
      .where(eq(workflowTerminalDecisions.workflowRunId, runId))).toEqual(decisions);
    expect(await db.select().from(workflowTerminalEffectIntents)
      .where(eq(workflowTerminalEffectIntents.companyId, companyId))
      .orderBy(workflowTerminalEffectIntents.id)).toEqual(intents);
    expect(await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowRunId, runId))
      .orderBy(workflowTransitionEvents.id)).toEqual(transitions);
    expect(await db.select().from(activityLog)
      .where(eq(activityLog.companyId, companyId)).orderBy(activityLog.id)).toEqual(activities);
    expect(executeToolStep).toHaveBeenCalledTimes(1);
  });
});
