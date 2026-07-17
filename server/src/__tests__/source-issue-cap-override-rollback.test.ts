// server/src/__tests__/source-issue-cap-override-rollback.test.ts
//
// [목적] casRestoreCapOverrideSnapshot 의 atomic rollback CAS 계약 검증. observed step/run/issue 필드
//   전체(status/iteration/dispatch/window/metadata/run startedAt+completedAt/issue status+completedAt) 가
//   null-safe lock 되어, metadata-only/completedAt/startedAt/issue race 가 발생하면 rollback 이 lose 하고
//   newer state 를 보존한다. rollback 성공 시 issue 도 포함해 전체 원복.
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issues, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { buildCapOverridePriorSnapshot, casRestoreCapOverrideSnapshot } from "../services/workflow/source-issue-cap-override-snapshot.js";
import { buildCapOverrideAuditPayload, drainHeartbeatRuns, FORWARD_APPLIED_AT, PRODUCER, reloadRun, reloadStepRun, seedCapExhaustedRun, startCapOverrideTestDb } from "./helpers/cap-override-fixtures.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip cap-override-rollback tests: ${support.reason ?? "unsupported host"}`);

describeEP("casRestoreCapOverrideSnapshot atomic rollback (observed fields null-safe CAS)", () => {
  let db!: Awaited<ReturnType<typeof startCapOverrideTestDb>>["db"];
  let testDb!: Awaited<ReturnType<typeof startCapOverrideTestDb>>;
  beforeAll(async () => { testDb = await startCapOverrideTestDb(); db = testDb.db; }, 60_000);
  // no afterEach row clearing — isolation is by randomUUID company scope (all queries company-scoped).
  afterAll(async () => { await drainHeartbeatRuns(db); await testDb.cleanup(); });

  // post-apply shape: step pending iter+1 (cleaned dispatch), run running/completedAt null, issue todo/completedAt null, audit present.
  async function seedPostApply(producerIssueStatus = "done") {
    const s = await seedCapExhaustedRun(db, { producerIssueStatus });
    const priorRun = await reloadRun(db, s.workflowRunId);
    const priorStep = await reloadStepRun(db, s.workflowRunId, PRODUCER);
    const [priorIssue] = await db.select().from(issues).where(eq(issues.id, s.producerIssueId));
    const fromIter = priorStep.iterationIndex ?? 1;
    await db.update(workflowStepRuns).set({ status: "pending", iterationIndex: fromIter + 1, startedAt: null, completedAt: null, lastDispatchAttemptAt: null, lastDispatchAcceptedAt: null, lastDispatchErrorAt: null, lastDispatchErrorSummary: null, lastDispatchRequestId: null, metadata: {} }).where(eq(workflowStepRuns.id, s.producerStepRunId));
    await db.update(workflowRuns).set({ status: "running", completedAt: null }).where(eq(workflowRuns.id, s.workflowRunId));
    await db.update(issues).set({ status: "todo", completedAt: null, updatedAt: FORWARD_APPLIED_AT }).where(eq(issues.id, s.producerIssueId));
    const auditKey = `cap-override:test-${s.producerStepRunId}`;
    await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, workflowRunId: s.workflowRunId, workflowStepRunId: s.producerStepRunId, issueId: s.producerIssueId, eventType: "owner_cap_override_retry", layer: "workflow_validation", idempotencyKey: auditKey, payload: { ...buildCapOverrideAuditPayload(s), status: "pending" } });
    return {
      s,
      priorIssue,
      snapshot: buildCapOverridePriorSnapshot({ run: priorRun, stepRun: priorStep, issue: priorIssue }),
      forwardIssueUpdatedAt: FORWARD_APPLIED_AT,
      fromIter,
      auditKey,
      cleanedMeta: {} as Record<string, unknown>,
    };
  }
  const restore = (ctx: Awaited<ReturnType<typeof seedPostApply>>) => casRestoreCapOverrideSnapshot(db, {
    companyId: ctx.s.companyId,
    snapshot: ctx.snapshot,
    cleanedMetadata: ctx.cleanedMeta,
    toIteration: ctx.fromIter + 1,
    forwardedIssueUpdatedAt: ctx.forwardIssueUpdatedAt.toISOString(),
    auditIdempotencyKey: ctx.auditKey,
    auditPayload: buildCapOverrideAuditPayload(ctx.s),
  });

  it("SUCCESS rollback restores step/run/issue/audit to the observed prior snapshot", async () => {
    const ctx = await seedPostApply("done");
    const ok = await restore(ctx);
    expect(ok).toBe("restored");
    expect((await reloadRun(db, ctx.s.workflowRunId)).status).toBe("failed");
    const producer = await reloadStepRun(db, ctx.s.workflowRunId, PRODUCER);
    expect(producer.status).toBe("completed");
    expect(producer.iterationIndex).toBe(ctx.fromIter);
    const [issue] = await db.select().from(issues).where(eq(issues.id, ctx.s.producerIssueId));
    expect(issue.status).toBe("done");                       // reopened todo → restored to original done
    expect(issue.completedAt).toEqual(ctx.priorIssue.completedAt);
    const ev = (await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.idempotencyKey, ctx.auditKey)))[0]!;
    expect((ev.payload as Record<string, unknown>).status).toBe("rolled_back");   // audit pending→rolled_back (no delete)
  });

  it("METADATA RACE: producer metadata changed concurrently → rollback loses, newer metadata preserved", async () => {
    const ctx = await seedPostApply();
    await db.update(workflowStepRuns).set({ metadata: { race: true } }).where(eq(workflowStepRuns.id, ctx.s.producerStepRunId));
    const ok = await restore(ctx);
    expect(ok).toBe("lost");
    expect((await reloadStepRun(db, ctx.s.workflowRunId, PRODUCER)).metadata).toEqual({ race: true });
    expect((await reloadRun(db, ctx.s.workflowRunId)).status).toBe("running");   // newer run state preserved
  });

  it("RUN completedAt RACE: run completed concurrently → rollback loses, completed run preserved", async () => {
    const ctx = await seedPostApply();
    await db.update(workflowRuns).set({ completedAt: new Date("2026-07-11T00:00:00.000Z") }).where(eq(workflowRuns.id, ctx.s.workflowRunId));
    const ok = await restore(ctx);
    expect(ok).toBe("lost");
    expect((await reloadRun(db, ctx.s.workflowRunId)).completedAt).toEqual(new Date("2026-07-11T00:00:00.000Z"));
  });

  it("RUN startedAt RACE (all-or-nothing): run advanced to a newer running attempt → rollback loses entirely", async () => {
    const ctx = await seedPostApply();
    const newerStartedAt = new Date("2026-07-10T00:10:00.000Z");
    await db.update(workflowRuns).set({ startedAt: newerStartedAt }).where(eq(workflowRuns.id, ctx.s.workflowRunId));
    const ok = await restore(ctx);
    expect(ok).toBe("lost");
    expect(await reloadRun(db, ctx.s.workflowRunId)).toEqual(expect.objectContaining({ status: "running", startedAt: newerStartedAt }));
    expect(await reloadStepRun(db, ctx.s.workflowRunId, PRODUCER)).toEqual(expect.objectContaining({ status: "pending", iterationIndex: ctx.fromIter + 1 }));
    expect(await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, ctx.s.companyId), eq(workflowTransitionEvents.eventType, "owner_cap_override_retry")))).toHaveLength(1); // audit preserved
  });
});
