import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { rmSync } from "node:fs";
import { createDb, agents, companies, missions, issues, heartbeatRuns, agentWakeupRequests, workflowDefinitions, workflowStepRuns, workflowRuns, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";
import { seedCapExhaustedRun, capOwnerAction } from "./helpers/cap-override-fixtures.js";
import { applyOwnerCapOverrideRetry } from "../services/workflow/source-issue-cap-override.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { claimPlainWorkflowStart } from "../services/workflow/plain-start-claim.js";
import { proposeReplacement, approveReplacement } from "../services/workflow/replacement-approval.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { heartbeatService } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";

const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({ getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }), runningProcesses: new Map() }));
let db: Db;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const roots: string[] = [];
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("heartbeat-recovery-"); db = createDb(temp.connectionString); }, 60_000);
afterAll(async () => { await waitForHeartbeatExecutionsToDrain(db); await db.$client.end(); await temp.cleanup(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });
beforeEach(() => adapter.mockReset().mockResolvedValue({ exitCode: 1, signal: null, timedOut: false, errorMessage: "test stop", usage: null, provider: "test", model: "test", resultJson: null, runtimeServices: [] }));

async function source() {
  const s = await seedReplacement(db); roots.push(s.tempRoot);
  const [issue] = await db.insert(issues).values({ companyId: s.companyId, missionId: s.mission.id, assigneeAgentId: s.actor.agentId,
    originKind: "workflow_execution", originRunId: s.run.id, title: "Source execution", status: "todo" }).returning();
  await db.update(workflowStepRuns).set({ issueId: issue.id }).where(eq(workflowStepRuns.id, s.downstreamStepRunId));
  return { ...s, issue };
}
async function stop(s: Awaited<ReturnType<typeof seedReplacement>>, serviceDb = db) {
  await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.actor.agentId));
  await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.mission.id));
  await waitForHeartbeatExecutionsToDrain(serviceDb);
}
async function replacementQueue() {
  const s = await source();
  await db.update(workflowDefinitions).set({ stepsJson: [{ id: "agent-root", name: "Agent root", type: "agent", agentId: s.actor.agentId, dependencies: [] }] }).where(eq(workflowDefinitions.id, s.run.workflowId));
  const proposal = await proposeReplacement(db, s.companyId, s.board, { sourceRunId: s.run.id, decisionEventId: s.input.replacementIntent.decisionEventId,
    idempotencyKey: "heartbeat-budget", metadata: {}, externalEffects: "operator_reconciled" });
  await approveReplacement(db, s.companyId, proposal.id, s.board);
  const target = (await admitReplacement(db, { ...s.input, replacementIntent: { ...s.input.replacementIntent, approvalId: proposal.id, idempotencyKey: "heartbeat-budget" } }, s.actor)).run;
  await claimPlainWorkflowStart(db, target.id, { activateMission: async () => {} } as never);
  await syncWorkflowRunState(db, target.id);
  const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, target.id));
  expect(request.status).toBe("queued");
  return { ...s, target, request };
}

it.each(["typed", "issue-only"])("refuses %s old-source wake after replacement starts", async (scope) => {
  const s = await source();
  const target = (await admitReplacement(db, s.input, s.actor)).run;
  expect(await claimPlainWorkflowStart(db, target.id, { activateMission: async () => {} } as never)).toBe("started");
  try {
    const context = { issueId: s.issue.id, ...(scope === "typed" ? { workflowRunId: s.run.id, workflowStepRunId: s.downstreamStepRunId } : {}) };
    const result = await heartbeatService(db).wakeup(s.actor.agentId, { source: "assignment", reason: "workflow_step_runnable", payload: context, contextSnapshot: context }).catch((error: Error) => error);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(adapter).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("workflow_run_replaced");
    expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.run.id)))[0].status).toBe("failed");
  } finally { await stop(s); }
});

it.each(["company", "agent"])("blocks replacement queue at %s monthly hard stop without a pause flag", async (scope) => {
  const s = await replacementQueue();
  try {
    if (scope === "company") await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, s.companyId));
    else await db.update(agents).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(agents.id, s.actor.agentId));
    await heartbeatService(db).resumeQueuedRuns(s.actor.agentId);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(adapter).not.toHaveBeenCalled();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, s.request.id)))[0].status).toBe("failed");
  } finally { await stop(s); }
});

it.each(["company", "agent", "mission", "heartbeat", "source"])("rechecks %s changed after claim at the actual adapter boundary", async (scope) => {
  const s = await replacementQueue();
  // Real PG trigger changes the authority after claim, during effect-intent recording,
  // immediately before the guarded adapter callback. No service/DB method is mocked.
  const change = scope === "company" ? `update companies set budget_monthly_cents=1, spent_monthly_cents=1 where id='${s.companyId}'`
    : scope === "agent" ? `update agents set budget_monthly_cents=1, spent_monthly_cents=1 where id='${s.actor.agentId}'`
    : scope === "mission" ? `update missions set status='cancelled' where id='${s.mission.id}'`
    : scope === "source" ? `update heartbeat_runs set issue_id='${s.issue.id}', context_snapshot=jsonb_build_object('issueId','${s.issue.id}','workflowRunId','${s.run.id}') where id=NEW.attempt_run_id::uuid`
    : `update heartbeat_runs set status='cancelled' where id=NEW.attempt_run_id::uuid`;
  await db.execute(sql.raw(`create function test_recovery_boundary_change() returns trigger language plpgsql as $$ begin
    if NEW.company_id='${s.companyId}' then ${change}; end if; return NEW; end $$;
    create trigger test_recovery_boundary before insert on effect_intents for each row execute function test_recovery_boundary_change();`));
  try {
    await heartbeatService(db).resumeQueuedRuns(s.actor.agentId);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(adapter).not.toHaveBeenCalled();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, s.request.id));
    expect(run.startedAt).not.toBeNull();
    expect(["failed", "cancelled"]).toContain(run.status);
    if (scope !== "heartbeat") expect(run.errorCode).toBe("heartbeat_recovery_blocked");
    else expect(run.status).toBe("cancelled");
  } finally {
    await db.execute(sql.raw("drop trigger test_recovery_boundary on effect_intents; drop function test_recovery_boundary_change();"));
    await stop(s);
  }
});

