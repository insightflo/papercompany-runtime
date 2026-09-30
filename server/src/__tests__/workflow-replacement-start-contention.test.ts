import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { workflowRuns, workflowStepRuns, workflowRecoveryAuthorities } from "@paperclipai/db";
import { replacementAcceptanceFixture } from "./helpers/replacement-acceptance-fixture.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { executeWorkflowRunWithStartOutcome } from "../services/workflow/workflow-run-execution.js";
import { reconcileReplacementStarts } from "../services/workflow/replacement-start-reconciler.js";

describe("replacement pending start PostgreSQL contention", () => {
  const fixture = replacementAcceptanceFixture();
  it('same pending target: real normal start plus two reconcilers overlap on PostgreSQL locks; one claim/materialization/queue', async () => {
    const { db, executor } = fixture;
    const s = await fixture.seed();
    const target = (await admitReplacement(db, s.input, s.actor)).run;
    expect(target.status).toBe('pending'); expect(target.startedAt).toBeNull();
    // Trigger audit observes actual committed transitions and detects timestamp rewrites even with equal status.
    await db.$client.unsafe(`CREATE TABLE p10_start_audit(kind text, row_id uuid, stamp timestamptz);
      CREATE FUNCTION p10_watch_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_TABLE_NAME='workflow_runs' THEN
          IF NEW.id='${target.id}'::uuid THEN
            IF OLD.status='pending' AND NEW.status='running' THEN INSERT INTO p10_start_audit VALUES ('claim', NEW.id, NEW.started_at); END IF;
            IF NEW.started_at IS DISTINCT FROM OLD.started_at THEN INSERT INTO p10_start_audit VALUES ('started_at_write', NEW.id, NEW.started_at); END IF;
          END IF;
        ELSIF TG_TABLE_NAME='workflow_step_runs' THEN
          IF NEW.workflow_run_id='${target.id}'::uuid THEN
            IF TG_OP='INSERT' THEN INSERT INTO p10_start_audit VALUES ('step_insert', NEW.id, NULL); END IF;
            IF NEW.last_dispatch_request_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.last_dispatch_request_id IS DISTINCT FROM OLD.last_dispatch_request_id) THEN
              INSERT INTO p10_start_audit VALUES ('queue_request', NEW.id, NULL);
            END IF;
          END IF;
        END IF; RETURN NEW; END $$;
      CREATE TRIGGER p10_watch_run AFTER UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION p10_watch_start();
      CREATE TRIGGER p10_watch_step AFTER INSERT OR UPDATE ON workflow_step_runs FOR EACH ROW EXECUTE FUNCTION p10_watch_start()`);
    const names = ['p10-normal', 'p10-reconciler-1', 'p10-reconciler-2'];
    const peers = names.map(name => fixture.peer(name));
    let unlock!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.execute(sql`select id from missions where id=${s.mission.id} for update`);
      locked(); await gate;
    });
    await ready;
    const calls = [executeWorkflowRunWithStartOutcome(peers[0], target.id), reconcileReplacementStarts(peers[1]), reconcileReplacementStarts(peers[2])];
    const joined = Promise.allSettled(calls);
    let waiters: { application_name: string; query: string }[] = [];
    try {
      const deadline = Date.now() + 15000;
      do {
        waiters = await db.$client.unsafe<typeof waiters>(`select application_name, pid, wait_event_type, wait_event, query from pg_stat_activity
          where application_name = ANY($1::text[]) and wait_event_type='Lock'`, [names]);
        if (waiters.length === 3) break;
        await new Promise(r => setTimeout(r, 20));
      } while (Date.now() < deadline);
      expect(waiters.map(w => w.application_name).sort()).toEqual([...names].sort());
      expect(waiters.every(w => /missions/.test(w.query) && /for update/i.test(w.query))).toBe(true);
      console.log('P10-2 actual DB overlap', waiters);
    } finally { unlock(); await blocker; }
    const settled = await joined;
    expect(settled.every(r => r.status === 'fulfilled')).toBe(true);
    const outcomes = settled.flatMap(r => r.status === 'fulfilled' ? (Array.isArray(r.value) ? r.value : [r.value]) : []);
    expect(outcomes.map(r => r.kind).sort()).toEqual(['busy', 'busy', 'started']);
    const [started] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, target.id));
    expect(started.startedAt).toBeInstanceOf(Date);
    expect(started.metadata?.replacementStart).toMatchObject({ schemaVersion: 1, deliveredAt: expect.any(String) });
    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.stepId)).size).toBe(2);
    const queued = rows.filter(r => r.metadata?.toolQueue?.status === 'queued');
    expect(queued).toHaveLength(1); expect(queued[0].lastDispatchRequestId).toBeTruthy();
    await executeWorkflowRunWithStartOutcome(peers[0], target.id);
    await reconcileReplacementStarts(peers[1]); await reconcileReplacementStarts(peers[2]);
    const [after] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, target.id));
    expect(after.startedAt).toEqual(started.startedAt);
    expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id))).toEqual(rows);
    const audit = await db.$client.unsafe('select kind, count(*)::int as count from p10_start_audit group by kind order by kind');
    expect(Object.fromEntries(audit.map(r => [r.kind, r.count]))).toEqual({ claim: 1, started_at_write: 1, step_insert: 2, queue_request: 1 });
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, s.companyId))).toHaveLength(2);
    expect(await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, s.run.id))).toHaveLength(1);
    expect(executor).not.toHaveBeenCalled();
    console.log('P10-2 evidence', { target: target.id, outcomes: outcomes.map(r => r.kind), audit, startedAt: after.startedAt,
      materializedSteps: rows.map(r => r.stepId), queuedRequest: queued[0].lastDispatchRequestId, adapterCalls: executor.mock.calls.length });
  }, 30_000);
});
