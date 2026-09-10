import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
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
import {
  completeWorkflowToolStepFromResult,
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("workflow frozen completion (captured retention applies, snapshot validated before mutation)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-completion-");
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

  /** frozen run + 실제 큐 프로세서로 claim 한 issue-less tool stepRun. */
  async function seedQueuedAndClaimedPublishStep(options: { capturedControls?: unknown; liveControls?: unknown }) {
    const dispatch = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(dispatch);
    const { companyId } = await seedCompanyOnly(fixture.sql, "FC" + randomUUID().slice(0, 4));
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId,
      name: "frozen-publish",
      stepsJson: [{
        id: "publish",
        name: "Publish",
        agentId: "",
        dependencies: [],
        tools: ["captured-sync"],
        toolArgs: { target: "hub" },
        ...(options.capturedControls !== undefined ? { executionControls: options.capturedControls } : {}),
      }],
    });
    const run = await createFrozenRun(db, { workflowId, companyId });
    await markRunStatus(db, run.id, "running");
    if (options.liveControls !== undefined) {
      await editLiveDefinition(db, workflowId, {
        stepsJson: [{
          id: "publish", name: "Publish", agentId: "", dependencies: [],
          tools: ["captured-sync"], toolArgs: {}, executionControls: options.liveControls,
        }],
      });
    }
    const requestId = `${run.id}:publish:${Date.now()}`;
    await seedQueuedToolStepRun(db, { runId: run.id, stepId: "publish", requestId });
    const claim = await processQueuedWorkflowToolStepRuns(db);
    expect(claim).toMatchObject({ claimedCount: 1, executedCount: 1 });
    return { companyId, runId: run.id, requestId };
  }

  it("applies captured deleteAfterUse:true retention even after the live control was turned off", async () => {
    const { companyId, runId, requestId } = await seedQueuedAndClaimedPublishStep({
      capturedControls: { deleteAfterUse: true },
      liveControls: { deleteAfterUse: false },
    });
    const stepRunId = (await stepRunsOf(db, runId)).find((candidate) => candidate.stepId === "publish")!.id;

    const result = await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId, requestId, toolName: "captured-sync",
      success: true, stdout: "published", data: { v: 1 }, exitCode: 0,
    });

    expect(result?.status).toBe("completed");
    const row = (await stepRunsOf(db, runId)).find((candidate) => candidate.id === stepRunId)!;
    expect(row.metadata.retentionDeleted).toMatchObject({ deleteAfterUse: true, toolName: "captured-sync", success: true });
    expect(row.metadata.toolInvocation).toBeUndefined();
    expect(row.metadata.toolResult).toBeUndefined();
  });

  it("retains the tool result when capture had no deleteAfterUse even though the live control was turned on", async () => {
    const { companyId, runId, requestId } = await seedQueuedAndClaimedPublishStep({
      liveControls: { deleteAfterUse: true },
    });
    const stepRunId = (await stepRunsOf(db, runId)).find((candidate) => candidate.stepId === "publish")!.id;

    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId, requestId, toolName: "captured-sync",
      success: true, stdout: "published", data: { v: 1 }, exitCode: 0,
    });

    const row = (await stepRunsOf(db, runId)).find((candidate) => candidate.id === stepRunId)!;
    expect(row.status).toBe("completed");
    expect(row.metadata.toolResult).toMatchObject({ success: true, data: { v: 1 }, toolName: "captured-sync" });
    expect(row.metadata.retentionDeleted).toBeUndefined();
    expect(row.metadata.toolInvocation).toMatchObject({ toolName: "captured-sync" });
  });

  it("rejects completion with 422 historical_definition_unproven on a corrupt snapshot before any step mutation", async () => {
    const { companyId, runId, requestId } = await seedQueuedAndClaimedPublishStep({});
    await corruptSnapshotSteps(fixture.sql, runId);
    const stepRunId = (await stepRunsOf(db, runId)).find((candidate) => candidate.stepId === "publish")!.id;
    const before = (await stepRunsOf(db, runId)).find((candidate) => candidate.id === stepRunId)!;

    const error = await captureHttpError(completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId, requestId, toolName: "captured-sync",
      success: true, stdout: "published", data: { v: 1 }, exitCode: 0,
    }));

    expect(error.status).toBe(422);
    expect(error.message).toBe("historical_definition_unproven");
    const after = (await stepRunsOf(db, runId)).find((candidate) => candidate.id === stepRunId)!;
    expect(after.status).toBe("running");
    expect(after.metadata).toEqual(before.metadata);
  });
});
