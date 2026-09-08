// @vitest-environment node
// [workflow-child fix round / descope v1] 신원/입력/CURRENT 제어와 동시성 cap 회귀. 원자적
//   클레임(이중 자식 차단, generation=1 고정)과 adopted-waiting cap 5는 유지되고, policy retry
//   체인/세대 CAS 상호작용은 D2 로 삭제됐다(거부 계약은 workflow-child-retry-refusal 스위트).
//   /tmp/task-spec-wfw-fix.txt 기준 + /tmp/wfw-descope-design.md §5 S 처분.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
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
  dispatchWorkflowChildStep,
  runWorkflowChildCompletionHook,
  reconcileWorkflowChildStepWaits,
} from "../services/workflow/workflow-child-execution.js";
import {
  completeWorkflowToolStepFromResult,
  normalizeWorkflowStepsForExecution,
  setWorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
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

describeEmbeddedPostgres("workflow child fix round — concurrency/retry", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
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

  it("concurrent double-dispatch creates and executes exactly one child (P1-1)", async () => {
    const companyId = await createCompanyFixture("Fix Double Co");
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
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;

    const outcomes = await Promise.allSettled([
      dispatchWorkflowChildStep({ db, run, definition, step, stepRun, now: new Date() }),
      dispatchWorkflowChildStep({ db, run, definition, step, stepRun, now: new Date() }),
    ]);
    expect(outcomes.map((o) => o.status === "fulfilled" && o.value)).toEqual([true, true]);

    const children = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(children).toHaveLength(1);
    // 단일 자식만 실행됐다 — 취소된 잉여 자식이 없어야 한다.
    expect(children[0]?.status).not.toBe("cancelled");
    const [invocation] = await db.select().from(workflowStepInvocations);
    expect(invocation?.childRunId).toBe(children[0]?.id);
    expect(invocation?.childRunId).not.toBe(runId);
    // [descope D2] 세대 교체 없음 — 클레임 신원은 항상 generation 1 이다.
    expect(invocation?.generation).toBe(1);
    expect(invocation?.state).toBe("linked");
  });

  it("enforces the waiting cap at 5 for six concurrent workflow steps (P2-8, wait:true only)", async () => {
    const companyId = await createCompanyFixture("Fix Cap Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: Array.from({ length: 6 }, (_, i) => ({
        ...childStep(childDefId),
        id: `run-child-${i}`,
        name: `Run child ${i}`,
      })),
    });
    const result = await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, result.runId));
    const failed = stepRuns.filter((s) => s.status === "failed");
    const waiting = stepRuns.filter((s) => s.status === "pending");
    expect(waiting).toHaveLength(5);
    expect(failed).toHaveLength(1);
    expect((failed[0]?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ error: "child_concurrency_exceeded" }),
    );
    const invocations = await db.select().from(workflowStepInvocations);
    expect(invocations).toHaveLength(5);
    const children = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(children).toHaveLength(5);
  });

  it("dispatches six sequential workflow steps without cap violations (P2-8)", async () => {
    const companyId = await createCompanyFixture("Fix Seq Co");
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{
        id: "t",
        name: "T",
        type: "tool",
        agentId: "",
        dependencies: [],
        toolNames: ["ok-tool"],
        toolArgs: {},
      }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: Array.from({ length: 6 }, (_, i) => ({
        ...childStep(childDefId),
        id: `seq-${i}`,
        name: `Seq ${i}`,
        dependencies: i === 0 ? [] : [`seq-${i - 1}`],
      })),
    });
    const result = await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    // 각 자식의 툴 스텝을 tool-runner 콜백처럼 직접 완료한다 — 완료 → 훅이 부모 스텝 마감 →
    //   sync 가 다음 순차 스텝을 발화한다. pending 이 소진될 때까지 반복.
    for (let i = 0; i < 12; i++) {
      const pendingParentSteps = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, result.runId)))
        .filter((s) => s.status === "pending");
      if (pendingParentSteps.length === 0) break;
      const waiting = pendingParentSteps.find((s) => {
        const meta = s.metadata as Record<string, unknown> | null;
        return !!meta && typeof meta === "object" && !!meta.workflowChild;
      });
      if (!waiting) break;
      const childRunId = ((waiting.metadata as Record<string, unknown>).workflowChild as Record<string, unknown>).childRunId as string;
      const [childStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, childRunId));
      await completeWorkflowToolStepFromResult(db, {
        companyId,
        stepRunId: childStepRun.id,
        workflowRunId: childRunId,
        stepId: childStepRun.stepId,
        toolName: "ok-tool",
        success: true,
        data: { ok: true },
        stdout: "",
        exitCode: 0,
      });
    }
    const stepRunsAfter = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, result.runId));
    expect(stepRunsAfter.every((s) => s.status === "completed")).toBe(true);
    const children = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(children).toHaveLength(6);
    expect(children.every((c) => c.status === "completed")).toBe(true);
  });

});
