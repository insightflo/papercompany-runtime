import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentWakeupRequests, companies, createDb, instanceSettings, issues, missions, workflowRuns, workflowStepRuns,
  workflowTerminalDecisions, workflowTerminalEffectIntents, workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { setupWorkflow } from "./helpers/workflow-step-retry-fixtures.js";
import { cleanupTerminalBoundaryTables } from "./helpers/run-terminal-boundary-fixture.js";
import { setRunTerminalBoundaryFlag } from "./helpers/run-terminal-boundary-integration-fixtures.js";
import {
  completeWorkflowToolStepFromResult,
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
  syncWorkflowRunState,
  type WorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";

import { createConsumptionHarness, consumptionState } from "./helpers/c02-consumption-fixture.js";
import { createClaimFixture } from "./helpers/c02-claim-race-fixture.js";
import { correctionRows, issueNextC02 } from "./helpers/c02-delivery-fixture.js";
import { claimHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { submitWorkflowVerdict } from "../services/workflow/agent-api.js";
import { hasWorkflowValidationCompletionLedger } from "../services/workflow/validation-verdict-ledger.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping C02 consumption tests: ${support.reason ?? "unsupported host"}`);

describeEP("C02 stage 2: existing tool result acceptance and run finalization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("c02-consumption-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await db.delete(workflowTransitionEvents);
    await db.delete(instanceSettings);
    await cleanupTerminalBoundaryTables(db);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  // Stage-2 preservation contract: workflow-dag-engine.test.ts:5764,5788,5828
  // requires public completion, durable success and duplicate no-op behavior.
  // run-terminal-boundary-integration.test.ts:81 defines flag-gated decision ownership.
  it.each([false, true])("boundary=%s: persists success once through the public completion path", async (enabled) => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "C02ConsumptionCo", status: "active" });
    await setRunTerminalBoundaryFlag(db, enabled);
    const { runId } = await setupWorkflow(db, companyId, [{
      id: "collect", name: "Collect", type: "tool", agentId: "", dependencies: [],
      toolNames: ["collect-data"], toolArgs: { source: "c02" },
    }]);
    // Only external execution is replaced; queue claim, acceptance and final writers remain real.
    const executeToolStep = vi.fn<WorkflowToolStepExecutor>().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(executeToolStep);

    expect((await syncWorkflowRunState(db, runId)).status).toBe("running");
    expect(executeToolStep).not.toHaveBeenCalled();
    expect(await processQueuedWorkflowToolStepRuns(db)).toMatchObject({
      claimedCount: 1, executedCount: 1, failedCount: 0,
    });
    expect(executeToolStep).toHaveBeenCalledTimes(1);
    const request = executeToolStep.mock.calls[0]![0];
    const [dispatched] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(dispatched).toMatchObject({
      stepId: "collect", status: "running", issueId: null,
      lastDispatchRequestId: request.requestId,
    });
    expect(dispatched!.lastDispatchAcceptedAt).toBeInstanceOf(Date);
    expect(request).toMatchObject({
      companyId, workflowRunId: runId, stepRunId: dispatched!.id,
      stepId: "collect", toolName: "collect-data", args: { source: "c02" },
    });
    expect(await db.select().from(workflowTerminalDecisions)
      .where(eq(workflowTerminalDecisions.workflowRunId, runId))).toHaveLength(0);

    const data = { ok: true, records: [{ id: "c02-record", value: 7 }] };
    const input = {
      companyId, stepRunId: dispatched!.id, requestId: request.requestId,
      workflowRunId: runId, stepId: "collect", toolName: "collect-data",
      success: true, data, stdout: JSON.stringify(data), stderr: "", exitCode: 0,
    };
    const result = await completeWorkflowToolStepFromResult(db, input);
    expect(result?.status).toBe("completed");
    const [completedStep] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, dispatched!.id));
    const [completedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(completedStep).toMatchObject({
      status: "completed", issueId: null,
      metadata: { toolResult: {
        requestId: request.requestId, toolName: "collect-data", success: true,
        data, stdout: JSON.stringify(data), stderr: "", exitCode: 0, error: null,
      } },
    });
    expect(completedStep!.completedAt).toBeInstanceOf(Date);
    expect(completedStep!.metadata).toMatchObject({
      toolResult: { completedAt: completedStep!.completedAt!.toISOString() },
    });
    expect(completedRun).toMatchObject({ status: "completed" });
    expect(completedRun!.completedAt).toBeInstanceOf(Date);
    const decisions = await db.select().from(workflowTerminalDecisions)
      .where(eq(workflowTerminalDecisions.workflowRunId, runId));
    expect(decisions).toHaveLength(enabled ? 1 : 0);
    if (enabled) expect(decisions[0]).toMatchObject({
      decision: "completed", policyCause: "outcome_convergence",
      discoveryPath: "engine_recompute", origin: "dag_engine",
    });
    const intents = await db.select().from(workflowTerminalEffectIntents)
      .where(eq(workflowTerminalEffectIntents.companyId, companyId)).orderBy(workflowTerminalEffectIntents.id);
    const transitions = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowRunId, runId)).orderBy(workflowTransitionEvents.id);
    const activities = await db.select().from(activityLog)
      .where(eq(activityLog.companyId, companyId)).orderBy(activityLog.id);

    const duplicate = await completeWorkflowToolStepFromResult(db, input);
    expect(duplicate).toEqual(result);
    expect(await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, dispatched!.id))).toEqual([completedStep]);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId))).toEqual([completedRun]);
    expect(await db.select().from(workflowTerminalDecisions)
      .where(eq(workflowTerminalDecisions.workflowRunId, runId))).toEqual(decisions);
    expect(await db.select().from(workflowTerminalEffectIntents)
      .where(eq(workflowTerminalEffectIntents.companyId, companyId))
      .orderBy(workflowTerminalEffectIntents.id)).toEqual(intents);
    expect(await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowRunId, runId))
      .orderBy(workflowTransitionEvents.id)).toEqual(transitions);
    expect(await db.select().from(activityLog)
      .where(eq(activityLog.companyId, companyId)).orderBy(activityLog.id)).toEqual(activities);
    expect(executeToolStep).toHaveBeenCalledTimes(1);
  });
});

