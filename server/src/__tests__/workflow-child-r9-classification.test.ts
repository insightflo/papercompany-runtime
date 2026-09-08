// @vitest-environment node
// [workflow-child r9 §2] settlement eligibility precedes malformed-terminal classification.
// lockLinkedSettlementIdentity must validate FULL eligibility (BASE_ID + CURRENT + S.pending +
// P running|cancelled + retained target) under P→I→S→C locks BEFORE either terminal writer
// classifies receipt/lease faults. Stale/ineligible callers get exact structured no-op with
// zero workflow_child.completion_refused_invalid_state activity; eligible malformed terminals
// still classify with the fixed reason precedence. Concurrency orderings (real lock-wait
// observation) live in workflow-child-r9-classification-races.test.ts.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, workflowDefinitions, workflowRuns, workflowStepInvocations, workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  childStep, configureWorkflowChildFixtures, createCompanyFixture, insertDefinition, insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";
import { insertChildStartLease, insertLinkedInvocation, insertMaterializedChildRun } from "./helpers/workflow-child-invocation-fixtures.js";
import { reconcileWorkflowChildStepWaits } from "../services/workflow/workflow-child-execution.js";
import { runWorkflowChildCompletionHook } from "../services/workflow/workflow-child-completion.js";
import {
  failLinkedChildStep, settleLinkedChildStepFromTerminal, type FailChildStepOutcome,
} from "../services/workflow/workflow-child-settlement-writers.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Fixture = {
  companyId: string; parentRunId: string; parentStepRunId: string; stepId: string; invocationId: string;
  childRunId: string; generation: 1; childDefId: string; parentDefId: string; runId: string; stepRunId: string;
};
type Writer = (x: Fixture) => Promise<FailChildStepOutcome>;

const settle: Writer = (x) => settleLinkedChildStepFromTerminal(db, x);
const fail: Writer = (x) => failLinkedChildStep(db, x, { errorCode: "r9_probe", detail: "r9 classification probe" });
const hook = (x: Fixture, status: string) =>
  runWorkflowChildCompletionHook(db, { id: x.childRunId, companyId: x.companyId, status });
const invalid = (reason: string) => ({ outcome: "invalid-state", code: "workflow_child_invalid_state", version: 1, reason });

/** 기본 픽스처는 자격 있는 malformed(completed-no-receipt C, S pending, P running)이다. */
async function fixture(
  name: string,
  o: { childStatus?: string; receipt?: boolean; childSteps?: boolean; parentStatus?: string; stepIds?: string[] } = {},
): Promise<Fixture> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({ companyId, name: `${name}-child`, steps: [] });
  const parentDefId = await insertDefinition({ companyId, name: `${name}-parent`, steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  const link = { companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: childDefId, childStatus: o.childStatus };
  const identity = o.receipt
    ? await insertMaterializedChildRun(db, { ...link, stepIds: o.stepIds ?? ["child-a"] })
    : await insertLinkedInvocation(db, link);
  if (!o.receipt && o.childSteps) {
    await db.insert(workflowStepRuns).values({
      id: randomUUID(), workflowRunId: identity.childRunId, stepId: "child-a", status: "pending", retryCount: 0,
    });
  }
  if (o.parentStatus && o.parentStatus !== "running") {
    await db.update(workflowRuns).set({ status: o.parentStatus }).where(eq(workflowRuns.id, runId));
  }
  return { ...identity, companyId, runId, stepRunId, childDefId, parentDefId };
}

const finishChild = (childRunId: string, status: string) =>
  db.update(workflowRuns).set({ status, completedAt: new Date() }).where(eq(workflowRuns.id, childRunId));
const addLease = (x: Fixture) => insertChildStartLease(db, { childRunId: x.childRunId, mode: "expired-deadline" });
const stepRow = async (x: Fixture) =>
  (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, x.stepRunId)))[0]!;

/** 전체 P/S/I/C 실행 행 JSON 스냅숏 — no-op/refusal 무변경 판정 기준. */
async function fullSnapshot(): Promise<string> {
  return JSON.stringify(await Promise.all([
    db.select().from(workflowRuns), db.select().from(workflowStepRuns), db.select().from(workflowStepInvocations),
  ]));
}

const refusalCount = async (companyId: string): Promise<number> => {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(activityLog)
    .where(and(eq(activityLog.action, "workflow_child.completion_refused_invalid_state"), eq(activityLog.companyId, companyId)));
  return row?.n ?? 0;
};

