import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { and, asc, eq, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issues, missions, qualityActions, workflowRuns,
  workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { expect } from "vitest";
import { parseObject } from "../../adapters/utils.js";
import { promoteDeferredWakeupRequest, promoteQueuedWakeupRequest,
  type HeartbeatFollowupPromotionDeps } from "../../services/heartbeat-followup-promotion.js";
import { withCorrectionDeliveryRoot, type CorrectionDeliveryInput, type CorrectionDeliveryResult,
  type WriteLinkedCorrectionRun } from "../../services/workflow/control-flow/qa-correction-delivery-root.js";
import type { DeliveryTx, DeliveryWake } from "../../services/workflow/control-flow/qa-correction-delivery-receipt.js";
import { qaCorrectionWakeKey } from "../../services/work-products/qa-correction-producer-attempt.js";
import { hashContract } from "../../services/quality/contract.js";
import { beginQaCorrection } from "../../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../../services/workflow/control-flow/qa-correction-storage.js";
import { commitQaCorrection } from "../../services/workflow/control-flow/qa-correction-commit.js";
import { parseQaCorrectionEventPayload } from "../../services/workflow/control-flow/qa-correction-contract.js";
import { commitDbState, makeCommitSource } from "../qa-correction-commit-fixture.js";
import { createCommitSourceHarness, issueC02, issueNextC02, type C02Case } from "./c02-fixture.js";

export { createCommitSourceHarness, issueC02, issueNextC02 };

/** Issue through the real C03 path with QA already completed; preserve the original todo input. */
export async function issueDeliveryC02(owned: Awaited<ReturnType<typeof createCommitSourceHarness>>,
  status: "todo" | "done"): Promise<C02Case> {
  if (status === "todo") return issueC02(owned, { mode: "content-only", quality: true });
  const s = await makeCommitSource(owned.db, owned.root, "content-only", false, true);
  await s.db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, s.f.qa.issueId!));
  // Match issueC02's nonzero target tuple and exhausted executor envelope before real issuance.
  s.f.qa.retryCount = 1; s.f.qa.iterationIndex = 2;
  for (const v of s.p.authority.verdicts) { v.qa.retryCount = 1; v.qa.iterationIndex = 2; }
  for (const b of s.p.bindings) { b.consumer.retryCount = 1; b.consumer.iterationIndex = 2; }
  s.request.retryCount = 1; s.request.iterationIndex = 2;
  await s.db.update(workflowStepRuns).set({ retryCount: 1, iterationIndex: 2,
    metadata: { artifactExecution: s.request.artifactExecution, toolArtifactRequest: s.request } }).where(eq(workflowStepRuns.id, s.f.qa.id));
  if (s.p.authority.kind !== "quality_current_output") throw Error("quality fixture required");
  const a = s.p.authority, [row] = await s.db.select().from(qualityActions).where(eq(qualityActions.id, a.actionId));
  const retryEnvelope = { ...row!.retryEnvelope, maxExecutorAttempts: 1 };
  a.retryEnvelopeHash = hashContract(retryEnvelope);
  await s.db.update(qualityActions).set({ retryEnvelope }).where(eq(qualityActions.id, a.actionId));
  const peer = owned.connect(), prepared = await beginQaCorrection(s.db, s.p);
  if (prepared.status !== "prepared") throw Error("real C02 preparation required: " + prepared.status);
  s.p = prepared.preparation;
  const measured = await measureQaCorrectionSources(s.db, {
    preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash });
  const stored = await storeQaCorrection(s.db, measured), result = await commitQaCorrection(s.db, stored);
  if (result.status !== "committed") throw Error("real C02 issuance required: " + result.status);
  const [appliedRow] = await peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, result.appliedEventId));
  if (!appliedRow) throw Error("peer cannot see committed application");
  const applied = parseQaCorrectionEventPayload("qa_remediation_applied", appliedRow.payload);
  const [followupRow] = await peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, applied.followupEventIds[0]!));
  if (!followupRow) throw Error("peer cannot see committed followup");
  const followup = parseQaCorrectionEventPayload("qa_correction_followup_requested", followupRow.payload);
  return { s, peer, stored, appliedRow, applied, followupRow, followup,
    ref: { companyId: s.p.companyId, workflowRunId: s.p.workflowRunId,
      appliedEventId: appliedRow.id, requestId: followup.requestId } };
}
export async function deliveryInput(c: C02Case): Promise<CorrectionDeliveryInput> {
  const [origin] = await c.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, c.s.f.verdictHeartbeatId));
  if (!origin) throw Error("real QA origin required");
  const t = c.followup.target, reason = "workflow_step_runnable";
  return { mode: "initial", ref: c.ref, companyId: c.ref.companyId, agentId: origin.agentId,
    issueId: t.issueId, missionId: c.s.p.missionId, workflowRunId: c.ref.workflowRunId,
    workflowStepRunId: t.stepRunId, workflowExecutionGeneration: t.executionGeneration,
    candidateWakeupRequestId: null, request: { source: "automation", triggerDetail: "system", reason,
      requestKind: reason, requestedByActorType: "system", requestedByActorId: "c02-delivery-test",
      idempotencyKey: qaCorrectionWakeKey(c.ref), payload: { qaCorrectionFollowup: c.ref, callerField: { retain: [1, 2] } },
      contextSnapshot: { issueId: t.issueId, taskId: t.issueId, taskKey: t.issueId,
        missionId: c.s.p.missionId, workflowRunId: c.ref.workflowRunId,
        workflowStepRunId: t.stepRunId, wakeReason: reason, wakeSource: "automation", wakeTriggerDetail: "system" } } };
}