describeEP("C02 13A: public verdict consumption", () => {
  let owned: Awaited<ReturnType<typeof createConsumptionHarness>>;
  beforeAll(async () => { owned = await createConsumptionHarness(); }, 60000);
  afterAll(async () => { await owned?.close(); }, 60000);

  async function prepare(quality = true) {
    const fixtures = createClaimFixture(owned, db => db, [], []), w = await fixtures.world(quality);
    const delivered = await correctionRows(w.c);
    const root = await claimHeartbeatWithRecoveryGuard(owned.db, delivered.heartbeats[0]!, new Date());
    if (!root) throw Error("public root claim missing");
    const queued = await fixtures.retry(w, root, "process_lost_retry");
    const actor = await claimHeartbeatWithRecoveryGuard(owned.db, queued, new Date());
    if (!actor) throw Error("public H1 claim missing");
    const [issue] = await w.c.peer.select().from(issues).where(eq(issues.id, w.c.followup.target.issueId));
    if (!issue) throw Error("actual issue missing");
    const input = { db: owned.db, issue, actor: { actorType: "agent" as const, actorId: actor.agentId,
      agentId: actor.agentId, runId: actor.id }, data: { verdict: "pass" as const, reason: "First H1 verdict" } };
    return { w, c: w.c, root, actor, input, delivery: delivered.receipts[0]! };
  }
  type Scenario = Awaited<ReturnType<typeof prepare>>;
  async function effects(s: Scenario) {
    // Independent peer SQL, including actual event IDs; no verdict/consumption seed.
    return s.c.peer.$client<{ id: string; event_type: string; heartbeat_run_id: string;
      wakeup_request_id: string | null; execution_generation: number | null; payload: Record<string, unknown> }[]>`
      SELECT * FROM workflow_transition_events WHERE company_id=${s.c.ref.companyId}
        AND ((heartbeat_run_id=${s.actor.id} AND event_type='workflow_validation_verdict')
          OR idempotency_key=${"qa-correction-consumed:" + s.c.ref.requestId}) ORDER BY id`;
  }

  // C02 first-effect/restart contract: the incoming second verdict cannot replace the first stored result.
  // C12 abstention contract: insufficient_evidence is recordable but cannot complete the issue.
  it.each(["pass", "insufficient_evidence"] as const)("stores %s with exact H1/root evidence and replays it", async verdict => {
    const s = await prepare(), quality = await consumptionState(s.c);
    expect(await effects(s)).toEqual([]);
    const first = await submitWorkflowVerdict({ ...s.input, data: { verdict, reason: "First H1 verdict" } });
    expect(first).toMatchObject({ isCandidate: true, satisfied: true, verdict });
    const stored = await effects(s);
    expect(stored).toHaveLength(2);
    const event = stored.find(row => row.event_type === "workflow_validation_verdict")!;
    const consumed = stored.find(row => row.event_type === "qa_correction_followup_consumed")!;
    expect(event).toMatchObject({ heartbeat_run_id: s.actor.id, payload: { verdict, reason: "First H1 verdict" } });
    expect(consumed).toMatchObject({ heartbeat_run_id: s.actor.id, wakeup_request_id: s.actor.wakeupRequestId,
      execution_generation: s.c.followup.target.executionGeneration,
      payload: { schemaVersion: "workflow.qa-correction.consumption.v2", ref: s.c.ref,
        followupEventId: s.c.followupRow.id, followup: s.c.followup,
        evidence: { kind: "workflow_verdict", eventId: event.id, deliveryEventId: s.delivery.id } } });
    expect(s.actor.retryOfRunId).toBe(s.root.id);
    expect(s.delivery).toMatchObject({ heartbeatRunId: s.root.id, wakeupRequestId: s.root.wakeupRequestId });
    const after = await consumptionState(s.c);
    expect(after.receipts).toEqual(quality.receipts);
    expect(after.usage).toEqual(quality.usage);
    expect(after.groups).toEqual(quality.groups);
    expect(await hasWorkflowValidationCompletionLedger({ db: owned.db, issue: s.input.issue })).toMatchObject(
      verdict === "pass" ? { satisfied: true, verdict: "pass" }
        : { satisfied: false, verdict: null, insufficientEvidence: true, insufficientEvidenceReason: "First H1 verdict" });
    expect(await submitWorkflowVerdict({ ...s.input,
      data: { verdict: "request_changes", reason: "Different incoming verdict" } })).toEqual(first);
    expect(await effects(s)).toEqual(stored);
    expect(await consumptionState(s.c)).toEqual(after);
  }, 60000);

  it("rolls back the official event on consumption failure and serializes first-effect retries", async () => {
    const s = await prepare(), before = await consumptionState(s.c);
    const name = "c02_" + randomUUID().replaceAll("-", "");
    await s.c.peer.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.company_id='${s.c.ref.companyId}'::uuid AND NEW.event_type='qa_correction_followup_consumed'
        THEN RAISE EXCEPTION 'c02_consumption_rollback'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON workflow_transition_events FOR EACH ROW EXECUTE FUNCTION ${name}();`));
    try {
      const failure: unknown = await submitWorkflowVerdict(s.input).then(() => null, error => error);
      const messages: string[] = [];
      for (let error: unknown = failure; error instanceof Error; error = error.cause) messages.push(error.message);
      expect(messages).toContain("c02_consumption_rollback");
      expect(await effects(s)).toEqual([]);
      expect(await consumptionState(s.c)).toEqual(before);
    } finally {
      await s.c.peer.execute(sql.raw(`DROP TRIGGER ${name} ON workflow_transition_events; DROP FUNCTION ${name}();`));
    }
    const [first, second] = await Promise.all([submitWorkflowVerdict(s.input),
      submitWorkflowVerdict({ ...s.input, db: s.c.peer })]);
    expect(second).toEqual(first);
    expect(await effects(s)).toHaveLength(2);
    const after = await consumptionState(s.c);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.usage).toEqual(before.usage);
    expect(after.groups).toEqual(before.groups);
  }, 60000);

  it.each(["late A", "C first", "cancel first", "broken proof"] as const)(
    "rejects %s without an ordinary verdict fallback", async fault => {
      const s = await prepare(false);
      if (fault === "C first") await issueNextC02(s.c);
      if (fault === "cancel first") await s.c.peer.update(missions).set({ status: "cancelled" })
        .where(eq(missions.id, s.c.s.p.missionId));
      if (fault === "broken proof") {
        const [wake] = await s.c.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, s.actor.wakeupRequestId!));
        await s.c.peer.update(agentWakeupRequests).set({ payload: { ...wake!.payload,
          __paperclipWorkflowProducerAttempt: { schemaVersion: 1 } } }).where(eq(agentWakeupRequests.id, wake!.id));
      }
      const input = fault === "late A" ? { ...s.input, actor: { ...s.input.actor, runId: s.c.s.f.verdictHeartbeatId } } : s.input;
      const before = await consumptionState(s.c), stored = await effects(s);
      await expect(submitWorkflowVerdict(input)).rejects.toThrow();
      expect(await effects(s)).toEqual(stored);
      expect(await consumptionState(s.c)).toEqual(before);
    }, 60000);
});
