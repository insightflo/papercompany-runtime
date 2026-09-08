import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, issueWorkProducts, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  createFrozenRun,
  editLiveDefinition,
  loadCapturedDefinition,
  markRunStatus,
  seedCompanyWithMission,
  seedFrozenIssueStep,
  seedFrozenStepRun,
  seedFrozenMissionGraph,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./helpers/workflow-frozen-mission-fixture.js";
import { captureWorkflowViewState, seedPluginWorkflowRunEntity } from "./helpers/workflow-frozen-view-state.js";
import { missionService } from "../services/missions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

// 세 번째 step 은 id 가 없는 채로 캡처된다(생성 시 정규화가 id 를 합성). live 그래프와 무관한 이름/키워드.
const CAPTURED_STEPS = [
  { id: "gather-sources", name: "Gather sources", agentId: "", type: "tool", tools: ["web.search"] },
  { id: "draft-brief", name: "Draft brief", agentId: "", dependencies: ["gather-sources"], toolNames: ["kb.lookup"] },
  {
    name: "QA gate",
    agentId: "",
    type: "qa",
    dependencies: ["draft-brief"],
    conditionalDependencies: [{ stepId: "draft-brief", when: "qa_request_changes", isBackEdge: true, maxIterations: 3 }],
  },
];

const LIVE_STEPS = [
  { id: "live-only-step", name: "Live replacement", agentId: "", dependencies: [] },
  {
    id: "draft-brief",
    name: "Live draft",
    agentId: "",
    dependencies: ["live-only-step"],
    conditionalDependencies: [{ stepId: "draft-brief", when: "qa_request_changes", isBackEdge: true, maxIterations: 7 }],
  },
];

