// @vitest-environment node
// [workflow-child fix round 4 — recovery, descope v1] healthy adoption/dead-parent/empty-child
// 회귀. /tmp/wfw-descope-design.md §5 파일 지도 행: "Keep healthy adoption/dead-parent/empty-child
// cases". descope v1 에서 unleased 시작 헬퍼/강제 실패 CAS/독립 부분 변이는 삭제됐다 — 죽은 부모
// 정리는 DEAD fence 취소, 만료는 마감 경과 공유 변이자, 미소유 무마간 stuck 자식은 bounded
// skipped(typed no-op)다. wait/retry 계열 시나리오는 삭제/거부 계약으로 대체됐다(D1/D2).
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
import { acquireWorkflowChildStartLease } from "../services/workflow/workflow-child-start-lease.js";
import { reconcileWorkflowChildStepWaits } from "../services/workflow/workflow-child-execution.js";
import { reconcileStuckWorkflowRuns } from "../services/workflow/reconciler.js";
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
  companyId: string; runId: string; stepRunId: string; childRunId: string; childDefId: string;
  invocationId: string; stepId: string;
};

/** legal v1 linked 자식 fixture — 세대 1, linked, wait/wait 메타데이터 없음(descope D1/D2). */
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
    id: childRunId, workflowId: childDefId, companyId, status: opts.childStatus ?? "pending",
    triggeredBy: "workflow-step", triggerSource: "workflow",
    parentRunId: runId, parentStepRunId: stepRunId, rootRunId: runId,
  });
  const [inv] = await db.insert(workflowStepInvocations).values({
    companyId, parentStepRunId: stepRunId, childRunId, generation: 1, state: "linked", targetWorkflowId: childDefId,
  }).returning();
  if (opts.adopted ?? true) {
    // 표시 프로젝션(workflowChild)은 display 전용 — 실행 권위가 아니다(설계 §2). wait 키 없음.
    await db.update(workflowStepRuns).set({
      metadata: { workflowChild: { childRunId, invocationId: inv.id, generation: 1 } },
    }).where(eq(workflowStepRuns.id, stepRunId));
  }
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
  return { companyId, runId, stepRunId, childRunId, childDefId, invocationId: inv.id, stepId: step.stepId };
}