/**
 * Real queued/deferred product writers with fixture-owned session/context inputs.
 * These isolated agents have no session history. No adapter, public wakeup or claim is invoked.
 */
export function deliveryWriter(c: C02Case, onWritten?: (tx: DeliveryTx, wake: DeliveryWake,
  heartbeat: typeof heartbeatRuns.$inferSelect) => Promise<void>): WriteLinkedCorrectionRun {
  const deps: HeartbeatFollowupPromotionDeps = {
    deferredWakeContextKey: "_paperclipWakeContext", issueRunStartStatuses: ["todo", "in_progress"],
    resolveSessionBeforeForWakeup: async (agent) => {
      // Query the actual task-session storage; these isolated agents have no task session to reuse.
      const rows = await c.peer.execute(sql`SELECT id FROM agent_task_sessions WHERE agent_id = ${agent.id}`);
      expect(rows).toHaveLength(0);
      const saved = await c.peer.execute(sql`SELECT id FROM mission_sessions
        WHERE agent_id = ${agent.id} AND mission_id = ${c.s.p.missionId}`);
      expect(saved).toHaveLength(0);
      return null;
    },
    enrichWakeContextSnapshot: input => {
      // All required fields were normalized before entering the root; preserve that exact fixture context.
      const contextSnapshot = input.contextSnapshot;
      expect(contextSnapshot.issueId).toBe(c.followup.target.issueId);
      expect(contextSnapshot.missionId).toBe(c.s.p.missionId);
      return { contextSnapshot, issueIdFromPayload: String(contextSnapshot.issueId),
        commentIdFromPayload: null, taskKey: String(contextSnapshot.taskKey), wakeCommentId: null };
    },
  };
  return async (tx, wake) => {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, wake.agentId));
    const [issue] = await tx.select().from(issues).where(eq(issues.id, wake.issueId!));
    if (!agent || !issue) throw Error("real writer scope required");
    const payload = parseObject(wake.payload), context = parseObject(payload._paperclipWakeContext);
    const isWorkflowStepResume = c.followup.operation === "recheck"
      && same(payload.qaCorrectionFollowup, c.ref)
      && wake.reason === "workflow_step_runnable" && wake.requestKind === wake.reason
      && context.wakeReason === wake.reason && payload.issueId === issue.id
      && context.issueId === issue.id && context.missionId === c.s.p.missionId
      && context.workflowRunId === c.ref.workflowRunId && context.workflowStepRunId === c.followup.target.stepRunId;
    const hb = wake.status === "deferred_issue_execution"
      ? await promoteDeferredWakeupRequest(deps, tx, { deferred: wake, deferredAgent: agent, issue })
      : await promoteQueuedWakeupRequest(deps, tx, { agent, request: wake,
        promotedContextSnapshot: context, promotedSource: "automation",
        promotedTriggerDetail: wake.triggerDetail, promotedIssueId: issue.id, promotedTaskKey: issue.id,
        missionIdForWake: issue.missionId, promotedIssue: issue, isWorkflowStepResume, isPlanReworkPromotion: false });
    const [actual] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, hb.id));
    // The normal writer MUST leave NULLs. Root persistence, not fixture pre-seeding, is under test.
    expect(actual).toMatchObject({ workflowStepRunId: null, workflowExecutionGeneration: null, status: "queued" });
    await onWritten?.(tx, wake, actual!);
    return hb;
  };
}
export function deliver(c: C02Case, i: CorrectionDeliveryInput, db = c.s.db,
  writer = deliveryWriter(c)): Promise<CorrectionDeliveryResult> {
  return withCorrectionDeliveryRoot(db, i, writer);
}
export async function deliveryState(c: C02Case) {
  const [issue] = await c.peer.select().from(issues).where(eq(issues.id, c.followup.target.issueId));
  return { ...await commitDbState({ ...c.s, db: c.peer }), issue };
}
export async function correctionRows(c: C02Case) {
  const wakes = await c.peer.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, c.ref.companyId), eq(agentWakeupRequests.idempotencyKey, qaCorrectionWakeKey(c.ref))))
    .orderBy(asc(agentWakeupRequests.id));
  const heartbeats = await c.peer.select().from(heartbeatRuns).where(
    sql`${heartbeatRuns.wakeupRequestId} IN (SELECT id FROM agent_wakeup_requests WHERE company_id = ${c.ref.companyId}
      AND idempotency_key = ${qaCorrectionWakeKey(c.ref)})`);
  const receipts = await c.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, c.ref.companyId), eq(workflowTransitionEvents.eventType, "qa_correction_followup_delivered")));
  return { wakes, heartbeats, receipts };
}
export async function blockDelivery(c: C02Case, i: CorrectionDeliveryInput, mode: "queued" | "deferred") {
  if (mode === "queued") {
    await c.peer.update(agents).set({ status: "paused" }).where(eq(agents.id, i.agentId));
    return async () => {
      await c.peer.update(agents).set({ status: "active" }).where(eq(agents.id, i.agentId));
    };
  }
  // Controlled pre-existing busy work only; this is not a correction delivery/receipt fixture.
  const [busy] = await c.peer.insert(heartbeatRuns).values({ companyId: i.companyId, agentId: i.agentId,
    issueId: i.issueId, status: "running", contextSnapshot: { issueId: i.issueId, missionId: i.missionId } }).returning();
  await c.peer.update(issues).set({ executionRunId: busy!.id }).where(eq(issues.id, i.issueId));
  return async () => {
    await c.peer.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, busy!.id));
    await c.peer.update(issues).set({ executionRunId: null }).where(eq(issues.id, i.issueId));
  };
}

