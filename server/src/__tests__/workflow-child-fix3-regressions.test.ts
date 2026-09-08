// @vitest-environment node
// [workflow-child fix round 3 / descope v1] P1 회귀(라운드-3 프로브의 descope 재현).
//   FireCrash/ModeCrash: 저장된 wait:false 정의는 런타임 경계에서 typed 거부된다(모드 복구/수리
//   없음). ClaimCrash/FullClaimCrash: unleased 시작 헬퍼는 삭제됐고, 임대 소유자 크래시 회복은
//   같은 linked 자식의 전체 신원 임대(acquireWorkflowChildStartLease)로만 이어받는다. FutureRetry:
//   retry 주입 S 는 actionable 한도를 점유하지 않고 invalid 진단으로 분리된다. TombstoneDispatch:
//   dispatch 는 tombstone 을 재생성하지 않고 1회 fenced 정산한다.
//   /tmp/task-spec-wfw-fix3.txt + 설계 §5/§6 S/R 처분.
import { eq, sql } from "drizzle-orm";
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
  reconcileWorkflowChildStepWaits,
} from "../services/workflow/workflow-child-execution.js";
import { dispatchWorkflowChildStepWithOutcome } from "../services/workflow/workflow-child-dispatch.js";
import { acquireWorkflowChildStartLease } from "../services/workflow/workflow-child-start-lease.js";
import {
  normalizeWorkflowStepsForExecution,
} from "../services/workflow/dag-engine.js";
import { reconcileStuckWorkflowRuns, reconcileWorkflow } from "../services/workflow/reconciler.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";
import {
  insertLinkedInvocation,
  insertMaterializedChildRun,
  type WorkflowChildIdentityFixture,
} from "./helpers/workflow-child-invocation-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Linked = {
  companyId: string;
  runId: string;
  stepRunId: string;
  childDefId: string;
  identity: WorkflowChildIdentityFixture;
};

