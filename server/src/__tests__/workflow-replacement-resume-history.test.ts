import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { heartbeatRuns, workflowRuns, workflowStepRuns, workflowRecoveryAuthorities, workflowTerminalDecisions } from "@paperclipai/db";
import { replacementAcceptanceFixture } from "./helpers/replacement-acceptance-fixture.js";
import { recoverTerminalRun } from "../services/workflow/run-recovery-authority.js";
import { resumeWorkflowRun } from "../services/workflow/workflow-store.js";
import { finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { proposeReplacement, approveReplacement } from "../services/workflow/replacement-approval.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";

describe("replacement fences historical resume authority", () => {
  const fixture = replacementAcceptanceFixture();
  it('actual resume@0 -> legitimate terminal@1 -> current owner+board replace@1 -> old resume receipt refused, zero writes', async () => {
    const { db } = fixture;
    const s = await fixture.seed();
    // Actual formal resume core called by workflow-store.resumeWorkflowRun; no authority row is fabricated.
    const oldCommand = { runId: s.run.id, companyId: s.companyId, expectedAuthorityVersion: 0,
      expectedDecision: 'failed', recoveryKind: 'manual_resume' as const,
      requestReference: 'p10-original-resume-at-zero', requestedBy: 'board', now: new Date() };
    const resumed = await recoverTerminalRun(db, oldCommand);
    expect(resumed.kind).toBe('recovered');
    if (resumed.kind !== 'recovered') throw new Error('resume did not execute');
    expect(resumed.run).toMatchObject({ id: s.run.id, status: 'running', dispatchAuthorityVersion: 1 });
    expect(resumed.authority).toMatchObject({ targetAuthorityVersion: 0, resultingAuthorityVersion: 1, replacementRunId: null });
    expect(await recoverTerminalRun(db, oldCommand)).toMatchObject({ kind: 'already_consumed', authority: { id: resumed.authority.id } });
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.run.id));
    const terminal = await finalizeRunTerminal(db, { runId: s.run.id, companyId: s.companyId,
      expectedAuthorityVersion: 1, decision: 'failed', gatePolicy: 'immediate', now: new Date(), stepRuns: steps,
      cause: { policy: 'recovery_deadline_hard', discovery: 'stuck_diagnostic', origin: 'reconciler', reason: 'P10 resumed attempt failed' } });
    expect(terminal.kind).toBe('finalized');
    const [failed] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.run.id));
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    expect(failed).toMatchObject({ status: 'failed', dispatchAuthorityVersion: 1 });
    expect(step.executionGeneration).toBe(2); // real resume + real terminal fencing
    const decisions = await db.select().from(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.workflowRunId, s.run.id));
    expect(decisions.map(d => d.decidedAuthorityVersion).sort()).toEqual([0, 1]);
    const heartbeatId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId: s.companyId, agentId: s.mission.ownerAgentId,
      issueId: s.recoveryIssueId, invocationSource: 'manual', status: 'succeeded', finishedAt: new Date() });
    const owner = await recordMissionOwnerDecision({ db,
      issue: { id: s.recoveryIssueId, companyId: s.companyId, missionId: s.mission.id }, heartbeatRunId: heartbeatId,
      submission: { decision: 'restart_from_start', recoveryTarget: { kind: 'tool_step', workflowRunId: s.run.id,
        stepRunId: step.id, expectedAuthorityVersion: failed.dispatchAuthorityVersion,
        expectedExecutionGeneration: step.executionGeneration, failedDispatchRequestId: step.lastDispatchRequestId } } });
    const proposal = await proposeReplacement(db, s.companyId, s.board, { sourceRunId: s.run.id,
      decisionEventId: owner.eventId, idempotencyKey: 'p10-replace-at-one', metadata: {}, externalEffects: 'operator_reconciled' });
    await approveReplacement(db, s.companyId, proposal.id, s.board);
    const replaced = await admitReplacement(db, { ...s.input, replacementIntent: { schemaVersion: 1,
      sourceRunId: s.run.id, expectedSourceAuthorityVersion: 1, decisionEventId: owner.eventId,
      approvalId: proposal.id, idempotencyKey: 'p10-replace-at-one' } }, s.actor);
    expect(replaced.replay).toBe(false);
    const receipts = await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, s.run.id));
    expect(receipts).toHaveLength(2);
    expect(receipts.find(r => r.targetAuthorityVersion === 0)?.id).toBe(resumed.authority.id);
    expect(receipts.find(r => r.targetAuthorityVersion === 1)).toMatchObject({ recoveryKind: 'replacement_from_start_v1',
      replacementRunId: replaced.run.id, resultingAuthorityVersion: 1, status: 'consumed' });
    // A database tripwire proves zero attempted DML, not only equal final snapshots.
    await db.$client.unsafe(`CREATE FUNCTION p10_refuse_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'P10_UNEXPECTED_WRITE'; END $$`);
    const guarded = ['workflow_runs', 'workflow_step_runs', 'issues', 'agent_wakeup_requests', 'heartbeat_runs', 'workflow_recovery_authorities'];
    for (const t of guarded) await db.$client.unsafe(`CREATE TRIGGER p10_no_write BEFORE INSERT OR UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION p10_refuse_write()`);
    try {
      const before = await fixture.snapshot(s.companyId);
      await expect(recoverTerminalRun(db, oldCommand)).rejects.toThrow('workflow_run_replaced');
      expect(await fixture.snapshot(s.companyId)).toEqual(before);
      await expect(resumeWorkflowRun(db, s.run.id, s.companyId)).rejects.toThrow('workflow_run_replaced');
      expect(await fixture.snapshot(s.companyId)).toEqual(before);
    } finally {
      for (const t of guarded) await db.$client.unsafe(`DROP TRIGGER p10_no_write ON ${t}`);
      await db.$client.unsafe('DROP FUNCTION p10_refuse_write()');
    }
    console.log('P10-1 evidence', { source: s.run.id, resumeVersion: 0, failedVersion: 1, replacement: replaced.run.id,
      authorityVersions: receipts.map(r => r.targetAuthorityVersion), oldReceiptRefused: true, writes: 0 });
  }, 30_000);
});
