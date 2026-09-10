import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, issues, workflowDefinitions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  createFrozenRun,
  editLiveDefinition,
  loadCapturedDefinition,
  markRunStatus,
  seedFrozenMissionGraph,
  seedFrozenStepRun,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./helpers/workflow-frozen-mission-fixture.js";
import { captureFrozenRecoveryState } from "./helpers/workflow-frozen-recovery-state.js";
import { buildMissionSupervisionContext } from "../services/missions/mission-supervision-context.js";
import { issueLessToolRecoveryOwnsFailure } from "../services/missions/tool-step-recovery-authority.js";
import { selectTerminalWorkflowAuthoritySource } from "../services/missions/terminal-mission-authority-source.js";
import { missionWorkflowContinuationRemains } from "../services/missions/terminal-mission-workflow-continuation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

const FROZEN_STEPS = [
  { id: "render-tool", name: "Render clip", agentId: "", type: "tool", toolName: "video.render", dependencies: [] },
  { id: "render-raw", name: "Render raw", agentId: "", type: "tool", toolName: "video.render", dependencies: ["render-tool"] },
  { id: "produce-a", name: "Produce artifact", agentId: "", dependencies: ["render-tool"] },
  { id: "review-gate", name: "QA gate", agentId: "", type: "qa", dependencies: ["produce-a"] },
  { id: "downstream", name: "Publish downstream", agentId: "", dependencies: [], conditionalDependencies: [{ stepId: "produce-a", when: "always" }] },
];

const LIVE_STEPS = [
  { id: "render-tool", name: "Live render", agentId: "", dependencies: [] },
  { id: "render-raw", name: "Live render raw", agentId: "", dependencies: ["render-tool"] },
  { id: "produce-a", name: "Produce artifact", agentId: "", dependencies: ["render-tool"] },
  { id: "review-gate", name: "Step X", agentId: "", type: "tool", dependencies: ["produce-a"], conditionalDependencies: [{ stepId: "produce-a", when: "qa_request_changes", isBackEdge: true, maxIterations: 3 }] },
];