describeEP("workflow frozen mission run view (listWorkflowRuns renders the captured definition)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;
  let sql: RawSql;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-mission-view-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
    sql = fixture.sql;
  }, 60_000);

  afterEach(async () => {
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  /** 실제 store createWorkflowRun 으로 캡처된 run + 스냅샷에서 읽은 stored steps. */
  async function seedCapturedViewRun() {
    const seed = await seedFrozenMissionGraph(sql, db, {
      issuePrefix: "FV" + randomUUID().slice(0, 4),
      name: "captured-mission-workflow",
      stepsJson: CAPTURED_STEPS,
    });
    const loaded = await loadCapturedDefinition(db, seed.runId);
    return { seed, loaded };
  }

  function synthesizedQaStepId(loaded: Awaited<ReturnType<typeof loadCapturedDefinition>>): string {
    const synthesized = loaded.steps.map((step) => step.id).filter((id) => !CAPTURED_STEPS.some((step) => step.id === id));
    expect(synthesized).toHaveLength(1);
    return synthesized[0]!;
  }

  it("keeps captured ids/order/name/deps/tools/qa cap after live edits; statuses/issues/products stay current", async () => {
    const { seed, loaded } = await seedCapturedViewRun();
    expect(loaded.source).toBe("snapshot");
    const qaStepId = synthesizedQaStepId(loaded);

    const gather = await seedFrozenIssueStep(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      runId: seed.runId,
      stepId: "gather-sources",
      title: "Gather issue",
      status: "running",
      startedAt: new Date("2026-08-02T09:00:00.000Z"),
    });
    await seedFrozenStepRun(db, {
      runId: seed.runId,
      stepId: qaStepId,
      status: "completed",
      completedAt: new Date("2026-08-02T09:30:00.000Z"),
    });
    const workProductId = randomUUID();
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId: seed.companyId,
      issueId: gather.issueId,
      type: "document",
      provider: "frozen-view-test",
      title: "View artifact",
      url: "file:///tmp/view-artifact.md",
      status: "ready_for_review",
      isPrimary: true,
      metadata: { path: "/tmp/view-artifact.md" },
    });

    await markRunStatus(db, seed.runId, "running");
    await editLiveDefinition(db, seed.workflowId, { name: "live-renamed-workflow", stepsJson: LIVE_STEPS });
    const beforeReads = await captureWorkflowViewState(sql, seed.missionId);
    const service = missionService(db);
    const first = await service.listWorkflowRuns(seed.missionId);
    const second = await service.listWorkflowRuns(seed.missionId);

    expect(first).toHaveLength(1);
    const run = first[0]!;
    expect(run.id).toBe(seed.runId);
    expect(run.workflowName).toBe("captured-mission-workflow");
    expect(run.steps.map((step) => step.stepId)).toEqual(loaded.steps.map((step) => step.id));
    expect(run.steps.map((step) => step.name)).toEqual(loaded.steps.map((step) => step.name));
    expect(run.steps).toHaveLength(loaded.steps.length);
    expect(run.steps.map((step) => step.stepId)).not.toContain("live-only-step");

    const byStepId = new Map(run.steps.map((step) => [step.stepId, step]));
    expect(byStepId.get("gather-sources")?.type).toBe("tool");
    expect(byStepId.get("gather-sources")?.toolNames).toEqual(["web.search"]);
    expect(byStepId.get("draft-brief")?.toolNames).toEqual(["kb.lookup"]);
    expect(byStepId.get("draft-brief")?.dependencies).toEqual(["gather-sources"]);
    expect(byStepId.get(qaStepId)?.dependencies).toEqual(["draft-brief"]);
    expect(byStepId.get(qaStepId)?.reworkCap).toBe(3);
    expect(byStepId.get("draft-brief")?.reworkCap).toBeNull();

    expect(run.status).toBe("running");
    expect(byStepId.get("gather-sources")?.status).toBe("running");
    expect(byStepId.get("gather-sources")?.startedAt?.toISOString()).toBe("2026-08-02T09:00:00.000Z");
    expect(byStepId.get(qaStepId)?.status).toBe("completed");
    expect(byStepId.get("gather-sources")?.issue?.title).toBe("Gather issue");
    expect(byStepId.get(qaStepId)?.issueId).toBeNull();
    expect(byStepId.get("gather-sources")?.workProducts).toEqual([
      expect.objectContaining({
        id: workProductId,
        url: "file:///tmp/view-artifact.md",
        metadata: { path: "/tmp/view-artifact.md" },
      }),
    ]);
    expect(run.progress).toEqual({
      totalSteps: 3,
      pendingSteps: 1,
      runningSteps: 1,
      completedSteps: 1,
      failedSteps: 0,
      skippedSteps: 0,
    });

    const frozen = (rows: typeof first) =>
      JSON.stringify(rows.map((entry) => entry.steps.map((step) => [step.stepId, step.name, step.dependencies, step.toolNames, step.reworkCap])));
    expect(frozen(second)).toBe(frozen(first));
    expect(second[0]?.workflowName).toBe("captured-mission-workflow");
    expect(await captureWorkflowViewState(sql, seed.missionId)).toEqual(beforeReads);
  });

  it("captures a second run after the edit with the new graph/name, independent of the first run's snapshot", async () => {
    const { seed, loaded } = await seedCapturedViewRun();
    const qaStepId = synthesizedQaStepId(loaded);
    await editLiveDefinition(db, seed.workflowId, { name: "live-renamed-workflow", stepsJson: LIVE_STEPS });
    const secondRun = await createFrozenRun(db, {
      workflowId: seed.workflowId,
      companyId: seed.companyId,
      missionId: seed.missionId,
    });
    const secondLoaded = await loadCapturedDefinition(db, secondRun.id);

    const runs = await missionService(db).listWorkflowRuns(seed.missionId);
    expect(runs).toHaveLength(2);
    const first = runs.find((run) => run.id === seed.runId)!;
    const second = runs.find((run) => run.id === secondRun.id)!;
    expect(first.workflowName).toBe("captured-mission-workflow");
    expect(first.steps.map((step) => step.stepId)).toEqual(loaded.steps.map((step) => step.id));
    expect(second.workflowName).toBe("live-renamed-workflow");
    expect(second.steps.map((step) => step.stepId)).toEqual(secondLoaded.steps.map((step) => step.id));
    expect(second.steps.map((step) => step.stepId)).toContain("live-only-step");
    expect(second.steps.map((step) => step.stepId)).not.toContain(qaStepId);
    const secondDraft = second.steps.find((step) => step.stepId === "draft-brief")!;
    expect(secondDraft.name).toBe("Live draft");
    expect(secondDraft.reworkCap).toBe(7);
  });

  it("rejects corrupt or missing expected snapshots with 422 and leaves every row untouched", async () => {
    const { seed } = await seedCapturedViewRun();
    await corruptSnapshotSteps(sql, seed.runId);
    const before = await captureWorkflowViewState(sql, seed.missionId);

    const corruptError = await captureHttpError(missionService(db).listWorkflowRuns(seed.missionId));
    expect(corruptError.status).toBe(422);
    expect((corruptError.details as { reason?: string }).reason).toBe("hash_mismatch");
    expect(await captureWorkflowViewState(sql, seed.missionId)).toEqual(before);

    await sql`DELETE FROM workflow_run_definitions WHERE workflow_run_id = ${seed.runId}`;
    const beforeMissing = await captureWorkflowViewState(sql, seed.missionId);
    expect(beforeMissing.workflow_run_definitions).toEqual([]);
    const missingError = await captureHttpError(missionService(db).listWorkflowRuns(seed.missionId));
    expect(missingError.status).toBe(422);
    expect((missingError.details as { reason?: string }).reason).toBe("marked_run_without_snapshot");

    expect(await captureWorkflowViewState(sql, seed.missionId)).toEqual(beforeMissing);
  });

  it("keeps genuine legacy raw-insert runs on the current definition view and persists no history", async () => {
    const { companyId, missionId } = await seedCompanyWithMission(sql, "FV" + randomUUID().slice(0, 4));
    const workflowId = await seedWorkflowDefinition(sql, {
      companyId,
      name: "legacy-current-workflow",
      stepsJson: [
        { id: "legacy-a", name: "Legacy A", agentId: "", dependencies: [] },
        { id: "legacy-b", name: "Legacy B", agentId: "", dependencies: ["legacy-a"] },
      ],
    });
    await seedWorkflowRun(sql, { workflowId, companyId, missionId });

    const initial = await missionService(db).listWorkflowRuns(missionId);
    expect(initial).toHaveLength(1);
    expect(initial[0]!.workflowName).toBe("legacy-current-workflow");
    expect(initial[0]!.steps.map((step) => step.stepId)).toEqual(["legacy-a", "legacy-b"]);

    await editLiveDefinition(db, workflowId, {
      name: "legacy-renamed-current",
      stepsJson: [{ id: "legacy-c", name: "Legacy C", agentId: "", dependencies: [] }],
    });
    const afterEdit = await missionService(db).listWorkflowRuns(missionId);
    expect(afterEdit).toHaveLength(1);
    expect(afterEdit[0]!.workflowName).toBe("legacy-renamed-current");
    expect(afterEdit[0]!.steps.map((step) => step.stepId)).toEqual(["legacy-c"]);

    const before = await captureWorkflowViewState(sql, missionId);
    expect(before.workflow_run_definitions).toEqual([]);
    const third = await missionService(db).listWorkflowRuns(missionId);
    expect(third[0]!.workflowName).toBe("legacy-renamed-current");
    expect(await captureWorkflowViewState(sql, missionId)).toEqual(before);
  });

  it("still merges plugin entity runs alongside the frozen native run", async () => {
    const { seed, loaded } = await seedCapturedViewRun();
    const gather = await seedFrozenIssueStep(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      runId: seed.runId,
      stepId: "gather-sources",
      status: "running",
    });
    const { pluginRunId } = await seedPluginWorkflowRunEntity(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      workflowName: "plugin-side-workflow",
      stepId: "plugin-step",
      stepName: "Plugin step",
      issueId: gather.issueId,
    });

    const runs = await missionService(db).listWorkflowRuns(seed.missionId);
    expect(runs).toHaveLength(2);
    const nativeRun = runs.find((run) => run.id === seed.runId)!;
    const pluginRun = runs.find((run) => run.id === pluginRunId)!;
    expect(nativeRun.workflowName).toBe("captured-mission-workflow");
    expect(nativeRun.steps.map((step) => step.stepId)).toEqual(loaded.steps.map((step) => step.id));
    expect(pluginRun.workflowName).toBe("plugin-side-workflow");
    expect(pluginRun.status).toBe("running");
    expect(pluginRun.steps).toEqual([
      expect.objectContaining({
        stepId: "plugin-step",
        name: "Plugin step",
        status: "running",
        issueId: gather.issueId,
      }),
    ]);
    expect(pluginRun.steps[0]!.workProducts).toEqual([]);
  });
});
