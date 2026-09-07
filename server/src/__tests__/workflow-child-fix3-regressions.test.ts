// @vitest-environment node
// [workflow-child fix round 3] P1 회귀(라운드-3 프로브 FireCrash/ModeCrash/ClaimCrash/
// FullClaimCrash/FutureRetry/TombstoneDispatch 의 반대 단언). /tmp/task-spec-wfw-fix3.txt.
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
  adoptChildForWaitingStep,
  claimWorkflowChildRunStart,
  hasLiveWorkflowChildWait,
  reconcileWorkflowChildStepWaits,
} from "../services/workflow/workflow-child-execution.js";
import {
  normalizeWorkflowStepsForExecution,
} from "../services/workflow/dag-engine.js";
import { dispatchWorkflowChildStep } from "../services/workflow/workflow-child-execution.js";
import { reconcileStuckWorkflowRuns, reconcileWorkflow } from "../services/workflow/reconciler.js";
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

async function linked(name: string, opts: { adopted?: boolean; childStatus?: string } = {}): Promise<Linked> {
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
    status: opts.childStatus ?? "pending",
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
    wait: true,
  }).returning();
  if (opts.adopted ?? true) {
    await db.update(workflowStepRuns).set({
      metadata: { workflowChild: { childRunId, invocationId: inv.id, generation: 1, wait: true } },
    }).where(eq(workflowStepRuns.id, stepRunId));
  }
  return { companyId, runId, stepRunId, childRunId, childDefId, invocationId: inv.id };
}

