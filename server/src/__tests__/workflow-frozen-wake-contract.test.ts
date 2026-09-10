import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  createDb,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
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

import {
  cleanupFrozenTables,
  createFrozenRun,
  editLiveDefinition,
  markRunStatus,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  stepRunsOf,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";
import { wakeExistingWorkflowStepIssue } from "../services/workflow/dag-engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("workflow frozen wake contract (canonical stored step + stored arrays)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-wake-contract-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  /** no-op 증명용 전체 행 스냅샷(full-row equality). */
  async function wakeBoundarySnapshot(companyId: string, runId: string) {
    return {
      issues: await db.select().from(issues).where(eq(issues.companyId, companyId)),
      stepRuns: await stepRunsOf(db, runId),
      activity: await db.select().from(activityLog),
      wakeups: await db.select().from(agentWakeupRequests),
    };
  }

  it("E: structural wake uses the stored gate topology + stored arrays; no official verdict means a full no-op", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "frozen-wake-gate-1" });
    const seeded = await seedCompanyWithMission(fixture.sql, "FWC");
    const capturedAgentId = seeded.agentId;
    const [liveAgent] = await db.insert(agents).values({
      id: randomUUID(), companyId: seeded.companyId, name: "Live Agent", role: "writer",
      status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const capturedSteps = [
      {
        id: "producer", name: "Build", agentId: capturedAgentId, dependencies: [],
        graphWorkProductRequired: true,
        conditionalDependencies: [{
          stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 1, allowCapAcceptance: true,
        }],
      },
      {
        id: "gate", name: "Structural", type: "tool", qaType: "structural",
        toolNames: ["captured-validator"], dependencies: ["producer"], agentId: "",
      },
      { id: "qa", name: "[QA] Semantic review", agentId: capturedAgentId, dependencies: ["producer", "gate"] },
    ];
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId: seeded.companyId, name: "frozen-wake-gate", stepsJson: capturedSteps,
    });
    const run = await createFrozenRun(db, {
      workflowId, companyId: seeded.companyId, missionId: seeded.missionId,
    });
    await markRunStatus(db, run.id, "running");
    const producerCompletedAt = new Date(Date.now() - 5_000);
    const token = { producerStepId: "producer", iterationIndex: 1, completedAt: producerCompletedAt.toISOString() };
    const requestId = `${run.id}:gate:${producerCompletedAt.getTime()}`;
    const [issue] = await db.insert(issues).values({
      companyId: seeded.companyId, missionId: seeded.missionId, title: "qa issue", status: "todo",
    }).returning();
    const gateRows = await db.insert(workflowStepRuns).values([
      { workflowRunId: run.id, stepId: "producer", status: "completed", iterationIndex: 1, completedAt: producerCompletedAt, metadata: {} },
      {
        workflowRunId: run.id, stepId: "gate", status: "completed", iterationIndex: 1,
        completedAt: new Date(producerCompletedAt.getTime() + 1_000),
        lastDispatchRequestId: requestId,
        metadata: { structuralGateProducerToken: token },
      },
      { workflowRunId: run.id, stepId: "qa", status: "pending", iterationIndex: 1, issueId: issue.id, metadata: {} },
    ]).returning();
    const gateStepRun = gateRows.find((candidate) => candidate.stepId === "gate")!;
    const qaStepRun = gateRows.find((candidate) => candidate.stepId === "qa")!;
    // Live edit: gate removed, backedge removed, QA renamed ordinary + reassigned + deps emptied.
    await editLiveDefinition(db, workflowId, {
      stepsJson: [
        { id: "producer", name: "Build", agentId: capturedAgentId, dependencies: [], graphWorkProductRequired: true },
        { id: "qa", name: "Semantic review", agentId: liveAgent.id, dependencies: [] },
      ],
    });
    const runRow = (await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)))[0]!;
    const definitionRow = (await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, workflowId)))[0]!;
    const liveQaStep = { id: "qa", name: "Semantic review", agentId: liveAgent.id, dependencies: [] };
    const wakeInput = {
      db, run: runRow, definition: definitionRow,
      step: liveQaStep, stepRunId: qaStepRun.id, issueId: issue.id,
    };

    // 1) No official verdict event: stored structural gate still required → full no-op.
    const before = await wakeBoundarySnapshot(seeded.companyId, run.id);
    const queuedFalse = await wakeExistingWorkflowStepIssue(wakeInput);
    expect(queuedFalse).toBe(false);
    expect(heartbeatWakeup).not.toHaveBeenCalled();
    expect(await wakeBoundarySnapshot(seeded.companyId, run.id)).toEqual(before);

    // 2) Durable PASS verdict for the exact current request + producer token → wake fires.
    await db.insert(workflowTransitionEvents).values({
      companyId: seeded.companyId, workflowRunId: run.id, workflowStepRunId: gateStepRun.id, issueId: null,
      eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "pass", decision: "pass", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${seeded.companyId}:${gateStepRun.id}:${requestId}`,
      payload: { kind: "structural_gate_verdict", requestId, verdict: "pass", producerToken: token },
    });
    const queuedTrue = await wakeExistingWorkflowStepIssue(wakeInput);
    expect(queuedTrue).toBe(true);
    expect(heartbeatWakeup).toHaveBeenCalledTimes(1);
    const [wokenAgentId, wakeOpts] = heartbeatWakeup.mock.calls[0]!;
    expect(wokenAgentId).toBe(capturedAgentId);
    for (const part of [wakeOpts!.payload, wakeOpts!.contextSnapshot]) {
      // Captured gate topology + stored toolNames array (live graph has no gate / no validator).
      expect(part.structuralGateCoverage).toEqual([{
        gateStepId: "gate",
        toolName: "captured-validator",
        producerStepId: "producer",
        producerIterationIndex: 1,
        producerCompletedAt: producerCompletedAt.toISOString(),
      }]);
      // Captured full cap array: the live producer no longer has the backedge, so this proves
      // the stored producer→qa backedge array drove the contract.
      expect(part.paperclipQaCapAcceptanceContract).toEqual({
        kind: "workflow_qa_cap_acceptance",
        qaStepId: "qa",
        producerStepId: "producer",
        currentIteration: 1,
        maxIterations: 1,
        verdictEndpoint: `/api/issues/${issue.id}/workflow/verdict`,
        nonblockingAcceptance: { classification: "nonblocking", limitationsRequired: true },
      });
    }
    const storedIssue = (await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!;
    expect(storedIssue.assigneeAgentId).toBe(capturedAgentId);
  });

  it("E: a ghost step absent from the snapshot is a full no-op (issue/step/activity/wakeup rows byte-equal)", async () => {
    const seeded = await seedCompanyWithMission(fixture.sql, "FWG");
    const capturedAgentId = seeded.agentId;
    const [liveAgent] = await db.insert(agents).values({
      id: randomUUID(), companyId: seeded.companyId, name: "Live Agent G", role: "writer",
      status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId: seeded.companyId, name: "frozen-wake-ghost",
      stepsJson: [{ id: "qa-step", name: "QA step", agentId: capturedAgentId, dependencies: [] }],
    });
    const run = await createFrozenRun(db, { workflowId, companyId: seeded.companyId, missionId: seeded.missionId });
    await markRunStatus(db, run.id, "running");
    const [ghostIssue] = await db.insert(issues).values({
      companyId: seeded.companyId, missionId: seeded.missionId, title: "ghost issue", status: "todo",
    }).returning();
    await db.insert(workflowStepRuns).values({
      workflowRunId: run.id, stepId: "qa-step", status: "pending", metadata: {},
    });
    await editLiveDefinition(db, workflowId, {
      stepsJson: [{ id: "qa-step", name: "Live mutated", agentId: liveAgent.id, dependencies: [] }],
    });
    const runRow = (await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)))[0]!;
    const definitionRow = (await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, workflowId)))[0]!;

    const before = await wakeBoundarySnapshot(seeded.companyId, run.id);
    const ghostQueued = await wakeExistingWorkflowStepIssue({
      db, run: runRow, definition: definitionRow,
      step: { id: "ghost-step", name: "Ghost", agentId: liveAgent.id, dependencies: [] },
      issueId: ghostIssue.id,
    });

    expect(ghostQueued).toBe(false);
    expect(heartbeatWakeup).not.toHaveBeenCalled();
    expect(await wakeBoundarySnapshot(seeded.companyId, run.id)).toEqual(before);
  });
});
