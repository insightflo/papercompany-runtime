// @vitest-environment node
// [workflow-child fix5 — cycle A] §3 공개 수동 resume/native 계속 + §4 bounded stuck 면제 회귀.
// /tmp/wfw-fix-design-cycleA.md 반대(subtractive) 시나리오 — 내구 레코드만이 권위(규칙 7/8).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companies, createDb, issueComments, issues, missions, toolDefinitions,
  workflowDefinitions, workflowRuns, workflowStepInvocations, workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  executeWorkflowRun, processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor, setWorkflowToolStepReadinessChecker,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import { reconcileStuckWorkflowRuns } from "../services/workflow/reconciler.js";
import { ensureWorkflowStepRunRecords } from "../services/workflow/workflow-step-materialization.js";
import { failOwnedWorkflowChildStart } from "../services/workflow/workflow-child-start-failure.js";
import type { ChildStartIdentity } from "../services/workflow/workflow-child-start-state.js";
import {
  childStep, configureWorkflowChildFixtures, createCompanyFixture, insertDefinition, insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

const TOOL_STEPS = [{ id: "t", name: "T", type: "tool", dependencies: [] }];
const HOUR = 3_600_000;

type Fixture = { companyId: string; runId: string; stepRunId: string; childRunId: string; childDefId: string };

/** 툴 스텝 자식 정의 + 링크(또는 claimed) 자식 픽스처. 부모 run/step 은 running/pending(retryCount 0). */
async function childFixture(name: string, opts: {
  parentStatus?: string; childStatus?: string; childStartedAt?: Date; invocationState?: "linked" | "claimed";
} = {}): Promise<Fixture> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({
    companyId, name: "child",
    steps: [{ id: "t", name: "T", type: "tool", agentId: "", dependencies: [], toolNames: ["echo-tool"], toolArgs: {} }],
  });
  const parentDefId = await insertDefinition({ companyId, name: "parent", steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const childRunId = randomUUID();
  await db.insert(workflowRuns).values({
    id: childRunId, workflowId: childDefId, companyId, status: opts.childStatus ?? "pending",
    triggeredBy: "workflow-step", triggerSource: "workflow",
    parentRunId: runId, parentStepRunId: stepRunId, rootRunId: runId,
    ...(opts.childStartedAt ? { startedAt: opts.childStartedAt } : {}),
  });
  await db.insert(workflowStepInvocations).values({
    companyId, parentStepRunId: stepRunId, childRunId, generation: 1,
    state: opts.invocationState ?? "linked", wait: true,
  });
  if (opts.parentStatus) {
    await db.update(workflowRuns).set({ status: opts.parentStatus, completedAt: new Date() }).where(eq(workflowRuns.id, runId));
  }
  return { companyId, runId, stepRunId, childRunId, childDefId };
}

const identityOf = async (x: Fixture): Promise<ChildStartIdentity> => ({
  companyId: x.companyId, parentRunId: x.runId, parentStepRunId: x.stepRunId,
  invocationId: (await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.parentStepRunId, x.stepRunId)))[0]!.id,
  generation: 1, childRunId: x.childRunId,
});

async function childRow(x: Fixture) {
  return (await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId)))[0];
}
async function childRows(x: Fixture) {
  return db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.childRunId));
}
async function seedMaterialized(x: Fixture, stepStatus: string, extras: Record<string, unknown> = {}) {
  await db.insert(workflowStepRuns).values({
    id: randomUUID(), workflowRunId: x.childRunId, stepId: "t", status: stepStatus, ...extras,
  });
  await db.update(workflowRuns).set({ childStartMaterializedAt: new Date() }).where(eq(workflowRuns.id, x.childRunId));
}
function armMocks() {
  executorMock = vi.fn().mockResolvedValue({ accepted: true, ok: true });
  setWorkflowToolStepExecutor(executorMock);
  setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));
}
let executorMock!: ReturnType<typeof vi.fn>;

