// @vitest-environment node
// [workflow-child fix round] P1-4/7 회복 검증: invocation 테이블 기반 후보(클레임 NULL 크래시,
// 트리거 크래시 고아 실행), stuck-run liveness(some), stuck 이전 child-wait 회복 순서.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  toolDefinitions,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  hasLiveWorkflowChildWait,
  reconcileWorkflowChildStepWaits,
} from "../services/workflow/workflow-child-execution.js";
import {
  completeWorkflowToolStepFromResult,
  normalizeWorkflowStepsForExecution,
  setWorkflowToolStepExecutor,
  setWorkflowToolStepReadinessChecker,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import { reconcileStuckWorkflowRuns, reconcileWorkflow } from "../services/workflow/reconciler.js";
import { WORKFLOW_CHILD_MAX_DEPTH, runDepthOfParentRun } from "../services/workflow/workflow-child-guards.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describeEmbeddedPostgres("workflow child fix round — recovery", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix-recovery-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    setWorkflowToolStepReadinessChecker(null);
    await db.delete(toolDefinitions);
    await db.delete(workflowStepInvocations);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("recovers a mid-claim crash: invocation with null child and null timestamps (P1-4)", async () => {
    const companyId = await createCompanyFixture("Fix Crash Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId)],
    });
    // 크래시 시뮬레이션: 클레임은 커밋됐지만 자식 생성/입양 전 — 메타데이터·타임스탬프 전부 NULL.
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    await db.insert(workflowStepInvocations).values({
      companyId,
      parentStepRunId: stepRunId,
      childRunId: null,
      generation: 1,
    });

    const results = await reconcileWorkflowChildStepWaits(db, { olderThanMs: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe("recovered");

    const [invocation] = await db.select().from(workflowStepInvocations);
    expect(invocation?.childRunId).not.toBeNull();
    const [childRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, invocation?.childRunId ?? ""));
    expect(childRun?.parentRunId).toBe(runId);
    expect(childRun?.missionId).toBeNull();
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    const meta = stepRun?.metadata as Record<string, unknown>;
    expect(meta.workflowChild).toEqual(expect.objectContaining({ childRunId: invocation?.childRunId, generation: 1 }));
  });

  it("executes and adopts a committed-but-never-started child after a trigger crash (P1-4)", async () => {
    const companyId = await createCompanyFixture("Fix Orphan Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId)],
    });
    // 트리거 크래시 시뮬레이션: 클레임+자식 run 행은 커밋됐지만 실행 전(pending, 스텝 레코드 없음),
    // 부모 스텝은 미입양(메타데이터 없음).
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const childRunId = randomUUID();
    await db.insert(workflowRuns).values({
      id: childRunId,
      workflowId: childDefId,
      companyId,
      status: "pending",
      triggeredBy: "workflow-step",
      triggerSource: "workflow",
      parentRunId: runId,
      parentStepRunId: stepRunId,
      rootRunId: runId,
      missionId: null,
    });
    await db.insert(workflowStepInvocations).values({
      companyId,
      parentStepRunId: stepRunId,
      childRunId,
      generation: 1,
      state: "linked",
    });

    const results = await reconcileWorkflowChildStepWaits(db, { olderThanMs: 0 });
    expect(results[0]?.action).toBe("recovered");

    const [childRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, childRunId));
    // 실행이 이어받아졌다 — 자식 run 이 시작됐고 자식 스텝 레코드가 생겼다.
    expect(childRun?.status).toBe("running");
    const childSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, childRunId));
    expect(childSteps.length).toBeGreaterThan(0);
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect((stepRun?.metadata as Record<string, unknown>).workflowChild).toBeTruthy();
  });

  it("does not force-fail a stuck run with a live child wait plus blocked dependents (P1-7)", async () => {
    const companyId = await createCompanyFixture("Fix Stuck Co");
    await db.insert(toolDefinitions).values({
      companyId,
      name: "ok-tool",
      description: "test tool",
      inputSchema: {},
      adapterType: "builtin",
      adapterConfig: {},
      enabled: true,
    });
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [
        childStep(childDefId),
        { id: "downstream", name: "D", type: "tool", agentId: "", dependencies: ["run-child"], toolNames: ["ok-tool"], toolArgs: {} },
      ],
    });
    const result = await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    await db.update(workflowRuns).set({ startedAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(workflowRuns.id, result.runId));

    const results = await reconcileStuckWorkflowRuns(db, 60);
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe("skipped");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId));
    expect(run?.status).toBe("running");
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, result.runId));
    expect(steps.every((s) => s.status === "pending" || s.status === "running")).toBe(true);
    const [waitingStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.stepId, "run-child"));
    expect(await hasLiveWorkflowChildWait(db, waitingStep!)).toBe(true);
  });

  it("heals a terminal child before the stuck-run pass in reconcileWorkflow (P1-7 ordering)", async () => {
    const companyId = await createCompanyFixture("Fix Order Co");
    await db.insert(toolDefinitions).values({
      companyId,
      name: "ok-tool",
      description: "test tool",
      inputSchema: {},
      adapterType: "builtin",
      adapterConfig: {},
      enabled: true,
    });
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));
    // 자식 정의는 이슈 없는 툴 스텝 — 수동 completion 이 이슈 동기화로 되돌려지지 않는다.
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "t", name: "T", type: "tool", agentId: "", dependencies: [], toolNames: ["ok-tool"], toolArgs: {} }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [
        childStep(childDefId),
        { id: "downstream", name: "D", type: "tool", agentId: "", dependencies: ["run-child"], toolNames: ["ok-tool"], toolArgs: {} },
      ],
    });
    const result = await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    // 자식을 종말시키되 completion hook 이 아직 마감하지 않은 상태로 만들고, run 을 stuck 나이로.
    const [invocation] = await db.select().from(workflowStepInvocations);
    const [childStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, invocation?.childRunId ?? ""));
    await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: childStepRun.id,
      workflowRunId: invocation?.childRunId ?? "",
      stepId: childStepRun.stepId,
      toolName: "ok-tool",
      success: true,
      data: { ok: true },
      stdout: "",
      exitCode: 0,
    });
    // 자식 종말이 훅을 통해 부모 마감까지 진행되므로, 훅 이전 상태를 재현하기 위해 스텝을 pending 으로 되돌린다.
    await db.update(workflowStepRuns).set({ status: "pending", completedAt: null })
      .where(and(eq(workflowStepRuns.workflowRunId, result.runId), eq(workflowStepRuns.stepId, "run-child")));
    await db.update(workflowRuns).set({ startedAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(workflowRuns.id, result.runId));

    await reconcileWorkflow(db, { timeoutMinutes: 60 });

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId));
    expect(run?.status).not.toBe("failed");
    const [waitingStep] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, result.runId), eq(workflowStepRuns.stepId, "run-child")));
    expect(waitingStep?.status).toBe("completed");
  });

  it("fails closed on cross-company ancestry in the depth walker (verifier edge)", async () => {
    const companyIdA = await createCompanyFixture("Fix Depth A");
    const companyIdB = await createCompanyFixture("Fix Depth B");
    const foreignDefId = await insertDefinition({ companyId: companyIdB, name: "foreign-wf", steps: [] });
    const foreignRunId = randomUUID();
    await db.insert(workflowRuns).values({
      id: foreignRunId,
      workflowId: foreignDefId,
      companyId: companyIdB,
      status: "running",
      triggeredBy: "board",
    });
    const depth = await runDepthOfParentRun(db, {
      parentRunId: foreignRunId,
      rootRunId: null,
      companyId: companyIdA,
    });
    expect(depth).toBeGreaterThan(WORKFLOW_CHILD_MAX_DEPTH);
    void companyIdA;
    void normalizeWorkflowStepsForExecution;
  });
});
