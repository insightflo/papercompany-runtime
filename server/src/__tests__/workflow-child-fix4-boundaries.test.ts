// @vitest-environment node
// [workflow-child fix round 4 / descope v1] Finding 4 + ModeCrash 경계 회귈 — adoption-only 복구,
// 마감 불변성, plain 수동 resume 권한, 그리고 정의 편집의 조기 거부. 수동/자동 intent 차원은
// 삭제됐다(D3) — 임대/만료 경계는 자동 임대 신원 하나뿐이다.
// /tmp/wfw-fix-design-round4.md §7 "boundaries" 스위트 + 설계 §5/§6 S/R/O 처분.
import { eq, sql } from "drizzle-orm";
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
  adoptChildForWaitingStep,
  reconcileWorkflowChildStepWaits,
  runWorkflowChildCompletionHook,
} from "../services/workflow/workflow-child-execution.js";
import {
  dispatchWorkflowChildStepWithOutcome,
} from "../services/workflow/workflow-child-dispatch.js";
import {
  acquireWorkflowChildStartLease,
  expireWorkflowChildStart,
} from "../services/workflow/workflow-child-start-lease.js";
import {
  normalizeWorkflowStepsForExecution,
  setWorkflowToolStepExecutor,
  setWorkflowToolStepReadinessChecker,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
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

async function linked(name: string, opts: { adopted?: boolean; receipt?: boolean } = {}): Promise<Linked> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({
    companyId,
    name: "child",
    steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
  });
  const parentDefId = await insertDefinition({ companyId, name: "parent", steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const identity = opts.receipt
    ? await insertMaterializedChildRun(db, {
      companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId,
    })
    : await insertLinkedInvocation(db, {
      companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId,
    });
  if (opts.adopted ?? !opts.receipt) {
    expect(await adoptChildForWaitingStep(db, { identity, observedMetadata: null, now: new Date() })).toBe(true);
  }
  return { companyId, runId, stepRunId, childDefId, identity };
}

describeEmbeddedPostgres("workflow child fix round 4 — boundaries", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix4-bnd-");
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

  it("healthy materialized child receives adoption repair only (HealthyUnadopted opposite)", async () => {
    const x = await linked("R4 HealthyUnadopted", { receipt: true, adopted: false });
    const original = new Date(Date.now() - 3_600_000);
    await db.update(workflowRuns).set({ startedAt: original }).where(eq(workflowRuns.id, x.identity.childRunId));
    const readiness = vi.fn().mockResolvedValue({ available: true });
    setWorkflowToolStepReadinessChecker(readiness);
    const results = await reconcileWorkflowChildStepWaits(db);
    expect(results[0]?.reason).toContain("adoption only");
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId));
    expect(child?.startedAt?.getTime()).toBe(original.getTime());
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.identity.childRunId));
    expect(steps).toHaveLength(1);
    expect(readiness).not.toHaveBeenCalled();
    // 수리된 adoption 메타데이터가 현재 invocation 과 정확히 일치하고 wait 키는 없다(D1).
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(step?.metadata).toMatchObject({
      workflowChild: { childRunId: x.identity.childRunId, invocationId: x.identity.invocationId, generation: 1 },
    });
    expect((step?.metadata as Record<string, unknown>).workflowChild)
      .toEqual(expect.not.objectContaining({ wait: expect.anything() }));
  });

  it("start deadline is immutable and bounds the timeout exemption", async () => {
    const x = await linked("R4 Deadline", { adopted: true });
    // 소유 임대 획득 → 불변 마감 설정 확인.
    const first = await acquireWorkflowChildStartLease(db, x.identity);
    expect(first.kind).toBe("owned");
    const [withLease] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId));
    expect(withLease?.childStartDeadlineAt).not.toBeNull();
    const deadline1 = withLease?.childStartDeadlineAt!.getTime();
    // 임대만 만료 → 재획득 시 같은 마감/새 토큰.
    await db.update(workflowRuns).set({
      childStartLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
    }).where(eq(workflowRuns.id, x.identity.childRunId));
    const second = await acquireWorkflowChildStartLease(db, x.identity);
    expect(second.kind).toBe("owned");
    const [reacquired] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId));
    expect(reacquired?.childStartDeadlineAt!.getTime()).toBe(deadline1);
    expect(reacquired?.childStartToken).not.toBe((first as { token: string }).token);
    // 마감 경과 → 공유 만료 정산이 실패로 종말시키고(생존 부모), 재시작 없다.
    await db.update(workflowRuns).set({
      childStartDeadlineAt: sql`clock_timestamp() - interval '1 second'`,
      childStartLeaseExpiresAt: sql`clock_timestamp() - interval '2 seconds'`,
    }).where(eq(workflowRuns.id, x.identity.childRunId));
    const expiry = await expireWorkflowChildStart(db, x.identity);
    expect(expiry).toEqual({ settled: true, childStatus: "failed" });
    const [expired] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId));
    expect(expired?.status).toBe("failed");
    expect((expired?.metadata as Record<string, unknown>).workflowChildStartFailure)
      .toEqual({ version: 1, errorCode: "child_start_timeout" });
    expect(expired?.childStartToken).toBeNull();
    expect(expired?.childStartLeaseExpiresAt).toBeNull();
    // 정산 커밋 후 훅이 pending 부모 스텝을 child_run_failed 로 마감한다.
    expect(await runWorkflowChildCompletionHook(db, {
      id: x.identity.childRunId, companyId: x.companyId, status: "failed",
    })).toBe(true);
    // [descope §3] 이후 패스에 소유 진행/재시작 없다 — 경과 마감 재선택은 typed skipped 양보다.
    const again = await reconcileWorkflowChildStepWaits(db);
    expect(again.some((r) => r.action === "recovered" || r.action === "failed")).toBe(false);
    const [settledChild] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId));
    expect(settledChild?.status).toBe("failed");
  });

  it("manual failed-run resume retains authorization for a plain run", async () => {
    const companyId = await createCompanyFixture("R4 ManualResume");
    const childDefId = await insertDefinition({
      companyId,
      name: "child",
      steps: [{ id: "t", name: "T", type: "tool", agentId: "", dependencies: [], toolNames: ["echo-tool"], toolArgs: {} }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent",
      steps: [{ id: "p", name: "P", type: "tool", agentId: "", dependencies: [], toolNames: ["echo-tool"], toolArgs: {} }],
    });
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));
    // trigger 시점 툴 카탈로그 검사 — echo-tool 이 회사에서 선택 가능해야 한다.
    await db.insert(toolDefinitions).values({
      companyId, name: "echo-tool", description: "test tool", inputSchema: {},
      adapterType: "builtin", adapterConfig: {}, enabled: true,
    });
    const result = await workflowService.trigger(db, {
      workflowId: parentDefId, companyId, triggeredBy: "board", triggerSource: "api",
    });
    await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, result.runId));
    // 공개 서비스 resume — 실패 plain run 수동 재개가 여전히 승인된다(terminal blanket ban 금지).
    const resumed = await workflowService.resumeRun(db, { runId: result.runId, companyId });
    expect(resumed.status).not.toBe("failed");
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, result.runId));
    expect(steps.filter((s) => s.stepId === "p")).toHaveLength(1);
    void childDefId;
  });

  it("an edited definition cannot restore unsupported options onto a linked child (early refusal)", async () => {
    // [ModeCrash 결정의 descope 전환] wait 모드 차원은 삭제됐다 — 남는 계약은 저장 정의가 지원
    //   불가 옵션을 되살리면 조기 거부되고 어떤 실행 행/토큰도 바뀌지 않는다는 것이다.
    const x = await linked("R4 EditedDefinition", { adopted: true });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
    await db.update(workflowDefinitions).set({
      stepsJson: [{ ...childStep(x.childDefId), onFailure: "retry", maxRetries: 2 }],
    }).where(eq(workflowDefinitions.id, run!.workflowId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    const [childBefore] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId));

    const outcome = await dispatchWorkflowChildStepWithOutcome(db, {
      run: run!,
      definition: definition!,
      step: normalizeWorkflowStepsForExecution(definition!.stepsJson)[0],
      stepRun: stepRun!,
      now: new Date(),
    });
    // 기존 linked 자식이 있어 pre-admission 정산도 불가 — 0행 no-op(skipped), 행 무변경.
    expect(outcome.outcome).toBe("skipped");
    const [stepAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(stepAfter?.status).toBe("pending");
    expect(stepAfter?.metadata).toEqual(stepRun?.metadata);
    expect(stepAfter?.retryCount).toBe(0);
    const [childAfter] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.identity.childRunId));
    expect(childAfter?.status).toBe(childBefore?.status);
    expect(childAfter?.childStartToken).toBe(childBefore?.childStartToken);
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(1);
  });
});
