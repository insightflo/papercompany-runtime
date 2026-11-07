import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { and, asc, eq, sql } from "drizzle-orm";
import { rmSync } from "node:fs";
import { createDb, agents, companies, missions, issues, heartbeatRuns, agentWakeupRequests, instanceSettings, workflowDefinitions, workflowStepRuns, workflowRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapters/types.js";
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
import { registerWorkflowArtifact, completeWorkflowIssue } from "../services/workflow/agent-api.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { prepareQaRemediationReservation } from "../services/workflow/control-flow/qa-remediation-prepare.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE } from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { parseQaRemediationCompletion, QA_REMEDIATION_COMPLETION_EVENT_TYPE } from "../services/workflow/control-flow/qa-remediation-completion.js";
import { freezeHeartbeatActualDrainIdentity } from "../services/heartbeat-actual-drain.js";
import { captureQaCorrectionExecutionIdentity } from "../services/workflow/control-flow/qa-correction-claim-root.js";
import { createQaFileOwnerRuntime, type QaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { createAdmissionHarness } from "./helpers/qa-remediation-admission-public-fixture.js";
import { PYTHON, deferred, within } from "./helpers/qa-remediation-parent-death-harness.js";
import { registerHeartbeatRecoveryBoundaryP1Cases } from "./helpers/heartbeat-recovery-boundary-p1-cases.js";
import { registerHeartbeatRecoveryBoundaryG1BCases } from "./helpers/heartbeat-recovery-boundary-g1b-cases.js";
import { createP1LifecycleScenario, addExecutionCandidateAgent, addExecutionCandidateStep, assertP1AdapterAttempt, waitForP1ProducerDrain } from "./helpers/heartbeat-recovery-boundary-fixtures.js";

const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({ getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }), runningProcesses: new Map() }));
let db: Db;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const roots: string[] = [];
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("heartbeat-recovery-"); db = createDb(temp.connectionString); }, 60_000);
afterAll(async () => { await waitForHeartbeatExecutionsToDrain(db); await db.$client.end(); await temp.cleanup(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });
beforeEach(() => { adapter.mockReset().mockResolvedValue({ exitCode: 1, signal: null, timedOut: false, errorMessage: "test stop", usage: null, provider: "test", model: "test", resultJson: null, runtimeServices: [] }); });

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

  registerHeartbeatRecoveryBoundaryP1Cases({
    adapter,
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

it("P2 public execution holds only with typed C5 proof and preserves boxed actual work", async () => {
  const harness = await createAdmissionHarness();
  const savedEnv = new Map<string, string | undefined>(["PAPERCLIP_STORAGE_PROVIDER", "PAPERCLIP_STORAGE_LOCAL_DIR",
    "PAPERCLIP_WORKFLOW_INSTANT_ADVANCE", "PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT", "PAPERCLIP_QA_FILE_OWNER_PYTHON"]
    .map(key => [key, process.env[key]] as const));
  const qaRelease = deferred<void>(), qaEntered = deferred<void>(), qaVerdictWritten = deferred<void>();
  const secondActualRelease = deferred<void>(), secondActualEntered = deferred<AdapterExecutionContext>();
  const nativeWait = deferred<void>(), unknownOwnerBegin = deferred<void>();
  const ownerExits: Promise<unknown>[] = [];
  const ownerTargetSets: string[][] = [];
  const ownerExitByTargetSet = new Map<number, Promise<unknown>>();
  const handlerByIssue = new Map<string, (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>>();
  const handlerByAgent = new Map<string, (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>>();
  const actual = (label: string): AdapterExecutionResult => ({ exitCode: 0, signal: null, timedOut: false,
    usage: null, provider: label, model: "fixture", resultJson: { stdout: label, stderr: "" }, runtimeServices: [] });
  const producerActual = actual("P2 producer actual"), qaActual = actual("P2 QA actual");
  const qaRefireActual = actual("P2 exact QA completion refire"), secondActual = actual("P2 boxed actual result");
  let scenario: Awaited<ReturnType<typeof createP1LifecycleScenario>> | null = null;
  let reservation: Awaited<ReturnType<typeof prepareQaRemediationReservation>> | null = null;
  let originalQaRunId: string | null = null, qaRefireCount = 0, secondEntries = 0, failNextOwnerBegin = false;
  let nativeBlocker: Awaited<ReturnType<ReturnType<typeof createQaFileOwnerRuntime>["begin"]>> | null = null;
  const cleanupFailures: unknown[] = [];
  let bodyFailure: unknown;
  const cleanExit = (exit: unknown) => {
    expect(exit).toMatchObject({ code: 0, signal: null });
  };
  const waitRun = async (runId: string, status: string) => within(vi.waitFor(async () => {
    const [run] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe(status);
    return run!;
  }, { timeout: 45_000, interval: 20 }), `P2 heartbeat ${runId} reaches ${status}`);
  const publicWakeOptions = (target: { issueId: string; stepRun: typeof workflowStepRuns.$inferSelect },
    current: Awaited<ReturnType<typeof createP1LifecycleScenario>>) => ({
    source: "assignment" as const, triggerDetail: "system" as const, reason: "workflow_step_runnable",
    payload: { issueId: target.issueId, missionId: current.missionId, workflowRunId: current.runId,
      workflowStepRunId: target.stepRun.id },
    contextSnapshot: { issueId: target.issueId, missionId: current.missionId, workflowRunId: current.runId,
      workflowStepRunId: target.stepRun.id },
  });
  try {
    const storageRoot = path.join(harness.root, "storage");
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageRoot;
    process.env.PAPERCLIP_WORKFLOW_INSTANT_ADVANCE = "0";
    process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT = harness.lockRoot;
    process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON = PYTHON!;
    await mkdir(storageRoot, { recursive: true });
    await harness.db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: true } })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableHeartbeatFinalizationV1: true } } });
    scenario = await createP1LifecycleScenario(harness);
    adapter.mockImplementation((context: AdapterExecutionContext) => {
      const issueId = typeof context.context.issueId === "string" ? context.context.issueId : null;
      const handler = issueId ? handlerByIssue.get(issueId) : handlerByAgent.get(context.agent.id);
      if (!handler) throw new Error(`unregistered P2 public adapter entry ${context.runId}`);
      return handler(context);
    });
    handlerByIssue.set(scenario.producerIssueId, async context => {
      const observed = await assertP1AdapterAttempt(harness.peer, context, { companyId: scenario!.companyId,
        agentId: scenario!.authorId, missionId: scenario!.missionId, workflowRunId: scenario!.runId,
        issueId: scenario!.producerIssueId, stepRunId: scenario!.producer.id, stepId: scenario!.producer.stepId });
      await mkdir(path.dirname(scenario!.file), { recursive: true });
      await writeFile(scenario!.file, "before\n", "utf8");
      const actor = { actorType: "agent" as const, actorId: scenario!.authorId, agentId: scenario!.authorId, runId: context.runId };
      await registerWorkflowArtifact({ db: harness.db, issue: observed.issue, actor,
        data: { path: scenario!.file, type: "document", isPrimary: true } });
      await completeWorkflowIssue({ db: harness.db, issue: observed.issue, actor, data: {} });
      return producerActual;
    });
    handlerByIssue.set(scenario.qaIssueId, async context => {
      const observed = await assertP1AdapterAttempt(harness.peer, context, { companyId: scenario!.companyId,
        agentId: scenario!.verifierId, missionId: scenario!.missionId, workflowRunId: scenario!.runId,
        issueId: scenario!.qaIssueId, stepRunId: scenario!.qa.id, stepId: scenario!.qa.stepId });
      if (originalQaRunId === null) {
        originalQaRunId = context.runId;
        await recordWorkflowValidationVerdict({ db: harness.db, issue: observed.issue, source: "workflow_api",
          verdict: "request_changes", actorAgentId: scenario!.verifierId, heartbeatRunId: context.runId,
          findings: [{ id: "p2-artifact", summary: "Correct the producer artifact", layer: "artifact" }],
          remediations: { items: [{ op: "string_replace", file: scenario!.file, find: "before", replace: "after" }] } });
        qaEntered.resolve();
        qaVerdictWritten.resolve();
        await qaRelease.promise;
        return qaActual;
      }
      qaRefireCount++;
      const [wake] = await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, observed.wake.id));
      const binding = wake?.payload?.qaRemediationCompletion;
      const completionRows = await harness.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, scenario!.companyId), eq(workflowTransitionEvents.workflowRunId, scenario!.runId),
        eq(workflowTransitionEvents.workflowStepRunId, scenario!.producer.id),
        eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
      if (!reservation || reservation.outcome !== "prepared" || completionRows.length !== 1 || !binding
        || typeof binding !== "object" || !("sourceVerdictEventId" in binding)
        || typeof binding.sourceVerdictEventId !== "string") {
        throw new Error("P2 QA refire lacks exact committed preparation/completion binding");
      }
      const completion = parseQaRemediationCompletion(completionRows[0]!.payload);
      expect(completion.preparationId).toBe(reservation.preparationEventId);
      expect(completion.completionId).toBe(completionRows[0]!.id);
      expect(completion.verdicts[0]?.heartbeatRunId).toBe(originalQaRunId);
      expect(completion.verdicts[0]?.eventId).toBe(binding.sourceVerdictEventId);
      expect(binding).toEqual({ preparationEventId: reservation.preparationEventId,
        sourceVerdictEventId: expect.any(String) });
      const verdict = await recordWorkflowValidationVerdict({ db: harness.db, issue: observed.issue, source: "workflow_api",
        verdict: "pass", actorAgentId: scenario!.verifierId, heartbeatRunId: context.runId });
      expect(verdict.satisfied).toBe(true);
      const actor = { actorType: "agent" as const, actorId: scenario!.verifierId, agentId: scenario!.verifierId, runId: context.runId };
      await completeWorkflowIssue({ db: harness.db, issue: observed.issue, actor, data: {} });
      return qaRefireActual;
    });

    const realRuntime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: harness.lockRoot, qaFileOwnerPython: PYTHON! });
    const ownerRuntime: QaFileOwnerRuntime = { capability: realRuntime.capability,
      begin: async (targets, beginOptions = {}) => {
        const targetSetIndex = ownerTargetSets.length;
        ownerTargetSets.push([...targets]);
        if (failNextOwnerBegin) {
          failNextOwnerBegin = false;
          unknownOwnerBegin.resolve();
          throw new Error("P2 generic adapter-start owner failure");
        }
        const owner = await realRuntime.begin(targets, { ...beginOptions, onEvent: event => {
          if (event.type === "lock_wait") nativeWait.resolve();
          beginOptions.onEvent?.(event);
        } });
        const exit = owner.awaitExit();
        ownerExits.push(exit);
        ownerExitByTargetSet.set(targetSetIndex, exit);
        return owner;
      } };
    const ordinaryService = heartbeatService(harness.db, { qaCorrectionExecution: { ownerRuntime } });
    const producerWake = await ordinaryService.wakeup(scenario.authorId, publicWakeOptions(
      { issueId: scenario.producerIssueId, stepRun: scenario.producer }, scenario));
    if (!producerWake?.wakeupRequestId) throw new Error("P2 producer did not enter the existing public wake path");
    const [producerStarted] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerWake.id));
    if (!producerStarted) throw new Error("P2 producer heartbeat disappeared");
    const producerDrain = await freezeHeartbeatActualDrainIdentity(harness.peer, producerStarted, { workflowRunId: scenario.runId });
    if (!producerDrain) throw new Error("P2 producer actual-drain identity was not frozen");
    await within(qaEntered.promise, "P2 original QA adapter start");
    await within(qaVerdictWritten.promise, "P2 official request-changes verdict");
    const qaRunId = originalQaRunId!;
    const [qaBefore] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, qaRunId));
    if (!qaBefore) throw new Error("P2 original QA heartbeat disappeared");
    const [qaWakeBefore] = await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, qaBefore.wakeupRequestId!));
    const reservationResult = await prepareQaRemediationReservation(harness.db, { companyId: scenario.companyId,
      missionId: scenario.missionId, workflowRunId: scenario.runId, producerStepRunId: scenario.producer.id,
      qaStepRunIds: [scenario.qa.id] });
    expect(reservationResult.outcome).toBe("prepared");
    if (reservationResult.outcome !== "prepared") throw new Error("P2 preparation was not durably prepared");
    reservation = reservationResult;
    await waitForP1ProducerDrain(harness.peer, producerDrain, producerActual);
    const [producerBefore] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerWake.id));
    const [preparationBefore] = await harness.peer.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.id, reservation.preparationEventId));
    const wakeIdsBefore = (await harness.peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scenario.companyId), eq(agentWakeupRequests.workflowRunId, scenario.runId)))
      .orderBy(asc(agentWakeupRequests.id))).map(row => row.id);

    const optedService = heartbeatService(harness.db, { qaCorrectionExecution: { ownerRuntime } });
    const heldAgentId = await addExecutionCandidateAgent(harness, scenario, "P2 held public executor");
    const heldTarget = await addExecutionCandidateStep(harness, scenario, heldAgentId, "P2 held public step");
    nativeBlocker = await realRuntime.begin([scenario.file]);
    const heldWake = await optedService.wakeup(heldAgentId, publicWakeOptions(heldTarget, scenario));
    if (!heldWake?.wakeupRequestId) throw new Error("P2 held public wake did not create a heartbeat/wake binding");
    await within(nativeWait.promise, "P2 public adapter-start native lock wait");
    const [heldRunBefore] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heldWake.id));
    if (!heldRunBefore) throw new Error("P2 held heartbeat disappeared while its native owner was blocked");
    expect(heldRunBefore).toMatchObject({ status: "running", executorOwnerReleasedAt: null });
    expect(heldRunBefore.executorOwnerAcknowledgedAt).toBeInstanceOf(Date);
    const heldIdentityBefore = captureQaCorrectionExecutionIdentity(heldRunBefore);
    expect(heldIdentityBefore.executorOwnerReleasedAt).toBeNull();
    const [heldStepBefore] = await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, heldTarget.stepRun.id));
    const [heldIssueBefore] = await harness.peer.select().from(issues).where(eq(issues.id, heldTarget.issueId));
    if (!heldIssueBefore) throw new Error("P2 held issue disappeared while its native owner was blocked");
    await within(harness.peer.transaction(async tx => {
      const [mission] = await tx.select({ id: missions.id }).from(missions).where(eq(missions.id, scenario!.missionId)).for("update");
      const [workflow] = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.id, scenario!.runId)).for("update");
      expect(mission?.id).toBe(scenario!.missionId);
      expect(workflow?.id).toBe(scenario!.runId);
    }), "P2 peer mission/run transaction commits while native owner is pending");
    const blocker = nativeBlocker;
    nativeBlocker = null;
    cleanExit(await blocker.close());
    cleanExit(await blocker.awaitExit());
    const held = await waitRun(heldWake.id, "failed");
    expect(held.errorCode).toBe("c5_held_not_invoked");
    const heldWakeAfter = await within(vi.waitFor(async () => {
      const [wake] = await harness.peer.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, heldWake.wakeupRequestId));
      expect(wake?.runId).toBe(held.id);
      expect(wake?.status).toBe("failed");
      return wake!;
    }, { timeout: 30_000, interval: 20 }), "P2 exact held wake terminalization");
    expect(heldWakeAfter).toMatchObject({ id: heldWake.wakeupRequestId, runId: held.id, status: "failed" });
    expect(adapter.mock.calls.filter(([call]) => call.context.issueId === heldTarget.issueId)).toHaveLength(0);
    const [heldStepAfter] = await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, heldTarget.stepRun.id));
    expect(heldStepAfter).toMatchObject({ id: heldStepBefore!.id, workflowRunId: heldStepBefore!.workflowRunId,
      issueId: heldStepBefore!.issueId, executionGeneration: heldStepBefore!.executionGeneration,
      retryCount: heldStepBefore!.retryCount, iterationIndex: heldStepBefore!.iterationIndex,
      status: heldStepBefore!.status });
    const heldIssueAfter = await within(vi.waitFor(async () => {
      const [issue] = await harness.peer.select().from(issues).where(eq(issues.id, heldTarget.issueId));
      expect(issue?.executionRunId).toBeNull();
      expect(issue?.checkoutRunId).toBeNull();
      expect(issue?.executionAgentNameKey).toBeNull();
      expect(issue?.executionLockedAt).toBeNull();
      return issue!;
    }, { timeout: 30_000, interval: 20 }), "P2 exact held issue owner release");
    expect(heldIssueAfter).toMatchObject({ id: heldTarget.issueId, companyId: heldIssueBefore.companyId,
      assigneeAgentId: heldIssueBefore.assigneeAgentId, status: heldIssueBefore.status,
      executionRunId: null, checkoutRunId: null, executionAgentNameKey: null, executionLockedAt: null });
    const [heldRunAfter] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heldWake.id));
    if (!heldRunAfter) throw new Error("P2 held heartbeat disappeared after terminal owner closure");
    expect(heldRunAfter).toMatchObject({
      id: heldIdentityBefore.heartbeatRunId, companyId: heldIdentityBefore.companyId,
      agentId: heldIdentityBefore.agentId, issueId: heldIdentityBefore.issueId,
      wakeupRequestId: heldIdentityBefore.wakeupRequestId,
      workflowStepRunId: heldIdentityBefore.workflowStepRunId,
      workflowExecutionGeneration: heldIdentityBefore.workflowExecutionGeneration,
      retryOfRunId: heldIdentityBefore.retryOfRunId,
      executionScopeKind: heldIdentityBefore.executionScopeKind,
      executionEpoch: heldIdentityBefore.executionEpoch, executionToken: heldIdentityBefore.executionToken,
      executorOwnerId: heldIdentityBefore.executorOwnerId,
      executorOwnerLeaseEpoch: heldIdentityBefore.executorOwnerLeaseEpoch,
      executorOwnerLeaseToken: heldIdentityBefore.executorOwnerLeaseToken,
      executorOwnerLeaseExpiresAt: heldIdentityBefore.executorOwnerLeaseExpiresAt,
      executorOwnerAcknowledgedAt: heldIdentityBefore.executorOwnerAcknowledgedAt,
      processLossRetryCount: heldIdentityBefore.processLossRetryCount,
      status: "failed", errorCode: "c5_held_not_invoked", finalizationVersion: 1,
      terminalOutcome: "failed", terminalDecisionSource: "heartbeat_status:failed:c5_held_not_invoked",
    });
    expect(heldRunAfter.executorOwnerReleasedAt).toBeInstanceOf(Date);
    expect(heldRunAfter.terminalDecidedAt).toBeInstanceOf(Date);
    expect(Number.isFinite(heldRunAfter.executorOwnerReleasedAt!.getTime())).toBe(true);
    expect(Number.isFinite(heldRunAfter.terminalDecidedAt!.getTime())).toBe(true);
    const heldTerminalAuthority = await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, heldRunAfter.companyId),
      eq(workflowTransitionEvents.heartbeatRunId, heldRunAfter.id),
      eq(workflowTransitionEvents.eventType, "workflow_authority_transition"),
      eq(workflowTransitionEvents.idempotencyKey, "terminal-outcome:" + heldRunAfter.id)));
    expect(heldTerminalAuthority).toHaveLength(1);
    expect(heldTerminalAuthority[0]).toMatchObject({
      companyId: heldRunAfter.companyId, workflowRunId: null,
      workflowStepRunId: heldRunAfter.workflowStepRunId, issueId: heldRunAfter.issueId,
      wakeupRequestId: heldRunAfter.wakeupRequestId, heartbeatRunId: heldRunAfter.id,
      executionGeneration: heldRunAfter.workflowExecutionGeneration,
      executorOwnerId: heldRunAfter.executorOwnerId, layer: "workflow_authority",
      decision: "shadow_write", reason: "terminal_outcome_decided",
      reasonCode: "terminal_outcome_decided", idempotencyKey: "terminal-outcome:" + heldRunAfter.id,
    });
    expect(heldTerminalAuthority[0]!.payload).toEqual({
      version: 1, transition: "terminal_outcome_decided",
      executionEpoch: heldRunAfter.executionEpoch, executionToken: heldRunAfter.executionToken,
      ownerLeaseEpoch: heldRunAfter.executorOwnerLeaseEpoch,
      ownerLeaseToken: heldRunAfter.executorOwnerLeaseToken, outcome: "failed",
      source: "heartbeat_status:failed:c5_held_not_invoked",
    });
    expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.heartbeatRunId, heldRunAfter.id),
      eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")))).toHaveLength(0);
    expect(await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerWake.id))).toEqual([producerBefore]);
    expect(await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, qaRunId))).toEqual([qaBefore]);
    expect(await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, qaWakeBefore!.id))).toEqual([qaWakeBefore]);
    expect(await harness.peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, reservation.preparationEventId)))
      .toEqual([preparationBefore]);
    await optedService.resumeQueuedRuns(heldAgentId);
    expect(adapter.mock.calls.filter(([call]) => call.context.issueId === heldTarget.issueId)).toHaveLength(0);
    const wakeIdsAfterHold = (await harness.peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scenario.companyId), eq(agentWakeupRequests.workflowRunId, scenario.runId)))
      .orderBy(asc(agentWakeupRequests.id))).map(row => row.id);
    expect(wakeIdsAfterHold).toEqual([...wakeIdsBefore, heldWake.wakeupRequestId].sort());

    const unrelatedAgentId = randomUUID();
    await harness.db.insert(agents).values({ id: unrelatedAgentId, companyId: scenario.companyId, name: "P2 unrelated U",
      status: "active", adapterType: "codex_local", adapterConfig: { cwd: harness.root, promptTemplate: "P2 unrelated U" },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } });
    handlerByAgent.set(unrelatedAgentId, async () => actual("P2 unrelated U complete"));
    const unrelated = await optedService.wakeup(unrelatedAgentId, { source: "on_demand" });
    if (!unrelated) throw new Error("P2 unrelated public U wake was not created");
    expect((await waitRun(unrelated.id, "succeeded")).resultJson).toEqual({ stdout: "P2 unrelated U complete", stderr: "" });

    qaRelease.resolve();
    await waitForHeartbeatExecutionsToDrain(harness.db, 60_000);
    expect(qaRefireCount).toBe(1);
    const [qaAfter] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, qaRunId));
    expect(qaAfter).toMatchObject({ id: qaRunId, status: "succeeded", resultJson: qaActual.resultJson,
      executorOwnerId: qaBefore.executorOwnerId, executorOwnerLeaseEpoch: qaBefore.executorOwnerLeaseEpoch,
      executorOwnerLeaseToken: qaBefore.executorOwnerLeaseToken, executionEpoch: qaBefore.executionEpoch,
      executionToken: qaBefore.executionToken });
    const completionRows = await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.workflowRunId, scenario.runId),
      eq(workflowTransitionEvents.workflowStepRunId, scenario.producer.id),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
    expect(completionRows).toHaveLength(1);
    expect(completionRows[0]!.payload.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: scenario.file, status: "applied" }),
    ]));
    const historicalPreparationRows = await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.id, reservation.preparationEventId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
    expect(historicalPreparationRows).toHaveLength(1);

    const allowedAgentId = await addExecutionCandidateAgent(harness, scenario, "P2 allowed public executor");
    const allowedTarget = await addExecutionCandidateStep(harness, scenario, allowedAgentId, "P2 allowed public step");
    handlerByIssue.set(allowedTarget.issueId, async context => {
      const observed = await assertP1AdapterAttempt(harness.peer, context, { companyId: scenario!.companyId,
        agentId: allowedAgentId, missionId: scenario!.missionId, workflowRunId: scenario!.runId,
        issueId: allowedTarget.issueId, stepRunId: allowedTarget.stepRun.id, stepId: allowedTarget.stepRun.stepId });
      secondEntries++;
      secondActualEntered.resolve(context);
      await secondActualRelease.promise;
      const actor = { actorType: "agent" as const, actorId: allowedAgentId, agentId: allowedAgentId, runId: context.runId };
      await completeWorkflowIssue({ db: harness.db, issue: observed.issue, actor, data: {} });
      return secondActual;
    });
    const allowedOwnerTargetSetStart = ownerTargetSets.length;
    const allowedWake = await optedService.wakeup(allowedAgentId, publicWakeOptions(allowedTarget, scenario));
    if (!allowedWake) throw new Error("P2 allowed public wake was not created");
    const enteredContext = await within(secondActualEntered.promise, "P2 public allowed adapter entry");
    expect(enteredContext.runId).toBe(allowedWake.id);
    const [allowedStarted] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, enteredContext.runId));
    if (!allowedStarted) throw new Error("P2 allowed heartbeat disappeared while actual was pending");
    await within(harness.peer.transaction(async tx => {
      const [mission] = await tx.select({ id: missions.id }).from(missions).where(eq(missions.id, scenario!.missionId)).for("update");
      const [workflow] = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.id, scenario!.runId)).for("update");
      const [heartbeat] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, allowedStarted.id)).for("update");
      const [issue] = await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, allowedTarget.issueId)).for("update");
      expect([mission?.id, workflow?.id, heartbeat?.id, issue?.id]).toEqual([
        scenario!.missionId, scenario!.runId, allowedStarted.id, allowedTarget.issueId]);
    }), "P2 peer mission/run/heartbeat/issue transaction commits during unresolved actual");
    const allowedOwnerTargetSetIndex = ownerTargetSets.findIndex((targets, index) =>
      index >= allowedOwnerTargetSetStart && targets.includes(scenario!.file));
    if (allowedOwnerTargetSetIndex < 0) {
      throw new Error("P2 allowed adapter-start did not begin a new native owner for the historical target");
    }
    const allowedOwnerExit = ownerExitByTargetSet.get(allowedOwnerTargetSetIndex);
    if (!allowedOwnerExit) throw new Error("P2 allowed native owner has no bound close/exit observation");
    cleanExit(await within(allowedOwnerExit, "P2 allowed native owner closes and exits before contender"));
    const contender = await realRuntime.begin([scenario.file]);
    cleanExit(await contender.close());
    cleanExit(await contender.awaitExit());
    expect(secondEntries).toBe(1);
    expect((await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, allowedStarted.id)))[0])
      .toMatchObject({ status: "running", executorOwnerId: allowedStarted.executorOwnerId,
        executorOwnerLeaseEpoch: allowedStarted.executorOwnerLeaseEpoch, executorOwnerLeaseToken: allowedStarted.executorOwnerLeaseToken });
    expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.heartbeatRunId, allowedStarted.id),
      eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")))).toHaveLength(0);
    secondActualRelease.resolve();
    await waitForHeartbeatExecutionsToDrain(harness.db, 60_000);
    const [allowedAfter] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, allowedStarted.id));
    expect(allowedAfter).toMatchObject({ status: "succeeded", resultJson: secondActual.resultJson,
      executorOwnerId: allowedStarted.executorOwnerId, executorOwnerLeaseEpoch: allowedStarted.executorOwnerLeaseEpoch,
      executorOwnerLeaseToken: allowedStarted.executorOwnerLeaseToken, executionEpoch: allowedStarted.executionEpoch,
      executionToken: allowedStarted.executionToken });
    expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.heartbeatRunId, allowedStarted.id),
      eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")))).toHaveLength(1);

    const unknownAgentId = await addExecutionCandidateAgent(harness, scenario, "P2 unknown adapter-start executor");
    const unknownTarget = await addExecutionCandidateStep(harness, scenario, unknownAgentId, "P2 unknown adapter-start step");
    const wakeIdsBeforeUnknown = (await harness.peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scenario.companyId), eq(agentWakeupRequests.workflowRunId, scenario.runId)))
      .orderBy(asc(agentWakeupRequests.id))).map(row => row.id);
    failNextOwnerBegin = true;
    const unknownWake = await optedService.wakeup(unknownAgentId, publicWakeOptions(unknownTarget, scenario));
    if (!unknownWake?.wakeupRequestId) throw new Error("P2 unknown public wake did not create a heartbeat/wake binding");
    await within(unknownOwnerBegin.promise, "P2 generic adapter-start guard failure before invocation");
    await waitForHeartbeatExecutionsToDrain(harness.db, 60_000);
    const [unknownAfter] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unknownWake.id));
    const [unknownWakeAfter] = await harness.peer.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, unknownWake.wakeupRequestId));
    expect(unknownAfter).toMatchObject({ id: unknownWake.id, status: "running", errorCode: null, finishedAt: null });
    expect(unknownWakeAfter).toMatchObject({ id: unknownWake.wakeupRequestId, runId: unknownWake.id,
      status: "claimed", finishedAt: null });
    expect(adapter.mock.calls.filter(([call]) => call.context.issueId === unknownTarget.issueId)).toHaveLength(0);
    const wakeIdsAfterUnknown = (await harness.peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scenario.companyId), eq(agentWakeupRequests.workflowRunId, scenario.runId)))
      .orderBy(asc(agentWakeupRequests.id))).map(row => row.id);
    expect(wakeIdsAfterUnknown).toEqual([...wakeIdsBeforeUnknown, unknownWake.wakeupRequestId].sort());
    expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.heartbeatRunId, unknownWake.id),
      eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")))).toHaveLength(0);
  } catch (error) {
    bodyFailure = error;
  } finally {
    qaRelease.resolve();
    secondActualRelease.resolve();
    if (nativeBlocker) {
      const blocker = nativeBlocker;
      nativeBlocker = null;
      try { cleanExit(await blocker.close()); cleanExit(await blocker.awaitExit()); }
      catch (error) { cleanupFailures.push(error); }
    }
    if (scenario) {
      try { await harness.db.update(agents).set({ status: "paused" }).where(eq(agents.companyId, scenario.companyId)); }
      catch (error) { cleanupFailures.push(error); }
      try { await harness.db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, scenario.missionId)); }
      catch (error) { cleanupFailures.push(error); }
    }
    try { await waitForHeartbeatExecutionsToDrain(harness.db, 60_000); } catch (error) { cleanupFailures.push(error); }
    for (const exit of ownerExits) {
      try { cleanExit(await exit); } catch (error) { cleanupFailures.push(error); }
    }
    try { await harness.close(); } catch (error) { cleanupFailures.push(error); }
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  if (bodyFailure) {
    if (cleanupFailures.length) throw new AggregateError([bodyFailure, ...cleanupFailures], "P2 public test and cleanup failed", { cause: bodyFailure });
    throw bodyFailure;
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, "P2 public test cleanup failed");
}, 240_000);

  registerHeartbeatRecoveryBoundaryG1BCases({
    adapter,
    getDb: () => db,
  });
