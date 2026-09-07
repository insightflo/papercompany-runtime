// @vitest-environment node
// [workflow-child fix round 2] round-2 검증 프로브(/tmp/wfw-r2-probes)의 회귀 반대 단언.
//   각 테스트는 프로브가 재현한 결함의 "올바른" 동작을 요구한다. /tmp/task-spec-wfw-fix2.txt.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  hasLiveWorkflowChildWait,
  reconcileWorkflowChildStepWaits,
} from "../services/workflow/workflow-child-execution.js";
import {
  cancelWorkflowRunWithCleanup,
  executeWorkflowRun,
  normalizeWorkflowStepsForExecution,
} from "../services/workflow/dag-engine.js";
import {
  dispatchWorkflowChildStep,
  runWorkflowChildCompletionHook,
} from "../services/workflow/workflow-child-execution.js";
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

type Linked = {
  companyId: string;
  runId: string;
  stepRunId: string;
  childRunId: string;
  childDefId: string;
  invocationId: string;
};

/** 프로브와 동일한 linked 픽스처(adopted/state 제어 가능). */
async function linked(name: string, opts: { adopted?: boolean; childStatus?: string; wait?: boolean } = {}): Promise<Linked> {
  const adopted = opts.adopted ?? true;
  const childStatus = opts.childStatus ?? "pending";
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({
    companyId,
    name: "child",
    steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
  });
  const parentDefId = await insertDefinition({ companyId, name: "parent", steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const childRunId = randomUUID();
  await db.insert(workflowRuns).values({
    id: childRunId,
    workflowId: childDefId,
    companyId,
    status: childStatus,
    triggeredBy: "workflow-step",
    triggerSource: "workflow",
    parentRunId: runId,
    parentStepRunId: stepRunId,
    rootRunId: runId,
  });
  const [inv] = await db.insert(workflowStepInvocations).values({
    companyId,
    parentStepRunId: stepRunId,
    childRunId,
    generation: 1,
    state: "linked",
  }).returning();
  if (adopted) {
    await db.update(workflowStepRuns).set({
      metadata: { workflowChild: { childRunId, invocationId: inv.id, generation: 1, wait: opts.wait ?? true } },
    }).where(eq(workflowStepRuns.id, stepRunId));
  }
  return { companyId, runId, stepRunId, childRunId, childDefId, invocationId: inv.id };
}

describeEmbeddedPostgres("workflow child fix round 2 — probe regressions", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix2-");
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

  it("reg probe1: adopted-but-unstarted child is claimed and started by recovery (P1-3)", async () => {
    const x = await linked("R2AdoptCrash", { adopted: true, childStatus: "pending" });
    const results = await reconcileWorkflowChildStepWaits(db);
    expect(results[0]?.action).toBe("recovered");
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.status).not.toBe("pending");
    expect(child?.startedAt).not.toBeNull();
    // 두 번째 패스에서도 정상(healthy) 상태로 수렴 — 영구 pending 아님.
    const second = await reconcileWorkflowChildStepWaits(db);
    const [childAfter] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(childAfter?.status).toBe(child?.status);
    void second;
  });

  it("reg probe2: cancelled child is never resurrected by a delayed executeWorkflowRun (P1-2)", async () => {
    const x = await linked("R2CancelRace", { adopted: true, childStatus: "pending" });
    await cancelWorkflowRunWithCleanup(db, x.runId, x.companyId);
    const [cancelled] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(cancelled?.status).toBe("cancelled");
    await expect(executeWorkflowRun(db, x.childRunId)).rejects.toThrow(/cancelled/i);
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.status).toBe("cancelled");
    const [parent] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    expect(parent?.status).toBe("cancelled");
  });

  it("reg probe3: terminal child settles despite an older healthy wait under a tiny scan limit (P1-4)", async () => {
    await linked("R2OldLive", { adopted: true, childStatus: "running" });
    const x = await linked("R2NewTerminal", { adopted: true, childStatus: "completed" });
    const results = await reconcileWorkflowChildStepWaits(db, { limit: 1 });
    expect(results[0]?.stepRunId).toBe(x.stepRunId);
    expect(results[0]?.action).toBe("recovered");
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(step?.status).toBe("completed");
  });

  it("reg probe4: deleting the child definition keeps a tombstone receipt that settles child_run_failed (P1-5)", async () => {
    const x = await linked("R2DeletedChild", { adopted: true, childStatus: "running" });
    await db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, x.childDefId));
    const receipts = await db.select().from(workflowStepInvocations);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.childRunId).toBeNull();
    expect(receipts[0]?.state).toBe("linked");
    const results = await reconcileWorkflowChildStepWaits(db);
    expect(results[0]?.action).toBe("recovered");
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(step?.status).toBe("failed");
    expect((step?.metadata as Record<string, unknown>).toolResult)
      .toEqual(expect.objectContaining({ error: "child_run_failed" }));
  });

  it("reg probe5: terminal unadopted child settles via authoritative linkage repair (P1-3)", async () => {
    const x = await linked("R2TerminalNoAdopt", { adopted: false, childStatus: "completed" });
    const results = await reconcileWorkflowChildStepWaits(db);
    expect(results[0]?.action).toBe("recovered");
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(step?.status).toBe("completed");
  });

  it("reg probe6: stale dispatch snapshot cannot consume a newer waiting retry (P1-1)", async () => {
    const x = await linked("R2StaleAdoption", { adopted: true, childStatus: "failed" });
    const [oldStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    const nextEligibleAt = new Date(Date.now() + 60_000).toISOString();
    await db.update(workflowStepRuns).set({
      retryCount: 1,
      metadata: {
        ...oldStep?.metadata,
        workflowRetry: {
          state: "waiting", retryNumber: 1, maxRetries: 2, nextEligibleAt,
          sourceRequestId: null, sourceCompletedAt: null, lastErrorSummary: null,
        },
      },
    }).where(eq(workflowStepRuns.id, x.stepRunId));
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run?.workflowId ?? ""));
    // 스테일 스냅숏(retryCount=0, gen 1)으로 dispatch 재개.
    await dispatchWorkflowChildStep({
      db,
      run: run!,
      definition: definition!,
      step: normalizeWorkflowStepsForExecution(definition!.stepsJson)[0],
      stepRun: oldStep!,
      now: new Date(),
    });
    const [adopted] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    const retry = (adopted?.metadata as Record<string, unknown>).workflowRetry as Record<string, unknown>;
    // 미래 retry 마감이 보존되고 waiting 이 소비되지 않는다.
    expect(retry.state).toBe("waiting");
    expect(retry.nextEligibleAt).toBe(nextEligibleAt);
    expect(adopted?.retryCount).toBe(1);
    // 구세대 자식 실패 훅은 새 retry 를 완료하지 못한다.
    const settled = await runWorkflowChildCompletionHook(db, { id: x.childRunId, companyId: x.companyId, status: "failed" });
    expect(settled).toBe(false);
    const [ended] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(ended?.status).toBe("pending");
  });

  it("reg probe7: cancelling the root reaches a running grandchild below a terminal intermediate (P1-6)", async () => {
    const x = await linked("R2TerminalBridge", { adopted: true, childStatus: "completed" });
    const grandchildId = randomUUID();
    await db.insert(workflowRuns).values({
      id: grandchildId,
      workflowId: x.childDefId,
      companyId: x.companyId,
      status: "running",
      triggeredBy: "workflow-step",
      triggerSource: "workflow",
      parentRunId: x.childRunId,
      rootRunId: x.runId,
    });
    await cancelWorkflowRunWithCleanup(db, x.runId, x.companyId);
    const [grandchild] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, grandchildId));
    expect(grandchild?.status).toBe("cancelled");
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.status).toBe("completed");
  });

  it("reg P1-3 liveness: deleted (tombstoned) child is not live; unstarted child stays startable-live", async () => {
    const alive = await linked("R2LiveAlive", { adopted: true, childStatus: "running" });
    expect(await hasLiveWorkflowChildWait(db, { id: alive.stepRunId, metadata: {} })).toBe(true);
    const dead = await linked("R2LiveDead", { adopted: true, childStatus: "running" });
    await db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, dead.childDefId));
    expect(await hasLiveWorkflowChildWait(db, { id: dead.stepRunId, metadata: {} })).toBe(false);
  });
});
