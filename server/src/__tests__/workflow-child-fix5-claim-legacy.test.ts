// @vitest-environment node
// [workflow-child fix5 — claim] descope v1 엄격 클레임/거부 스위트(설계 §2/§3/§6).
//   레거시 수리·세대 admission 사례는 삭제됐다(D2/D5). 남는 계약:
//   재사용은 정합 linked 자식뿐(슬롯 미소모), tombstone(linked+NULL)은 재생성 없이 fenced 정산,
//   커밋된 claimed/세대≠1/workflowRetry 스텝은 변이 전 fail-closed 거부, 같은 회사 부모/스텝
//   치환·비활성/타회사 정의도 거부다. 커밋된 claimed 비정합 fixture 만 §2 허용대로 격리
//   트랜잭션에서 트리거를 우회해 만든다(실행 경로는 이 상태를 절대 만들지 않는다).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, issueComments, issues, missions,
  workflowDefinitions, workflowRuns, workflowStepInvocations, workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dispatchWorkflowChildStepWithOutcome } from "../services/workflow/workflow-child-execution.js";
import { claimChildInvocation } from "../services/workflow/workflow-child-invocation-claim.js";
import { acquireWorkflowChildStartLease } from "../services/workflow/workflow-child-start-lease.js";
import { normalizeWorkflowStepsForExecution } from "../services/workflow/dag-engine.js";
import {
  childStep, configureWorkflowChildFixtures, createCompanyFixture, insertDefinition,
  insertRunWithWorkflowStepRun, insertStepRunForRun,
} from "./helpers/workflow-child-fixtures.js";
import {
  insertLinkedInvocation, insertMaterializedChildRun, insertOrphanChildMarkedRun,
  insertTombstoneInvocation,
} from "./helpers/workflow-child-invocation-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type ChildSuite = { companyId: string; childDefId: string; parentDefId: string; runId: string; stepRunId: string };

/** 자식 정의(agent 1스텝) + 부모 정의(child 스텝) + running run/pending 스텝 기본 픽스처. */
async function childSuite(name: string, opts: { retryCount?: number; metadata?: Record<string, unknown> } = {}): Promise<ChildSuite> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({
    companyId, name: `${name}-child`,
    steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
  });
  const parentDefId = await insertDefinition({ companyId, name: `${name}-parent`, steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({
    companyId, workflowId: parentDefId, retryCount: opts.retryCount, metadata: opts.metadata,
  });
  return { companyId, childDefId, parentDefId, runId, stepRunId };
}

/** dispatch 입력 — 현재 DB 상태를 재적재해 스테일 스냅숏 혼입을 막는다. */
async function dispatchInputOf(x: ChildSuite) {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, x.parentDefId));
  const step = normalizeWorkflowStepsForExecution(definition!.stepsJson).find((s) => s.id === "run-child")!;
  const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId));
  return { run: run!, definition: definition!, step, stepRun: stepRun!, now: new Date() };
}

const childrenOf = (parentRunId: string) =>
  db.select().from(workflowRuns).where(and(eq(workflowRuns.parentRunId, parentRunId), eq(workflowRuns.triggerSource, "workflow")));
const invocationOf = (stepRunId: string) =>
  db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.parentStepRunId, stepRunId)).limit(1);
const runRow = async (id: string) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0];
const stepRow = async (id: string) => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id)))[0];
const toolResultOf = async (stepRunId: string) =>
  ((await stepRow(stepRunId))?.metadata as Record<string, unknown>).toolResult as Record<string, unknown>;

/** [§2 비정합 fixture 전용] 격리 트랜잭션에서 트리거를 우회해 커밋된 claimed 행을 만든다. */
async function insertCommittedClaimedRow(input: { companyId: string; parentStepRunId: string; childRunId?: string; targetWorkflowId: string }): Promise<string> {
  const invocationId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute("set local session_replication_role = replica");
    await tx.insert(workflowStepInvocations).values({
      id: invocationId,
      companyId: input.companyId,
      parentStepRunId: input.parentStepRunId,
      childRunId: input.childRunId ?? null,
      state: "claimed",
      generation: 1,
      targetWorkflowId: input.targetWorkflowId,
    });
  });
  return invocationId;
}

