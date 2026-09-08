// @vitest-environment node
// [workflow-child fix round 2 / descope v1] round-2 프로브(/tmp/wfw-r2-probes) 회귀 반대 단언의
//   descope 재현. linked 자식은 전부 새 픽스처(insertLinkedInvocation/insertMaterializedChildRun —
//   법정 v1 상태)로 만들고, 지연 시작은 실행 경로에서 typed ineligible 로 양보한다. 정의 삭제는
//   활성 invocation 동안 거부되고(D6), tombstone 정산/그랜드차일드 전파/liveness 컨트롤은 유지.
//   /tmp/task-spec-wfw-fix2.txt + 설계 §5/§6 S/R 처분.
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
  hasLiveWorkflowChildWait,
  reconcileWorkflowChildStepWaits,
  runWorkflowChildCompletionHook,
} from "../services/workflow/workflow-child-execution.js";
import {
  cancelWorkflowRunWithCleanup,
  executeWorkflowRunWithStartOutcome,
  normalizeWorkflowStepsForExecution,
} from "../services/workflow/dag-engine.js";
import { dispatchWorkflowChildStepWithOutcome } from "../services/workflow/workflow-child-dispatch.js";
import { deleteWorkflowDefinition } from "../services/workflow/workflow-store.js";
import { HttpError } from "../errors.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
  insertStepRunForRun,
} from "./helpers/workflow-child-fixtures.js";
import {
  insertGrandchildInvocation,
  insertLinkedInvocation,
  insertMaterializedChildRun,
  insertOrphanChildMarkedRun,
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
  childRunId: string;
  childDefId: string;
  identity: WorkflowChildIdentityFixture;
};

/**
 * 프로브 linked 픽스처의 descope 판 — 법정 v1 상태만 만든다. completed 자식은 영수증 있는
 * materialized 종말(terminal-before-materialization 성공은 비정합)이고, 실패 초기화만 영수증
 * 없이 종말 가능하다. 입양은 실제 adoption writer(projection-only)로 기록한다.
 */