describeEP("workflow frozen supervision context (projected run definitions feed supervision)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-mission-supervision-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  /** tool failure + producer + QA + downstream 을 같은 definition 으로 freeze 하고 실 step 행을 만든다. */
  async function seedSupervisionMission() {
    let producerIssueId = randomUUID();
    let qaIssueId = randomUUID();
    // live graph fallback 정렬을 결정적으로 만들기 위해 producer id < qa id 로 맞춘다.
    if (producerIssueId.localeCompare(qaIssueId) > 0) [producerIssueId, qaIssueId] = [qaIssueId, producerIssueId];
    const seed = await seedFrozenMissionGraph(fixture.sql, db, {
      issuePrefix: "FS" + randomUUID().slice(0, 4),
      name: "frozen-supervision-workflow",
      stepsJson: FROZEN_STEPS,
    });
    await db.insert(issues).values([
      { id: producerIssueId, companyId: seed.companyId, missionId: seed.missionId, title: "Producer A", status: "in_progress", originKind: "workflow_execution" },
      { id: qaIssueId, companyId: seed.companyId, missionId: seed.missionId, title: "QA gate issue", status: "in_progress", originKind: "workflow_execution" },
    ]);
    await seedFrozenStepRun(db, {
      runId: seed.runId,
      stepId: "render-tool",
      status: "failed",
      startedAt: new Date("2026-08-01T10:00:00.000Z"),
      lastDispatchRequestId: "req-render-1",
    });
    await seedFrozenStepRun(db, { runId: seed.runId, stepId: "render-raw", status: "failed" });
    await seedFrozenStepRun(db, {
      runId: seed.runId,
      stepId: "produce-a",
      issueId: producerIssueId,
      status: "failed",
      startedAt: new Date("2026-08-01T10:05:00.000Z"),
    });
    await seedFrozenStepRun(db, {
      runId: seed.runId,
      stepId: "review-gate",
      issueId: qaIssueId,
      status: "failed",
      startedAt: new Date("2026-08-01T10:06:00.000Z"),
    });
    await seedFrozenStepRun(db, { runId: seed.runId, stepId: "downstream", status: "pending" });
    await markRunStatus(db, seed.runId, "failed");
    await editLiveDefinition(db, seed.workflowId, {
      name: "live-renamed-workflow",
      stepsJson: LIVE_STEPS,
      executionMode: "dynamic_owner_plan",
      dynamicPlanBootstrapOnly: true,
    });
    return { ...seed, producerIssueId, qaIssueId };
  }

  it("projects every selected row through the captured run definition in both collections", async () => {
    const f = await seedSupervisionMission();
    const captured = await loadCapturedDefinition(db, f.runId);
    const context = await buildMissionSupervisionContext(db, { missionId: f.missionId });

    const rows = context.stepRows.filter((row) => row.run.id === f.runId);
    expect(rows).toHaveLength(FROZEN_STEPS.length);
    for (const row of rows) {
      expect(row.definition.name).toBe("frozen-supervision-workflow");
      expect(row.definition.executionMode).toBe(captured.executionMode);
      expect(row.definition.executionMode).toBe("static_dag");
      expect(row.definition.dynamicPlanBootstrapOnly).toBe(false);
      expect(row.definition.stepsJson).toEqual(captured.steps);
    }
    for (const row of context.stepRowsByIssueId.get(f.qaIssueId) ?? []) {
      expect(row.definition.stepsJson).toEqual(captured.steps);
      expect(row.definition.name).toBe("frozen-supervision-workflow");
    }
    // live definition row itself diverged after the editor edit.
    const [live] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, f.workflowId));
    expect(live!.name).toBe("live-renamed-workflow");
    expect(live!.executionMode).toBe("dynamic_owner_plan");
  });

  it("issueLessToolRecoveryOwnsFailure follows the frozen tool identity with real execution evidence", async () => {
    const f = await seedSupervisionMission();
    const context = await buildMissionSupervisionContext(db, { missionId: f.missionId });
    const tooled = context.stepRows.find((row) => row.run.id === f.runId && row.stepRun.stepId === "render-tool")!;
    const raw = context.stepRows.find((row) => row.run.id === f.runId && row.stepRun.stepId === "render-raw")!;
    expect(tooled.stepRun.issueId).toBeNull();
    expect(issueLessToolRecoveryOwnsFailure(tooled)).toBe(true);
    expect(issueLessToolRecoveryOwnsFailure(raw)).toBe(false);
  });

  it("selectTerminalWorkflowAuthoritySource prioritizes the stored QA failed issue in the run group", async () => {
    const f = await seedSupervisionMission();
    const context = await buildMissionSupervisionContext(db, { missionId: f.missionId });
    const source = selectTerminalWorkflowAuthoritySource({
      missionIssues: context.missionIssues,
      missionIssueById: context.missionIssueById,
      workflowStepRows: context.stepRows.filter((row) => row.run.id === f.runId),
    });
    expect(source?.id).toBe(f.qaIssueId);
  });

  it("missionWorkflowContinuationRemains still sees the captured pending downstream step", async () => {
    const f = await seedSupervisionMission();
    const context = await buildMissionSupervisionContext(db, { missionId: f.missionId });
    const verdict = missionWorkflowContinuationRemains(
      context.stepRows.filter((row) => row.run.id === f.runId),
    );
    expect(verdict).toEqual({ remains: true, reason: `runnable-step:run:${f.runId}:step:downstream` });
  });

  it("a second run captured after the edit keeps its own new definition (no cross-run contamination)", async () => {
    const f = await seedSupervisionMission();
    const run2 = await createFrozenRun(db, { workflowId: f.workflowId, companyId: f.companyId, missionId: f.missionId });
    await seedFrozenStepRun(db, { runId: run2.id, stepId: "review-gate", status: "pending" });
    const captured2 = await loadCapturedDefinition(db, run2.id);
    const context = await buildMissionSupervisionContext(db, { missionId: f.missionId });

    const rows2 = context.stepRows.filter((row) => row.run.id === run2.id);
    expect(rows2).toHaveLength(1);
    expect(rows2[0]!.definition.name).toBe("live-renamed-workflow");
    expect(rows2[0]!.definition.executionMode).toBe("dynamic_owner_plan");
    expect(rows2[0]!.definition.stepsJson).toEqual(captured2.steps);

    const run1Steps = context.stepRows.find((row) => row.run.id === f.runId)!.definition.stepsJson as Array<Record<string, unknown>>;
    const run2Steps = rows2[0]!.definition.stepsJson as Array<Record<string, unknown>>;
    expect(run1Steps.find((step) => step.id === "review-gate")?.conditionalDependencies).toBeUndefined();
    expect(run2Steps.find((step) => step.id === "review-gate")?.conditionalDependencies).toEqual([
      { stepId: "produce-a", when: "qa_request_changes", isBackEdge: true, maxIterations: 3 },
    ]);
    expect(run2Steps.some((step) => step.id === "downstream")).toBe(false);
    expect(run1Steps.some((step) => step.id === "downstream")).toBe(true);
  });

  it("a legacy unmarked raw-insert run keeps current live definition behavior", async () => {
    const f = await seedSupervisionMission();
    const legacyRunId = await seedWorkflowRun(fixture.sql, {
      workflowId: f.workflowId,
      companyId: f.companyId,
      missionId: f.missionId,
      status: "running",
    });
    await seedFrozenStepRun(db, { runId: legacyRunId, stepId: "review-gate", status: "pending" });

    const context = await buildMissionSupervisionContext(db, { missionId: f.missionId });
    const row = context.stepRows.find((entry) => entry.run.id === legacyRunId)!;
    expect(row.definition.name).toBe("live-renamed-workflow");
    expect(row.definition.executionMode).toBe("dynamic_owner_plan");
    expect(row.definition.stepsJson).toEqual(LIVE_STEPS);
  });

  it.each(["missing", "corrupt"] as const)(
    "%s expected snapshot rejects context with 422 and leaves domain rows unchanged",
    async (state) => {
      const f = await seedSupervisionMission();
      const before = await captureFrozenRecoveryState(db, f.runId);
      if (state === "missing") {
        await (fixture.sql as RawSql)`DELETE FROM workflow_run_definitions WHERE workflow_run_id = ${f.runId}`;
      } else {
        await corruptSnapshotSteps(fixture.sql, f.runId);
      }
      const error = await captureHttpError(buildMissionSupervisionContext(db, { missionId: f.missionId }));
      expect(error.status).toBe(422);
      expect(error.message).toBe("historical_definition_unproven");
      expect(await captureFrozenRecoveryState(db, f.runId)).toEqual(before);
    },
  );
});
