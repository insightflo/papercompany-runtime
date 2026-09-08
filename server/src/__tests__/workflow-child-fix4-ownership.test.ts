// @vitest-environment node
// [workflow-child fix round 4 / descope v1] Finding 1 회귀 — 실행 진입 임대 소유권/중복
//   materialization 차단. unleased 시작 헬퍼(claimWorkflowChildRunStart)는 삭제됐고 모든 진입은
//   전체 신원 임대(acquireWorkflowChildStartLease) 소유자뿐이다. 수동/자동 intent 차원 없음(D3) —
//   토큰/만료 소유자 매트릭스는 자동 임대 하나로 축약됐다.
//   /tmp/wfw-fix-design-round4.md §7 "ownership" 스위트 + 설계 §5/§6 S/O 처분.
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import {
  executeWorkflowRunWithStartOutcome,
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
  setWorkflowToolStepReadinessChecker,
} from "../services/workflow/dag-engine.js";
import { acquireWorkflowChildStartLease } from "../services/workflow/workflow-child-start-lease.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";
import {
  insertLinkedInvocation,
  type WorkflowChildIdentityFixture,
} from "./helpers/workflow-child-invocation-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Owned = {
  companyId: string;
  runId: string;
  stepRunId: string;
  childRunId: string;
  childDefId: string;
  identity: WorkflowChildIdentityFixture;
};

/** 툴 스텝 자식 + 법정 linked 자식 + 사전 입양(회복 후보를 start-unmaterialized 로 고정). */
async function ownedToolChild(name: string): Promise<Owned> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({
    companyId,
    name: "child",
    steps: [{ id: "t", name: "T", type: "tool", agentId: "", dependencies: [], toolNames: ["echo-tool"], toolArgs: {} }],
  });
  const parentDefId = await insertDefinition({ companyId, name: "parent", steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const identity = await insertLinkedInvocation(db, {
    companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId,
  });
  expect(await adoptChildForWaitingStep(db, { identity, observedMetadata: null, now: new Date() })).toBe(true);
  return { companyId, runId, stepRunId, childRunId: identity.childRunId, childDefId, identity };
}

describeEmbeddedPostgres("workflow child fix round 4 — ownership", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix4-own-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    setWorkflowToolStepReadinessChecker(null);
    vi.restoreAllMocks();
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

  it("active creator owns readiness until lease expiry (CreatorRace opposite)", async () => {
    const x = await ownedToolChild("R4 CreatorRace");
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    let entries = 0;
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setWorkflowToolStepReadinessChecker(async () => {
      entries += 1;
      if (entries === 1) { entered(); await gate; }
      return { available: true };
    });
    // creator 가 임대를 취득하고 readiness 진입 — live 임대 동안 회복은 양보한다.
    const creator = executeWorkflowRunWithStartOutcome(db, x.childRunId);
    await entry;
    const results = await reconcileWorkflowChildStepWaits(db);
    expect(results.some((r) => r.action === "recovered")).toBe(false);
    expect(entries).toBe(1);
    release();
    const outcome = await creator;
    expect(outcome.kind).toBe("started");
    expect(entries).toBe(1);
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.childStartMaterializedAt).not.toBeNull();
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.childRunId));
    expect(steps.filter((s) => s.stepId === "t")).toHaveLength(1);
  });

  it("expired creator cannot materialize or fail a new owner", async () => {
    const x = await ownedToolChild("R4 ExpiredCreator");
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    let entries = 0;
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setWorkflowToolStepReadinessChecker(async () => {
      entries += 1;
      if (entries === 1) { entered(); await gate; }
      return { available: true };
    });
    const creator = executeWorkflowRunWithStartOutcome(db, x.childRunId);
    await entry;
    // 임대만 만료시킨다(마감은 미래 유지) — 회복이 새 소유자로 이어받는다.
    await db.update(workflowRuns).set({
      childStartLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
    }).where(eq(workflowRuns.id, x.childRunId));
    await reconcileWorkflowChildStepWaits(db);
    release();
    await creator.catch(() => undefined);
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.childStartMaterializedAt).not.toBeNull();
    expect(child?.status).not.toBe("failed");
    expect(child?.status).not.toBe("cancelled");
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.childRunId));
    expect(steps.filter((s) => s.stepId === "t")).toHaveLength(1);
  });

  it("concurrent materialization persists one row per run and step (DuplicateSteps opposite)", async () => {
    const x = await ownedToolChild("R4 DuplicateSteps");
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));
    await Promise.all([
      executeWorkflowRunWithStartOutcome(db, x.childRunId),
      reconcileWorkflowChildStepWaits(db),
      reconcileWorkflowChildStepWaits(db),
    ]);
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.childRunId));
    expect(steps.filter((s) => s.stepId === "t")).toHaveLength(1);
    // 직접 중복 insert 는 유일 인덱스 위반으로 거부된다.
    await expect(db.insert(workflowStepRuns).values({
      workflowRunId: x.childRunId, stepId: "t", status: "pending",
    })).rejects.toThrow();
  });

  it("claim crash spares the live lease and takes over the same child after expiry", async () => {
    // (a) 임대 획득 후 크래시 — live 임대 동안 회복은 후보조차 아니다(스텝 행 0).
    const x = await ownedToolChild("R4 ClaimCrash");
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));
    const lease = await acquireWorkflowChildStartLease(db, x.identity);
    expect(lease.kind).toBe("owned");
    expect(await reconcileWorkflowChildStepWaits(db)).toHaveLength(0);
    expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.childRunId))).toHaveLength(0);

    // (b) 임대 만료 후 같은 linked 자식으로 이어받기 — 마감 경과 전이다.
    await db.update(workflowRuns).set({
      childStartLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
    }).where(eq(workflowRuns.id, x.childRunId));
    const results = await reconcileWorkflowChildStepWaits(db);
    expect(results[0]?.action).toBe("recovered");
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.childRunId));
    expect(steps.length).toBeGreaterThan(0);
  });

  it("zero-definition-step child completes once with a materialization receipt", async () => {
    const x = await ownedToolChild("R4 EmptyChild");
    await db.update(workflowDefinitions).set({ stepsJson: [] }).where(eq(workflowDefinitions.id, x.childDefId));
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));
    const results = await reconcileWorkflowChildStepWaits(db);
    expect(results[0]?.action).toBe("recovered");
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.childStartMaterializedAt).not.toBeNull();
    expect(child?.status).toBe("completed");
    expect(await reconcileWorkflowChildStepWaits(db)).toHaveLength(0);
  });

  it("post-materialization executor failure does not authorize a child restart", async () => {
    const x = await ownedToolChild("R4 PostMatFail");
    const executor = vi.fn().mockRejectedValue(new Error("tool exploded"));
    setWorkflowToolStepExecutor(executor);
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));
    const results = await reconcileWorkflowChildStepWaits(db);
    expect(results[0]?.action).toBe("recovered");
    await processQueuedWorkflowToolStepRuns(db);
    // 자식은 종말(native 실패 경로)이며 재시작 후보가 아니다.
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.status).not.toBe("running");
    expect(await reconcileWorkflowChildStepWaits(db)).toHaveLength(0);
  });
});