/** Actual PostgreSQL wait chains, including an indirect second waiter, with two distinct backend PIDs. */
export async function waitForDeliveryLocks(observer: Db, holderPid: number, count: number) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const rows = await observer.execute(sql`SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`);
    const reaches = (pid: number, seen = new Set<number>()): boolean => {
      if (pid === holderPid) return true;
      if (seen.has(pid)) return false;
      const row = rows.find(r => Number(r.pid) === pid);
      return !!row && (row.blockers as number[]).some(p => reaches(Number(p), new Set(seen).add(pid)));
    };
    const waiting = rows.filter(r => /from\s+"?(workflow_runs|quality_policy_usage|quality_action_groups|quality_actions|quality_policy_versions)"?\s/i.test(String(r.query))
      && /for\s+(no\s+key\s+update|update|share)/i.test(String(r.query)) && reaches(Number(r.pid)));
    const pids = new Set(waiting.map(r => Number(r.pid)));
    if (pids.size === count) return [...pids];
    if (Date.now() >= deadline) throw Error("actual delivery wait chain missing");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
export async function invalidateDelivery(c: C02Case, i: CorrectionDeliveryInput, fault: string) {
  if (fault === "cancel") await c.peer.update(missions).set({ status: "cancelled" }).where(eq(missions.id, i.missionId));
  if (fault === "binding") await c.peer.update(workflowStepOutputBindings).set({ workProductId: c.s.productId })
    .where(eq(workflowStepOutputBindings.id, c.s.f.bindingId));
  if (fault === "owner") {
    const [h] = await c.peer.insert(heartbeatRuns).values({ companyId: i.companyId, agentId: i.agentId,
      issueId: i.issueId, status: "running" }).returning();
    await c.peer.update(issues).set({ executionRunId: h!.id }).where(eq(issues.id, i.issueId));
  }
  if (fault === "terminal") await c.peer.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, i.workflowRunId));
  if (fault === "quality") {
    if (c.s.p.authority.kind !== "quality_current_output") throw Error("quality fixture required");
    await c.peer.update(qualityActions).set({ cancelRequestedAt: new Date() }).where(eq(qualityActions.id, c.s.p.authority.actionId));
  }
}
export async function corruptDelivery(c: C02Case, fault: string) {
  const { wakes, heartbeats, receipts } = await correctionRows(c), w = wakes[0]!, h = heartbeats[0]!, r = receipts[0]!;
  if (!w || !h || !r) throw Error("corruption requires actual delivered records first");
  if (fault === "proof") await c.peer.update(agentWakeupRequests).set({ payload: {
    ...w.payload, __paperclipWorkflowProducerAttempt: { ...parseObject(w.payload?.__paperclipWorkflowProducerAttempt), retryCount: 999 } } })
    .where(eq(agentWakeupRequests.id, w.id));
  if (fault === "target") await c.peer.update(agentWakeupRequests).set({ issueId: c.s.p.producer.issueId }).where(eq(agentWakeupRequests.id, w.id));
  if (fault === "backref") await c.peer.update(heartbeatRuns).set({ wakeupRequestId: c.s.f.verdictWakeId }).where(eq(heartbeatRuns.id, h.id));
  if (fault === "time") await c.peer.execute(sql`UPDATE workflow_transition_events
    SET created_at = created_at + interval '1 microsecond' WHERE id = ${r.id}`);
  if (fault === "order") await c.peer.execute(sql`UPDATE agent_wakeup_requests SET requested_at =
    (SELECT created_at - interval '1 microsecond' FROM workflow_transition_events WHERE id = ${c.followupRow.id}) WHERE id = ${w.id}`);
  if (fault === "duplicate_wake") {
    const { id: _id, ...copy } = w;
    await c.peer.insert(agentWakeupRequests).values(copy);
  }
  if (fault === "duplicate_hb") {
    const { id: _id, ...copy } = h;
    await c.peer.insert(heartbeatRuns).values(copy);
  }
  if (fault === "context") await c.peer.update(agentWakeupRequests).set({ reason: "issue_execution_promoted",
    payload: { ...w.payload, _paperclipWakeContext: {} } }).where(eq(agentWakeupRequests.id, w.id));
}

