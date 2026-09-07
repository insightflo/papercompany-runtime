// @vitest-environment node
// [workflow-child fix5 — claim/legacy] cycle A §6 잠금 세대 클레임 + §10 레거시 claimed+nonnull
// 판별자 수리 검증. 스테일 세대 탈락, waiting 자기 해제 금지, 네이티브 해제 1회 승인, 재사용
// 내구 wait 보존, 부모 잠금 경합 busy, 레거시 3-pass 정산/무변화 픽스처.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
  dispatchWorkflowChildStep,
  dispatchWorkflowChildStepWithOutcome,
  reconcileWorkflowChildStepWaits,
} from "../services/workflow/workflow-child-execution.js";
import { refreshWorkflowChildRecoveryRow } from "../services/workflow/workflow-child-recovery-candidates.js";
import { normalizeWorkflowStepsForExecution } from "../services/workflow/dag-engine.js";
import { reconcileDueWorkflowStepRetries } from "../services/workflow/reconciler.js";
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

type ReceiptOptions = {
  state?: "linked" | "claimed";
  childStatus?: string | null;
  wait?: boolean;
  adopted?: boolean;
};

async function receipt(name: string, opts: ReceiptOptions = {}) {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({
    companyId,
    name: `${name}-child`,
    steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
  });
  const parentDefId = await insertDefinition({ companyId, name: `${name}-parent`, steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const childRunId = opts.childStatus === null ? null : randomUUID();
  if (childRunId) {
    await db.insert(workflowRuns).values({
      id: childRunId,
      workflowId: childDefId,
      companyId,
      status: opts.childStatus ?? "pending",
      triggeredBy: "workflow-step",
      triggerSource: "workflow",
      parentRunId: runId,
      parentStepRunId: stepRunId,
      rootRunId: runId,
    });
  }
  const [inv] = await db.insert(workflowStepInvocations).values({
    companyId,
    parentStepRunId: stepRunId,
    childRunId,
    generation: 1,
    state: opts.state ?? "linked",
    wait: opts.wait ?? true,
  }).returning();
  if (opts.adopted ?? true) {
    await db.update(workflowStepRuns).set({
      metadata: { workflowChild: { childRunId, invocationId: inv.id, generation: 1, wait: opts.wait ?? true } },
    }).where(eq(workflowStepRuns.id, stepRunId));
  }
  return { companyId, parentDefId, childDefId, runId, stepRunId, childRunId, invocationId: inv.id };
}

async function dispatchInputOf(x: Awaited<ReturnType<typeof receipt>>) {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
  const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, x.parentDefId));
  const step = normalizeWorkflowStepsForExecution(definition!.stepsJson)[0];
  return { db, run: run!, definition: definition!, step, stepRun: stepRun!, now: new Date() };
}

const childrenOf = (parentRunId: string) =>
  db.select().from(workflowRuns).where(and(eq(workflowRuns.parentRunId, parentRunId), eq(workflowRuns.triggerSource, "workflow")));
const invocationOf = (stepRunId: string) =>
  db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.parentStepRunId, stepRunId)).limit(1);
const stepOf = (stepRunId: string) =>
  db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)).limit(1);
function retryMetadata(nextEligibleAt: string) {
  return { state: "waiting", retryNumber: 1, maxRetries: 2, nextEligibleAt, sourceRequestId: null, sourceCompletedAt: null, lastErrorSummary: null };
}

