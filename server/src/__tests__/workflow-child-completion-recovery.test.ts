// @vitest-environment node
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow child-step tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

import { agents } from "@paperclipai/db";
import {
  dispatchWorkflowChildStep,
  reconcileWorkflowChildStepWaits,
  runWorkflowChildCompletionHook,
} from "../services/workflow/workflow-child-execution.js";
import { failChildStep } from "../services/workflow/workflow-child-completion.js";
import { normalizeWorkflowStepsForExecution } from "../services/workflow/dag-engine.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";

let db: Awaited<ReturnType<typeof createDb>>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describeEmbeddedPostgres("workflow-child completion/recovery", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-child-recovery-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
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

  /** dispatch 로 법정 linked 자식을 만든다(클레임 트랜잭션 경유 — 유일한 legal 생성 경로). */
  async function dispatchAndGetChild(input: { companyId: string; parentDefId: string; name: string }) {
    const childDefId = await insertDefinition({
      companyId: input.companyId,
      name: `${input.name}-child`,
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId: input.companyId,
      name: `${input.name}-parent`,
      steps: [childStep(childDefId)],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({
      companyId: input.companyId,
      workflowId: parentDefId,
    });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson).find((s) => s.id === "run-child")!;
    const stepRun = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0];
    expect(await dispatchWorkflowChildStep({ db, run, definition, step, stepRun, now: new Date() })).toBe(true);
    const [childRun] = await db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(childRun).toBeTruthy();
    return { runId, stepRunId, childRun: childRun! };
  }

  it("propagates a durable failed child to the waiting parent step via the completion hook", async () => {
    const companyId = await createCompanyFixture("Hook Co");
    const { stepRunId, childRun } = await dispatchAndGetChild({ companyId, parentDefId: randomUUID(), name: "hook" });
    await db
      .update(workflowRuns)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(workflowRuns.id, childRun.id));
    await runWorkflowChildCompletionHook(db, { id: childRun.id, companyId: childRun.companyId, status: "failed" });
    const [failedStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(failedStepRun?.status).toBe("failed");
    expect((failedStepRun?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: false, error: "child_run_failed" }),
    );
  });

  it("cancelled child completes the waiting parent step with child_run_cancelled", async () => {
    const companyId = await createCompanyFixture("Cancel Co");
    const { stepRunId, childRun } = await dispatchAndGetChild({ companyId, parentDefId: randomUUID(), name: "cancel" });
    // 훅은 호출자 status 를 신뢰하지 않고 자식 run 의 영속 종말 상태를 재조회한다 — 먼저 영속화.
    await db
      .update(workflowRuns)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(workflowRuns.id, childRun.id));
    await runWorkflowChildCompletionHook(db, { id: childRun.id, companyId: childRun.companyId, status: "cancelled" });
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(stepRun?.status).toBe("failed");
    expect((stepRun?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: false, error: "child_run_cancelled" }),
    );
  });

  it("completion requires a durable terminal child at the final write — hint status alone is a no-op", async () => {
    const companyId = await createCompanyFixture("Durable Co");
    const { stepRunId, childRun } = await dispatchAndGetChild({ companyId, parentDefId: randomUUID(), name: "durable" });
    // 자식 run 행은 아직 running — 호출자 status 힌트("completed")는 완료 권위가 없다.
    const settled = await runWorkflowChildCompletionHook(db, {
      id: childRun.id,
      companyId: childRun.companyId,
      status: "completed",
    });
    expect(settled).toBe(false);
    const [pendingStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(pendingStepRun?.status).toBe("pending");
    expect((pendingStepRun?.metadata as Record<string, unknown>).toolResult).toBeUndefined();
  });

  it("settles a deleted-child tombstone once as child_run_failed, then repeated settlement is a no-op", async () => {
    const companyId = await createCompanyFixture("Tombstone Co");
    const { runId, stepRunId, childRun } = await dispatchAndGetChild({ companyId, parentDefId: randomUUID(), name: "tomb" });
    // 자식 run 행 삭제 → FK ON DELETE SET NULL → linked+NULL tombstone(D4).
    await db.delete(workflowRuns).where(eq(workflowRuns.id, childRun.id));
    const [invocation] = await db.select().from(workflowStepInvocations);
    expect(invocation?.state).toBe("linked");
    expect(invocation?.childRunId).toBeNull();

    const settled = await failChildStep(db, {
      companyId,
      workflowRunId: runId,
      stepRunId,
      stepId: "run-child",
      errorCode: "child_run_failed",
      detail: "linked child workflow run was deleted",
      tombstone: { invocationId: invocation!.id, generation: 1 },
    });
    expect(settled.outcome).toBe("settled");
    const [failedStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(failedStepRun?.status).toBe("failed");
    expect((failedStepRun?.metadata as Record<string, unknown>).toolResult).toEqual(
      expect.objectContaining({ success: false, error: "child_run_failed" }),
    );

    // 반복 정산/tombstone 콜백 — 이미 정산된 S 는 no-op 이다(1회 정산 계약).
    const repeated = await failChildStep(db, {
      companyId,
      workflowRunId: runId,
      stepRunId,
      stepId: "run-child",
      errorCode: "child_run_failed",
      detail: "linked child workflow run was deleted",
      tombstone: { invocationId: invocation!.id, generation: 1 },
    });
    expect(repeated.outcome).toBe("no-op");
  });

  it("unlinked and tombstone child callbacks are typed no-ops — no plain settlement authority", async () => {
    const companyId = await createCompanyFixture("Unlinked Co");
    const { stepRunId, childRun } = await dispatchAndGetChild({ companyId, parentDefId: randomUUID(), name: "unlinked" });
    await db
      .update(workflowRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(workflowRuns.id, childRun.id));
    // tombstone: 링크를 끊고(자식 삭제) 같은 childRunId 로 훅 재호출 — linked invocation 이 없다.
    await db.delete(workflowRuns).where(eq(workflowRuns.id, childRun.id));
    const hook = await runWorkflowChildCompletionHook(db, {
      id: childRun.id,
      companyId: childRun.companyId,
      status: "completed",
    });
    expect(hook).toBe(false);
    // 스텝은 tombstone 정산 전까지 pending 으로 남는다(무링크 완료 권위 없음).
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(stepRun?.status).toBe("pending");
    // plain run — invocation 이 아예 없는 run 의 종말 훅도 no-op 이다.
    const plainHook = await runWorkflowChildCompletionHook(db, {
      id: runId2(companyId),
      companyId,
      status: "completed",
    });
    expect(plainHook).toBe(false);
  });

  it("reconciler heals an orphaned wait: durable terminal child while parent step pending", async () => {
    const companyId = await createCompanyFixture("Reconcile Co");
    const { stepRunId, childRun } = await dispatchAndGetChild({ companyId, parentDefId: randomUUID(), name: "recon" });
    // simulate age for the reconciler cutoff
    await db
      .update(workflowStepRuns)
      .set({ lastDispatchAttemptAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(workflowStepRuns.id, stepRunId));
    // child completed out-of-band
    await db
      .update(workflowRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(workflowRuns.id, childRun.id));

    const results = await reconcileWorkflowChildStepWaits(db, { now: new Date() });
    expect(results.length).toBeGreaterThan(0);
    const [healedStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(healedStepRun?.status).toBe("completed");
  });

  function runId2(_companyId: string): string {
    return randomUUID();
  }
});
