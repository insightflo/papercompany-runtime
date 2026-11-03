import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createReplacementRootNotifications, withReplacementRootNotificationDb } from "../services/issue-assignment-wakeup.js";
import { createQaFileOwnerRuntime, type QaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { reconcileQaRemediationReservation } from "../services/workflow/control-flow/qa-remediation-reconcile.js";
import { QA_REMEDIATION_COMPLETION_EVENT_TYPE } from "../services/workflow/control-flow/qa-remediation-completion.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE } from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import {
  assertCommittedCompletion, eventRows, openBackendLossFixture, ROOT_AFTER, wakeRows,
  type BackendLossFixture, type RootWorld, type TestDb,
} from "./helpers/qa-remediation-backend-loss-fixture.js";

const PYTHON = process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON ?? process.env.PYTHON
  ?? process.env.PATH?.split(delimiter).map((part) => join(part, "python3"))
    .find((candidate) => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
if (!PYTHON) throw new Error("A Python 3 executable is required for backend-loss proof");

function waitFor<T>(promise: Promise<T>, label: string, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  })]).finally(() => { if (timer) clearTimeout(timer); });
}

async function until<T>(probe: () => Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} was not observed`);
}

function nativeRuntime(fixture: BackendLossFixture,
  onOwner?: (owner: Awaited<ReturnType<QaFileOwnerRuntime["begin"]>>) => void): QaFileOwnerRuntime {
  const runtime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: fixture.lockRoot, qaFileOwnerPython: PYTHON! });
  return {
    capability: runtime.capability,
    async begin(targets, options) {
      const owner = await runtime.begin(targets, options);
      onOwner?.(owner);
      return owner;
    },
  };
}

function requestOf(world: RootWorld) {
  return { companyId: world.companyId, missionId: world.missionId, workflowRunId: world.runId,
    producerStepRunId: world.producerStepRunId, qaStepRunIds: [world.qaStepRunId] };
}

function backendGate(fixture: BackendLossFixture, world: RootWorld) {
  const suffix = randomUUID().replace(/-/g, "");
  const functionName = `c5_gate_${suffix}`;
  const triggerName = `c5_gate_${suffix}`;
  const lockA = Number.parseInt(suffix.slice(0, 7), 16) || 1;
  const lockB = Number.parseInt(suffix.slice(7, 14), 16) || 1;
  const triggerRunId = world.runId;
  let held = false;
  let removed = false;
  return {
    lockA, lockB, functionName, triggerName,
    async install() {
      await fixture.controllerDb.db.$client.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.event_type = 'qa_remediation_completed' AND NEW.workflow_run_id = '${triggerRunId}'::uuid THEN
            PERFORM pg_advisory_xact_lock(${lockA}, ${lockB});
          END IF;
          RETURN NEW;
        END $$`);
      await fixture.controllerDb.db.$client.unsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON workflow_transition_events
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      await fixture.controllerDb.db.$client.unsafe("SELECT pg_advisory_lock($1::int, $2::int)", [lockA, lockB]);
      held = true;
    },
    async release() {
      if (!held) return;
      await fixture.controllerDb.db.$client.unsafe("SELECT pg_advisory_unlock($1::int, $2::int)", [lockA, lockB]);
      held = false;
    },
    async remove() {
      if (removed) return;
      await fixture.controllerDb.db.$client.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON workflow_transition_events`);
      await fixture.controllerDb.db.$client.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
      removed = true;
    },
  };
}

async function rootCall(db: TestDb, world: RootWorld, runtime: QaFileOwnerRuntime,
  notifications = createReplacementRootNotifications()) {
  const result = await withReplacementRootNotificationDb(db.db, notifications,
    () => reconcileQaRemediationReservation(db.db, requestOf(world), runtime));
  return { result, notifications };
}

describe("QA remediation recovery after backend loss during finalization", () => {
  let fixture: BackendLossFixture | undefined;
  afterEach(async () => { if (fixture) { await fixture.dispose(); fixture = undefined; } });

  it("preserves the published actual, holds unknown transaction outcome, then completes once on reentry", async () => {
    fixture = await openBackendLossFixture();
    const target = await fixture.seedWorld(fixture.rootDb.db, "target");
    const gate = backendGate(fixture, target);
    await gate.install();
    let targetOwner: Awaited<ReturnType<QaFileOwnerRuntime["begin"]>> | undefined;
    let publicationReceipt: Awaited<ReturnType<NonNullable<typeof targetOwner>["publish"]>> | undefined;
    const runtime = nativeRuntime(fixture, (owner) => {
      targetOwner = owner;
      const publish = owner.publish.bind(owner);
      owner.publish = async (items) => { publicationReceipt = await publish(items); return publicationReceipt; };
    });
    const caller = createReplacementRootNotifications();
    const targetJob = rootCall(fixture.rootDb, target, runtime, caller);
    try {
      const lock = await until(async () => {
        const rows = await fixture!.observerDb.db.$client.unsafe(
          `SELECT a.pid, a.backend_start, a.application_name, a.datname, a.state, a.wait_event_type,
                  l.classid::text AS classid, l.objid::text AS objid, l.objsubid, l.granted, a.query
             FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
            WHERE a.application_name = $1 AND a.datname = current_database()
              AND a.state = 'active' AND a.wait_event_type = 'Lock'
              AND l.locktype = 'advisory' AND l.classid = $2 AND l.objid = $3
              AND l.objsubid = 2 AND NOT l.granted`,
          [fixture!.rootDb.applicationName, gate.lockA, gate.lockB],
        );
        const row = rows.find((candidate) => /insert into ["]?workflow_transition_events/i.test(String(candidate.query)));
        return row ?? null;
      }, "target backend blocked inside completion insert").catch(async (error: unknown) => {
        const sessions = await fixture!.observerDb.db.$client.unsafe(
          `SELECT pid, backend_start, application_name, datname, state, wait_event_type, wait_event, query
             FROM pg_stat_activity WHERE application_name = $1`, [fixture!.rootDb.applicationName],
        );
        throw new Error(`${error instanceof Error ? error.message : String(error)}; sessions=${JSON.stringify(sessions)}`);
      });
      expect(Number(lock.pid)).toBeGreaterThan(0);
      expect(lock.application_name).toBe(fixture.rootDb.applicationName);
      expect(lock.datname).toBe(await fixture.observerDb.db.$client.unsafe("SELECT current_database() AS name").then((rows) => rows[0]?.name));
      expect(publicationReceipt).toMatchObject({ outcome: "published", files: [{ target: target.file, status: "applied" }] });
      expect(await readFile(target.file, "utf8")).toBe(ROOT_AFTER);

      const unrelated = await fixture.seedWorld(fixture.unrelatedDb.db, "independent");
      const unrelatedResult = await rootCall(fixture.unrelatedDb, unrelated, nativeRuntime(fixture));
      expect(unrelatedResult.result).toMatchObject({ outcome: "completed", created: true });
      expect((await assertCommittedCompletion(fixture.unrelatedDb.db, unrelated)).wake.id).toBeTruthy();

      const terminated = await fixture.observerDb.db.$client.unsafe(
        `SELECT pg_terminate_backend(a.pid) AS terminated
           FROM pg_stat_activity a
          WHERE a.pid = $1 AND a.backend_start = $2::timestamptz
            AND a.application_name = $3 AND a.datname = current_database()`,
        [lock.pid, String(lock.backend_start), fixture.rootDb.applicationName],
      );
      expect(terminated[0]?.terminated).toBe(true);
      await until(async () => {
        const rows = await fixture!.observerDb.db.$client.unsafe(
          `SELECT 1 AS present FROM pg_stat_activity
            WHERE pid = $1 AND backend_start = $2::timestamptz
              AND application_name = $3 AND datname = current_database()`,
          [lock.pid, String(lock.backend_start), fixture!.rootDb.applicationName],
        );
        return rows.length === 0 ? true : null;
      }, "exact terminated backend exit");
      const held = await waitFor(targetJob, "root held result after backend loss");
      expect(held.result).toMatchObject({ outcome: "held", reason: "transaction_outcome_unknown" });
      await fixture.closeDb(fixture.rootDb);
      expect(caller.agentIds.size).toBe(0);
      expect(caller.correctionWakeupRequestIds.size).toBe(0);
      expect(targetOwner).toBeDefined();
      expect(await targetOwner!.awaitExit()).toMatchObject({ signal: "SIGKILL" });
      expect(await readFile(target.file, "utf8")).toBe(ROOT_AFTER);
      expect(await eventRows(fixture.observerDb.db, target, QA_REMEDIATION_COMPLETION_EVENT_TYPE)).toHaveLength(0);
      expect(await eventRows(fixture.observerDb.db, target, QA_REMEDIATION_PREPARATION_EVENT_TYPE)).toHaveLength(1);
      const afterLossWakes = await wakeRows(fixture.observerDb.db, target.companyId);
      expect(afterLossWakes).toEqual(target.seedWakes);

      await gate.release();
      await gate.remove();
      const retryDb = fixture.makeDb("retry");
      let retryPublication: Awaited<ReturnType<NonNullable<typeof targetOwner>["publish"]>> | undefined;
      const retryResult = await rootCall(retryDb, target, nativeRuntime(fixture, (owner) => {
        const publish = owner.publish.bind(owner);
        owner.publish = async (items) => { retryPublication = await publish(items); return retryPublication; };
      }));
      expect(retryResult.result).toMatchObject({ outcome: "completed", created: true });
      expect(retryPublication).toMatchObject({ outcome: "published", files: [{ target: target.file, status: "already_applied" }] });
      expect(await readFile(target.file, "utf8")).toBe(ROOT_AFTER);
      await assertCommittedCompletion(fixture.observerDb.db, target);
      expect(await eventRows(fixture.observerDb.db, target, QA_REMEDIATION_COMPLETION_EVENT_TYPE)).toHaveLength(1);
      expect(retryResult.result.outcome === "completed" ? retryResult.result.notifications : null)
        .toMatchObject({ agentIds: [target.verifier], wakeupRequestIds: [expect.any(String)] });
    } finally {
      await gate.release();
      await gate.remove();
      if (targetOwner) await targetOwner.abort();
      await Promise.allSettled([targetJob]);
    }
  }, 90_000);
});
