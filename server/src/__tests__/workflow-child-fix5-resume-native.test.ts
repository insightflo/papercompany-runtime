// @vitest-environment node
// [workflow-child fix5 — resume] descope v1 D3 — 수동 자식 resume/네이티브 continuation 제거 스위트.
//   공개 engine.resumeRun 은 linked 자식을 부수효과(정의 검증/리셋/임대/실행) "이전"에 typed
//   거부하고(워크플로 재시작은 부모 재실행), 비정합 child-marked run 은 workflow_child_invalid_state,
//   없는 run 은 not-found, plain run 은 기존 경로 그대로다. 삭제된 native-continuation execute
//   옵션과 manual-resume prepared-fence 는 경계에 공급해도 아무 권위가 없다 — 실행 권위는 자동
//   임대 소유(token+완전 신원)뿐이고, 자식 리셋 콜백/리셋 쓰기는 남지 않았다(스냅숏 불변 증명).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, issueComments, issues, missions,
  workflowDefinitions, workflowRuns, workflowStepInvocations, workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executeWorkflowRun } from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import { ensureWorkflowStepRunRecords } from "../services/workflow/workflow-step-materialization.js";
import { acquireWorkflowChildStartLease } from "../services/workflow/workflow-child-start-lease.js";
import { findChildStartIdentityForRun } from "../services/workflow/workflow-child-start-state.js";
import {
  childStep, configureWorkflowChildFixtures, createCompanyFixture, insertDefinition,
  insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";
import { insertLinkedInvocation, insertOrphanChildMarkedRun } from "./helpers/workflow-child-invocation-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

const CHILD_STEPS = [{ id: "t", name: "T", type: "tool", dependencies: [], toolNames: ["echo-tool"] }];

type Fixture = {
  companyId: string; runId: string; stepRunId: string; childRunId: string;
  childDefId: string; parentDefId: string; invocationId: string;
};

/** 툴 스텝 자식 정의 + linked 자식 픽스처 — 부모 running/pending, 자식 상태는 opts 로 조정. */
async function childFixture(name: string, opts: { childStatus?: string } = {}): Promise<Fixture> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({ companyId, name: `${name}-child`, steps: CHILD_STEPS });
  const parentDefId = await insertDefinition({ companyId, name: `${name}-parent`, steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const identity = await insertLinkedInvocation(db, {
    companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId, childStatus: opts.childStatus,
  });
  return { companyId, runId, stepRunId, childRunId: identity.childRunId, childDefId, parentDefId, invocationId: identity.invocationId };
}

const runRow = async (id: string) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0];
const childRows = (childRunId: string) =>
  db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, childRunId));

/** 자식 관련 전체 실행 행 스냅숏 — 거부/무권위 호출의 "무변경"을 바이트 수준으로 증명한다. */
async function childSnapshot(x: Fixture) {
  return JSON.stringify({
    child: await runRow(x.childRunId),
    parent: await runRow(x.runId),
    parentStep: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId)))[0] ?? null,
    invocation: (await db.select().from(workflowStepInvocations)
      .where(eq(workflowStepInvocations.parentStepRunId, x.stepRunId)))[0] ?? null,
    childSteps: await childRows(x.childRunId),
  });
}