async function linked(name: string, opts: { adopted?: boolean; childStatus?: string; receipt?: boolean } = {}): Promise<Linked> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({
    companyId,
    name: "child",
    steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
  });
  const parentDefId = await insertDefinition({ companyId, name: "parent", steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const childStatus = opts.childStatus ?? "pending";
  const identity = opts.receipt || childStatus === "completed"
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
  return { companyId, runId, stepRunId, childRunId: identity.childRunId, childDefId, identity };
}

async function childExecutionSnapshot(childRunId: string): Promise<string> {
  const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, childRunId));
  const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, childRunId));
  return JSON.stringify({
    child: child ? { ...child, startedAt: null, completedAt: null } : null,
    steps,
  });
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
    await reconcileWorkflowChildStepWaits(db);
    const [childAfter] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(childAfter?.status).toBe(child?.status);
  });

  it("reg probe2: cancelled child is never resurrected — delayed start yields typed ineligible (P1-2)", async () => {
    const x = await linked("R2CancelRace", { adopted: true, childStatus: "pending" });
    await cancelWorkflowRunWithCleanup(db, x.runId, x.companyId);
    const [cancelled] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(cancelled?.status).toBe("cancelled");
    const before = await childExecutionSnapshot(x.childRunId);

    // [descope] 평문 throw 대신 typed ineligible 경계 — 초기화 쓰기는 0이다.
    const outcome = await executeWorkflowRunWithStartOutcome(db, x.childRunId);
    expect(outcome.kind).toBe("ineligible");
    expect(await childExecutionSnapshot(x.childRunId)).toBe(before);
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.status).toBe("cancelled");
    expect(child?.childStartToken).toBeNull();
    expect(child?.childStartMaterializedAt).toBeNull();
    const [parent] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    expect(parent?.status).toBe("cancelled");
  });

  it("reg probe3: terminal child settles despite an older healthy wait under a tiny scan limit (P1-4)", async () => {
    await linked("R2OldLive", { adopted: true, childStatus: "running", receipt: true });
    const x = await linked("R2NewTerminal", { adopted: true, childStatus: "completed" });
    const results = await reconcileWorkflowChildStepWaits(db, { limit: 1 });
    expect(results[0]?.stepRunId).toBe(x.stepRunId);
    expect(results[0]?.action).toBe("recovered");
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(step?.status).toBe("completed");
  });

  it("reg probe4: definition delete refuses while active; child-run deletion settles a tombstone (P1-5)", async () => {
    const x = await linked("R2DeletedChild", { adopted: true, childStatus: "running" });

    // [D6/R] 활성 invocation 동안 정의 물리 삭제는 public 경로에서 typed 409 로 거부된다.
    let thrown: unknown = null;
    try {
      await deleteWorkflowDefinition(db, x.childDefId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(409);
    expect((thrown as Error).message).toContain("workflow_definition_has_active_child_invocations");
    // 모든 행 보존.
    expect(await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, x.childDefId))).toHaveLength(1);
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(1);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId))).toHaveLength(1);

    // [D4] 자식 run 행 직접 삭제는 허용 — tombstone(linked+NULL)이 1회 child_run_failed 정산.
    await db.delete(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    const [invocation] = await db.select().from(workflowStepInvocations);
    expect(invocation?.state).toBe("linked");
    expect(invocation?.childRunId).toBeNull();
    const results = await reconcileWorkflowChildStepWaits(db);
    expect(results[0]?.action).toBe("recovered");
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(step?.status).toBe("failed");
    expect((step?.metadata as Record<string, unknown>).toolResult)
      .toEqual(expect.objectContaining({ error: "child_run_failed" }));
  });

  it("reg probe5: terminal unadopted child settles without display adoption or re-execution (P1-3)", async () => {
    const x = await linked("R2TerminalNoAdopt", { adopted: false, childStatus: "completed" });
    const before = await childExecutionSnapshot(x.childRunId);
    const results = await reconcileWorkflowChildStepWaits(db);
    expect(results[0]?.action).toBe("recovered");
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(step?.status).toBe("completed");
    // 자식 재실행 없음 — 영수증/스텝/상태 무변경.
    expect(await childExecutionSnapshot(x.childRunId)).toBe(before);
  });

  it("reg probe6: retry-injected workflow S is refused — no adoption, settlement, or new child (P1-1)", async () => {
    const x = await linked("R2StaleAdoption", { adopted: true, childStatus: "failed" });
    await db.update(workflowStepRuns).set({
      retryCount: 1,
      metadata: {
        workflowRetry: {
          state: "waiting", retryNumber: 1, maxRetries: 2,
          nextEligibleAt: new Date(Date.now() + 60_000).toISOString(),
          sourceRequestId: null, sourceCompletedAt: null, lastErrorSummary: null,
        },
      },
    }).where(eq(workflowStepRuns.id, x.stepRunId));
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run?.workflowId ?? ""));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));

    // 스테일 dispatch 재개 — retry 상태 S 는 invalid-state 로 거부된다(감사 이벤트, 행 무변경).
    const outcome = await dispatchWorkflowChildStepWithOutcome(db, {
      run: run!,
      definition: definition!,
      step: normalizeWorkflowStepsForExecution(definition!.stepsJson)[0],
      stepRun: stepRun!,
      now: new Date(),
    });
    expect(outcome.outcome).toBe("skipped");
    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    const retry = (after?.metadata as Record<string, unknown>).workflowRetry as Record<string, unknown>;
    expect(retry.state).toBe("waiting");
    expect(after?.retryCount).toBe(1);
    expect(after?.status).toBe("pending");
    expect((after?.metadata as Record<string, unknown>).workflowChild).toBeUndefined();
    // 감사: workflow_child_invalid_state 구조화 이벤트.
    const audits = await db.select().from(activityLog).where(eq(activityLog.action, "workflow_child_invalid_state"));
    expect(audits.some((row) => row.entityId === x.stepRunId)).toBe(true);
    // 구세대 자식 실패 훅도 retry 상태 S 를 완료하지 못한다(CURRENT 위반 — fenced no-op).
    const settled = await runWorkflowChildCompletionHook(db, { id: x.childRunId, companyId: x.companyId, status: "failed" });
    expect(settled).toBe(false);
    const [ended] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(ended?.status).toBe("pending");
  });

  it("reg probe7: cancelling the root reaches a linked grandchild; a malformed bridge is refused (P1-6)", async () => {
    const x = await linked("R2TerminalBridge", { adopted: true, childStatus: "completed" });
    // 법정 경로: 종말 중간 자식 아래 완전한 linked 손자.
    const grandchild = await insertGrandchildInvocation(db, {
      companyId: x.companyId,
      parentRunId: x.childRunId,
      grandchildWorkflowId: x.childDefId,
      grandchildStatus: "running",
    });
    // 비정합 경로: invocation 링크 없는 child-marked bridge(표 밖 — no-write 거부 입력).
    const bridgeStepRunId = await insertStepRunForRun({ runId: x.childRunId, stepId: "bridge" });
    const orphanId = await insertOrphanChildMarkedRun(db, {
      companyId: x.companyId,
      parentRunId: x.childRunId,
      parentStepRunId: bridgeStepRunId,
      childWorkflowId: x.childDefId,
    });

    await cancelWorkflowRunWithCleanup(db, x.runId, x.companyId);
    const [grandchildRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, grandchild.childRunId));
    expect(grandchildRun?.status).toBe("cancelled");
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.status).toBe("completed");
    // 비정합 bridge 는 plain 취소로 함부로 쓰이지 않는다(fail-closed, 행 무변경).
    const [orphan] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, orphanId));
    expect(orphan?.status).toBe("pending");
    const orphanSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, orphanId));
    expect(orphanSteps).toHaveLength(0);
  });

  it("reg P1-3 liveness: deleted (tombstoned) child is not live; unstarted child stays startable-live", async () => {
    const alive = await linked("R2LiveAlive", { adopted: true, childStatus: "running" });
    expect(await hasLiveWorkflowChildWait(db, { id: alive.stepRunId, metadata: {} })).toBe(true);
    const dead = await linked("R2LiveDead", { adopted: true, childStatus: "running" });
    await db.delete(workflowRuns).where(eq(workflowRuns.id, dead.childRunId));
    expect(await hasLiveWorkflowChildWait(db, { id: dead.stepRunId, metadata: {} })).toBe(false);
  });
});