describeEmbeddedPostgres("workflow child r9 — eligibility precedes malformed-terminal classification", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-r9-classification-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    for (const table of [workflowStepInvocations, workflowStepRuns, workflowRuns, workflowDefinitions, activityLog, agents, companies]) {
      await db.delete(table);
    }
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  // 설계 §2 포트 — 4 stale BUG 사례(× 두 writer = 8 safe opposites) + retry-key 확장.
  // 베이스가 자격 있는 malformed이므로 분류가 자격보다 먼저면 여기서 invalid-state로 깨진다.
  const staleModes: Array<[string, (x: Fixture) => Promise<unknown>]> = [
    ["S settled (failed)", async (x) => { await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, x.stepRunId)); }],
    ["S.retryCount=1", async (x) => { await db.update(workflowStepRuns).set({ retryCount: 1 }).where(eq(workflowStepRuns.id, x.stepRunId)); }],
    ["P failed", async (x) => { await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, x.runId)); }],
    ["C retained-target drifted to legal same-company definition", async (x) => {
      const alt = await insertDefinition({ companyId: x.companyId, name: "alt-def", steps: [] });
      await db.update(workflowRuns).set({ workflowId: alt }).where(eq(workflowRuns.id, x.childRunId));
    }],
    ["S.metadata workflowRetry:null", async (x) => { await db.update(workflowStepRuns).set({ metadata: { workflowRetry: null } }).where(eq(workflowStepRuns.id, x.stepRunId)); }],
    ["S.metadata workflowRetry:garbage", async (x) => { await db.update(workflowStepRuns).set({ metadata: { workflowRetry: "garbage" } }).where(eq(workflowStepRuns.id, x.stepRunId)); }],
  ];
  for (const [label, mutate] of staleModes) {
    it(`safe opposite ${label}: both writers exact no-op, P/I/S/C byte-unchanged, zero refusal activity`, async () => {
      const x = await fixture("R9 safe", { childStatus: "completed" });
      await mutate(x);
      const before = await fullSnapshot();
      expect(await settle(x), `${label} settle`).toEqual({ outcome: "no-op" });
      expect(await fullSnapshot(), label).toBe(before);
      expect(await fail(x), `${label} fail`).toEqual({ outcome: "no-op" });
      expect(await fullSnapshot(), label).toBe(before);
      expect(await refusalCount(x.companyId), label).toBe(0);
    });
  }

  it("ineligible controls: S completed/skipped, P completed, nonterminal C, swapped identity axes, generation≠1 → exact no-op both writers", async () => {
    const donor = await fixture("R9 ctl-donor", { childStatus: "completed" });
    const cases: Array<[string, () => Promise<Fixture>]> = [
      ["S completed", async () => {
        const x = await fixture("R9 ctl-sc", { childStatus: "completed" });
        await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, x.stepRunId));
        return x;
      }],
      ["S skipped", async () => {
        const x = await fixture("R9 ctl-ss", { childStatus: "completed" });
        await db.update(workflowStepRuns).set({ status: "skipped" }).where(eq(workflowStepRuns.id, x.stepRunId));
        return x;
      }],
      ["P completed", async () => fixture("R9 ctl-pc", { childStatus: "completed", parentStatus: "completed" })],
      ["C pending (nonterminal)", async () => fixture("R9 ctl-cp", { childStatus: "pending" })],
      ["C running (nonterminal)", async () => fixture("R9 ctl-cr", { childStatus: "running" })],
      ["swapped invocation+child to coherent same-company donor", async () => {
        const x = await fixture("R9 ctl-swap", { childStatus: "completed" });
        return { ...x, invocationId: donor.invocationId, childRunId: donor.childRunId };
      }],
    ];
    for (const [label, make] of cases) {
      const target = await make();
      const before = await fullSnapshot();
      expect(await settle(target), `${label} settle`).toEqual({ outcome: "no-op" });
      expect(await fail(target), `${label} fail`).toEqual({ outcome: "no-op" });
      expect(await fullSnapshot(), label).toBe(before);
      expect(await refusalCount(target.companyId), label).toBe(0);
    }
    const gx = await fixture("R9 ctl-gen", { childStatus: "completed" });
    const forged = { ...gx, generation: 2 } as unknown as Fixture;
    expect(await settle(forged)).toEqual({ outcome: "no-op" });
    expect(await fail(forged)).toEqual({ outcome: "no-op" });
    expect(await refusalCount(gx.companyId)).toBe(0);
    expect(await refusalCount(donor.companyId)).toBe(0);
  });

  it("eligible malformed still classifies: completed-no-receipt → invalid-state + exactly one activity per call, zero mutation (both writers)", async () => {
    for (const writer of [settle, fail]) {
      const x = await fixture("R9 malformed", { childStatus: "completed" });
      const before = await fullSnapshot();
      expect(await writer(x), writer.name).toEqual(invalid("completed_without_materialization_receipt"));
      const refusals = await db.select().from(activityLog).where(and(
        eq(activityLog.action, "workflow_child.completion_refused_invalid_state"), eq(activityLog.entityId, x.childRunId),
      ));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({ companyId: x.companyId, entityType: "workflow_run", entityId: x.childRunId });
      expect(refusals[0]!.details).toMatchObject({
        version: 1, code: "workflow_child_invalid_state", reason: "completed_without_materialization_receipt",
      });
      expect(await fullSnapshot(), writer.name).toBe(before);
    }
  });

  it("reason precedence holds for both writers: completed reason first, lease beats child-steps", async () => {
    const cases: Array<[string, string, () => Promise<Fixture>]> = [
      ["completed no-receipt + child step rows keeps completed reason", "completed_without_materialization_receipt",
        async () => fixture("R9 pr-crows", { childStatus: "completed", childSteps: true })],
      ["failed + rows + no receipt + no lease → child-steps reason", "child_steps_without_materialization_receipt",
        async () => fixture("R9 pr-frows", { childStatus: "failed", childSteps: true })],
      ["failed + rows + no receipt + lease pair → lease reason beats child-steps", "terminal_child_has_start_lease",
        async () => {
          const x = await fixture("R9 pr-flease", { childStatus: "failed", childSteps: true });
          await addLease(x);
          await finishChild(x.childRunId, "failed");
          return x;
        }],
      ["completed + receipt + zero rows + lease pair → lease reason", "terminal_child_has_start_lease",
        async () => {
          const x = await fixture("R9 pr-clease", { childStatus: "completed", receipt: true, stepIds: [] });
          await addLease(x);
          await finishChild(x.childRunId, "completed");
          return x;
        }],
      ["completed + no receipt + lease pair → completed reason still first", "completed_without_materialization_receipt",
        async () => {
          const x = await fixture("R9 pr-cnrlease", { childStatus: "completed" });
          await addLease(x);
          await finishChild(x.childRunId, "completed");
          return x;
        }],
    ];
    for (const [label, reason, make] of cases) {
      for (const writer of [settle, fail]) {
        const x = await make();
        const before = await fullSnapshot();
        expect(await writer(x), `${label} (${writer.name})`).toEqual(invalid(reason));
        expect(await refusalCount(x.companyId), label).toBe(1);
        expect(await fullSnapshot(), label).toBe(before);
      }
    }
  });

  it("cancelled parent stays eligible: malformed completed child is still invalid-state for both writers (positive eligibility control)", async () => {
    for (const writer of [settle, fail]) {
      const x = await fixture("R9 cancelP", { childStatus: "completed", parentStatus: "cancelled" });
      expect(await writer(x), writer.name).toEqual(invalid("completed_without_materialization_receipt"));
      expect(await refusalCount(x.companyId)).toBe(1);
    }
  });

  it("receipted completed zero-steps settles once then repeats as no-op with no refusal activity (hook path)", async () => {
    const x = await fixture("R9 ok-empty", { childStatus: "completed", receipt: true, stepIds: [] });
    expect(await hook(x, "completed")).toBe(true);
    expect((await stepRow(x)).status).toBe("completed");
    expect(await hook(x, "completed")).toBe(false);
    expect(await settle(x)).toEqual({ outcome: "no-op" });
    expect(await refusalCount(x.companyId)).toBe(0);
  });

  it("failed-initialization no-receipt zero-steps settles as a real failure via the terminal-derived writer", async () => {
    const x = await fixture("R9 failed-init", { childStatus: "failed" });
    expect(await settle(x)).toEqual({ outcome: "settled" });
    const step = await stepRow(x);
    expect(step.status).toBe("failed");
    expect((step.metadata as Record<string, { toolResult: { success: boolean; error: string } }>).toolResult)
      .toMatchObject({ success: false, error: "child_run_failed" });
    expect(await refusalCount(x.companyId)).toBe(0);
  });

  it("inherited controls: hook false on eligible malformed (one refusal), reconciler skips without recovery, rows unchanged", async () => {
    const x = await fixture("R9 inherited", { childStatus: "completed" });
    expect(await hook(x, "completed")).toBe(false);
    expect(await refusalCount(x.companyId)).toBe(1);
    await db.update(workflowStepRuns).set({
      metadata: { workflowChild: { childRunId: x.childRunId, invocationId: x.invocationId, generation: 1 } },
    }).where(eq(workflowStepRuns.id, x.stepRunId));
    const before = await fullSnapshot();
    const results = await reconcileWorkflowChildStepWaits(db, { limit: 10 });
    const mine = results.filter((r) => r.stepRunId === x.stepRunId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.action).toBe("skipped");
    expect(results.every((r) => r.action !== "recovered")).toBe(true);
    expect(await fullSnapshot()).toBe(before);
    expect((await stepRow(x)).status).toBe("pending");
    // reconciler 의 skip 은 같은 writer 를 거치므로 invalid-state 감사 1건이 추가된다(호출당 1건, dedupe 기계 없음).
    expect(await refusalCount(x.companyId)).toBe(2);
  });
});
