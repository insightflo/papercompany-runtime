import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, workflowDefinitions, type Db } from "@paperclipai/db";
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
  completeWorkflowToolStepFromResult,
  executeWorkflowRun,
  setWorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";
import { projectExecutionDefinition } from "../services/workflow/execution-definition-view.js";
import {
  cleanupFrozenTables,
  createFrozenRun,
  editLiveDefinition,
  loadCapturedDefinition,
  seedCompanyOnly,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  stepRunsOf,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("workflow frozen dispatch (captured graph executes despite live edits)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-dispatch-");
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

  async function seedFrozenWorkflow(
    stepsJson: unknown[],
    options: { name?: string; executionMode?: string; dynamicPlanBootstrapOnly?: boolean } = {},
  ) {
    const { companyId } = await seedCompanyOnly(fixture.sql, "FD" + randomUUID().slice(0, 4));
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId,
      name: options.name ?? "frozen-dispatch-workflow",
      stepsJson,
      executionMode: options.executionMode ?? null,
      dynamicPlanBootstrapOnly: options.dynamicPlanBootstrapOnly ?? false,
    });
    const run = await createFrozenRun(db, { workflowId, companyId });
    return { companyId, workflowId, runId: run.id };
  }

  it("materializes step runs only for captured ids: synthesized id stable, live additions and duplicate delivery gates ignored", async () => {
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    const { workflowId, runId } = await seedFrozenWorkflow([
      { id: "publish-onboarding-hub", name: "Publish onboarding hub", agentId: "", dependencies: [], tools: ["captured-sync"], toolArgs: { target: "hub" } },
      { id: "downstream", name: "Downstream", agentId: "", dependencies: ["publish-onboarding-hub"], tools: ["captured-sync"], toolArgs: {} },
      { name: "Ghost step", agentId: "", dependencies: [], tools: ["captured-sync"] },
    ]);
    const captured = await loadCapturedDefinition(db, runId);
    expect(captured.source).toBe("snapshot");
    const capturedIds = captured.steps.map((step) => step.id).sort();
    expect(capturedIds).toContain("delivery-verification-gate");
    const ghostId = captured.steps.map((step) => step.id)
      .find((id) => !["publish-onboarding-hub", "downstream", "delivery-verification-gate"].includes(id));
    expect(ghostId).toMatch(/^[0-9a-f-]{36}$/u);

    // Live definition replaced: extra live step + rename — captured graph must not change.
    await editLiveDefinition(db, workflowId, {
      name: "live-renamed",
      stepsJson: [
        { id: "live-extra", name: "Live extra", agentId: "", dependencies: [], tools: ["live-tool"] },
        { id: "publish-onboarding-hub", name: "Renamed live", agentId: "", dependencies: [], tools: ["live-tool"] },
        { id: "downstream", name: "Downstream live", agentId: "", dependencies: ["publish-onboarding-hub"], tools: ["live-tool"] },
      ],
    });

    await executeWorkflowRun(db, runId);
    const rows = await stepRunsOf(db, runId);
    expect(rows.map((row) => row.stepId).sort()).toEqual(capturedIds);
    expect(rows.filter((row) => row.stepId === "delivery-verification-gate")).toHaveLength(1);
    expect(rows.find((row) => row.stepId === ghostId)?.stepId).toBe(ghostId);
  });

  it("captured static mode stays static after terminal root even when live graph became dynamic", async () => {
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    const { companyId, workflowId, runId } = await seedFrozenWorkflow([
      { id: "root", name: "Root", agentId: "", dependencies: [], tools: ["captured-sync"], toolArgs: {} },
      { id: "downstream", name: "Downstream", agentId: "", dependencies: ["root"], tools: ["captured-sync"], toolArgs: {} },
    ]);
    expect((await loadCapturedDefinition(db, runId)).executionMode).toBe("static_dag");
    await editLiveDefinition(db, workflowId, { executionMode: "dynamic_owner_plan", dynamicPlanBootstrapOnly: true, name: "now-dynamic-live" });

    await executeWorkflowRun(db, runId);
    const rootRun = (await stepRunsOf(db, runId)).find((row) => row.stepId === "root")!;
    expect(rootRun.lastDispatchRequestId).not.toBeNull();
    const complete = await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: rootRun.id,
      requestId: rootRun.lastDispatchRequestId!,
      toolName: "captured-sync",
      success: true,
      stdout: "ok",
      exitCode: 0,
    });
    expect(complete?.status).toBe("running");
    const downstream = (await stepRunsOf(db, runId)).find((row) => row.stepId === "downstream")!;
    expect(downstream.status).toBe("running");
    expect(downstream.lastDispatchRequestId).not.toBeNull();
  });

  it("captured dynamic mode launches only root steps even when live graph became static", async () => {
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    const { companyId, workflowId, runId } = await seedFrozenWorkflow([
      { id: "root", name: "Root", agentId: "", dependencies: [], tools: ["captured-sync"], toolArgs: {} },
      { id: "downstream", name: "Downstream", agentId: "", dependencies: ["root"], tools: ["captured-sync"], toolArgs: {} },
    ], { name: "frozen-dynamic-captured", executionMode: "dynamic_owner_plan", dynamicPlanBootstrapOnly: true });
    expect((await loadCapturedDefinition(db, runId)).executionMode).toBe("dynamic_owner_plan");
    await editLiveDefinition(db, workflowId, { executionMode: "static_dag", dynamicPlanBootstrapOnly: false, name: "now-static-live" });

    await executeWorkflowRun(db, runId);
    const rootRun = (await stepRunsOf(db, runId)).find((row) => row.stepId === "root")!;
    const complete = await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: rootRun.id,
      requestId: rootRun.lastDispatchRequestId!,
      toolName: "captured-sync",
      success: true,
      stdout: "ok",
      exitCode: 0,
    });
    expect(complete?.status).toBe("completed");
    const downstream = (await stepRunsOf(db, runId)).find((row) => row.stepId === "downstream")!;
    expect(downstream.lastDispatchRequestId).toBeNull();
    expect(downstream.status).toBe("skipped");
  });
});

