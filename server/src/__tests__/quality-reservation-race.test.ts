// C03/C12: the existing company-period attempt cap is one shared budget across groups.
// Real independent PostgreSQL backends must be observed waiting before either contender is released.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  applyPendingMigrations, createDb, qualityActionGroups, qualityActions, qualityPolicyUsage,
  qualityPolicyVersions, workflowRuns, workflowStepRuns, type Db,
} from "@paperclipai/db";
import { seedQualityFixture } from "./helpers/quality-fixture.js";
import { hashContract } from "../services/quality/contract.js";
import { lockQualityAttemptBudget, reserveQualityRetryUsage } from "../services/quality/retry-budget.js";
import { ensureCanonicalQualityExecution } from "../services/quality/native-records.js";
import { scheduleWorkflowStepRetry } from "../services/workflow/step-retry-scheduler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 4_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("quality_race_wait_not_observed");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe("quality reservation serialization", () => {
  let instance: EmbeddedPostgres | undefined;
  let directory = "";
  const clients: Db[] = [];
  let db: Db, first: Db, second: Db, watcher: Db;
  beforeAll(async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const listener = net.createServer();
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        const address = listener.address();
        listener.close(error => {
          if (error) reject(error);
          else if (!address || typeof address === "string") reject(new Error("quality_race_no_port"));
          else resolve(address.port);
        });
      });
    });
    if ([54329, 55432].includes(port)) throw new Error("quality_race_forbidden_port");
    directory = await mkdtemp(path.join(os.tmpdir(), "quality-reservation-race-"));
    instance = new EmbeddedPostgres({
      databaseDir: directory, port, user: "paperclip", password: "paperclip", persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      onLog: () => {}, onError: () => {},
    });
    await instance.initialise();
    await instance.start();
    const url = "postgres://paperclip:paperclip@127.0.0.1:" + port + "/postgres";
    await applyPendingMigrations(url);
    for (let index = 0; index < 4; index++) clients.push(createDb(url));
    [db, first, second, watcher] = clients as [Db, Db, Db, Db];
  }, 180_000);
  afterAll(async () => {
    const results = await Promise.allSettled(clients.map(client => client.$client.end({ timeout: 5 })));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    let stopped = !instance;
    try { await instance?.stop(); stopped = true; } catch (error) { errors.push(error); }
    if (stopped && directory) {
      try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "quality race cleanup failed");
  });

  it.each([0, 1])("reserves the last slot exactly once with %i pre-existing attempts", async initialAttempts => {
    const seeded = await seedQualityFixture(db);
    const [original] = await db.select().from(qualityActions).where(eq(qualityActions.id, seeded.actionId));
    const [group] = await db.select().from(qualityActionGroups).where(eq(qualityActionGroups.id, seeded.groupId));
    const [policy] = await db.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.id, seeded.policyVersionId));
    if (original!.target.kind !== "qa_addendum" || original!.effect.kind !== "hold") throw new Error("unexpected fixture");
    const groupId = randomUUID(), actionId = randomUUID(), intentKey = "race-" + actionId;
    const target = { ...original!.target, intentKey }, effect = { ...original!.effect, target };
    const maxExecutorAttempts = initialAttempts + 1;
    await db.update(qualityActions).set({ retryEnvelope: { ...original!.retryEnvelope, maxExecutorAttempts } })
      .where(eq(qualityActions.id, seeded.actionId));
    await db.insert(qualityActionGroups).values({ ...group!, id: groupId, rootOccurrenceSetHash: "22".repeat(32) });
    await db.insert(qualityActions).values({
      ...original!, id: actionId, groupId, intentKey, target, effect, occurrenceSetHash: "22".repeat(32),
      targetHash: hashContract(target), effectHash: hashContract(effect),
      retryEnvelope: { ...original!.retryEnvelope, groupId, intentKey, maxExecutorAttempts,
        targetHash: hashContract(target), effectHash: hashContract(effect) },
    });
    const actionIds = [seeded.actionId, actionId], groupIds = [seeded.groupId, groupId];
    const input = { companyId: seeded.companyId, actionId: seeded.actionId, now: new Date() };
    if (initialAttempts) await db.transaction(tx => reserveQualityRetryUsage(tx, input));
    const before = await db.select().from(qualityPolicyUsage).where(eq(qualityPolicyUsage.companyId, seeded.companyId));
    expect(before).toHaveLength(initialAttempts ? 1 : 0);
    const control = await db.$client.reserve(), observer = await watcher.$client.reserve();
    const start = deferred<void>(), ready = [deferred<number>(), deferred<number>()];
    let gate: "row" | "advisory" | null = null;
    let jobs: Promise<PromiseSettledResult<void>[]> | undefined;
    const finished = [false, false];
    try {
      const [controller] = await control`select pg_backend_pid() as pid`;
      const [reader] = await observer`select pg_backend_pid() as pid`;
      if (initialAttempts) {
        await control`begin`; gate = "row";
        await control`select id from quality_policy_usage where company_id = ${seeded.companyId} for update`;
      } else {
        await control.unsafe(`CREATE FUNCTION public.quality_reservation_gate() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock_shared(73004, 1); RETURN NEW; END $$`);
        await control.unsafe(`CREATE TRIGGER quality_reservation_gate BEFORE INSERT ON public.quality_policy_usage
          FOR EACH ROW WHEN (NEW.company_id = '${seeded.companyId}'::uuid)
          EXECUTE FUNCTION public.quality_reservation_gate()`);
        await control`select pg_advisory_lock(73004, 1)`; gate = "advisory";
      }
      jobs = Promise.allSettled([first, second].map((client, index) => client.transaction(async tx => {
        await tx.execute(sql`set local statement_timeout = '6s'`);
        const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
        ready[index]!.resolve(Number(backend!.pid));
        await start.promise;
        await reserveQualityRetryUsage(tx, { ...input, actionId: actionIds[index]! });
      }).catch(error => { ready[index]!.reject(error); throw error; }).finally(() => { finished[index] = true; })));
      const pids = await Promise.all(ready.map(item => item.promise));
      expect(new Set([...pids, Number(controller!.pid), Number(reader!.pid)]).size).toBe(4);
      start.resolve();
      await until(async () => {
        if (finished.some(Boolean)) throw new Error("quality_race_finished_before_wait");
        const rows = await observer`select pid, state, wait_event_type, query, pg_blocking_pids(pid) as blockers
          from pg_stat_activity where pid in (${pids[0]!}, ${pids[1]!})`;
        if (rows.length !== 2 || !rows.every(row => row.state === "active" && row.wait_event_type === "Lock")) return false;
        const reachesGate = (pid: number, seen = new Set<number>()): boolean => {
          if (pid === Number(controller!.pid)) return true;
          if (seen.has(pid)) return false;
          const row = rows.find(row => Number(row.pid) === pid);
          return !!row && (row.blockers as number[]).some(next => reachesGate(Number(next), new Set(seen).add(pid)));
        };
        return pids.every(pid => reachesGate(pid)) && rows.some(row => /quality_policy_usage/.test(String(row.query)));
      });
      if (gate === "row") await control`commit`;
      else expect((await control`select pg_advisory_unlock(73004, 1) as ok`)[0]!.ok).toBe(true);
      gate = null;
      const settled = await jobs;
      expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason.message).toBe("quality_execution_attempts_exhausted");
      const usage = await db.select().from(qualityPolicyUsage).where(eq(qualityPolicyUsage.companyId, seeded.companyId));
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        policyVersionId: seeded.policyVersionId, executionAttempts: initialAttempts + 1, revision: initialAttempts + 2,
        windowStart: new Date(policy!.definition.periodStart), windowEnd: new Date(policy!.definition.periodEnd),
        reservedCostCents: 0, chargedCostCents: 0,
      });
      const groups = await db.select().from(qualityActionGroups).where(eq(qualityActionGroups.companyId, seeded.companyId));
      expect(groups).toHaveLength(2);
      expect(groups.reduce((sum, row) => sum + Number(row.usage.executionAttempts ?? 0), 0)).toBe(initialAttempts + 1);
      groupIds.forEach((id, index) => {
        const row = groups.find(row => row.id === id)!;
        const expected = (index === 0 ? initialAttempts : 0) + (settled[index]!.status === "fulfilled" ? 1 : 0);
        expect(Number(row.usage.executionAttempts ?? 0)).toBe(expected);
        expect(row.revision).toBe(expected + 1);
      });
    } finally {
      start.resolve();
      try {
        if (gate === "row") await control`rollback`;
        if (gate === "advisory") await control`select pg_advisory_unlock(73004, 1)`;
      } finally {
        try {
          await jobs;
          if (!initialAttempts) {
            await control.unsafe("DROP TRIGGER IF EXISTS quality_reservation_gate ON public.quality_policy_usage");
            await control.unsafe("DROP FUNCTION IF EXISTS public.quality_reservation_gate()");
          }
        } finally { control.release(); observer.release(); }
      }
    }
  });

  it("holds the quality budget before waiting on the retry run lock", async () => {
    const seeded = await seedQualityFixture(db);
    const binding = await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    await db.update(workflowStepRuns).set({
      status: "failed", completedAt: new Date(), retryCount: 0, executionGeneration: 2,
      metadata: { qualityActionId: seeded.actionId },
    }).where(eq(workflowStepRuns.id, binding.stepRunId));
    await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, binding.workflowRunId));
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, binding.stepRunId));
    const control = await db.$client.reserve(), observer = await watcher.$client.reserve();
    const ready = deferred<number>();
    let held = false, schedulerPid = 0, schedulerDone = false, probeDone = false;
    let scheduled: Promise<PromiseSettledResult<Awaited<ReturnType<typeof scheduleWorkflowStepRetry>>>[]> | undefined;
    let probed: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      await control`begin`; held = true;
      await control`select id from workflow_runs where id = ${binding.workflowRunId} for update`;
      const [holder] = await control`select pg_backend_pid() as pid`;
      scheduled = Promise.allSettled([scheduleWorkflowStepRetry(first, {
        companyId: seeded.companyId, workflowRunId: binding.workflowRunId, stepRunId: binding.stepRunId,
        retryNumber: 1, maxRetries: 3, delaySeconds: 0,
        observedStatus: "failed", observedRetryCount: 0, observedCompletedAt: step!.completedAt,
        observedLastDispatchRequestId: step!.lastDispatchRequestId,
        observedMetadataSnapshot: step!.metadata as Record<string, unknown>,
        observedExecutionGeneration: 2, errorSummary: "adapter failed",
      }).finally(() => { schedulerDone = true; })]);
      await until(async () => {
        if (schedulerDone) throw new Error("quality_order_scheduler_finished_before_wait");
        const rows = await observer`select pid, query from pg_stat_activity where state = 'active'
          and wait_event_type = 'Lock' and ${Number(holder!.pid)} = any(pg_blocking_pids(pid))`;
        const waiting = rows.find(row => /workflow_runs/.test(String(row.query)));
        schedulerPid = Number(waiting?.pid ?? 0);
        return schedulerPid !== 0;
      });
      probed = Promise.allSettled([second.transaction(async tx => {
        await tx.execute(sql`set local statement_timeout = '6s'`);
        const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
        ready.resolve(Number(backend!.pid));
        await lockQualityAttemptBudget(tx, { companyId: seeded.companyId, actionId: seeded.actionId, now: new Date() });
        throw new Error("quality_order_probe_rollback");
      }).catch(error => { ready.reject(error); throw error; }).finally(() => { probeDone = true; })]);
      const probePid = await ready.promise;
      await until(async () => {
        if (probeDone) throw new Error("quality_order_budget_not_held_before_run");
        const rows = await observer`select query from pg_stat_activity where pid = ${probePid}
          and wait_event_type = 'Lock' and ${schedulerPid} = any(pg_blocking_pids(pid))`;
        return rows.some(row => /quality_policy_usage/.test(String(row.query)));
      });
      await control`commit`; held = false;
      const [result] = await scheduled;
      expect(result!.status).toBe("fulfilled");
      if (result!.status === "fulfilled") expect(result!.value.result).toBe("scheduled");
      const [probe] = await probed;
      expect(probe!.status).toBe("rejected");
      if (probe!.status === "rejected") expect(probe!.reason.message).toBe("quality_order_probe_rollback");
      const [usage] = await db.select().from(qualityPolicyUsage).where(eq(qualityPolicyUsage.companyId, seeded.companyId));
      expect(usage!.executionAttempts).toBe(1);
    } finally {
      try { if (held) await control`rollback`; }
      finally {
        try { await Promise.all([scheduled, probed]); }
        finally { control.release(); observer.release(); }
      }
    }
  });
});