/** A genuine same-key violation inside receipt insertion; all trigger effects must roll back too. */
export async function installReceiptCollision(c: C02Case) {
  const name = "c02_" + randomUUID().replaceAll("-", "");
  await c.peer.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $c02$
    BEGIN IF NEW.company_id = '${c.ref.companyId}'::uuid
      AND NEW.event_type = 'qa_correction_followup_delivered' AND pg_trigger_depth() = 1 THEN
      INSERT INTO workflow_transition_events(company_id, mission_id, workflow_run_id, workflow_step_run_id,
        issue_id, wakeup_request_id, heartbeat_run_id, execution_generation, event_type, layer, idempotency_key, payload, created_at)
      VALUES (NEW.company_id, NEW.mission_id, NEW.workflow_run_id, NEW.workflow_step_run_id, NEW.issue_id,
        NEW.wakeup_request_id, NEW.heartbeat_run_id, NEW.execution_generation, NEW.event_type,
        NEW.layer, NEW.idempotency_key, NEW.payload, NEW.created_at);
    END IF; RETURN NEW; END; $c02$`));
  await c.peer.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON workflow_transition_events
    FOR EACH ROW EXECUTE FUNCTION ${name}()`));
  return async () => {
    await c.peer.execute(sql.raw(`DROP TRIGGER ${name} ON workflow_transition_events`));
    await c.peer.execute(sql.raw(`DROP FUNCTION ${name}()`));
  };
}