/** 법정 linked 픽스처 — completed 만 영수증형(materialized), 실패 초기화는 무영수증 종말. */
async function linked(name: string, opts: { adopted?: boolean; childStatus?: string } = {}): Promise<Linked> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({
    companyId,
    name: "child",
    steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
  });
  const parentDefId = await insertDefinition({ companyId, name: "parent", steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const childStatus = opts.childStatus ?? "pending";
  const identity = childStatus === "completed"
    ? await insertMaterializedChildRun(db, {
      companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId, childStatus,
    })
    : await insertLinkedInvocation(db, {
      companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId, childStatus,
    });
  const adoptable = !["completed", "failed", "cancelled", "aborted", "timed-out"].includes(childStatus);
  if ((opts.adopted ?? true) && adoptable) {
    expect(await adoptChildForWaitingStep(db, { identity, observedMetadata: null, now: new Date() })).toBe(true);
  }
  return { companyId, runId, stepRunId, childDefId, identity };
}

/** dispatch 입력을 내구 행에서 재구성한다(스테일 스냅숏 시뮬레이션 포함). */
async function dispatchInputFor(x: Linked) {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
  const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
  return {
    run: run!,
    definition: definition!,
    step: normalizeWorkflowStepsForExecution(definition!.stepsJson)[0],
    stepRun: stepRun!,
    now: new Date(),
  };
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

  it("reg FireCrash: a saved wait:false definition is refused at dispatch before claim (P1-1)", async () => {
    // [R] 공유 검증 우회 raw 정의 — 이미 저장된 false 도 런타임 거부다. invocation/run 0.
    const companyId = await createCompanyFixture("R3FireCrash");
    const childDefId = await insertDefinition({
      companyId,
      name: "child",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent",
      steps: [{ ...childStep(childDefId), wait: false }],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
    const outcome = await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputFor({
      companyId, runId, stepRunId, childDefId,
      identity: { companyId, parentRunId: runId, parentStepRunId: stepRunId, stepId: "run-child", invocationId: "", childRunId: "", generation: 1 },
    }));
    expect(outcome.outcome).toBe("failed");
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    expect(stepRun?.status).toBe("failed");
    expect((stepRun?.metadata as Record<string, unknown>).toolResult)
      .toEqual(expect.objectContaining({ error: "workflow_child_unsupported_option" }));
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
    const children = await db.select().from(workflowRuns).where(eq(workflowRuns.parentRunId, runId));
    expect(children).toHaveLength(0);
  });

  it("reg ModeCrash: an edited wait:false definition cannot repair or re-mode a linked child (P1-1)", async () => {
    const x = await linked("R3ModeCrash", { adopted: true });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    await db.update(workflowDefinitions).set({ stepsJson: [{ ...childStep(x.childDefId), wait: false }] })
      .where(eq(workflowDefinitions.id, run!.workflowId));
    const before = JSON.stringify({
      stepRun: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId)))[0] ?? null,
      child: (await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId)))[0] ?? null,
    });

    // 기존 linked 자식이 있으므로 pre-admission 정산도 불가 — 0행 no-op 양보(행 무변경).
    const outcome = await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputFor(x));
    expect(outcome.outcome).toBe("skipped");
    const after = JSON.stringify({
      stepRun: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId)))[0] ?? null,
      child: (await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId)))[0] ?? null,
    });
    expect(after).toBe(before);
    // 모드 컬럼/모드 수리는 존재하지 않는다(D1) — invocation 은 wait 키 없이 linked 만 있다.
    const [invocation] = await db.select().from(workflowStepInvocations);
    expect(invocation?.state).toBe("linked");
    expect((invocation as Record<string, unknown>).wait).toBeUndefined();
  });

  it("reg ClaimCrash: lease-owner crash is recovered on the SAME linked child after expiry (P1-2)", async () => {
    const x = await linked("R3ClaimCrash", { adopted: true });
    const lease = await acquireWorkflowChildStartLease(db, x.identity);
    expect(lease.kind).toBe("owned");
    const [withLease] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId));
    const deadline = withLease?.childStartDeadlineAt;
    expect(deadline).not.toBeNull();
    // 소유자 크래시: 임대만 경과(절대 마감은 미래) — 같은 자식으로 이어받는다.
    await db.update(workflowRuns).set({
      childStartLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
    }).where(eq(workflowRuns.id, x.identity.childRunId));

    const results = await reconcileWorkflowChildStepWaits(db, { olderThanMs: 0 });
    expect(results[0]?.action).toBe("recovered");
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId));
    // 정확히 한 번의 초기화 — 영수증 1, 마감 불변.
    expect(child?.childStartMaterializedAt).not.toBeNull();
    expect(child?.childStartDeadlineAt).toEqual(deadline);
    const childSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.identity.childRunId));
    expect(childSteps.length).toBeGreaterThan(0);
    const second = await reconcileWorkflowChildStepWaits(db, { olderThanMs: 0 });
    expect(second.filter((r) => r.action === "recovered")).toHaveLength(0);
  });

  it("reg FullClaimCrash: recovery materializes once; an elapsed deadline settles terminally instead (P1-2)", async () => {
    // (a) 임대 획득 후 크래시 → 회복이 한 번 materialize.
    const a = await linked("R3FullClaimA", { adopted: true });
    expect((await acquireWorkflowChildStartLease(db, a.identity)).kind).toBe("owned");
    await db.update(workflowRuns).set({
      childStartLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
    }).where(eq(workflowRuns.id, a.identity.childRunId));
    const results = await reconcileWorkflowChildStepWaits(db, { olderThanMs: 0 });
    expect(results.filter((r) => r.action === "recovered")).toHaveLength(1);
    const childSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, a.identity.childRunId));
    expect(childSteps.length).toBeGreaterThan(0);

    // (b) 절대 마감 경과 — 회복이 아니라 종말 정산(child_start_timeout)으로 결론난다.
    const b = await linked("R3FullClaimB", { adopted: true });
    expect((await acquireWorkflowChildStartLease(db, b.identity)).kind).toBe("owned");
    await db.update(workflowRuns).set({
      childStartLeaseExpiresAt: sql`clock_timestamp() - interval '2 seconds'`,
      childStartDeadlineAt: sql`clock_timestamp() - interval '1 second'`,
    }).where(eq(workflowRuns.id, b.identity.childRunId));
    await reconcileWorkflowChildStepWaits(db, { olderThanMs: 0 });
    const [expired] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, b.identity.childRunId));
    expect(expired?.status).toBe("failed");
    expect((expired?.metadata as Record<string, unknown>).workflowChildStartFailure)
      .toEqual({ version: 1, errorCode: "child_start_timeout" });
    const [bStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, b.stepRunId));
    expect(bStep?.status).toBe("failed");

    // (a) 의 materialized 자식은 generic stuck timeout 이 실패 처리하지 못한다.
    await db.update(workflowRuns).set({ startedAt: new Date(Date.now() - 7_200_000) })
      .where(eq(workflowRuns.id, a.identity.childRunId));
    const stuck = await reconcileStuckWorkflowRuns(db, 60);
    expect(stuck.every((r) => r.action !== "recovered" || !r.reason?.includes("Marked stuck run as failed"))).toBe(true);
    const [stillRunning] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, a.identity.childRunId));
    expect(stillRunning?.status).not.toBe("failed");
    await reconcileWorkflow(db);
  });

  it("reg FutureRetry: retry-injected S is rejected without occupying the actionable limit (P1-3)", async () => {
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

    // 첫 패스(limit 1): 어린 정산 가능 영수증이 선택되고, retry S 는 별도 invalid 진단으로 분리.
    const rows = await reconcileWorkflowChildStepWaits(db, { limit: 1 });
    expect(rows[0]?.stepRunId).toBe(younger.stepRunId);
    expect(rows[0]?.action).toBe("recovered");
    const diagnostic = rows.find((r) => r.stepRunId === old.stepRunId);
    expect(diagnostic).toEqual(expect.objectContaining({
      action: "skipped",
      code: "parent_step_retry_state_present",
    }));
    const [youngerStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, younger.stepRunId));
    expect(youngerStep?.status).toBe("completed");

    // 정산 후 남은 것은 배제된 retry S 뿐 — actionable 소유 진행 없다(점유 없음).
    const after = await reconcileWorkflowChildStepWaits(db, { limit: 1 });
    expect(after.some((r) => r.action === "recovered")).toBe(false);
    const [oldStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, old.stepRunId));
    const retry = (oldStep?.metadata as Record<string, unknown>).workflowRetry as Record<string, unknown>;
    expect(retry.state).toBe("waiting");
    expect(oldStep?.status).toBe("pending");
    expect(oldStep?.retryCount).toBe(1);
  });

  it("reg TombstoneDispatch: dispatch settles a deletion tombstone instead of recreating (P1-4)", async () => {
    const x = await linked("R3Tombstone", { adopted: true, childStatus: "running" });
    await db.delete(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId));
    const dispatched = await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputFor(x));
    expect(dispatched.outcome).toBe("failed");
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
