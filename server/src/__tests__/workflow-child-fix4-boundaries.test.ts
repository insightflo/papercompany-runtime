// @vitest-environment node
// [workflow-child fix round 4] Finding 4 + ModeCrash 경계 회귀 — adoption-only 복구, 마감 불변성,
// 수동 resume 권한, 기본 wait 모드가 정의 편집을 따르지 않음.
// /tmp/wfw-fix-design-round4.md §7 "boundaries" 스위트.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
  claimWorkflowChildRunStart,
  reconcileWorkflowChildStepWaits,
} from "../services/workflow/workflow-child-execution.js";
import {
  executeWorkflowRun,
  setWorkflowToolStepExecutor,
  setWorkflowToolStepReadinessChecker,
} from "../services/workflow/dag-engine.js";
import { sql } from "drizzle-orm";
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

type Linked = {
  companyId: string; runId: string; stepRunId: string; childRunId: string; childDefId: string;
};

async function linked(name: string, opts: { adopted?: boolean; childStatus?: string; wait?: boolean } = {}): Promise<Linked> {
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
    companyId, parentStepRunId: stepRunId, childRunId, generation: 1,
    state: "linked", wait: opts.wait ?? true,
  }).returning();
  if (opts.adopted ?? true) {
    await db.update(workflowStepRuns).set({
      metadata: { workflowChild: { childRunId, invocationId: inv.id, generation: 1, wait: opts.wait ?? true } },
    }).where(eq(workflowStepRuns.id, stepRunId));
  }
  return { companyId, runId, stepRunId, childRunId, childDefId };
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
    const x = await linked("R4 HealthyUnadopted", { adopted: false, childStatus: "running", wait: true });
    const original = new Date(Date.now() - 3_600_000);
    await db.update(workflowRuns).set({ startedAt: original }).where(eq(workflowRuns.id, x.childRunId));
    await db.insert(workflowStepRuns).values({ workflowRunId: x.childRunId, stepId: "a", status: "pending" });
    const readiness = vi.fn().mockResolvedValue({ available: true });
    setWorkflowToolStepReadinessChecker(readiness);
    const results = await reconcileWorkflowChildStepWaits(db);
    expect(results[0]?.reason).toContain("adoption only");
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.startedAt?.getTime()).toBe(original.getTime());
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.childRunId));
    expect(steps).toHaveLength(1);
    expect(readiness).not.toHaveBeenCalled();
    // 수리된 adoption 메타데이터가 현재 invocation 과 정확히 일치한다.
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(step?.metadata).toMatchObject({
      workflowChild: { childRunId: x.childRunId, generation: 1, wait: true },
    });
  });

  it("start deadline is immutable and bounds the timeout exemption", async () => {
    const x = await linked("R4 Deadline", { adopted: true });
    const identity = {
      companyId: x.companyId, parentRunId: x.runId, parentStepRunId: x.stepRunId,
      invocationId: (await db.select().from(workflowStepInvocations)
        .where(eq(workflowStepInvocations.parentStepRunId, x.stepRunId)))[0]!.id,
      generation: 1, childRunId: x.childRunId,
    };
    const { acquireWorkflowChildStartLease, expireWorkflowChildStart } = await import("../services/workflow/workflow-child-start-lease.js");
    // 소유 임대 획득 → 불변 마감 설정 확인.
    const first = await acquireWorkflowChildStartLease(db, identity);
    expect(first.kind).toBe("owned");
    const [withLease] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(withLease?.childStartDeadlineAt).not.toBeNull();
    const deadline1 = withLease?.childStartDeadlineAt!.getTime();
    // 임대만 만료 → 재획득 시 같은 마감/새 토큰.
    await db.update(workflowRuns).set({
      childStartLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
    }).where(eq(workflowRuns.id, x.childRunId));
    const second = await acquireWorkflowChildStartLease(db, identity);
    expect(second.kind).toBe("owned");
    const [reacquired] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(reacquired?.childStartDeadlineAt!.getTime()).toBe(deadline1);
    expect(reacquired?.childStartToken).not.toBe((first as { token: string }).token);
    // 마감 경과 → reconcile 이 실패 정산 + 구조화 timeout 코드, 재시작 없음.
    await db.update(workflowRuns).set({
      childStartDeadlineAt: sql`clock_timestamp() - interval '1 second'`,
      childStartLeaseExpiresAt: sql`clock_timestamp() - interval '2 seconds'`,
    }).where(eq(workflowRuns.id, x.childRunId));
    await reconcileWorkflowChildStepWaits(db);
    void expireWorkflowChildStart;
    const [expired] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(expired?.status).toBe("failed");
    expect((expired?.metadata as Record<string, unknown>).workflowChildStartFailure)
      .toEqual({ version: 1, errorCode: "child_start_timeout" });
    expect(await reconcileWorkflowChildStepWaits(db)).toHaveLength(0);
  });

  it("manual failed-run resume retains authorization", async () => {
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
    await db.insert(toolDefinitions).values({
      companyId, name: "echo-tool", description: "test tool", inputSchema: {},
      adapterType: "builtin", adapterConfig: {}, enabled: true,
    });
    const result = await workflowService.trigger(db, {
      workflowId: parentDefId, companyId, triggeredBy: "board", triggerSource: "api",
    });
    await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, result.runId));
    // 공개 서비스 resume — 실패 run 수동 재개가 여전히 승인된다(terminal blanket ban 금지).
    const resumed = await workflowService.resumeRun(db, { runId: result.runId, companyId });
    expect(resumed.status).not.toBe("failed");
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, result.runId));
    expect(steps.filter((s) => s.stepId === "p")).toHaveLength(1);
    void childDefId;
  });

  it("default wait:true is not inferred from an edited definition; explicit false survives (ModeCrash decision)", async () => {
    // (a) 미기록(기본 true) 수령 + 정의를 false 로 편집 → 내구 true 유지(레거시 제한 문서화 케이스).
    const a = await linked("R4 LegacyDefault", { adopted: false });
    const [runA] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, a.runId));
    await db.update(workflowDefinitions).set({ stepsJson: [childStep(a.childDefId, { wait: false })] })
      .where(eq(workflowDefinitions.id, runA.workflowId));
    await reconcileWorkflowChildStepWaits(db);
    const [stepA] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, a.stepRunId));
    expect((stepA?.metadata as Record<string, unknown>).workflowChild)
      .toMatchObject({ wait: true });
    // (b) 명시 false 수령 + 정의를 true 로 편집 → 내구 false 유지(재사용 경로 포함).
    const b = await linked("R4 ExplicitFalse", { adopted: false });
    const [runB] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, b.runId));
    await db.update(workflowDefinitions).set({ stepsJson: [childStep(b.childDefId, { wait: false })] })
      .where(eq(workflowDefinitions.id, runB.workflowId));
    await db.update(workflowStepInvocations).set({ wait: false })
      .where(eq(workflowStepInvocations.parentStepRunId, b.stepRunId));
    await db.update(workflowDefinitions).set({ stepsJson: [childStep(b.childDefId, { wait: true })] })
      .where(eq(workflowDefinitions.id, runB.workflowId));
    await reconcileWorkflowChildStepWaits(db);
    const [stepB] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, b.stepRunId));
    expect((stepB?.metadata as Record<string, unknown>).workflowChild)
      .toMatchObject({ wait: false });
  });
});
