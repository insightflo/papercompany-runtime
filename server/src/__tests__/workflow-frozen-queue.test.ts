import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, issues, workflowDelegations, workflowStepRuns, type Db } from "@paperclipai/db";
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
  editLiveDefinition,
  markRunStatus,
  seedCompanyOnly,
  seedQueuedToolStepRun,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  stepRunsOf,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";
import { processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("workflow frozen queue dispatch (captured tool contract survives live edits)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-queue-");
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

  async function seedInspectionSyncWorkflow(liveSteps?: unknown[]) {
    const { companyId } = await seedCompanyOnly(fixture.sql, "FQ" + randomUUID().slice(0, 4));
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId,
      name: "inspection-then-sync",
      stepsJson: [
        { id: "inspection", name: "Inspection", agentId: "", dependencies: [], tools: ["captured-inspect"], toolArgs: {} },
        {
          id: "sync-dashboard",
          name: "Sync dashboard",
          agentId: "",
          dependencies: [],
          conditionalDependencies: [{ stepId: "inspection", when: "always" }],
          tools: ["captured-sync"],
          toolArgs: { target: "hub" },
        },
      ],
    });
    const run = await createFrozenRun(db, { workflowId, companyId });
    await markRunStatus(db, run.id, "running");
    if (liveSteps) await editLiveDefinition(db, workflowId, { stepsJson: liveSteps });
    return { companyId, workflowId, runId: run.id };
  }

  async function seedTerminalInspection(runId: string) {
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "inspection",
      status: "completed",
      issueId: null,
      completedAt: new Date(),
      metadata: {},
    });
  }

  it("skips while the captured when:always predecessor is non-terminal, then dispatches exactly once after the same-row gate transition", async () => {
    const dispatch = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(dispatch);
    const { runId } = await seedInspectionSyncWorkflow([
      { id: "inspection", name: "Inspection", agentId: "", dependencies: [], tools: ["captured-inspect"], toolArgs: {} },
      // Live edit: edge removed + tool swapped — frozen gate/tool must still rule.
      { id: "sync-dashboard", name: "Sync dashboard", agentId: "", dependencies: [], tools: ["live-tool"], toolArgs: {} },
    ]);
    const [inspectionRow] = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: "inspection", status: "running", issueId: null, metadata: {},
    }).returning();
    const requestId = `${runId}:sync-dashboard:${Date.now()}`;
    const queuedRow = await seedQueuedToolStepRun(db, { runId, stepId: "sync-dashboard", requestId });

    const result = await processQueuedWorkflowToolStepRuns(db);

    expect(result.skippedCount).toBeGreaterThanOrEqual(1);
    expect(dispatch).not.toHaveBeenCalled();
    const row = (await stepRunsOf(db, runId)).find((candidate) => candidate.stepId === "sync-dashboard")!;
    expect(row.lastDispatchAcceptedAt).toBeNull();
    expect(row.lastDispatchRequestId).toBe(requestId);

    // Same inspection row goes terminal; the SAME queued request is reprocessed.
    await db.update(workflowStepRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(workflowStepRuns.id, inspectionRow!.id));

    const second = await processQueuedWorkflowToolStepRuns(db);

    expect(second).toMatchObject({ claimedCount: 1, executedCount: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      stepId: "sync-dashboard",
      toolName: "captured-sync",
      args: { target: "hub" },
      requestId,
    }));
    expect(queuedRow.lastDispatchRequestId).toBe(requestId);
    const rows = await stepRunsOf(db, runId);
    expect(rows.map((candidate) => candidate.stepId).sort()).toEqual(["inspection", "sync-dashboard"]);
    const claimedRow = rows.find((candidate) => candidate.stepId === "sync-dashboard")!;
    expect(claimedRow.lastDispatchAcceptedAt).toBeInstanceOf(Date);
    expect(claimedRow.lastDispatchRequestId).toBe(requestId);
  });

  it("builds the delegation default title from the captured workflow/step names, not live renames", async () => {
    const source = await seedCompanyOnly(fixture.sql, "FDQ" + randomUUID().slice(0, 3));
    const target = await seedCompanyOnly(fixture.sql, "TQ" + randomUUID().slice(0, 3));
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId: source.companyId,
      name: "captured-name",
      stepsJson: [{
        id: "delegate", name: "Captured step", agentId: "", dependencies: [],
        tools: ["delegate_to_company"], toolArgs: { targetCompanyId: target.companyId },
      }],
    });
    const run = await createFrozenRun(db, { workflowId, companyId: source.companyId });
    await markRunStatus(db, run.id, "running");
    const requestId = `${run.id}:delegate:${Date.now()}`;
    const queuedRow = await seedQueuedToolStepRun(db, { runId: run.id, stepId: "delegate", requestId });
    await editLiveDefinition(db, workflowId, {
      name: "live-name",
      stepsJson: [{
        id: "delegate", name: "Live step", agentId: "", dependencies: [],
        tools: ["delegate_to_company"], toolArgs: { targetCompanyId: target.companyId },
      }],
    });

    const result = await processQueuedWorkflowToolStepRuns(db);

    expect(result).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
    const [delegation] = await db.select().from(workflowDelegations);
    expect(delegation).toMatchObject({
      sourceCompanyId: source.companyId,
      sourceWorkflowRunId: run.id,
      sourceWorkflowStepRunId: queuedRow.id,
      targetCompanyId: target.companyId,
      status: "active",
    });
    const sourceIssue = (await db.select().from(issues).where(eq(issues.id, delegation!.sourceIssueId)))[0]!;
    const targetIssue = (await db.select().from(issues).where(eq(issues.id, delegation!.targetIssueId)))[0]!;
    expect(sourceIssue.companyId).toBe(source.companyId);
    expect(sourceIssue.title).toBe("[DELEGATED] captured-name: Captured step");
    expect(targetIssue.companyId).toBe(target.companyId);
    expect(targetIssue.title).toBe("captured-name: Captured step");
    const row = (await stepRunsOf(db, run.id)).find((candidate) => candidate.stepId === "delegate")!;
    expect(row.lastDispatchAcceptedAt).toBeInstanceOf(Date);
    expect(row.lastDispatchRequestId).toBe(requestId);
  });

  it("claims and dispatches exactly one request with captured tool/args once the captured predecessor is terminal", async () => {
    const dispatch = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(dispatch);
    const { runId } = await seedInspectionSyncWorkflow();
    await seedTerminalInspection(runId);
    const requestId = `${runId}:sync-dashboard:${Date.now()}`;
    await seedQueuedToolStepRun(db, { runId, stepId: "sync-dashboard", requestId });

    const result = await processQueuedWorkflowToolStepRuns(db);

    expect(result).toMatchObject({ claimedCount: 1, executedCount: 1, failedCount: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      stepId: "sync-dashboard",
      toolName: "captured-sync",
      args: { target: "hub" },
      requestId,
    }));
    const rows = await stepRunsOf(db, runId);
    expect(rows).toHaveLength(2);
    const row = rows.find((candidate) => candidate.stepId === "sync-dashboard")!;
    expect(row.lastDispatchAcceptedAt).toBeInstanceOf(Date);
    expect(row.lastDispatchRequestId).toBe(requestId);
    expect(row.metadata.toolInvocation).toMatchObject({ toolName: "captured-sync", args: { target: "hub" } });
  });

  it("keeps a persisted queued toolInvocation authoritative despite a live tool edit (no re-resolution)", async () => {
    const dispatch = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(dispatch);
    const { runId } = await seedInspectionSyncWorkflow([
      { id: "inspection", name: "Inspection", agentId: "", dependencies: [], tools: ["captured-inspect"], toolArgs: {} },
      { id: "sync-dashboard", name: "Sync dashboard", agentId: "", dependencies: [], tools: ["live-tool"], toolArgs: { target: "live" } },
    ]);
    await seedTerminalInspection(runId);
    const requestId = `${runId}:sync-dashboard:${Date.now()}`;
    await seedQueuedToolStepRun(db, {
      runId,
      stepId: "sync-dashboard",
      requestId,
      toolInvocation: { requestId, toolName: "persisted-tool", args: { q: "persisted" }, queuedAt: new Date().toISOString() },
    });

    await processQueuedWorkflowToolStepRuns(db);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "persisted-tool",
      args: { q: "persisted" },
      requestId,
    }));
    const row = (await stepRunsOf(db, runId)).find((candidate) => candidate.stepId === "sync-dashboard")!;
    expect(row.metadata.toolInvocation).toMatchObject({ toolName: "persisted-tool", args: { q: "persisted" } });
  });

  it("rejects the queue batch with 422 historical_definition_unproven on a corrupt snapshot (no claim, no dispatch)", async () => {
    const dispatch = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(dispatch);
    const { runId } = await seedInspectionSyncWorkflow();
    await corruptSnapshotSteps(fixture.sql, runId);
    const requestId = `${runId}:sync-dashboard:${Date.now()}`;
    await seedQueuedToolStepRun(db, { runId, stepId: "sync-dashboard", requestId });

    const error = await captureHttpError(processQueuedWorkflowToolStepRuns(db));

    expect(error.status).toBe(422);
    expect(error.message).toBe("historical_definition_unproven");
    expect(dispatch).not.toHaveBeenCalled();
    const row = (await stepRunsOf(db, runId)).find((candidate) => candidate.stepId === "sync-dashboard")!;
    expect(row.lastDispatchAcceptedAt).toBeNull();
    expect(row.status).toBe("running");
  });
});
