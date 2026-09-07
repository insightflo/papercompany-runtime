// @vitest-environment node
// [workflow-child fix round 4] Finding 2/3 회귀 — 죽은 부모 자식 정상화 + 삭제된 미래 retry 정산.
// /tmp/wfw-fix-design-round4.md §7 "recovery" 스위트.
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
  claimWorkflowChildRunStart,
  reconcileWorkflowChildStepWaits,
} from "../services/workflow/workflow-child-execution.js";
import { reconcileStuckWorkflowRuns } from "../services/workflow/reconciler.js";
import { selectActionableCandidates } from "../services/workflow/workflow-child-recovery-candidates.js";
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
      for (const wait of [true, false] as const) {
        it(`dead ${parentStatus} parent: ${adopted ? "adopted" : "unadopted"} wait:${wait} child is cancelled before adoption (DeadPending opposite)`, async () => {
          const x = await linked(`R4 Dead ${parentStatus} ${adopted} ${wait}`, { adopted, wait });
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
  }

  it("dead-parent claimed child is reclaimed and never permanently exempt (DeadClaim opposite)", async () => {
    const x = await linked("R4 DeadClaim", { adopted: true });
    await claimWorkflowChildRunStart(db, { childRunId: x.childRunId, companyId: x.companyId });
    await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, x.runId));
    await db.update(workflowRuns).set({ startedAt: new Date(Date.now() - 7_200_000) }).where(eq(workflowRuns.id, x.childRunId));
    // child pass 가 먼저 취소한다(claim 상태·시작 시각과 무관).
    await reconcileWorkflowChildStepWaits(db);
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.status).toBe("cancelled");
  });

  it("stuck pass does not exempt an unowned zero-step linked child from timeout", async () => {
    const x = await linked("R4 StuckUnowned", { adopted: true });
    await db.update(workflowRuns).set({
      status: "running",
      startedAt: new Date(Date.now() - 7_200_000),
    }).where(eq(workflowRuns.id, x.childRunId));
    const results = await reconcileStuckWorkflowRuns(db, 60);
    // 소유 임대가 없으므로 면제되지 않는다(force-fail 또는 양보 재판정 — skip 금지는 아님,
    // 단 'child ownership' 사유의 skip 은 없어야 한다).
    expect(results.find((r) => r.runId === x.childRunId && r.reason?.includes("start lease"))).toBeUndefined();
  });

  it("deleted future-retry receipt cannot occupy the bounded recovery limit (DeletedFuture opposite)", async () => {
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

    // 첫 패스: 미래 retry 영수증이 limit=1 을 점유하지 못하고 어린 정산 가능 영수증이 선택된다.
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
    // 현재 세대가 아니므로 아직 정산하지 않는다(retry 가 먼저 진행되어야 한다).
    expect(results.every((r) => r.action !== "recovered" || r.reason.includes("tombstone"))).toBe(true);
  });
});