describeEmbeddedPostgres("workflow child fix5 — strict claim/refusal (no repair, no retry admission)", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix5-claim-");
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

  it("cap=5 counts committed invocations including tombstones and mixed states; the sixth claim fails atomically", async () => {
    const x = await childSuite("F5C Cap");
    const kinds = ["materialized", "linked", "tombstone", "materialized", "linked"] as const;
    for (let i = 0; i < kinds.length; i += 1) {
      const siblingStepRunId = await insertStepRunForRun({ runId: x.runId, stepId: `sib-${i}` });
      if (kinds[i] === "materialized") {
        await insertMaterializedChildRun(db, { companyId: x.companyId, parentRunId: x.runId, parentStepRunId: siblingStepRunId, childWorkflowId: x.childDefId, stepId: `sib-${i}` });
      } else if (kinds[i] === "linked") {
        await insertLinkedInvocation(db, { companyId: x.companyId, parentRunId: x.runId, parentStepRunId: siblingStepRunId, childWorkflowId: x.childDefId, stepId: `sib-${i}` });
      } else {
        await insertTombstoneInvocation(db, { companyId: x.companyId, parentStepRunId: siblingStepRunId, targetWorkflowId: x.childDefId });
      }
    }
    expect((await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(x))).outcome).toBe("failed");
    expect(await toolResultOf(x.stepRunId)).toEqual(expect.objectContaining({ success: false, error: "child_concurrency_exceeded" }));
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(5);
    expect(await childrenOf(x.runId)).toHaveLength(4);
  });

  it("reuse of a coherent linked child consumes no cap slot and creates no replacement", async () => {
    const x = await childSuite("F5C Reuse");
    const identity = await insertLinkedInvocation(db, { companyId: x.companyId, parentRunId: x.runId, parentStepRunId: x.stepRunId, childWorkflowId: x.childDefId });
    for (const [i, kind] of ["tombstone", "linked", "materialized", "linked"].entries()) {
      const siblingStepRunId = await insertStepRunForRun({ runId: x.runId, stepId: `rs-${i}` });
      if (kind === "linked") {
        await insertLinkedInvocation(db, { companyId: x.companyId, parentRunId: x.runId, parentStepRunId: siblingStepRunId, childWorkflowId: x.childDefId, stepId: `rs-${i}` });
      } else if (kind === "materialized") {
        await insertMaterializedChildRun(db, { companyId: x.companyId, parentRunId: x.runId, parentStepRunId: siblingStepRunId, childWorkflowId: x.childDefId, stepId: `rs-${i}` });
      } else {
        await insertTombstoneInvocation(db, { companyId: x.companyId, parentStepRunId: siblingStepRunId, targetWorkflowId: x.childDefId });
      }
    }
    // cap 이 꽉 찬 5개 커밋 상태에서도 같은 스텝 재도달은 재사용이다 — 6번째 슬롯을 소모하지 않는다.
    expect((await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(x))).outcome).toBe("waiting");
    expect((await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(x))).outcome).toBe("waiting");
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(5);
    const [inv] = await invocationOf(x.stepRunId);
    expect(inv?.state).toBe("linked");
    expect(inv?.childRunId).toBe(identity.childRunId);
    expect((await childrenOf(x.runId)).map((c) => c.id).sort()).toContain(identity.childRunId);
    expect(await childrenOf(x.runId)).toHaveLength(4);
  });

  it("tombstone (linked+NULL) dispatch settles the bound step once and never recreates a child", async () => {
    const x = await childSuite("F5C Tomb");
    const tomb = await insertTombstoneInvocation(db, { companyId: x.companyId, parentStepRunId: x.stepRunId, targetWorkflowId: x.childDefId });
    expect((await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(x))).outcome).toBe("failed");
    expect(await toolResultOf(x.stepRunId)).toEqual(expect.objectContaining({ success: false, error: "child_run_failed" }));
    const [inv] = await invocationOf(x.stepRunId);
    expect(inv?.state).toBe("linked");
    expect(inv?.childRunId).toBeNull();
    expect(inv?.generation).toBe(tomb.generation);
    expect(await childrenOf(x.runId)).toHaveLength(0);
    // 반복 콜백 no-op — 이미 정산된 스텝은 재정산/재생성되지 않는다(D4).
    expect((await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(x))).outcome).toBe("skipped");
    expect((await stepRow(x.stepRunId))?.status).toBe("failed");
    expect(await childrenOf(x.runId)).toHaveLength(0);
  });

  it("committed claimed rows refuse claim as invalid-state; execution rows stay unchanged (no repair/adoption)", async () => {
    // (1) claimed+NULL — 수리/재사용/자식 생성 없음.
    const nullCase = await childSuite("F5C ClaimedNull");
    await insertCommittedClaimedRow({ companyId: nullCase.companyId, parentStepRunId: nullCase.stepRunId, targetWorkflowId: nullCase.childDefId });
    const claim = await claimChildInvocation(db, {
      companyId: nullCase.companyId, run: (await runRow(nullCase.runId))!, parentStepRunId: nullCase.stepRunId,
      stepId: "run-child", generation: 1, targetWorkflowId: nullCase.childDefId, renderedInputs: {}, now: new Date(),
    });
    expect(claim).toEqual(expect.objectContaining({ outcome: "invalid-state" }));
    expect((await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(nullCase))).outcome).toBe("skipped");
    const [nullInv] = await invocationOf(nullCase.stepRunId);
    expect(nullInv?.state).toBe("claimed");
    expect(nullInv?.childRunId).toBeNull();
    expect((await stepRow(nullCase.stepRunId))?.status).toBe("pending");
    // 입양 프로젝션 없음 — metadata 는 초기값 {} 에 머문다.
    expect((await stepRow(nullCase.stepRunId))?.metadata).toEqual({});
    expect(await childrenOf(nullCase.runId)).toHaveLength(0);
    // (2) claimed+nonnull — 영수증 유무와 무관하게 거부, 입양 없음(r6 판별자).
    const nnCase = await childSuite("F5C ClaimedNN");
    const orphanRunId = await insertOrphanChildMarkedRun(db, {
      companyId: nnCase.companyId, parentRunId: nnCase.runId, parentStepRunId: nnCase.stepRunId, childWorkflowId: nnCase.childDefId,
    });
    await insertCommittedClaimedRow({ companyId: nnCase.companyId, parentStepRunId: nnCase.stepRunId, childRunId: orphanRunId, targetWorkflowId: nnCase.childDefId });
    expect((await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(nnCase))).outcome).toBe("skipped");
    const [nnInv] = await invocationOf(nnCase.stepRunId);
    expect(nnInv?.state).toBe("claimed");
    expect(nnInv?.childRunId).toBe(orphanRunId);
    expect((await stepRow(nnCase.stepRunId))?.metadata).toEqual({});
    expect((await runRow(orphanRunId))?.status).toBe("pending");
    // 감사 — 구조화 invalid-state 이벤트만 남는다(행 무변경의 증거).
    const audits = await db.select().from(activityLog).where(eq(activityLog.action, "workflow_child_invalid_state"));
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it("generation != 1 is refused before any mutation at claim and lease entries", async () => {
    const x = await childSuite("F5C Gen");
    const baseInput = {
      companyId: x.companyId, run: (await runRow(x.runId))!, parentStepRunId: x.stepRunId, stepId: "run-child",
      generation: 1, targetWorkflowId: x.childDefId, renderedInputs: {}, now: new Date(),
    };
    const stale = await claimChildInvocation(db, { ...baseInput, generation: 2 } as typeof baseInput);
    expect(stale).toEqual({ outcome: "invalid-state", reason: expect.stringContaining("generation must be 1") });
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
    expect(await childrenOf(x.runId)).toHaveLength(0);
    // 행 레벨 세대 불일치도 fail-closed — linked 자식이 있어도 임대/변이 없다.
    const identity = await insertLinkedInvocation(db, { companyId: x.companyId, parentRunId: x.runId, parentStepRunId: x.stepRunId, childWorkflowId: x.childDefId });
    expect((await acquireWorkflowChildStartLease(db, { ...identity, generation: 2 })).kind).toBe("ineligible");
    const child = await runRow(identity.childRunId);
    expect(child?.status).toBe("pending");
    expect(child?.childStartToken).toBeNull();
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(1);
  });

  it("workflowRetry metadata (any value, even null) and nonzero retryCount refuse the claim before mutation", async () => {
    const cases = [
      { label: "meta", opts: { metadata: { workflowRetry: { state: "waiting", nextEligibleAt: new Date().toISOString() } } } },
      { label: "null", opts: { metadata: { workflowRetry: null } } },
      { label: "count", opts: { retryCount: 1 } },
    ] as const;
    for (const { label, opts } of cases) {
      const x = await childSuite(`F5C Retry ${label}`, opts);
      expect((await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(x))).outcome).toBe("skipped");
      expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
      expect(await childrenOf(x.runId)).toHaveLength(0);
      const step = await stepRow(x.stepRunId);
      expect(step?.status).toBe("pending");
      expect(step?.retryCount).toBe(opts.retryCount ?? 0);
    }
  });

  it("same-company wrong parent/step substitution fails closed with zero mutations on both sides", async () => {
    const companyId = await createCompanyFixture("F5C Swap Co");
    const childDefId = await insertDefinition({ companyId, name: "swap-child", steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }] });
    const donorDefId = await insertDefinition({ companyId, name: "swap-donor", steps: [childStep(childDefId)] });
    const recipientDefId = await insertDefinition({ companyId, name: "swap-recipient", steps: [childStep(childDefId)] });
    const donor = await insertRunWithWorkflowStepRun({ companyId, workflowId: donorDefId });
    const recipient = await insertRunWithWorkflowStepRun({ companyId, workflowId: recipientDefId });
    const donorIdentity = await insertLinkedInvocation(db, { companyId, parentRunId: donor.runId, parentStepRunId: donor.stepRunId, childWorkflowId: childDefId });
    const snapshotOf = async () => JSON.stringify({
      donor: await runRow(donor.runId), donorChild: await runRow(donorIdentity.childRunId),
      donorStep: await stepRow(donor.stepRunId), donorInv: (await invocationOf(donor.stepRunId))[0] ?? null,
      recipient: await runRow(recipient.runId), recipientStep: await stepRow(recipient.stepRunId),
    });
    const before = await snapshotOf();
    // (1) 클레임 치환 — 수신자 run 에 공여자 parentStepRunId 를 건네면 fail-closed.
    const swapped = await claimChildInvocation(db, {
      companyId, run: (await runRow(recipient.runId))!, parentStepRunId: donor.stepRunId, stepId: "run-child",
      generation: 1, targetWorkflowId: childDefId, renderedInputs: {}, now: new Date(),
    });
    expect(swapped.outcome).toBe("ineligible");
    // (2) 임대 신원 치환 — 부모/스텝은 수신자, invocation/자식은 공여자.
    expect((await acquireWorkflowChildStartLease(db, {
      companyId, parentRunId: recipient.runId, parentStepRunId: recipient.stepRunId, stepId: "run-child",
      invocationId: donorIdentity.invocationId, generation: 1, childRunId: donorIdentity.childRunId,
    })).kind).toBe("ineligible");
    // (3) 논리 스텝 ID 치환 — stepId 만 어긋나도 거부.
    expect((await acquireWorkflowChildStartLease(db, { ...donorIdentity, stepId: "other-step" })).kind).toBe("ineligible");
    expect(await snapshotOf()).toBe(before);
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(1);
  });

  it("inactive and cross-company target definitions refuse claim; execution rows stay empty", async () => {
    const x = await childSuite("F5C Defn");
    // (1) 대상 정의 비활성 — 정의 잠금 하 클레임 거부(ineligible), 실행 행 무변경.
    const inactiveChild = await insertDefinition({ companyId: x.companyId, name: "inactive-child", steps: [] });
    await db.update(workflowDefinitions).set({ status: "archived" }).where(eq(workflowDefinitions.id, inactiveChild));
    await db.update(workflowDefinitions).set({ stepsJson: [childStep(inactiveChild)] }).where(eq(workflowDefinitions.id, x.parentDefId));
    const claim = await claimChildInvocation(db, {
      companyId: x.companyId, run: (await runRow(x.runId))!, parentStepRunId: x.stepRunId, stepId: "run-child",
      generation: 1, targetWorkflowId: inactiveChild, renderedInputs: {}, now: new Date(),
    });
    expect(claim.outcome).toBe("ineligible");
    expect((await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(x))).outcome).toBe("skipped");
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
    expect(await childrenOf(x.runId)).toHaveLength(0);
    expect((await stepRow(x.stepRunId))?.status).toBe("pending");
    // (2) 타회사 대상 — 사전검사(child_workflow_not_found)가 클레임 전 pre-admission 실패 정산.
    const otherCompanyId = await createCompanyFixture("F5C Other Co");
    const foreignDefId = await insertDefinition({ companyId: otherCompanyId, name: "foreign", steps: [] });
    await db.update(workflowDefinitions).set({ stepsJson: [childStep(foreignDefId)] }).where(eq(workflowDefinitions.id, x.parentDefId));
    expect((await dispatchWorkflowChildStepWithOutcome(db, await dispatchInputOf(x))).outcome).toBe("failed");
    expect(await toolResultOf(x.stepRunId)).toEqual(expect.objectContaining({ success: false, error: "child_workflow_not_found" }));
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
    expect(await childrenOf(x.runId)).toHaveLength(0);
  });
});
