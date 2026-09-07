// @vitest-environment node
// [workflow-child fix round 4] Finding 1 회귀 — 실행 진입 임대 소유권/중복 materialization 차단.
// /tmp/wfw-fix-design-round4.md §7 "ownership" 스위트.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  missions,
  toolDefinitions,
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
  normalizeWorkflowStepsForExecution,
  processQueuedWorkflowToolStepRuns,
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Owned = Awaited<ReturnType<typeof ownedToolChild>>;

/** 툴 스텝 자식 정의 + 링크/클레임된 자식 픽스처. */
async function ownedToolChild(name: string): Promise<{
  companyId: string; runId: string; stepRunId: string; childRunId: string; childDefId: string;
}> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({
    companyId,
    name: "child",
    steps: [{ id: "t", name: "T", type: "tool", agentId: "", dependencies: [], toolNames: ["echo-tool"], toolArgs: {} }],
  });
  const parentDefId = await insertDefinition({ companyId, name: "parent", steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const childRunId = randomUUID();
  await db.insert(workflowRuns).values({
    id: childRunId, workflowId: childDefId, companyId, status: "pending",
    triggeredBy: "workflow-step", triggerSource: "workflow",
    parentRunId: runId, parentStepRunId: stepRunId, rootRunId: runId,
  });
  await db.insert(workflowStepInvocations).values({
    companyId, parentStepRunId: stepRunId, childRunId, generation: 1, state: "linked", wait: true,
  });
  return { companyId, runId, stepRunId, childRunId, childDefId };
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
    await claimWorkflowChildRunStart(db, { childRunId: x.childRunId, companyId: x.companyId });
    const creator = executeWorkflowRun(db, x.childRunId);
    await entry;
    // 임대가 살아있는 동안 회복은 시작 후보가 아니다 — readiness 재진입 없음.
    const results = await reconcileWorkflowChildStepWaits(db);
    expect(results.some((r) => r.action === "recovered")).toBe(false);
    expect(entries).toBe(1);
    release();
    await creator;
    expect(entries).toBe(1);
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.childStartMaterializedAt).not.toBeNull();
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, x.childRunId));
    expect(steps.filter((s) => s.stepId === "t")).toHaveLength(1);
  });

  it("expired creator cannot materialize or fail a new owner", { timeout: 30_000 }, async () => {
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
    await claimWorkflowChildRunStart(db, { childRunId: x.childRunId, companyId: x.companyId });
    const creator = executeWorkflowRun(db, x.childRunId);
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
    await claimWorkflowChildRunStart(db, { childRunId: x.childRunId, companyId: x.companyId });
    await Promise.all([
      executeWorkflowRun(db, x.childRunId),
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

  it("claim crash takes over after lease expiry; reservation-only crash is immediate", async () => {
    // (a) 예약 전용 크래시 — 즉시 회복 가능.
    const a = await ownedToolChild("R4 ClaimCrashA");
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));
    await claimWorkflowChildRunStart(db, { childRunId: a.childRunId, companyId: a.companyId });
    await reconcileWorkflowChildStepWaits(db);
    const aSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, a.childRunId));
    expect(aSteps.length).toBeGreaterThan(0);

    // (b) 임대 획득 후 크래시 — 만료 전에는 무동작, 만료 후 이어받기.
    const b = await ownedToolChild("R4 ClaimCrashB");
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    await db.update(workflowRuns).set({
      status: "running",
      startedAt: new Date(),
      childStartToken: sql`${randomUUID()}`,
      childStartLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
      childStartDeadlineAt: sql`clock_timestamp() + interval '5 minutes'`,
    }).where(eq(workflowRuns.id, b.childRunId));
    expect(await reconcileWorkflowChildStepWaits(db)).toHaveLength(0);
    await db.update(workflowRuns).set({
      childStartLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
    }).where(eq(workflowRuns.id, b.childRunId));
    await reconcileWorkflowChildStepWaits(db);
    const bSteps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, b.childRunId));
    expect(bSteps.length).toBeGreaterThan(0);
  });

  it("zero-definition-step child completes once with a materialization receipt", async () => {
    const x = await ownedToolChild("R4 EmptyChild");
    await db.update(workflowDefinitions).set({ stepsJson: [] }).where(eq(workflowDefinitions.id, x.childDefId));
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true, ok: true }));
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));
    await claimWorkflowChildRunStart(db, { childRunId: x.childRunId, companyId: x.companyId });
    await reconcileWorkflowChildStepWaits(db);
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
    await claimWorkflowChildRunStart(db, { childRunId: x.childRunId, companyId: x.companyId });
    await reconcileWorkflowChildStepWaits(db);
    await processQueuedWorkflowToolStepRuns(db);
    // 자식은 종말(native 실패 경로)이며 재시작 후보가 아니다.
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.childRunId));
    expect(child?.status).not.toBe("running");
    expect(await reconcileWorkflowChildStepWaits(db)).toHaveLength(0);
  });
});
