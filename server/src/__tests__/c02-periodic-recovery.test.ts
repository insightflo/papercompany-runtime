import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, costEvents, heartbeatRuns, issues, missions,
  workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { createNativeWorkflowReconciler } from "../services/workflow/native-reconciler.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { hasWorkflowValidationCompletionLedger } from "../services/workflow/validation-verdict-ledger.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { qaCorrectionDeliverySchema } from "../services/workflow/control-flow/qa-correction-contract.js";
import { createCommitSourceHarness, issueC02 } from "./helpers/c02-fixture.js";
import { commitDbState } from "./qa-correction-commit-fixture.js";
import { correctionRows } from "./helpers/c02-delivery-fixture.js";
import {
  createFrozenRun, seedCompanyWithMission, seedWorkflowDefinition,
} from "./helpers/workflow-frozen-execution-fixture.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

// Only external model execution is replaced. DB, issuance, queue, claims and drains stay real.
const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async original => ({
  ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
}));
const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn("Skipping C02 periodic recovery:", support.reason);
const succeeded = {
  exitCode: 0, signal: null, timedOut: false, usage: null, provider: "test",
  model: "test", resultJson: null, runtimeServices: [],
};

describeEP("C02/C12 14B: periodic recovery of issued requests", () => {
  // C02 requires recovery both before durable enqueue and after enqueue loses its drain.
  // A new reconciler/root connection must use only persisted state, never the old notification set.
  it.each(["request", "delivery"] as const)("recovers a lost %s with one issued request and execution", async fault => {
    const owned = await createCommitSourceHarness();
    const roots: Db[] = [owned.db];
    let release = () => {};
    let removeFault = async () => {};
    adapter.mockReset();
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "periodic-storage"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
    try {
      const c = await issueC02(owned, { mode: "content-only" });
      const { s, peer } = c, target = c.followup.target;
      const [origin] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.verdictHeartbeatId));
      const now = new Date();
      await peer.update(agentWakeupRequests).set({ status: "completed" })
        .where(eq(agentWakeupRequests.companyId, s.p.companyId));
      await peer.update(issues).set({ completedAt: s.f.producer.completedAt })
        .where(eq(issues.id, s.p.producer.issueId));
      await peer.update(issues).set({ status: "done", completedAt: now, assigneeAgentId: origin!.agentId })
        .where(eq(issues.id, target.issueId));
      await peer.update(workflowStepRuns).set({ status: "running", completedAt: null })
        .where(eq(workflowStepRuns.id, target.stepRunId));
      await peer.update(workflowRuns).set({ startedAt: now }).where(eq(workflowRuns.id, c.ref.workflowRunId));
      await peer.update(agents).set({
        status: "active", adapterType: "codex_local", adapterConfig: { cwd: owned.root },
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      }).where(eq(agents.id, origin!.agentId));
      const held = new Promise<void>(resolve => { release = resolve; });
      const executed: Array<{ heartbeatRunId: string; wakeupRequestId: string; agentId: string; ref: unknown }> = [];
      adapter.mockImplementation(async (ctx: { runId: string; agent: { id: string } }) => {
        const [run] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ctx.runId));
        const [wake] = await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run!.wakeupRequestId!));
        const rows = await correctionRows(c);
        expect(rows.receipts).toHaveLength(1);
        expect(rows.receipts[0]!.heartbeatRunId).toBe(ctx.runId);
        // An independent connection can see delivery and take the locks before the model starts.
        await peer.transaction(async tx => {
          await tx.execute(sql`select id from missions where id=${s.p.missionId} for update nowait`);
          await tx.execute(sql`select id from workflow_runs where id=${c.ref.workflowRunId} for update nowait`);
        });
        executed.push({ heartbeatRunId: ctx.runId, wakeupRequestId: wake!.id,
          agentId: ctx.agent.id, ref: wake!.payload?.qaCorrectionFollowup });
        await held;
        return succeeded;
      });
      const state = () => commitDbState({ ...s, db: peer });
      const costs = () => peer.select().from(costEvents).where(eq(costEvents.companyId, s.p.companyId)).orderBy(costEvents.id);
      const before = await state(), costBefore = await costs();
      expect(before.events.filter(e => e.eventType === "qa_correction_followup_requested")).toHaveLength(1);
      expect(before.events.filter(e => e.id === c.ref.appliedEventId)).toHaveLength(1);
      const correctionEvents = (snapshot: typeof before) => snapshot.events.filter(e =>
        e.eventType.startsWith("qa_correction_") || e.idempotencyKey?.startsWith("qa-correction-applied:"));
      const preserved = async () => {
        const after = await state();
        for (const key of ["products", "pins", "usage", "groups", "receipts"] as const) {
          expect(after[key]).toEqual(before[key]);
        }
        expect(correctionEvents(after).filter(e => e.eventType !== "qa_correction_followup_delivered"))
          .toEqual(correctionEvents(before));
        expect(await costs()).toEqual(costBefore);
        return after;
      };
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const gate = "c02_periodic_" + randomUUID().replaceAll("-", "");
      const table = fault === "request" ? "agent_wakeup_requests" : "heartbeat_runs";
      const predicate = fault === "request"
        ? "NEW.idempotency_key = 'qa-correction-wake:" + c.ref.requestId + "'"
        : "NEW.issue_id = '" + target.issueId + "'::uuid";
      await peer.execute(sql.raw(`CREATE FUNCTION ${gate}() RETURNS trigger LANGUAGE plpgsql AS $c02$
        BEGIN IF ${predicate} THEN RAISE EXCEPTION 'C02 periodic delivery loss'; END IF; RETURN NEW; END $c02$;
        CREATE TRIGGER ${gate} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${gate}();`));
      removeFault = async () => {
        await peer.execute(sql.raw(`DROP TRIGGER ${gate} ON ${table}; DROP FUNCTION ${gate}();`));
        removeFault = async () => {};
      };
      const original = createNativeWorkflowReconciler({ db: owned.db, logger });
      await original.reconcile();
      expect(original.getState().tickCount).toBe(1);
      const lost = await correctionRows(c);
      expect([lost.wakes.length, lost.heartbeats.length, lost.receipts.length])
        .toEqual([fault === "request" ? 0 : 1, 0, 0]);
      expect(adapter).not.toHaveBeenCalled();
      await preserved();
      await removeFault();

      const restartedDb = owned.connect();
      roots.push(restartedDb);
      const [rootPid] = await restartedDb.$client`select pg_backend_pid() as pid`;
      const [peerPid] = await peer.$client`select pg_backend_pid() as pid`;
      expect(rootPid!.pid).not.toBe(peerPid!.pid);
      const restarted = createNativeWorkflowReconciler({ db: restartedDb, logger });
      await restarted.reconcile();
      await vi.waitFor(() => expect(executed).toHaveLength(1), { timeout: 5000 });
      const delivered = await correctionRows(c);
      expect([delivered.wakes.length, delivered.heartbeats.length, delivered.receipts.length]).toEqual([1, 1, 1]);
      const receipt = qaCorrectionDeliverySchema.parse(delivered.receipts[0]!.payload);
      expect(receipt).toMatchObject({ ref: c.ref, followupEventId: c.followupRow.id });
      expect(delivered.wakes[0]).toMatchObject({
        id: receipt.wakeupRequestId, runId: receipt.heartbeatRunId, agentId: origin!.agentId,
        idempotencyKey: "qa-correction-wake:" + c.ref.requestId,
        payload: { qaCorrectionFollowup: c.ref },
      });
      if (lost.wakes.length) expect(receipt.wakeupRequestId).toBe(lost.wakes[0]!.id);
      expect(delivered.heartbeats[0]).toMatchObject({
        id: receipt.heartbeatRunId, wakeupRequestId: receipt.wakeupRequestId,
        workflowStepRunId: target.stepRunId, workflowExecutionGeneration: target.executionGeneration,
      });
      expect(executed).toEqual([{ heartbeatRunId: receipt.heartbeatRunId,
        wakeupRequestId: receipt.wakeupRequestId, agentId: origin!.agentId, ref: c.ref }]);
      await restarted.reconcile();
      await createNativeWorkflowReconciler({ db: restartedDb, logger }).reconcile();
      expect(await correctionRows(c)).toEqual(delivered);
      expect(adapter).toHaveBeenCalledTimes(1);
      await preserved();

      release();
      for (const db of roots) await waitForHeartbeatExecutionsToDrain(db);
      // Assert again after real settlement, so an extra ordinary retry cannot hide after the hold.
      await restarted.reconcile();
      for (const db of roots) await waitForHeartbeatExecutionsToDrain(db);
      const finished = await correctionRows(c), after = await preserved();
      expect([finished.wakes.length, finished.heartbeats.length, finished.receipts.length]).toEqual([1, 1, 1]);
      expect(finished.wakes[0]!.id).toBe(receipt.wakeupRequestId);
      expect(finished.heartbeats[0]).toMatchObject({ id: receipt.heartbeatRunId, status: "succeeded" });
      expect(finished.heartbeats[0]!.finishedAt).toBeInstanceOf(Date);
      expect(after.heartbeats).toHaveLength(before.heartbeats.length + 1);
      expect(after.wakes).toHaveLength(before.wakes.length + 1);
      expect(after.events.filter(e => e.eventType === "qa_correction_followup_consumed")).toHaveLength(0);
      expect(after.events.filter(e => e.eventType === "workflow_validation_verdict"
        && e.heartbeatRunId === receipt.heartbeatRunId)).toHaveLength(0);
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(executed).toHaveLength(1);
      console.info("C02 periodic recovery evidence", JSON.stringify({
        fault, ref: c.ref, lostWakeId: lost.wakes[0]?.id ?? null, receipt,
        rootPid: rootPid!.pid, peerPid: peerPid!.pid, executed, drained: true,
      }));
    } finally {
      release();
      try { await removeFault(); }
      finally {
        try { for (const db of roots) await waitForHeartbeatExecutionsToDrain(db); }
        finally { adapter.mockReset(); vi.unstubAllEnvs(); await owned.close(); }
      }
    }
  }, 120000);

  // C12 preservation: a successful same-generation recheck still deduplicates without a PASS.
  // Later-finishing A must not hide that valid recheck when choosing successful start evidence.
  it("preserves same-generation suppression even when an older A finishes last", async () => {
    const owned = await createCommitSourceHarness(), db = owned.db, peer = owned.connect();
    adapter.mockReset().mockResolvedValue(succeeded);
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "same-generation-storage"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
    try {
      const { companyId, agentId, missionId } = await seedCompanyWithMission(db.$client, "C02P");
      await db.update(missions).set({ status: "active" }).where(eq(missions.id, missionId));
      const workflowId = await seedWorkflowDefinition(db.$client, {
        companyId, name: "C02 same generation", stepsJson: [
          { id: "produce", name: "Produce", agentId, dependencies: [] },
          { id: "qa", type: "qa", qaType: "semantic", name: "[QA] Check", agentId, dependencies: ["produce"] },
        ],
      });
      const run = await createFrozenRun(db, { workflowId, companyId, missionId });
      await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, run.id));
      const rejectedAt = new Date("2026-06-18T07:10:00Z");
      const completedAt = new Date("2026-06-18T07:15:00Z");
      const [producerIssue, qaIssue] = await db.insert(issues).values([
        { companyId, missionId, title: "Produce", status: "done", assigneeAgentId: agentId,
          originKind: "workflow_execution", completedAt },
        { companyId, missionId, title: "[QA] Check", status: "blocked", assigneeAgentId: agentId,
          originKind: "workflow_execution" },
      ]).returning();
      const steps = await db.insert(workflowStepRuns).values([
        { workflowRunId: run.id, stepId: "produce", issueId: producerIssue!.id, status: "completed", completedAt },
        { workflowRunId: run.id, stepId: "qa", issueId: qaIssue!.id, status: "failed", completedAt: rejectedAt },
      ]).returning();
      const qa = steps.find(s => s.stepId === "qa")!;
      const [authority] = await db.insert(heartbeatRuns).values({
        companyId, agentId, issueId: qaIssue!.id, status: "succeeded",
        startedAt: new Date("2026-06-18T07:09:00Z"), finishedAt: rejectedAt,
      }).returning();
      await db.insert(workflowTransitionEvents).values({
        companyId, missionId, workflowRunId: run.id, workflowStepRunId: qa.id, issueId: qaIssue!.id,
        heartbeatRunId: authority!.id, eventType: "workflow_validation_verdict", layer: "workflow_validation",
        verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
        createdAt: rejectedAt, idempotencyKey: "c02-periodic-rejection:" + qa.id,
        payload: { kind: "workflow_validation_verdict", workflowRunId: run.id, stepRunId: qa.id,
          issueId: qaIssue!.id, verdict: "request_changes", diagnostics: [] },
      });
      const successes = await db.insert(heartbeatRuns).values([
        { companyId, agentId, issueId: qaIssue!.id, status: "succeeded",
          startedAt: completedAt, finishedAt: new Date("2026-06-18T07:16:00Z") },
        { companyId, agentId, issueId: qaIssue!.id, status: "succeeded",
          startedAt: new Date("2026-06-18T07:14:00Z"), finishedAt: new Date("2026-06-18T07:17:00Z") },
      ]).returning();
      expect(await hasWorkflowValidationCompletionLedger({ db, issue: qaIssue! })).toMatchObject({
        isCandidate: true, satisfied: true, verdict: "request_changes",
        workflowRunId: run.id, workflowStepRunId: qa.id,
      });
      const wakesBefore = await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      for (let pass = 0; pass < 2; pass++) await syncWorkflowRunState(db, run.id);
      await waitForHeartbeatExecutionsToDrain(db);
      expect(await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual(wakesBefore);
      expect(adapter).not.toHaveBeenCalled();
      const verdicts = await peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.workflowRunId, run.id),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      ));
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]!.heartbeatRunId).toBe(authority!.id);
      expect(verdicts.every(v => successes.every(h => h.id !== v.heartbeatRunId))).toBe(true);
    } finally {
      try { await waitForHeartbeatExecutionsToDrain(db); }
      finally { adapter.mockReset(); vi.unstubAllEnvs(); await owned.close(); }
    }
  }, 120000);
});