describeEmbeddedPostgres("workflow child fix5 — locked claim + legacy link", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix5-claim-legacy-");
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

  it("stale caller generation 2 vs durable retryCount 0 yields ineligible with the whole receipt preserved", async () => {
    const x = await receipt("F5 Stale Gen2", { state: "linked", childStatus: "pending", adopted: true });
    const stale = { ...(await dispatchInputOf(x)), stepRun: { ...(await stepOf(x.stepRunId))[0]!, retryCount: 1 } };
    expect(await dispatchWorkflowChildStep(stale)).toBe(true);
    const [inv] = await invocationOf(x.stepRunId);
    expect(inv?.generation).toBe(1);
    expect(inv?.childRunId).toBe(x.childRunId);
    expect((await stepOf(x.stepRunId))[0]?.retryCount).toBe(0);
    expect(await childrenOf(x.runId)).toHaveLength(1);
  });

  it("stale generation 1 against current generation 2 yields without adopting the newer child", async () => {
    const x = await receipt("F5 Stale Gen1", { state: "linked", childStatus: "running", adopted: true });
    const stale = await dispatchInputOf(x);
    await db.update(workflowStepRuns).set({ retryCount: 1 }).where(eq(workflowStepRuns.id, x.stepRunId));
    await db.update(workflowStepInvocations).set({ generation: 2 }).where(eq(workflowStepInvocations.id, x.invocationId));
    // 호출자 스냅숏은 구세대(retryCount 0 → expected 1) — 내구 세대는 이미 2 다.
    const outcome = await dispatchWorkflowChildStepWithOutcome(db, { ...stale, stepRun: { ...stale.stepRun, retryCount: 0 } });
    expect(outcome.outcome).toBe("skipped");
    const [inv] = await invocationOf(x.stepRunId);
    expect(inv?.generation).toBe(2);
    expect(inv?.childRunId).toBe(x.childRunId);
    const [step] = await stepOf(x.stepRunId);
    expect((step?.metadata as Record<string, unknown>).workflowChild).toEqual(
      expect.objectContaining({ childRunId: x.childRunId, generation: 1 }),
    );
    expect(await childrenOf(x.runId)).toHaveLength(1);
  });

  it("waiting retry even when due cannot self-release via recovery; metadata unchanged", async () => {
    const x = await receipt("F5 Waiting", { state: "linked", childStatus: "failed", adopted: true });
    const nextEligibleAt = new Date(Date.now() - 60_000).toISOString();
    const [step] = await stepOf(x.stepRunId);
    await db.update(workflowStepRuns).set({
      retryCount: 1,
      metadata: { ...(step?.metadata as Record<string, unknown>), workflowRetry: retryMetadata(nextEligibleAt) },
    }).where(eq(workflowStepRuns.id, x.stepRunId));
    expect(await refreshWorkflowChildRecoveryRow(db, x.invocationId)).toBeNull();
    expect(await reconcileWorkflowChildStepWaits(db).then((rows) => rows.filter((r) => r.stepRunId === x.stepRunId))).toHaveLength(0);
    const [after] = await stepOf(x.stepRunId);
    const retry = (after?.metadata as Record<string, unknown>).workflowRetry as Record<string, unknown>;
    expect(retry.state).toBe("waiting");
    expect(retry.nextEligibleAt).toBe(nextEligibleAt);
    expect(after?.status).toBe("pending");
    expect(await childrenOf(x.runId)).toHaveLength(1);
  });

  it("native due-retry release authorizes the next generation exactly once", async () => {
    const x = await receipt("F5 Release", { state: "linked", childStatus: "failed", adopted: true });
    const [step] = await stepOf(x.stepRunId);
    await db.update(workflowStepRuns).set({
      retryCount: 1,
      metadata: { ...(step?.metadata as Record<string, unknown>), workflowRetry: retryMetadata(new Date(Date.now() - 1_000).toISOString()) },
    }).where(eq(workflowStepRuns.id, x.stepRunId));
    await reconcileDueWorkflowStepRetries(db);
    const children = await childrenOf(x.runId);
    expect(children).toHaveLength(2);
    const [inv] = await invocationOf(x.stepRunId);
    expect(inv?.generation).toBe(2);
    expect(inv?.childRunId).not.toBe(x.childRunId);
    expect(inv?.state).toBe("linked");
    await reconcileDueWorkflowStepRetries(db);
    expect(await childrenOf(x.runId)).toHaveLength(2);
  });

  it("reused dispatch preserves the durable wait after definition edits in both reuse directions", async () => {
    const x = await receipt("F5 Wait Edit", { state: "linked", childStatus: "pending", adopted: true });
    expect((await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(x))).outcome).toBe("waiting");
    await db.update(workflowDefinitions).set({ stepsJson: [childStep(x.childDefId, { wait: false })] })
      .where(eq(workflowDefinitions.id, x.parentDefId));
    expect((await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(x))).outcome).toBe("waiting");
    const [inv] = await invocationOf(x.stepRunId);
    expect(inv?.wait).toBe(true);
    const [step] = await stepOf(x.stepRunId);
    expect((step?.metadata as Record<string, unknown>).workflowChild).toEqual(expect.objectContaining({ wait: true }));
    expect(await childrenOf(x.runId)).toHaveLength(1);
  });

  it("held parent lock yields busy without writes and the dispatch succeeds after release", async () => {
    const x = await receipt("F5 Held Lock", { state: "claimed", childStatus: null, adopted: false });
    let locked!: () => void;
    let release!: () => void;
    const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute("select id from workflow_runs where id = '" + x.runId + "' for update");
      locked();
      await gate;
    });
    await lockedPromise;
    try {
      const outcome = await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(x));
      expect(outcome.outcome).toBe("skipped");
    } finally {
      release();
      await holder;
    }
    expect(await childrenOf(x.runId)).toHaveLength(0);
    const [invBefore] = await invocationOf(x.stepRunId);
    expect(invBefore?.childRunId).toBeNull();
    expect((await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(x))).outcome).toBe("progressed");
    expect(await childrenOf(x.runId)).toHaveLength(1);
    const [invAfter] = await invocationOf(x.stepRunId);
    expect(invAfter?.state).toBe("linked");
    expect(invAfter?.childRunId).not.toBeNull();
  }, 20_000);

  it("legacy claimed receipts: younger terminal receipt settles in the first pass and stays settled; older row repairs once", async () => {
    const old = await receipt("F5 Legacy Old", { state: "claimed", childStatus: "pending", adopted: false });
    await db.update(workflowStepInvocations).set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(workflowStepInvocations.id, old.invocationId));
    const young = await receipt("F5 Legacy Young", { state: "claimed", childStatus: "completed", adopted: false });
    const first = await reconcileWorkflowChildStepWaits(db, { limit: 1 });
    expect(first.map((r) => r.stepRunId)).toEqual([young.stepRunId]);
    expect(first[0]?.action).toBe("recovered");
    expect((await stepOf(young.stepRunId))[0]?.status).toBe("completed");
    expect((await invocationOf(old.stepRunId))[0]?.state).toBe("claimed");
    expect((await childrenOf(old.runId))[0]?.status).toBe("pending");
    await reconcileWorkflowChildStepWaits(db, { limit: 1 });
    await reconcileWorkflowChildStepWaits(db, { limit: 1 });
    expect((await stepOf(young.stepRunId))[0]?.status).toBe("completed");
    const [oldInv] = await invocationOf(old.stepRunId);
    expect(oldInv?.state).toBe("linked");
    expect(oldInv?.childRunId).toBe(old.childRunId);
    expect(await childrenOf(old.runId)).toHaveLength(1);
    const oldChild = (await childrenOf(old.runId))[0]!;
    expect(oldChild.status).not.toBe("pending");
    expect(oldChild.startedAt).not.toBeNull();
    const [oldStep] = await stepOf(old.stepRunId);
    expect((oldStep?.metadata as Record<string, unknown>).workflowChild).toEqual(
      expect.objectContaining({ childRunId: old.childRunId, generation: 1 }),
    );
  });

  it("linked discriminator control settles without repair; waiting-retry and wrong-company legacy fixtures unchanged across three passes", async () => {
    const control = await receipt("F5 Link Control", { state: "linked", childStatus: "completed", adopted: false });
    const waiting = await receipt("F5 Wait Legacy", { state: "claimed", childStatus: "failed", adopted: true });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const [waitStep] = await stepOf(waiting.stepRunId);
    await db.update(workflowStepRuns).set({
      retryCount: 1,
      metadata: { ...(waitStep?.metadata as Record<string, unknown>), workflowRetry: retryMetadata(future) },
    }).where(eq(workflowStepRuns.id, waiting.stepRunId));
    const wrong = await receipt("F5 Wrong Co", { state: "claimed", childStatus: "running", adopted: false });
    const otherCompany = await createCompanyFixture("F5 Other Co Holder");
    await db.update(workflowRuns).set({ companyId: otherCompany }).where(eq(workflowRuns.id, wrong.childRunId!));
    for (let i = 0; i < 3; i += 1) {
      await reconcileWorkflowChildStepWaits(db, { limit: 25 });
    }
    expect((await stepOf(control.stepRunId))[0]?.status).toBe("completed");
    const [waitAfter] = await stepOf(waiting.stepRunId);
    const retry = (waitAfter?.metadata as Record<string, unknown>).workflowRetry as Record<string, unknown>;
    expect(retry.state).toBe("waiting");
    expect(retry.nextEligibleAt).toBe(future);
    expect(waitAfter?.retryCount).toBe(1);
    expect((await invocationOf(waiting.stepRunId))[0]?.state).toBe("claimed");
    const [wrongInv] = await invocationOf(wrong.stepRunId);
    expect(wrongInv?.state).toBe("claimed");
    expect(wrongInv?.childRunId).toBe(wrong.childRunId);
    expect((await childrenOf(wrong.runId))[0]?.status).toBe("running");
    expect((await stepOf(wrong.stepRunId))[0]?.status).toBe("pending");
  });
});