it.each(["heartbeat", "wake"])("rejects a stale issued %s for a permanently replaced source", async (kind) => {
  const s = await source();
  await admitReplacement(db, s.input, s.actor);
  const context = { issueId: s.issue.id, workflowRunId: s.run.id, workflowStepRunId: s.downstreamStepRunId, missionId: s.mission.id };
  const [wake] = await db.insert(agentWakeupRequests).values({ companyId: s.companyId, agentId: s.actor.agentId, source: "automation", status: "queued",
    issueId: s.issue.id, workflowRunId: s.run.id, payload: { ...context, _paperclipWakeContext: context } }).returning();
  if (kind === "heartbeat") {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId: s.actor.agentId, issueId: s.issue.id,
      invocationSource: "automation", status: "queued", wakeupRequestId: wake.id, contextSnapshot: context }).returning();
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
  }
  try {
    await heartbeatService(db).resumeQueuedRuns(s.actor.agentId);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(adapter).not.toHaveBeenCalled();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).not.toBe("queued");
    expect((await db.select().from(issues).where(eq(issues.id, s.issue.id)))[0].status).toBe("todo");
  } finally { await stop(s); }
});

it("serializes a late old-source wake behind replacement's mission/run transaction", async () => {
  const s = await source();
  let wake!: Promise<unknown>;
  await db.transaction(async (tx) => {
    await tx.select().from(missions).where(eq(missions.id, s.mission.id)).for("update");
    wake = heartbeatService(db).wakeup(s.actor.agentId, { source: "assignment", payload: { issueId: s.issue.id }, contextSnapshot: { issueId: s.issue.id } }).catch((e: Error) => e);
    // Wait until a real backend is blocked by our transaction, not an arbitrary delay.
    await vi.waitFor(async () => {
      const rows = await db.execute(sql`select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%missions%'`);
      expect(rows.length).toBeGreaterThan(0);
    });
    await admitReplacement(tx as unknown as Db, s.input, s.actor);
  });
  try {
    expect(await wake).toMatchObject({ message: "workflow_run_replaced" });
    expect(adapter).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, s.issue.id))).toHaveLength(0);
  } finally { await stop(s); }
});

it("replacement loses to a live source heartbeat admitted under the shared lock", async () => {
  const s = await source();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  adapter.mockImplementationOnce(async () => { entered(); await gate; return { exitCode: 1, signal: null, timedOut: false, errorMessage: "test stop", runtimeServices: [] }; });
  try {
    await heartbeatService(db).wakeup(s.actor.agentId, { source: "assignment", payload: { issueId: s.issue.id }, contextSnapshot: { issueId: s.issue.id } });
    await ready;
    await expect(admitReplacement(db, s.input, s.actor)).rejects.toThrow("replacement_execution_in_flight");
    expect(adapter).toHaveBeenCalledTimes(1);
  } finally {
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.actor.agentId));
    release();
    await stop(s);
  }
});

it.each(["company", "agent"])("also blocks the committed cap recovery queue at %s hard stop", async (scope) => {
  const s = await seedCapExhaustedRun(db);
  const result = await applyOwnerCapOverrideRetry(db, { companyId: s.companyId, issueId: s.producerIssueId, ownerAction: capOwnerAction(s) });
  expect(result.kind).toBe("cap_override_applied");
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `cap-override-wake:${s.ownerDecisionEventId}`));
  expect(wake.status).toBe("queued");
  try {
    if (scope === "company") await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, s.companyId));
    else await db.update(agents).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(agents.id, s.producerAgentId));
    await heartbeatService(db).resumeQueuedRuns(s.producerAgentId);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(adapter).not.toHaveBeenCalled();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe("failed");
  } finally {
    await db.update(agents).set({ status: "paused" }).where(eq(agents.companyId, s.companyId));
    await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.missionId));
    await waitForHeartbeatExecutionsToDrain(db);
  }
});

it("starts the accepted replacement queue with budgets available", async () => {
  const s = await replacementQueue();
  try {
    await heartbeatService(db).resumeQueuedRuns(s.actor.agentId);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(adapter.mock.calls.some(([call]) => call.context.workflowRunId === s.target.id)).toBe(true);
  } finally { await stop(s); }
});

it.each(["owner", "legacy"])("preserves unrelated %s heartbeat liveness", async (kind) => {
  const s = await source();
  await admitReplacement(db, s.input, s.actor);
  const [issue] = await db.insert(issues).values({ companyId: s.companyId, assigneeAgentId: s.actor.agentId, title: "Unrelated work", status: "todo",
    ...(kind === "owner" ? { missionId: s.mission.id, originKind: "mission_owner_action" } : {}) }).returning();
  try {
    const accepted = await heartbeatService(db).wakeup(s.actor.agentId, { source: "assignment", payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } });
    await waitForHeartbeatExecutionsToDrain(db);
    expect(accepted).not.toBeNull();
    expect(adapter.mock.calls.some(([call]) => call.context.issueId === issue.id)).toBe(true);
  } finally { await stop(s); }
});
