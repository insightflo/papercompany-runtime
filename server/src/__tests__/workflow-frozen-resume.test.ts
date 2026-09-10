import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  createDb,
  issues,
  missionPlanArtifacts,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";import {
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

import {
  captureHttpError,
  seedCompanyOnly,
  seedCompanyWithMission,
  seedWorkflowRun,
} from "./helpers/workflow-execution-definition-fixture.js";
import {
  cleanupFrozenTables,
  createFrozenRun,
  editLiveDefinition,
  loadCapturedDefinition,
  markRunStatus,
  seedToolDefinition,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  stepRunsOf,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";
import {
  executeWorkflowRun,
  setWorkflowToolStepExecutor,
  setWorkflowToolStepReadinessChecker,
  wakeExistingWorkflowStepIssue,
} from "../services/workflow/dag-engine.js";
import { ensureCreatedRunOversight } from "../services/workflow/workflow-created-run-oversight.js";
import { workflowService } from "../services/workflow/engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("workflow frozen resume/contract/wake boundaries", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-resume-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    setWorkflowToolStepExecutor(null);
    setWorkflowToolStepReadinessChecker(null);
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  it("D: step execution contract keeps captured name/tool args/knowledge bases/timeout after a live step edit", async () => {
    const { companyId } = await seedCompanyOnly(fixture.sql, "FR" + randomUUID().slice(0, 3));
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId,
      name: "frozen-contract",
      stepsJson: [{
        id: "report", name: "Captured report", agentId: "", dependencies: [],
        tools: ["captured-tool"], toolArgs: { q: "captured" },
        knowledgeBaseIds: ["kb-captured"], timeoutSeconds: 180,
      }],
    });
    const run = await createFrozenRun(db, { workflowId, companyId });
    const [issue] = await db.insert(issues).values({ companyId, title: "report issue", status: "in_progress" }).returning();
    await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "report", issueId: issue.id, status: "running", metadata: {} });
    await editLiveDefinition(db, workflowId, {
      name: "live-renamed",
      stepsJson: [{
        id: "report", name: "Live report", agentId: "", dependencies: [],
        tools: ["live-tool"], toolArgs: { q: "live" }, knowledgeBaseIds: ["kb-live"], timeoutSeconds: 30,
      }],
    });

    const contract = await workflowService.getStepExecutionContractForIssue(db, issue.id);

    expect(contract).toMatchObject({
      stepId: "report",
      stepName: "Captured report",
      toolNames: ["captured-tool"],
      toolArgs: { q: "captured" },
      knowledgeBaseIds: ["kb-captured"],
      stepTimeoutSeconds: 180,
    });
  });

  it("E: wake restores the captured assignee and wakes via the boundary adapter; a step missing from the snapshot is a no-op", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "frozen-wake-1" });
    const seeded = await seedCompanyWithMission(fixture.sql, "FRW");
    const capturedAgentId = seeded.agentId;
    const [liveAgent] = await db.insert(agents).values({
      id: randomUUID(), companyId: seeded.companyId, name: "Live Agent", role: "writer",
      status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId: seeded.companyId, name: "frozen-wake",
      stepsJson: [{ id: "qa-step", name: "QA step", agentId: capturedAgentId, dependencies: [] }],
    });
    const run = await createFrozenRun(db, { workflowId, companyId: seeded.companyId, missionId: seeded.missionId });
    await markRunStatus(db, run.id, "running");
    const [issue] = await db.insert(issues).values({
      companyId: seeded.companyId, missionId: seeded.missionId, title: "qa issue", status: "todo",
    }).returning();
    const [stepRun] = await db.insert(workflowStepRuns).values({
      workflowRunId: run.id, stepId: "qa-step", issueId: issue.id, status: "pending", metadata: {},
    }).returning();
    await editLiveDefinition(db, workflowId, {
      name: "live-wake-renamed",
      stepsJson: [{ id: "qa-step", name: "Live mutated", agentId: liveAgent.id, dependencies: [] }],
    });
    const runRow = (await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)))[0]!;
    const definitionRow = (await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, workflowId)))[0]!;

    const queued = await wakeExistingWorkflowStepIssue({
      db, run: runRow, definition: definitionRow,
      step: { id: "qa-step", name: "Live mutated", agentId: liveAgent.id, dependencies: [] },
      stepRunId: stepRun.id, issueId: issue.id,
    });

    expect(queued).toBe(true);
    expect(heartbeatWakeup).toHaveBeenCalledTimes(1);
    expect(heartbeatWakeup).toHaveBeenCalledWith(capturedAgentId, expect.objectContaining({
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({ issueId: issue.id, mutation: "workflow_resume", workflowRunId: run.id }),
    }));
    const storedIssue = (await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!;
    expect(storedIssue.assigneeAgentId).toBe(capturedAgentId);
    // Ghost-step no-op proof (full-row) lives in workflow-frozen-wake-contract.test.ts.
  });

  it("F1: resumeRun uses captured readiness tool names, resets the captured failed IF, and retries collect with the captured tool", async () => {
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    const { companyId } = await seedCompanyOnly(fixture.sql, "FRC");
    await seedToolDefinition(db, companyId, "captured-sync");
    const conditionGroup = {
      combinator: "all",
      conditions: [{
        source: { kind: "work_product_json", stepId: "collect", title: "decision.json", path: "$.status" },
        dataType: "string", operator: "equals", rightValue: "selected",
      }],
    } as const;
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId, name: "frozen-resume-control",
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
    setWorkflowToolStepReadinessChecker(async ({ toolNames }) =>
      toolNames.every((name) => name === "captured-sync")
        ? { available: true }
        : { available: false, reason: "live-only-tool referenced" });

    await workflowService.resumeRun(db, { runId: run.id, companyId });

    const rows = await stepRunsOf(db, run.id);
    // Captured IF reset: pending, control metadata/timestamps cleared. The only metadata left is the
    // engine-synced graphWorkProductRequired marker (syncStepRunExecutionControlMetadata re-stamps
    // it on every load). Collect stays non-terminal, so the IF is never re-evaluated (no artifact
    // evaluation here). Live-only control never materializes from the captured graph.
    const ifRow = rows.find((candidate) => candidate.stepId === "if-decision")!;
    expect(ifRow.status).toBe("pending");
    expect(ifRow.startedAt).toBeNull();
    expect(ifRow.completedAt).toBeNull();
    expect(ifRow.metadata).toEqual({ graphWorkProductRequired: false });
    expect(rows.find((candidate) => candidate.stepId === "live-if")).toBeUndefined();
    // Captured collect retries with the CAPTURED tool even though the live graph now references
    // live-unregistered-tool (unlaunched-reset + launch re-queues the failed tool step in resumeRun).
    const collectRow = rows.find((candidate) => candidate.stepId === "collect")!;
    expect(collectRow.status).toBe("running");
    expect(collectRow.metadata.toolInvocation).toMatchObject({ toolName: "captured-sync" });
    expect(collectRow.lastDispatchRequestId).not.toBeNull();
  });

  it("F2: resumeRun on a marked run without snapshot rejects 422 before any status/step mutation", async () => {
    const { companyId } = await seedCompanyOnly(fixture.sql, "FRM");
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId, name: "frozen-resume-missing",
      stepsJson: [{ id: "s1", name: "S1", agentId: "", dependencies: [] }],
    });
    const runId = await seedWorkflowRun(fixture.sql, {
      workflowId, companyId, status: "failed", metadata: { executionDefinitionVersion: 1 },
    });

    const error = await captureHttpError(workflowService.resumeRun(db, { runId, companyId }));

    expect(error.status).toBe(422);
    expect(error.message).toBe("historical_definition_unproven");
    const row = (await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;
    expect(row.status).toBe("failed");
    expect(row.startedAt).toBeNull();
    expect(await stepRunsOf(db, runId)).toHaveLength(0);
  });

  it("F3: executeWorkflowRun on a marked run without snapshot rejects 422 with no step writes and no dispatch", async () => {
    const { companyId } = await seedCompanyOnly(fixture.sql, "FRE");
    const dispatch = vi.fn();
    setWorkflowToolStepExecutor(dispatch as never);
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId, name: "frozen-execute-missing",
      stepsJson: [{ id: "s1", name: "S1", agentId: "", dependencies: [], tools: ["captured-sync"] }],
    });
    const runId = await seedWorkflowRun(fixture.sql, {
      workflowId, companyId, status: "pending", metadata: { executionDefinitionVersion: 1 },
    });

    const error = await captureHttpError(executeWorkflowRun(db, runId));

    expect(error.status).toBe(422);
    expect(error.message).toBe("historical_definition_unproven");
    expect(dispatch).not.toHaveBeenCalled();
    const row = (await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;
    expect(row.status).toBe("pending");
    expect(row.startedAt).toBeNull();
    expect(await stepRunsOf(db, runId)).toHaveLength(0);
  });

  it("G: post-create oversight uses captured provenance name and captured step ids despite a later live rename", async () => {
    const seeded = await seedCompanyWithMission(fixture.sql, "FRO");
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId: seeded.companyId, name: "captured-name-v1",
      stepsJson: [{ id: "step-a", name: "Step A", agentId: seeded.agentId, dependencies: [] }],
    });
    const run = await createFrozenRun(db, { workflowId, companyId: seeded.companyId, missionId: seeded.missionId });
    expect((await loadCapturedDefinition(db, run.id)).provenance).not.toBeNull();
    await editLiveDefinition(db, workflowId, {
      name: "live-renamed-v2",
      stepsJson: [
        { id: "step-a", name: "Step A", agentId: seeded.agentId, dependencies: [] },
        { id: "live-b", name: "Live B", agentId: seeded.agentId, dependencies: [] },
      ],
    });

    await ensureCreatedRunOversight(db, run);

    const oversight = (await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_oversight")))[0]!;
    expect(oversight.title).toBe("[OVERSIGHT] captured-name-v1");
    expect(oversight.missionId).toBe(seeded.missionId);
    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, seeded.missionId));
    const refs = plans.flatMap((plan) => ((plan.refs ?? {}) as { workflowStepIds?: string[] }).workflowStepIds ?? []);
    expect(refs).toContain("step-a");
    expect(refs).not.toContain("live-b");
  });
});
