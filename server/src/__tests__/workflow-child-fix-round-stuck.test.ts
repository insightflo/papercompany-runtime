// @vitest-environment node
// [workflow-child fix round / descope v1] P1-7 stuck-run 경계(분할 스위트). 라이브 자식 대기 +
//   봉쇄된 후행 스텝이 있는 run 은 stuck pass 가 실패 처리하지 않고, terminal 자식 정산은 stuck
//   pass 보다 먼저 reconcileWorkflow 한 패스에서 치유된다. 설계 §5 분할(파일 300행 상한).
//   /tmp/task-spec-wfw-fix.txt 기준.
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
} from "../services/workflow/workflow-child-execution.js";
import {
  completeWorkflowToolStepFromResult,
  setWorkflowToolStepExecutor,
  setWorkflowToolStepReadinessChecker,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import { reconcileStuckWorkflowRuns, reconcileWorkflow } from "../services/workflow/reconciler.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
} from "./helpers/workflow-child-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describeEmbeddedPostgres("workflow child fix round — stuck boundaries", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix-stuck-");
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

  /** 툴 스텝 자식 + 봉쇄된 후행 툴 스텝을 가진 부모 run 을 trigger 한다. */
  async function triggerParentWithWaitingChild(companyId: string, name: string) {
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
      name: `${name}-child`,
      steps: [{ id: "t", name: "T", type: "tool", agentId: "", dependencies: [], toolNames: ["ok-tool"], toolArgs: {} }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: `${name}-parent`,
      steps: [
        childStep(childDefId),
        { id: "downstream", name: "D", type: "tool", agentId: "", dependencies: ["run-child"], toolNames: ["ok-tool"], toolArgs: {} },
      ],
    });
    return await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
  }

  it("does not force-fail a stuck run with a live child wait plus blocked dependents (P1-7)", async () => {
    const companyId = await createCompanyFixture("Fix Stuck Co");
    const result = await triggerParentWithWaitingChild(companyId, "stuck");
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
    const result = await triggerParentWithWaitingChild(companyId, "order");
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
});
