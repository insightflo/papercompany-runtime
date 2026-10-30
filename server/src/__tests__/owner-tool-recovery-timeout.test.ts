import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, createDb, heartbeatRuns, workflowRecoveryAuthorities, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createOwnerToolSourceLifecycleFixture, successfulAdapterResult } from "./helpers/owner-tool-source-lifecycle-fixture.js";
import { completeWorkflowToolStepFromResult } from "../services/workflow/dag-engine.js";
import { captureExecutionDefinition } from "../services/workflow/execution-definition.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { applyOwnerToolRecovery } from "../services/missions/owner-tool-recovery.js";

const { adapterExecute, assignmentPromises } = vi.hoisted(() => ({
  adapterExecute: vi.fn(),
  assignmentPromises: [] as Promise<unknown>[],
}));
vi.mock("../adapters/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../adapters/index.js")>();
  return { ...actual, getServerAdapter: (...args: Parameters<typeof actual.getServerAdapter>) => ({
    ...actual.getServerAdapter(...args), execute: adapterExecute,
  }) };
});
vi.mock("../services/issue-assignment-wakeup.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return { ...actual, queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) => {
    const pending = actual.queueIssueAssignmentWakeup(input);
    if (pending) assignmentPromises.push(pending);
    return pending;
  } };
});

// heartbeat.ts 의 stale execution 종단 경로는 heartbeat/wakeup 모두 timed_out 을 쓰고
// settleHeartbeatAfterExecution 로 settledAt 을 남긴다. 이 파일은 그 종단 관찰 조합이
// owner-tool 회복 판정에서 어떻게 다뤄야 하는지(좁은 인정 조건 + 유지 조건)를 검증한다.
describe("owner tool recovery terminal timed_out source observation (real DB)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => {
    adapterExecute.mockResolvedValue(successfulAdapterResult());
    temp = await startEmbeddedPostgresTestDatabase("owner-tool-recovery-timeout-");
    db = createDb(temp.connectionString);
  }, 60_000);
  const fixture = createOwnerToolSourceLifecycleFixture({ getDb: () => db, roots, assignmentPromises,
    completeToolStep: completeWorkflowToolStepFromResult, captureDefinition: captureExecutionDefinition,
    assertCompletion: result => expect(result).not.toBeNull() });
  const { seedRecovered, context } = fixture;
  type Scenario = Awaited<ReturnType<typeof seedRecovered>>;
  async function apply(s: Scenario) {
    const { c, issue, sourceIssue } = await context(s);
    return applyOwnerToolRecovery({ db, mission: c.mission, issue, sourceIssue, stepRows: c.stepRows, apply: true });
  }
  /** stale-timeout 종단 상태의 dispatch 튜플(heartbeat+wakeup)을 step 에 정확히 연결한다. */
  async function seedTimedOutDispatch(s: Scenario, options: { settledAt?: Date | null; heartbeatGenerationOffset?: number } = {}) {
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    const heartbeatId = randomUUID(), wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: s.companyId, agentId: s.ownerAgentId,
      source: "workflow", status: "timed_out", workflowRunId: s.workflowRunId,
      workflowStepRunId: s.stepRunId, workflowExecutionGeneration: step.executionGeneration });
    await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId: s.companyId, agentId: s.ownerAgentId,
      workflowStepRunId: s.stepRunId,
      workflowExecutionGeneration: step.executionGeneration + (options.heartbeatGenerationOffset ?? 0),
      wakeupRequestId: wakeId, status: "timed_out",
      settledAt: options.settledAt === undefined ? new Date() : options.settledAt });
    await db.update(workflowStepRuns).set({ dispatchOwnerHeartbeatRunId: heartbeatId, dispatchOwnerWakeupRequestId: wakeId })
      .where(eq(workflowStepRuns.id, s.stepRunId));
    return { heartbeatId, wakeId };
  }
  afterEach(async () => {
    await Promise.all(assignmentPromises.splice(0));
    await waitForHeartbeatExecutionsToDrain(db);
    adapterExecute.mockReset().mockResolvedValue(successfulAdapterResult());
  });
  afterAll(async () => {
    await Promise.all(assignmentPromises.splice(0));
    if (db) await waitForHeartbeatExecutionsToDrain(db);
    await temp?.cleanup();
    roots.forEach(root => rmSync(root, { recursive: true, force: true }));
  });

  it("accepts a positively settled timed_out dispatch tuple and recognizes the already recovered native source without new execution or authority", async () => {
    const s = await seedRecovered("done");
    const [before] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    await seedTimedOutDispatch(s);
    const heartbeatsBefore = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.companyId))).length;
    const result = await apply(s);
    expect(result?.outcome).toMatchObject({ kind: "no_op", outcome: "blocked", reason: "source_already_recovered", target: null });
    expect(result?.appliedAction).toBeUndefined();
    const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    expect(after).toMatchObject({ status: "completed", executionGeneration: before.executionGeneration,
      lastDispatchRequestId: before.lastDispatchRequestId });
    const heartbeatsAfter = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.companyId))).length;
    expect(heartbeatsAfter).toBe(heartbeatsBefore);
    const authorities = await db.select().from(workflowRecoveryAuthorities)
      .where(eq(workflowRecoveryAuthorities.workflowRunId, s.workflowRunId));
    expect(authorities).toHaveLength(0);
  });

  it("holds the source when the timed_out heartbeat is not positively settled yet", async () => {
    const s = await seedRecovered("done");
    await seedTimedOutDispatch(s, { settledAt: null });
    const result = await apply(s);
    expect(result?.outcome).toMatchObject({ kind: "no_op", outcome: "blocked", reason: "source_dispatch_still_live" });
    expect(result?.appliedAction).toBeUndefined();
  });

  it("holds the source when the settled timed_out heartbeat does not match the exact dispatch tuple", async () => {
    const s = await seedRecovered("done");
    await seedTimedOutDispatch(s, { heartbeatGenerationOffset: 1 });
    const result = await apply(s);
    expect(result?.outcome).toMatchObject({ kind: "no_op", outcome: "blocked", reason: "source_dispatch_reference_mismatch" });
    expect(result?.appliedAction).toBeUndefined();
  });

  it("holds the source when success evidence is missing even with a settled timed_out dispatch tuple", async () => {
    const s = await seedRecovered("done");
    await seedTimedOutDispatch(s);
    await db.update(workflowStepRuns).set({ metadata: {} }).where(eq(workflowStepRuns.id, s.stepRunId));
    const result = await apply(s);
    expect(result?.outcome).toMatchObject({ kind: "no_op", outcome: "blocked" });
    expect(result?.outcome.reason).toBe("source_success_evidence_missing");
    expect(result?.appliedAction).toBeUndefined();
  });

  it("holds a wake-only terminal timed_out request that has no positively settled linked heartbeat", async () => {
    const s = await seedRecovered("done");
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: s.companyId, agentId: s.ownerAgentId,
      source: "workflow", status: "timed_out", workflowRunId: s.workflowRunId,
      workflowStepRunId: s.stepRunId, workflowExecutionGeneration: step.executionGeneration });
    await db.update(workflowStepRuns).set({ dispatchOwnerWakeupRequestId: wakeId })
      .where(eq(workflowStepRuns.id, s.stepRunId));
    const result = await apply(s);
    expect(result?.outcome).toMatchObject({ kind: "no_op", outcome: "blocked", reason: "source_dispatch_reference_mismatch" });
    expect(result?.appliedAction).toBeUndefined();
  });
});