describeEmbeddedPostgres("workflow child fix round 3 — P1 regressions", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix3-");
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

  it("reg FireCrash: unstarted wait:false child of a COMPLETED parent is still started by recovery (P1-1)", async () => {
    const x = await linked("R3FireCrash", { adopted: false });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    const [inv] = await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.parentStepRunId, x.stepRunId));
    await db.update(workflowDefinitions).set({ stepsJson: [childStep(x.childDefId, { wait: false })] })
      .where(eq(workflowDefinitions.id, run.workflowId));
    // 실제 adoption API 로 fire-and-forget 마감(부모 run 이 먼저 완료되는 크래시 창 재현).
    expect(await adoptChildForWaitingStep(db, {
      companyId: x.companyId, run, step: childStep(x.childDefId, { wait: false }) as never, stepRun,
      now: new Date(), wait: false, renderedInputs: {}, invocationId: inv.id, childRunId: x.childRunId, generation: 1,
    })).toBe(true);
    // 프로덕션 claim 트랜잭션이 wait=false 를 내구 기록한 상태를 모델링한다(fix4 §6 —
    // 실제 dispatch 클레임은 원자적으로 wait 를 기록; 미기록 행은 legacy default-true 로 계약됨).
    await db.update(workflowStepInvocations).set({ wait: false })
      .where(eq(workflowStepInvocations.parentStepRunId, x.stepRunId));
    const [parent] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    expect(parent?.status).toBe("completed");
    // 회복이 부모 상태와 무관하게 미시작 자식을 시작한다.
    const results = await reconcileWorkflowChildStepWaits(db);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.action === "recovered")).toBe(true);
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.status).not.toBe("pending");
    expect(child?.startedAt).not.toBeNull();
  });

  it("reg ModeCrash: unadopted wait:false recovery preserves the requested fire-and-forget mode (P1-1)", async () => {
    const x = await linked("R3ModeCrash", { adopted: false });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    await db.update(workflowDefinitions).set({ stepsJson: [childStep(x.childDefId, { wait: false })] })
      .where(eq(workflowDefinitions.id, run.workflowId));
    // 클레임에 요청된 wait 모드를 기록한다(프로덕션 claim tx 와 동일).
    await db.update(workflowStepInvocations).set({ wait: false }).where(eq(workflowStepInvocations.parentStepRunId, x.stepRunId));
    await reconcileWorkflowChildStepWaits(db);
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    const meta = step?.metadata as Record<string, unknown>;
    expect((meta.workflowChild as Record<string, unknown>).wait).toBe(false);
    // fire-and-forget: adoption 복구가 스텝을 즉시 완료한다(pending 대기로 바뀌지 않는다).
    expect(step?.status).toBe("completed");
  });

  it("reg ClaimCrash: claimed-but-unmaterialized child is resumed with real step execution (P1-2)", async () => {
    const x = await linked("R3ClaimCrash", { adopted: true, childStatus: "pending" });
    expect(await claimWorkflowChildRunStart(db, { childRunId: x.childRunId, companyId: x.companyId })).toBe(true);
    const first = await reconcileWorkflowChildStepWaits(db);
    const second = await reconcileWorkflowChildStepWaits(db);
    void second;
    expect(first.some((r) => r.action === "recovered")).toBe(true);
    const childSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.childRunId));
    expect(childSteps.length).toBeGreaterThan(0);
    expect(await hasLiveWorkflowChildWait(db, { id: x.stepRunId, metadata: {} })).toBe(true);
  });

  it("reg FullClaimCrash: full reconciliation launches the claimed child and stuck pass spares unmaterialized runs (P1-2)", async () => {
    const x = await linked("R3FullClaim", { adopted: true, childStatus: "pending" });
    expect(await claimWorkflowChildRunStart(db, { childRunId: x.childRunId, companyId: x.companyId })).toBe(true);
    await reconcileWorkflow(db);
    const childSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.childRunId));
    expect(childSteps.length).toBeGreaterThan(0);
    // 자식 시작 시각을 임계치 넘게 밀어도 generic timeout 이 미 materialized run 을 실패 처리하지 못한다.
    await db.update(workflowRuns).set({ startedAt: new Date(Date.now() - 7_200_000) }).where(eq(workflowRuns.id, x.childRunId));
    const stuck = await reconcileStuckWorkflowRuns(db, 60);
    expect(stuck.every((r) => r.action !== "recovered" || !r.reason?.includes("Marked stuck run as failed"))).toBe(true);
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.status).not.toBe("failed");
  });

  it("reg FutureRetry: future-retry terminal receipt no longer blocks a younger processable candidate (P1-3)", async () => {
    const old = await linked("R3FutureRetry", { adopted: true, childStatus: "failed" });
    const [s] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, old.stepRunId));
    await db.update(workflowStepRuns).set({
      retryCount: 1,
      metadata: {
        ...s?.metadata,
        workflowRetry: {
          state: "waiting", retryNumber: 1, maxRetries: 2,
          nextEligibleAt: new Date(Date.now() + 3_600_000).toISOString(),
          sourceRequestId: null, sourceCompletedAt: null, lastErrorSummary: null,
        },
      },
    }).where(eq(workflowStepRuns.id, s!.id));
    const younger = await linked("R3YoungerDone", { adopted: true, childStatus: "completed" });
    // 첫 패스: 미래 retry 영수증이 limit=1 을 점유하지 못하고 더 어린 정산 가능 영수증이 선택된다.
    const rows = await reconcileWorkflowChildStepWaits(db, { limit: 1 });
    expect(rows[0]?.stepRunId).toBe(younger.stepRunId);
    expect(rows[0]?.action).toBe("recovered");
    const [youngerStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, younger.stepRunId));
    expect(youngerStep?.status).toBe("completed");
    // 정산된 뒤 남은 것은 배제된 구세대 영수증뿐 — 후보가 비어 있다(점유 없음).
    const after = await reconcileWorkflowChildStepWaits(db, { limit: 1 });
    expect(after).toHaveLength(0);
    // 미래 retry 는 소비되지 않는다.
    const [oldStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, old.stepRunId));
    const retry = (oldStep?.metadata as Record<string, unknown>).workflowRetry as Record<string, unknown>;
    expect(retry.state).toBe("waiting");
    expect(oldStep?.status).toBe("pending");
  });

  it("reg TombstoneDispatch: dispatch settles a deletion tombstone instead of recreating (P1-4)", async () => {
    const x = await linked("R3Tombstone", { adopted: true, childStatus: "running" });
    await db.delete(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run?.workflowId ?? ""));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    const dispatched = await dispatchWorkflowChildStep({
      db,
      run: run!,
      definition: definition!,
      step: normalizeWorkflowStepsForExecution(definition!.stepsJson)[0],
      stepRun: stepRun!,
      now: new Date(),
    });
    expect(dispatched).toBe(false);
    const [inv] = await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.parentStepRunId, x.stepRunId));
    expect(inv?.childRunId).toBeNull();
    expect(inv?.state).toBe("linked");
    const children = await db.select().from(workflowRuns).where(eq(workflowRuns.parentRunId, x.runId));
    expect(children).toHaveLength(0);
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(step?.status).toBe("failed");
    expect((step?.metadata as Record<string, unknown>).toolResult)
      .toEqual(expect.objectContaining({ error: "child_run_failed" }));
  });
});