describeEmbeddedPostgres("workflow child fix5 — no manual child resume, plain-run unchanged", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix5-resume-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    for (const table of [activityLog, issueComments, issues, missions, workflowStepInvocations, workflowStepRuns, workflowRuns, workflowDefinitions, agents, companies]) {
      await db.delete(table);
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("public resume of a linked pending child refuses typed before any mutation (no reset callback writes)", async () => {
    const x = await childFixture("F5R Linked");
    const before = await childSnapshot(x);
    await expect(workflowService.resumeRun(db, { runId: x.childRunId, companyId: x.companyId }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("workflow_child_resume_not_supported") });
    // 정의 검증/컨트롤 리셋/임대/실행 부수효과 0 — 자식 리셋 콜백 경로는 존재하지 않는다.
    expect(await childSnapshot(x)).toBe(before);
    expect(await childRows(x.childRunId)).toHaveLength(0);
    expect((await runRow(x.childRunId))?.childStartToken).toBeNull();
  });

  it("failed linked child cannot be resurrected through resume; it stays terminal with rows unchanged", async () => {
    const x = await childFixture("F5R FailedLinked", { childStatus: "failed" });
    await db.update(workflowRuns).set({ status: "failed", completedAt: new Date() }).where(eq(workflowRuns.id, x.runId));
    await db.update(workflowRuns).set({ status: "failed", completedAt: new Date() }).where(eq(workflowRuns.id, x.childRunId));
    const before = await childSnapshot(x);
    await expect(workflowService.resumeRun(db, { runId: x.childRunId, companyId: x.companyId }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("workflow_child_resume_not_supported") });
    expect(await childSnapshot(x)).toBe(before);
    expect((await runRow(x.childRunId))?.status).toBe("failed");
    expect((await runRow(x.childRunId))?.completedAt).not.toBeNull();
  });

  it("incoherent child-marked run refuses as invalid-state with no plain-run fallback", async () => {
    const x = await childFixture("F5R Invalid");
    const orphanRunId = await insertOrphanChildMarkedRun(db, {
      companyId: x.companyId, parentRunId: x.runId, parentStepRunId: x.stepRunId, childWorkflowId: x.childDefId,
    });
    const orphan: Fixture = { ...x, childRunId: orphanRunId };
    const before = await childSnapshot(orphan);
    await expect(workflowService.resumeRun(db, { runId: orphanRunId, companyId: x.companyId }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("workflow_child_invalid_state") });
    expect(await childSnapshot(orphan)).toBe(before);
    expect((await runRow(orphanRunId))?.status).toBe("pending");
  });

  it("resume of a missing run stays not-found", async () => {
    const companyId = await createCompanyFixture("F5R Missing");
    await expect(workflowService.resumeRun(db, { runId: randomUUID(), companyId }))
      .rejects.toThrow(/Workflow run not found/);
  });

  it("removed native-continuation execute option confers no authority at the runtime boundary", async () => {
    const x = await childFixture("F5R ManualExec", { childStatus: "failed" });
    await db.update(workflowRuns).set({ status: "failed", completedAt: new Date() }).where(eq(workflowRuns.id, x.runId));
    const before = await childSnapshot(x);
    // 삭제된 intent 옵션을 런타임 경계로 공급해도 자동 진입 자격(비종말 자식)이 없으면 무변경이다.
    // 타입 경계: executeWorkflowRun 은 옵션 인자 자체를 받지 않는다(3인자 공급은 회귀 신호).
    const legacyOptions = { intent: "native-continuation" };
    const result = await executeWorkflowRun(db, x.childRunId, legacyOptions as never);
    expect(result.status).toBe("failed");
    expect(await childSnapshot(x)).toBe(before);
    expect(await childRows(x.childRunId)).toHaveLength(0);
  });

  it("prepared-fence manual intent grants no ownership at the internal boundary; only the automatic token owns", async () => {
    const x = await childFixture("F5R Fence");
    const found = await findChildStartIdentityForRun(db, x.childRunId);
    if (!found) throw new Error("expected linked identity");
    // (1) 잘못된 토큰 + 삭제된 manual-resume intent — 소유 없음(not-owner), 초기화 0행.
    const forged = {
      identity: found.identity, token: randomUUID(), intent: "manual-resume",
    } as unknown as { identity: typeof found.identity; token: string };
    expect((await ensureWorkflowStepRunRecords(db, {
      runId: x.childRunId, steps: CHILD_STEPS, childStartFence: forged,
      buildMetadata: (step) => ({ stepId: step.id }), syncControls: async (_syncDb, rows) => rows,
    })).kind).toBe("not-owner");
    expect(await childRows(x.childRunId)).toHaveLength(0);
    expect((await runRow(x.childRunId))?.childStartMaterializedAt).toBeNull();
    // (2) 대조 — 유효 자동 임대 토큰(intent 없음)만 초기화 권위를 가진다.
    const lease = await acquireWorkflowChildStartLease(db, found.identity);
    if (lease.kind !== "owned") throw new Error(`expected owned lease, got ${lease.kind}`);
    const materialized = await ensureWorkflowStepRunRecords(db, {
      runId: x.childRunId, steps: CHILD_STEPS, childStartFence: { identity: lease.identity, token: lease.token },
      buildMetadata: (step) => ({ stepId: step.id }), syncControls: async (_syncDb, rows) => rows,
    });
    expect(materialized.kind).toBe("ready");
    expect(await childRows(x.childRunId)).toHaveLength(1);
    expect((await runRow(x.childRunId))?.childStartMaterializedAt).not.toBeNull();
    expect((await runRow(x.childRunId))?.childStartToken).toBeNull();
  });

  it("plain failed run resume keeps the pre-feature path (control)", { timeout: 30_000 }, async () => {
    const companyId = await createCompanyFixture("F5R PlainControl");
    const defId = await insertDefinition({
      companyId, name: "plain",
      steps: [{ id: "done-node", name: "Complete", type: "complete", dependencies: [], completionReason: "closed" }],
    });
    const runId = randomUUID();
    await db.insert(workflowRuns).values({ id: runId, workflowId: defId, companyId, status: "failed", triggeredBy: "board", startedAt: new Date() });
    await db.insert(workflowStepRuns).values({ id: randomUUID(), workflowRunId: runId, stepId: "done-node", status: "failed", completedAt: new Date() });
    const result = await workflowService.resumeRun(db, { runId, companyId });
    expect(result.status).toBe("completed");
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(step?.status).toBe("completed"); // failed → 리셋 → 재평가 완료(plain 전용 경로)
  });

  it("refusal precedes every reset: linked child resume leaves parent/step/invocation byte-identical across repeats", async () => {
    const x = await childFixture("F5R Repeat");
    const before = await childSnapshot(x);
    for (let i = 0; i < 3; i += 1) {
      await expect(workflowService.resumeRun(db, { runId: x.childRunId, companyId: x.companyId }))
        .rejects.toMatchObject({ status: 409, message: expect.stringContaining("workflow_child_resume_not_supported") });
      expect(await childSnapshot(x)).toBe(before);
    }
    // 자동 초기화 경로(임대)는 여전히 유효하다 — 거부는 수동 resume 만 막는다.
    expect((await acquireWorkflowChildStartLease(db, (await findChildStartIdentityForRun(db, x.childRunId))!.identity)).kind).toBe("owned");
  });
});