describeEmbeddedPostgres("workflow child fix5 — manual resume, native continuation, bounded stuck exemption", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix5-resume-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    setWorkflowToolStepReadinessChecker(null);
    vi.restoreAllMocks();
    for (const table of [toolDefinitions, workflowStepInvocations, workflowStepRuns, workflowRuns, workflowDefinitions, activityLog, issueComments, issues, missions, agents, companies]) {
      await db.delete(table);
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("§3 public resume of a failed linked zero-row child with a failed parent creates real rows and receipt", async () => {
    const x = await childFixture("F5R OwnedZeroRow", { parentStatus: "failed", childStatus: "failed" });
    await db.insert(toolDefinitions).values({ companyId: x.companyId, name: "echo-tool", description: "t", inputSchema: {}, adapterType: "builtin", adapterConfig: {}, enabled: true });
    armMocks();
    const resumed = await workflowService.resumeRun(db, { runId: x.childRunId, companyId: x.companyId });
    expect(resumed.status).not.toBe("failed");
    const child = await childRow(x);
    expect(child?.status).toBe("running");
    expect(child?.childStartMaterializedAt).not.toBeNull();
    expect(child?.childStartToken).toBeNull(); // 영수증 소비로 정리됨
    expect(await childRows(x)).toHaveLength(1);
    expect((await childRow(x))?.completedAt).toBeNull();
    expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId)))[0]?.status).toBe("failed");
  });

  it("§3 public resume of a failed materialized child dispatches its queued tool once; ids/parent preserved; old token cannot write", async () => {
    const x = await childFixture("F5R NativeDispatch", { parentStatus: "failed", childStatus: "failed" });
    await db.insert(toolDefinitions).values({ companyId: x.companyId, name: "echo-tool", description: "t", inputSchema: {}, adapterType: "builtin", adapterConfig: {}, enabled: true });
    armMocks();
    const oldToken = randomUUID();
    await seedMaterialized(x, "pending");
    await db.update(workflowRuns).set({
      childStartToken: oldToken,
      childStartLeaseExpiresAt: new Date(Date.now() + 60_000),
      childStartDeadlineAt: new Date(Date.now() + 300_000),
    }).where(eq(workflowRuns.id, x.childRunId));
    const before = await childRows(x);
    expect(before).toHaveLength(1);
    const resumed = await workflowService.resumeRun(db, { runId: x.childRunId, companyId: x.companyId });
    const after = await childRows(x);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id)); // 행 ID/개수 불변
    expect(resumed.status).not.toBe("failed");
    expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId)))[0]?.status).toBe("failed");
    // 진행 없는 추가 sync 없이 큐 처리만으로 실행기 1회 호출.
    const dispatch = await processQueuedWorkflowToolStepRuns(db, { limit: 10 });
    expect(executorMock).toHaveBeenCalledTimes(1);
    expect(dispatch.executedCount).toBeGreaterThan(0);
    // 옛 토큰은 materialize/fail 어느 쪽 권위도 없다.
    const fence = { identity: await identityOf(x), token: oldToken, intent: "manual-resume" as const };
    expect((await ensureWorkflowStepRunRecords(db, {
      runId: x.childRunId, steps: TOOL_STEPS, childStartFence: fence,
      buildMetadata: (s) => ({ stepId: s.id }), syncControls: async (_d, rows) => rows,
    })).kind).toBe("not-owner");
    expect((await failOwnedWorkflowChildStart(db, { ...fence, errorCode: "probe" })).kind).toBe("lost");
  });

  it("§4 receipt-less legacy claimed+child rows are repaired by the stuck pass, then resumed", async () => {
    const x = await childFixture("F5R LegacyClaim", {
      childStatus: "running", childStartedAt: new Date(Date.now() - 2 * HOUR), invocationState: "claimed",
    });
    await db.insert(toolDefinitions).values({ companyId: x.companyId, name: "echo-tool", description: "t", inputSchema: {}, adapterType: "builtin", adapterConfig: {}, enabled: true });
    armMocks();
    const results = await reconcileStuckWorkflowRuns(db, 60);
    expect(results.map((r) => r.runId)).toContain(x.childRunId);
    expect(results.find((r) => r.runId === x.childRunId)?.reason).toBe("Unmaterialized linked child start timed out");
    const [invocation] = await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.parentStepRunId, x.stepRunId));
    expect(invocation?.state).toBe("linked"); // 판별자 수리
    expect(invocation?.wait).toBe(true); // wait/child/세대 불변
    const settled = await childRow(x);
    expect(settled?.status).toBe("failed");
    expect(settled?.childStartToken).toBeNull();
    // 수리+정산된 자식은 공개 resume 으로 실제 초기화된다(owned 경로).
    const resumed = await workflowService.resumeRun(db, { runId: x.childRunId, companyId: x.companyId });
    expect(resumed.status).not.toBe("failed");
    expect((await childRow(x))?.childStartMaterializedAt).not.toBeNull();
    expect(await childRows(x)).toHaveLength(1);
  });

  it("§3 native continuation on a one-hour-old materialized running child preserves started/completed/child_start columns exactly", async () => {
    const x = await childFixture("F5R NativePreserve", { childStatus: "running", childStartedAt: new Date(Date.now() - HOUR) });
    await db.insert(toolDefinitions).values({ companyId: x.companyId, name: "echo-tool", description: "t", inputSchema: {}, adapterType: "builtin", adapterConfig: {}, enabled: true });
    armMocks();
    await seedMaterialized(x, "running", { lastDispatchRequestId: "req-1", startedAt: new Date(Date.now() - HOUR) });
    const before = JSON.stringify(await childRow(x));
    const result = await executeWorkflowRun(db, x.childRunId, { intent: "native-continuation" });
    expect(result.status).not.toBe("failed");
    expect(JSON.stringify(await childRow(x))).toBe(before); // 시작 연산으로서의 컬럼 변형 없음
    await processQueuedWorkflowToolStepRuns(db, { limit: 10 });
    expect(executorMock).toHaveBeenCalledTimes(1);
    const [beforeRow, afterRow] = [JSON.parse(before) as Record<string, unknown>, await childRow(x)];
    expect(afterRow?.startedAt?.toISOString()).toBe(beforeRow.startedAt as string);
    expect(afterRow?.completedAt?.toISOString() ?? null).toBe(beforeRow.completedAt as string | null);
    expect(afterRow?.childStartMaterializedAt?.toISOString()).toBe(beforeRow.childStartMaterializedAt as string);
    expect(afterRow?.childStartToken ?? null).toBe(beforeRow.childStartToken as string | null);
    expect(afterRow?.childStartLeaseExpiresAt?.toISOString() ?? null).toBe(beforeRow.childStartLeaseExpiresAt as string | null);
    expect(afterRow?.childStartDeadlineAt?.toISOString() ?? null).toBe(beforeRow.childStartDeadlineAt as string | null);
  });

  it("§3 failed and cancelled unmaterialized continuations do nothing", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const x = await childFixture(`F5R DoNothing ${status}`, { childStatus: status });
      const result = await executeWorkflowRun(db, x.childRunId, { intent: "native-continuation" });
      expect(result.status).toBe(status);
      expect(await childRows(x)).toHaveLength(0);
      const child = await childRow(x);
      expect(child?.status).toBe(status);
      expect(child?.childStartMaterializedAt).toBeNull();
      expect(child?.childStartToken).toBeNull();
    }
  });

  it("§3 plain failed run resume still resets failed control nodes and resumes (regression)", { timeout: 30_000 }, async () => {
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
    expect(step?.status).toBe("completed"); // failed → reset → 재평가 완료
  });

  it("§4 stalled materialized linked child fails in the stuck pass while a leased unmaterialized child stays exempt", async () => {
    const stalled = await childFixture("F5R Stalled", { childStatus: "running", childStartedAt: new Date(Date.now() - 2 * HOUR) });
    await seedMaterialized(stalled, "completed");
    const leased = await childFixture("F5R Leased", { childStatus: "running", childStartedAt: new Date(Date.now() - 2 * HOUR) });
    await db.update(workflowRuns).set({
      childStartToken: randomUUID(),
      childStartLeaseExpiresAt: new Date(Date.now() + 60_000),
      childStartDeadlineAt: new Date(Date.now() + 300_000),
    }).where(eq(workflowRuns.id, leased.childRunId));
    const results = await reconcileStuckWorkflowRuns(db, 60);
    const stalledResult = results.find((r) => r.runId === stalled.childRunId);
    expect(stalledResult?.action).toBe("recovered"); // 무조건 skip 제거 — native liveness 후 실패
    expect((await childRow(stalled))?.status).toBe("failed");
    const leasedResult = results.find((r) => r.runId === leased.childRunId);
    expect(leasedResult?.action).toBe("skipped"); // 유효 OWNED_AUTO 면제
    expect((await childRow(leased))?.status).toBe("running");
    expect(await childRows(leased)).toHaveLength(0);
  });

  it("§4 dead-parent stale zero-step child is not exempt; standalone stuck pass settles it", async () => {
    const x = await childFixture("F5R DeadParent", {
      parentStatus: "failed", childStatus: "running", childStartedAt: new Date(Date.now() - 2 * HOUR),
    });
    await db.update(workflowRuns).set({
      childStartToken: randomUUID(),
      childStartLeaseExpiresAt: new Date(Date.now() - 1_000),
      childStartDeadlineAt: new Date(Date.now() + 300_000),
    }).where(eq(workflowRuns.id, x.childRunId));
    const results = await reconcileStuckWorkflowRuns(db, 60);
    const result = results.find((r) => r.runId === x.childRunId);
    expect(result?.action).toBe("recovered");
    expect(result?.reason).toBe("Unmaterialized linked child start timed out");
    const child = await childRow(x);
    expect(child?.status).toBe("failed");
    expect(child?.childStartToken).toBeNull();
    expect(child?.childStartLeaseExpiresAt).toBeNull();
    expect(await childRows(x)).toHaveLength(0);
  });
});