describe("projectExecutionDefinition (pure adapter)", () => {
  const rowBase = {
    id: randomUUID(),
    companyId: randomUUID(),
    name: "live-name",
    description: null,
    status: "active",
    stepsJson: [{ id: "live-step", name: "Live", agentId: "", dependencies: [] }],
    projectId: "proj-kept",
    executionMode: null,
    dynamicPlanBootstrapOnly: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never as typeof workflowDefinitions.$inferSelect;

  const provenanceBase = {
    schemaVersion: 1, origin: "run_creation", workflowId: rowBase.id, missionId: null,
    workflowName: "captured-name", source: "native", sourceKind: "workflow",
    definitionUpdatedAt: new Date().toISOString(),
  };

  function snapshotExecution(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      normalizerVersion: 1,
      steps: [{ id: "captured-step", name: "Captured", agentId: "", dependencies: [] }],
      definitionHash: "a".repeat(64),
      executionMode: "dynamic_owner_plan",
      source: "snapshot",
      provenance: { ...provenanceBase },
      ...overrides,
    } as never as Awaited<ReturnType<typeof loadCapturedDefinition>>;
  }

  it("legacy_current returns the original definition untouched", () => {
    expect(projectExecutionDefinition(rowBase, snapshotExecution({ source: "legacy_current", provenance: null }))).toBe(rowBase);
  });

  it("snapshot projects captured name/steps/mode without mutating inputs", () => {
    const definition = { ...rowBase };
    const execution = snapshotExecution();
    const projected = projectExecutionDefinition(definition, execution);
    expect(projected).not.toBe(definition);
    expect(projected.name).toBe("captured-name");
    expect(projected.stepsJson).toBe(execution.steps);
    expect(projected.executionMode).toBe("dynamic_owner_plan");
    expect(projected.dynamicPlanBootstrapOnly).toBe(true);
    expect(projected.projectId).toBe("proj-kept");
    expect(definition.name).toBe("live-name");
    expect(definition.stepsJson).toEqual([{ id: "live-step", name: "Live", agentId: "", dependencies: [] }]);
    expect(execution.executionMode).toBe("dynamic_owner_plan");
  });

  it("rejects snapshot execution without provenance (loader-impossible but publicly typed)", () => {
    expect(() => projectExecutionDefinition(rowBase, snapshotExecution({ provenance: null })))
      .toThrowError("historical_definition_unproven");
  });
});
