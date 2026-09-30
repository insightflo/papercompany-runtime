import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, heartbeatRuns, issues, workflowRuns, workflowStepRuns, workflowRecoveryAuthorities, workflowTerminalDecisions, workflowTransitionEvents } from "@paperclipai/db";
import { missionOwnerDecisionSubmitSchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { missionService } from "../services/missions.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { reconcileDueWorkflowStepRetries } from "../services/workflow/retry-reconciler.js";

const { wakeup } = vi.hoisted(() => ({ wakeup: vi.fn().mockResolvedValue({ id: "test-wake" }) }));
vi.mock("../services/issue-assignment-wakeup.js", async (original) => {
  const actual = await original<typeof import("../services/issue-assignment-wakeup.js")>();
  return { ...actual, queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) =>
    actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup } }) };
});

describe("exact tool recovery selection (real DB, no prose authority)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("exact-tool-recovery-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => {
    setWorkflowToolStepExecutor(null);
    await temp?.cleanup();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  async function seed() {
    const s = await seedToolRecoveryScenario({ db, artifactExists: false });
    roots.push(s.tempRoot);
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.recoveryIssueId));
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId: s.companyId,
      agentId: issue.assigneeAgentId!, issueId: issue.id, status: "succeeded" });
    return { ...s, issue, heartbeatRunId };
  }
  const target = (s: Awaited<ReturnType<typeof seed>>) => ({ kind: "tool_step" as const,
    workflowRunId: s.workflowRunId, stepRunId: s.stepRunId,
    expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null });
  async function decide(s: Awaited<ReturnType<typeof seed>>, recoveryTarget: unknown) {
    await recordMissionOwnerDecision({ db,
      issue: { id: s.issue.id, companyId: s.companyId, missionId: s.issue.missionId },
      heartbeatRunId: s.heartbeatRunId, sourceIssueId: s.issue.originId,
      submission: missionOwnerDecisionSubmitSchema.parse({ decision: "retry_source_issue", recoveryTarget }),
    });
  }
  async function supervise(s: Awaited<ReturnType<typeof seed>>) {
    return missionService(db).runActiveMissionOwnerSupervision({ companyId: s.companyId,
      staleAfterMinutes: 1, now: new Date("2026-07-06T05:07:00Z"), applyOwnerDecisionActions: true });
  }

  it("does not infer a target from one failed step or the legacy description", async () => {
    const s = await seed();
    const executor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(executor);
    const before = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.workflowRunId));
    const result = await supervise(s);
    expect(executor).not.toHaveBeenCalled();
    expect(result.missions[0]?.recoveryOutcomes).toContainEqual(expect.objectContaining({ kind: "no_op", reason: "target_missing" }));
    expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.workflowRunId))).toEqual(before);
    const links = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, s.stepRunId));
    expect(links).toContainEqual(expect.objectContaining({ eventType: "owner_tool_recovery_target_v1", payload: expect.objectContaining({ schemaVersion: 1, kind: "tool_step" }) }));
  });

  it.each(["unknown", "wrong_run", "stale_generation", "terminal", "running", "no_failure_evidence", "exhausted", "consumed"])("returns no_op for %s without execution mutations", async (variant) => {
    const s = await seed();
    const t = target(s);
    if (variant === "unknown") t.stepRunId = randomUUID();
    if (variant === "wrong_run") t.workflowRunId = randomUUID();
    if (variant === "stale_generation") t.expectedExecutionGeneration = 9;
    if (variant === "terminal" || variant === "running") {
      await db.update(workflowRuns).set({ status: variant === "terminal" ? "completed" : "running" }).where(eq(workflowRuns.id, s.workflowRunId));
    }
    if (variant === "no_failure_evidence") {
      await db.update(workflowStepRuns).set({ startedAt: null, metadata: {} }).where(eq(workflowStepRuns.id, s.stepRunId));
    }
    if (variant === "exhausted") {
      await db.update(workflowStepRuns).set({ metadata: { workflowRetryExhaustion: {} } }).where(eq(workflowStepRuns.id, s.stepRunId));
    }
    if (variant === "consumed") {
      await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, eventType: "mission_owner_tool_step_retry",
        layer: "mission_owner_recovery", idempotencyKey: `mission-native-tool-step-retry:${s.issue.missionId}:${s.issue.id}:${s.workflowRunId}:collect-us-stockflow` });
    }
    await decide(s, t);
    const executor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(executor);
    const before = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.workflowRunId));
    const result = await supervise(s);
    expect(executor).not.toHaveBeenCalled();
    expect(result.missions[0]?.recoveryOutcomes).toContainEqual(expect.objectContaining({ kind: "no_op" }));
    expect(result.missions[0]?.appliedActions.some((a) => a.type === "owner_decision_retry_source_issue")).toBe(false);
    expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.workflowRunId))).toEqual(before);
  });

  it("postcommit interruption backfills one authority-bound outcome with the recovered native request", async () => {
    const s = await seed();
    await db.insert(workflowTerminalDecisions).values({ companyId: s.companyId, workflowRunId: s.workflowRunId,
      decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard", discoveryPath: "stuck_diagnostic", origin: "reconciler" });
    await decide(s, target(s));
    await db.$client.unsafe(`CREATE FUNCTION reject_recovery_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${s.stepRunId}'::uuid AND NEW.last_dispatch_request_id IS NOT NULL THEN RAISE EXCEPTION 'queue interruption'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER reject_recovery_queue BEFORE UPDATE ON workflow_step_runs FOR EACH ROW EXECUTE FUNCTION reject_recovery_queue()`);
    try { await supervise(s).catch(() => undefined); }
    finally { await db.$client.unsafe("DROP TRIGGER reject_recovery_queue ON workflow_step_runs; DROP FUNCTION reject_recovery_queue()"); }
    const [pending] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    expect(pending.status).toBe("pending");
    const [authority] = await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, s.workflowRunId));
    expect(authority.ownerDecisionEventId).toBeTruthy();
    await db.$client.unsafe(`CREATE FUNCTION reject_recovery_outcome() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workflow_step_run_id = '${s.stepRunId}'::uuid AND NEW.payload->>'schema' = 'recovery_outcome.v1' THEN RAISE EXCEPTION 'outcome interruption'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER reject_recovery_outcome BEFORE INSERT ON workflow_transition_events FOR EACH ROW EXECUTE FUNCTION reject_recovery_outcome()`);
    try {
      await reconcileDueWorkflowStepRetries(db);
      const [unchanged] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
      expect(unchanged).toEqual(pending);
    } finally { await db.$client.unsafe("DROP TRIGGER reject_recovery_outcome ON workflow_transition_events; DROP FUNCTION reject_recovery_outcome()"); }
    await Promise.all([reconcileDueWorkflowStepRetries(db), reconcileDueWorkflowStepRetries(db)]);
    const [delivered] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    expect(delivered.lastDispatchRequestId).toBeTruthy();
    const outcomes = (await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, s.stepRunId)))
      .filter((e) => e.payload?.schema === "recovery_outcome.v1");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].payload).toMatchObject({ authorityId: authority.id, dispatchRequestId: delivered.lastDispatchRequestId,
      target: target(s), outcome: "dispatched" });
    await reconcileDueWorkflowStepRetries(db);
    expect((await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, s.stepRunId)))
      .filter((e) => e.payload?.schema === "recovery_outcome.v1")).toEqual(outcomes);
  });

  it("preserves the selected identity in the ledger and selects only that step among three failures", async () => {
    const s = await seed();
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    for (let n = 0; n < 2; n++) {
      const runId = randomUUID();
      await db.insert(workflowRuns).values({ companyId: s.companyId, workflowId: run.workflowId,
        missionId: run.missionId, triggeredBy: "test", id: runId, status: "failed" });
      await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "collect-us-stockflow",
        status: "failed", startedAt: new Date(), metadata: { toolResult: { success: false } } });
    }
    await db.insert(workflowTerminalDecisions).values({ companyId: s.companyId, workflowRunId: s.workflowRunId,
      decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard", discoveryPath: "stuck_diagnostic", origin: "reconciler" });
    await decide(s, target(s));
    const [event] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, s.issue.id));
    expect(event.payload?.recoveryTarget).toEqual(target(s));
    const executor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(executor);
    const result = await supervise(s);
    const [retried] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    expect(retried.status).toBe("running");
    expect(retried.lastDispatchRequestId).toBeTruthy();
    expect(retried.metadata).toMatchObject({ toolQueue: { status: "queued" } });
    const outcomes = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, s.stepRunId));
    const [authority] = await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, s.workflowRunId));
    expect(outcomes.filter((e) => e.payload?.schema === "recovery_outcome.v1")).toHaveLength(1);
    expect(outcomes.find((e) => e.payload?.schema === "recovery_outcome.v1")?.payload).toMatchObject({
      authorityId: authority.id, decisionEventId: event.id, target: target(s),
      dispatchRequestId: retried.lastDispatchRequestId, outcome: "dispatched",
    });
    const otherRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, run.missionId!));
    expect(otherRuns.filter((r) => r.id !== s.workflowRunId).map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(result.missions[0]?.appliedActions).toContainEqual(expect.objectContaining({
      type: "native_tool_step_retry", workflowRunId: s.workflowRunId, stepRunId: s.stepRunId,
    }));
    // The native queue is durable; tool execution itself has not been asserted.
    expect(result.missions[0]?.recoveryOutcomes).toContainEqual(expect.objectContaining({
      kind: "retry_requested", outcome: "dispatched", dispatchRequestId: retried.lastDispatchRequestId,
    }));
  });
});
