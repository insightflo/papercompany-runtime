import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { workflowStepRuns, type Db } from "@paperclipai/db";
import { createQaFileOwnerRuntime, type QaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { reconcileQaRemediationReservation } from "../services/workflow/control-flow/qa-remediation-reconcile.js";
import {
  QA_REMEDIATION_PREPARATION_EVENT_TYPE, parseQaRemediationPreparation,
} from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { QA_REMEDIATION_COMPLETION_EVENT_TYPE } from "../services/workflow/control-flow/qa-remediation-completion.js";
import {
  createReplacementRootNotifications, withReplacementRootNotificationDb,
} from "../services/issue-assignment-wakeup.js";
import {
  assertCommittedCompletion, eventRows, openBackendLossFixture, ROOT_AFTER, ROOT_BEFORE, wakeRows,
  type RootWorld,
} from "./helpers/qa-remediation-backend-loss-fixture.js";
import {
  CHILD_FIXTURE, createRenameBarrier, deferred, NATIVE_HELPER, observeRootChild, processExited, processState,
  PYTHON, SERVER_ROOT, waitForBackendGone, waitForProcessExit, within,
} from "./helpers/qa-remediation-parent-death-harness.js";

import { executeAdmissionFixtureAdapter } from "./helpers/qa-remediation-admission-public-fixture.js";
vi.mock("../adapters/index.js", async original => ({ ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: executeAdmissionFixtureAdapter }) }));

function requestOf(world: RootWorld) {
  return { companyId: world.companyId, missionId: world.missionId, workflowRunId: world.runId,
    producerStepRunId: world.producerStepRunId, qaStepRunIds: [world.qaStepRunId] };
}

async function rootCall(world: RootWorld, db: Db, runtime: QaFileOwnerRuntime) {
  const notifications = createReplacementRootNotifications();
  const result = await withReplacementRootNotificationDb(db, notifications,
    () => reconcileQaRemediationReservation(db, requestOf(world), runtime));
  return { result, notifications };
}

