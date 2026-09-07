// @vitest-environment node
// [workflow-child fix round] P1-2/3 retry·세대 검증: 실제 policy retry 체인, stale hook 차단,
// 경쟁 reconciler 멱등성. /tmp/task-spec-wfw-fix.txt 기준.
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
  runWorkflowChildCompletionHook,
  reconcileWorkflowChildStepWaits,
} from "../services/workflow/workflow-child-execution.js";
import {
  completeWorkflowToolStepFromResult,
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

describeEmbeddedPostgres("workflow child fix round — retry/generation", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix-retry-");
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

  it("runs real policy retry on child failure: one new child per attempt, exhaustion at maxRetries (P1-3)", async () => {
    const companyId = await createCompanyFixture("Fix Retry Co");
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true, ok: false, error: "boom" });
    setWorkflowToolStepExecutor(toolExecutor);
    const childDefId = await insertDefinition({
      companyId,
      name: "failing-child-wf",
      steps: [{
        id: "t",
        name: "T",
        type: "tool",
        agentId: "",
        dependencies: [],
        toolNames: ["fail-tool"],
        toolArgs: {},
      }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [{
        ...childStep(childDefId),
        onFailure: "retry",
        maxRetries: 2,
        graphRetryDelaySeconds: 0,
      }],
    });
    await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    // 각 시도의 자식 툴 스텝을 tool-runner 콜백처럼 실패 완료한다 — 훅이 부모 스텝을 마감하고
    //   policy retry 가 다음 세대 자식을 발사한다(초기 + retry 2회 = 3회 반복).
    for (let i = 0; i < 3; i++) {
      const [inv] = await db.select().from(workflowStepInvocations);
      if (!inv?.childRunId) break;
      const [childStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, inv.childRunId));
      if (!childStepRun) break;
      await completeWorkflowToolStepFromResult(db, {
        companyId,
        stepRunId: childStepRun.id,
        workflowRunId: inv.childRunId,
        stepId: childStepRun.stepId,
        toolName: "fail-tool",
        success: false,
        data: { ok: false, error: "boom" },
        error: "boom",
        stderr: "boom",
        exitCode: 1,
      });
    }
    const children = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    // 초기 시도 + retry 2회 = 정확히 3개 자식, 전부 실행되어 failed 로 종말(취소된 잉여 없음).
    expect(children).toHaveLength(3);
    expect(children.every((c) => c.status === "failed")).toBe(true);
    const [invocation] = await db.select().from(workflowStepInvocations);
    expect(invocation?.generation).toBe(3);
    const [finalRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, children[0]?.parentRunId ?? ""));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, finalRun?.id ?? ""));
    expect(finalRun?.status).toBe("failed");
    expect(stepRun?.status).toBe("failed");
    expect(stepRun?.retryCount).toBe(2);
    expect((stepRun?.metadata as Record<string, unknown>).workflowRetryExhaustion).toEqual({ attempts: 3, maxRetries: 2 });
  });

  it("blocks stale hook against retry-waiting step and newer generation, re-reads child status from DB (P1-2)", async () => {
    const companyId = await createCompanyFixture("Fix Stale Co");
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(randomUUID())],
    });
    const child1Id = randomUUID();
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({
      companyId,
      workflowId: parentDefId,
      metadata: {
        workflowChild: { childRunId: child1Id, generation: 1, wait: true, dispatchedAt: new Date().toISOString() },
      },
    });
    await db.insert(workflowRuns).values({
      id: child1Id,
      workflowId: parentDefId,
      companyId,
      status: "failed",
      triggeredBy: "workflow-step",
      triggerSource: "workflow",
      parentRunId: runId,
      parentStepRunId: stepRunId,
      rootRunId: runId,
    });
    await db.insert(workflowStepInvocations).values({
      companyId,
      parentStepRunId: stepRunId,
      childRunId: child1Id,
      generation: 1, state: "linked",
    });

    // 세대 1 hook(구세대 자식 종말) → 정상 마감된다.
    const first = await runWorkflowChildCompletionHook(db, { id: child1Id, companyId, status: "failed" });
    expect(first).toBe(true);

    // policy retry 가 예약된 상태(workflowRetry waiting)로 시뮬레이션 → 같은 hook 재발화는 차단.
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    await db.update(workflowStepRuns).set({
      status: "pending",
      retryCount: 1,
      metadata: {
        ...(stepRun?.metadata as Record<string, unknown>),
        workflowRetry: {
          retryNumber: 1,
          state: "waiting",
          nextEligibleAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    }).where(eq(workflowStepRuns.id, stepRunId));
    const blocked = await runWorkflowChildCompletionHook(db, { id: child1Id, companyId, status: "failed" });
    expect(blocked).toBe(false);
    const [stillPending] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(stillPending?.status).toBe("pending");

    // 세대 2 치환 후: 호출자가 status 를 failed 로 줘도 DB 재조회 값(completed)이 승리한다.
    const child2Id = randomUUID();
    await db.insert(workflowRuns).values({
      id: child2Id,
      workflowId: parentDefId,
      companyId,
      status: "completed",
      triggeredBy: "workflow-step",
      triggerSource: "workflow",
      parentRunId: runId,
      parentStepRunId: stepRunId,
      rootRunId: runId,
    });
    await db.update(workflowStepInvocations).set({ childRunId: child2Id, generation: 2 })
      .where(eq(workflowStepInvocations.parentStepRunId, stepRunId));
    await db.update(workflowStepRuns).set({
      metadata: {
        workflowChild: { childRunId: child2Id, generation: 2, wait: true, dispatchedAt: new Date().toISOString() },
      },
    }).where(eq(workflowStepRuns.id, stepRunId));
    const second = await runWorkflowChildCompletionHook(db, { id: child2Id, companyId, status: "failed" });
    expect(second).toBe(true);
    const [completed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(completed?.status).toBe("completed");
    // 구세대 자식(C1)은 세대 불일치로 더 이상 마감할 수 없다.
    const stale = await runWorkflowChildCompletionHook(db, { id: child1Id, companyId, status: "failed" });
    expect(stale).toBe(false);
  });

  it("competing reconcilers settle a terminal child exactly once (P1-2)", async () => {
    const companyId = await createCompanyFixture("Fix Race Co");
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(randomUUID())],
    });
    const childId = randomUUID();
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({
      companyId,
      workflowId: parentDefId,
      metadata: {
        workflowChild: { childRunId: childId, generation: 1, wait: true, dispatchedAt: new Date().toISOString() },
      },
    });
    await db.insert(workflowRuns).values({
      id: childId,
      workflowId: parentDefId,
      companyId,
      status: "completed",
      triggeredBy: "workflow-step",
      triggerSource: "workflow",
      parentRunId: runId,
      parentStepRunId: stepRunId,
      rootRunId: runId,
    });
    await db.insert(workflowStepInvocations).values({
      companyId,
      parentStepRunId: stepRunId,
      childRunId: childId,
      generation: 1,
      state: "linked",
    });

    const results = await Promise.all([
      reconcileWorkflowChildStepWaits(db, { olderThanMs: 0 }),
      reconcileWorkflowChildStepWaits(db, { olderThanMs: 0 }),
    ]);
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(stepRun?.status).toBe("completed");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run?.status).toBe("completed");
    expect(results.flat().every((r) => r.action !== "failed")).toBe(true);
  });
});