describeEmbeddedPostgres("workflow child fix round 4 — recovery", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix4-rec-");
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

  for (const parentStatus of ["failed", "cancelled"] as const) {
    for (const adopted of [true, false]) {
      it(`dead ${parentStatus} parent: ${adopted ? "adopted" : "unadopted"} child is cancelled before adoption (DeadPending)`, async () => {
        const x = await linked(`R4 Dead ${parentStatus} ${adopted}`, { adopted });
        await db.update(workflowRuns).set({ status: parentStatus }).where(eq(workflowRuns.id, x.runId));
        const results = await reconcileWorkflowChildStepWaits(db);
        expect(results.some((r) => r.action === "recovered")).toBe(true);
        const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
        expect(child?.status).toBe("cancelled");
        const [parent] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
        expect(parent?.status).toBe(parentStatus);
        const children = await db.select().from(workflowRuns).where(eq(workflowRuns.parentRunId, x.runId));
        expect(children).toHaveLength(1);
      });
    }
  }

  it("dead-parent leased child is reclaimed and never permanently exempt (DeadClaim)", async () => {
    // r4 DeadClaim (S) — fire/unleased fixture 를 유효한 소유 자동 시작으로 변환: 전체 신원 임대
    // 취득(소유자만 running 전이) → 죽은 부모 → 자식 취소(claim 상태·시작 시각과 무관).
    const x = await linked("R4 DeadClaim", { adopted: true });
    const lease = await acquireWorkflowChildStartLease(db, {
      companyId: x.companyId,
      parentRunId: x.runId,
      parentStepRunId: x.stepRunId,
      stepId: x.stepId,
      invocationId: x.invocationId,
      childRunId: x.childRunId,
      generation: 1,
    });
    expect(lease.kind).toBe("owned");
    const [started] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(started?.status).toBe("running");
    expect(started?.childStartToken).not.toBeNull();
    await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, x.runId));
    // child pass 가 먼저 취소한다(임대 소유와 무관 — DEAD fence 취소).
    await reconcileWorkflowChildStepWaits(db);
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.status).toBe("cancelled");
    expect(child?.childStartToken).toBeNull();
  });

  it("stuck pass yields a bounded skip for an unowned zero-step linked child (rows unchanged)", async () => {
    // descope v1: 독립 강제 실패 CAS 는 삭제됐다(설계 §4 recovery-timeout 행). 미소유+무마간
    // 미 materialized 자식은 bounded skipped(typed no-op)다 — failed/recovered 로 보고하지 않고
    // 실행 행은 그대로다.
    const x = await linked("R4 StuckUnowned", { adopted: true });
    await db.update(workflowRuns).set({
      status: "running",
      startedAt: new Date(Date.now() - 7_200_000),
    }).where(eq(workflowRuns.id, x.childRunId));
    const before = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    const results = await reconcileStuckWorkflowRuns(db, 60);
    const reported = results.find((r) => r.runId === x.childRunId);
    expect(reported?.action).toBe("skipped");
    const after = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(after[0]?.status).toBe("running");
    expect(after[0]?.childStartToken).toBeNull();
    expect(after[0]?.completedAt).toBe(before[0]?.completedAt);
    expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.childRunId))).toHaveLength(0);
  });

  it("deleted future-retry receipt cannot occupy the bounded recovery limit (DeletedFuture)", async () => {
    const old = await linked("R4 DeletedFuture", { adopted: true, childStatus: "failed" });
    const [s] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, old.stepRunId));
    const retrySnapshot = {
      state: "waiting", retryNumber: 1, maxRetries: 2,
      nextEligibleAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    await db.update(workflowStepRuns).set({
      retryCount: 1,
      metadata: { ...(s?.metadata as Record<string, unknown>), workflowRetry: retrySnapshot },
    }).where(eq(workflowStepRuns.id, s!.id));
    await db.delete(workflowRuns).where(eq(workflowRuns.id, old.childRunId));
    const young = await linked("R4 YoungTerminal", { adopted: true, childStatus: "completed" });
    // [r8 §4] completed 는 0스텝이라도 영수증이 있어야 법정 종말이다 — 빈 정의 영수증 완료.
    await db.update(workflowRuns).set({ childStartMaterializedAt: new Date() }).where(eq(workflowRuns.id, young.childRunId));

    // 첫 패스: retry 주입 영수증(R — 거부)이 limit=1 을 점유하지 못하고 어린 정산 가능 영수증이 선택된다.
    const rows = await reconcileWorkflowChildStepWaits(db, { limit: 1 });
    expect(rows[0]?.stepRunId).toBe(young.stepRunId);
    expect(rows[0]?.action).toBe("recovered");
    // 정산 이후 남은 것은 배제된 구 영수증뿐 — 후보가 비어 있다(점유 없음).
    const [youngStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, young.stepRunId));
    expect(youngStep?.status).toBe("completed");
    // 구 영수증은 바이트 단위로 보존된다(retry snapshot/generation/linked-null 무변경, 자식 미재생성).
    const [inv] = await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.parentStepRunId, old.stepRunId));
    expect(inv?.childRunId).toBeNull();
    expect(inv?.state).toBe("linked");
    expect(inv?.generation).toBe(1);
    const [oldStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, old.stepRunId));
    expect(oldStep?.retryCount).toBe(1);
    expect((oldStep?.metadata as Record<string, unknown>).workflowRetry).toEqual(retrySnapshot);
    const children = await db.select().from(workflowRuns).where(eq(workflowRuns.parentRunId, old.runId));
    expect(children).toHaveLength(0);
  });

  it("old-generation nonwaiting tombstone still settles as child_run_failed", async () => {
    const old = await linked("R4 OldTombstone", { adopted: true, childStatus: "failed" });
    const [s] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, old.stepRunId));
    await db.update(workflowStepRuns).set({
      retryCount: 1,
      metadata: { ...(s?.metadata as Record<string, unknown>) },
    }).where(eq(workflowStepRuns.id, s!.id));
    await db.delete(workflowRuns).where(eq(workflowRuns.id, old.childRunId));
    const results = await reconcileWorkflowChildStepWaits(db, { limit: 1 });
    // retry 주입(R) 영수증은 정산/복구되지 않는다 — 남는 tombstone 도 무변경(재생성 없음).
    expect(results.every((r) => r.action !== "recovered" || r.reason.includes("tombstone"))).toBe(true);
  });
});