describe.sequential("C5 owning Node parent death at native rename barriers", () => {
  it("preserves the prepared attempt and makes scoped progress/reentry after SIGKILL before and after real replace", async () => {
    const fixture = await openBackendLossFixture({ realProducer: true });
    try {
      for (const phase of ["before", "after"] as const) {
        const world = await fixture.seedWorld(fixture.rootDb.db, `parent-${phase}-${randomUUID().slice(0, 6)}`);
        const initialStepIds = (await fixture.observerDb.db.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
          .where(eq(workflowStepRuns.workflowRunId, world.runId))).map((row) => row.id).sort();
        const barrierDir = await realpath(await mkdtemp(join(tmpdir(), `c5-parent-barrier-${phase}-`)));
        const barrier = await createRenameBarrier(barrierDir, NATIVE_HELPER);
        let ownerNode: ChildProcessByStdio<null, Readable, Readable> | undefined;
        let ownerClose: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> | undefined;
        let recovery: Promise<Awaited<ReturnType<typeof reconcileQaRemediationReservation>>> | undefined;
        try {
          const appName = `c5-parent-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
          const databaseUrl = new URL(fixture.postgres.connectionString);
          databaseUrl.searchParams.set("application_name", appName);
          const context = { databaseUrl: databaseUrl.toString(), appName, lockRoot: fixture.lockRoot,
            pythonCommand: PYTHON!, helperPath: barrier.helperPath, request: requestOf(world) };
          const argv = ["--import", "tsx", CHILD_FIXTURE];
          const child = spawn(process.execPath, argv, { cwd: SERVER_ROOT,
            env: { ...process.env, C5_PARENT_DEATH_CONTEXT: JSON.stringify(context) },
            stdio: ["ignore", "pipe", "pipe"] });
          ownerNode = child;
          const ownerPid = child.pid;
          if (!ownerPid) throw new Error("owning Node child did not receive an OS PID");
          const observed = observeRootChild(child);
          ownerClose = observed.closed;
          const started = await within(observed.started, "owning Node startup", 60_000);
          expect(started.pid).toBe(ownerPid);
          expect(started.appName).toBe(appName);
          expect(started.argv).toContain(CHILD_FIXTURE);
          expect(started.cwd).toBe(SERVER_ROOT);

          const beforeHit = await within(barrier.before, "native pre-replace barrier");
          expect(beforeHit.phase).toBe("before");
          expect(beforeHit.dst).toBe(world.file);
          expect(beforeHit.parentPid).toBe(ownerPid);
          const helperStateAtBarrier = processState(beforeHit.helperPid);
          expect(helperStateAtBarrier).not.toBeNull();
          expect(helperStateAtBarrier).not.toMatch(/^Z/);
          const databaseRows = await fixture.observerDb.db.$client.unsafe(
            "SELECT pid, state FROM pg_stat_activity WHERE application_name = $1", [appName]);
          const transaction = databaseRows.find((row) => row.state === "idle in transaction");
          expect(transaction).toBeDefined();
          const backendPid = Number(transaction!.pid);

          if (phase === "after") {
            barrier.replace();
            const afterHit = await within(barrier.after, "native post-replace barrier");
            expect(afterHit.src).toBe(beforeHit.src);
            expect(afterHit.dst).toBe(world.file);
            expect(afterHit.parentPid).toBe(ownerPid);
            expect(await readFile(world.file, "utf8")).toBe(ROOT_AFTER);
          }

          const parentAlive = processState(ownerPid);
          expect(parentAlive).not.toBeNull();
          expect(parentAlive).not.toMatch(/^Z/);
          child.kill("SIGKILL");
          const ownerExit = await within(observed.closed, "owning Node exit");
          expect(ownerExit).toEqual({ code: null, signal: "SIGKILL" });
          const helperAfterParentDeath = processState(beforeHit.helperPid);
          expect(helperAfterParentDeath).not.toBeNull();
          expect(helperAfterParentDeath).not.toMatch(/^Z/);
          await waitForBackendGone(fixture.observerDb.db, backendPid);

          const preparationRows = await eventRows(fixture.observerDb.db, world, QA_REMEDIATION_PREPARATION_EVENT_TYPE);
          expect(preparationRows).toHaveLength(1);
          const preparation = parseQaRemediationPreparation(preparationRows[0]!.payload);
          expect(preparation.producer.stepRunId).toBe(world.producerStepRunId);
          expect(preparation.verdicts[0]).toMatchObject({ eventId: world.verdictId, heartbeatRunId: world.heartbeatId });
          expect(await eventRows(fixture.observerDb.db, world, QA_REMEDIATION_COMPLETION_EVENT_TYPE)).toHaveLength(0);
          expect(await wakeRows(fixture.observerDb.db, world.companyId)).toEqual(world.seedWakes);

          const unrelated = await fixture.seedWorld(fixture.unrelatedDb.db, `parent-unrelated-${phase}`);
          const unrelatedResult = await within(rootCall(unrelated, fixture.unrelatedDb.db,
            createQaFileOwnerRuntime({ qaFileOwnerLockRoot: fixture.lockRoot, qaFileOwnerPython: PYTHON! })), "unrelated mission progress");
          expect(unrelatedResult.result.outcome).toBe("completed");
          expect(await readFile(unrelated.file, "utf8")).toBe(ROOT_AFTER);
          const helperBeforeRelease = processState(beforeHit.helperPid);
          expect(helperBeforeRelease).not.toBeNull();
          expect(helperBeforeRelease).not.toMatch(/^Z/);

          const lockWait = deferred<{ readonly type: "lock_wait"; readonly target: string }>();
          const baseRuntime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: fixture.lockRoot, qaFileOwnerPython: PYTHON! });
          const recoveryRuntime: QaFileOwnerRuntime = {
            capability: baseRuntime.capability,
            begin: (targets, options) => baseRuntime.begin(targets, { ...options, onEvent: (event: { readonly type: "lock_wait"; readonly target: string }) => {
              if (event.type === "lock_wait" && event.target === world.file) lockWait.resolve(event);
              options?.onEvent?.(event);
            } }),
          };
          const notifications = createReplacementRootNotifications();
          recovery = withReplacementRootNotificationDb(fixture.rootDb.db, notifications,
            () => reconcileQaRemediationReservation(fixture.rootDb.db, requestOf(world), recoveryRuntime));
          const contender = await within(Promise.race([
            lockWait.promise.then((event) => ({ kind: "waiting" as const, event })),
            recovery.then((result) => ({ kind: "settled" as const, result }), (error) => ({ kind: "error" as const, error })),
          ]), "recovery guard wait");
          expect(contender.kind).toBe("waiting");
          if (contender.kind !== "waiting") throw new Error("recovery completed before observing the held native guard");
          expect(contender.event.target).toBe(world.file);

          if (phase === "before") {
            expect(await readFile(world.file, "utf8")).toBe(ROOT_BEFORE);
            barrier.replace();
            const afterHit = await within(barrier.after, "native replace after owning Node death");
            expect(afterHit.src).toBe(beforeHit.src);
            expect(afterHit.dst).toBe(world.file);
            expect(await readFile(world.file, "utf8")).toBe(ROOT_AFTER);
          }
          barrier.returnFromReplace();
          const helperExitState = await within(waitForProcessExit(beforeHit.helperPid), "native helper/guard settlement");
          expect(processExited(beforeHit.helperPid)).toBe(true);

          const recovered = await within(recovery, "same-attempt root reentry");
          expect(recovered.outcome).toBe("completed");
          expect(notifications.agentIds).toContain(world.verifier);
          const committed = await assertCommittedCompletion(fixture.observerDb.db, world);
          expect(await wakeRows(fixture.observerDb.db, world.companyId)).toEqual(
            [...world.seedWakes, committed.wake].sort((left, right) => left.id.localeCompare(right.id)));
          const finalStepIds = (await fixture.observerDb.db.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
            .where(eq(workflowStepRuns.workflowRunId, world.runId))).map((row) => row.id).sort();
          expect(finalStepIds).toEqual(initialStepIds);
          const finalBytes = await readFile(world.file);
          expect(finalBytes.toString("utf8")).toBe(ROOT_AFTER);
          expect(barrier.hits.filter((hit) => hit.phase === "before")).toHaveLength(1);
          expect(barrier.hits.filter((hit) => hit.phase === "after")).toHaveLength(1);
          expect(observed.messages.some((message) => message.kind === "unhandled" || message.kind === "root_error")).toBe(false);
          console.info("C5_PARENT_DEATH_EVIDENCE", JSON.stringify({ phase, test: "preserves the prepared attempt and makes scoped progress/reentry after SIGKILL before and after real replace", argv: [process.execPath, ...argv], cwd: SERVER_ROOT,
            ownerNodePid: ownerPid, ownerNodeExit: ownerExit, helperPid: beforeHit.helperPid,
            helperParentPidAtBarrier: beforeHit.parentPid, helperExitState, databaseBackendPid: backendPid,
            preparationId: preparation.preparationId, producerStepRunId: preparation.producer.stepRunId,
            sourceVerdictEventId: preparation.verdicts[0]?.eventId, initialWakeIds: world.seedWakes.map((wake) => wake.id),
            finalWakeIds: (await wakeRows(fixture.observerDb.db, world.companyId)).map((wake) => wake.id),
            completionCount: (await eventRows(fixture.observerDb.db, world, QA_REMEDIATION_COMPLETION_EVENT_TYPE)).length,
            finalBytesSha256: createHash("sha256").update(finalBytes).digest("hex"),
            unrelatedOutcome: unrelatedResult.result.outcome,
            unhandledChildMessages: observed.messages.filter((message) => message.kind === "unhandled").length,
            childStdout: observed.output().stdout, childStderr: observed.output().stderr }));
        } finally {
          if (ownerNode && ownerNode.exitCode === null && ownerNode.signalCode === null) ownerNode.kill("SIGKILL");
          await barrier.releaseForCleanup();
          if (ownerClose) await within(ownerClose, "owning Node cleanup").catch(() => undefined);
          if (recovery) await Promise.allSettled([recovery]);
          const helperPid = barrier.hits[0]?.helperPid;
          if (helperPid) await waitForProcessExit(helperPid).catch(() => undefined);
          await barrier.close();
          await rm(barrierDir, { recursive: true, force: true });
        }
      }
    } finally {
      await fixture.dispose();
    }
  }, 180_000);
});
