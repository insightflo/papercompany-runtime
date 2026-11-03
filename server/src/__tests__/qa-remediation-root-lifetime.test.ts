// Stage B owned-root proof. Each case uses isolated PostgreSQL, the real Python
// owner/flock and real os.replace; only the test-owned launcher adds pipe gates.
// A PASS here is root-lifetime evidence, not workflow activation or mission proof.

import { randomUUID, createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { accessSync, constants } from "node:fs";
import {
  mkdir, mkdtemp, readFile, realpath, rm, writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueWorkProducts, issues,
  missions, startEmbeddedPostgresTestDatabase, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { seedInternalAdmissionWorld, executeAdmissionFixtureAdapter } from "./helpers/qa-remediation-admission-public-fixture.js";
vi.mock("../adapters/index.js", async original => ({ ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: executeAdmissionFixtureAdapter }) }));
const fixtureClosers = new Set<() => Promise<void>>();
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import { QA_REMEDIATION_MAX_FILE_BYTES } from "../services/workflow/control-flow/qa-remediation-contract.js";
import {
  QA_REMEDIATION_PREPARATION_EVENT_TYPE, parseQaRemediationPreparation,
  type QaRemediationPreparation,
} from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import {
  QA_REMEDIATION_COMPLETION_EVENT_TYPE, parseQaRemediationCompletion,
  qaRemediationCompletionKey, qaRemediationRefireV2WakeKey,
} from "../services/workflow/control-flow/qa-remediation-completion.js";
import { prepareQaRemediationReservation } from "../services/workflow/control-flow/qa-remediation-prepare.js";
import {
  publishQaRemediationPreparation, type QaRemediationPublicationAuthority,
} from "../services/workflow/control-flow/qa-remediation-publication.js";
import {
  FILE_OWNER_PROTOCOL_VERSION, QaRemediationFileOwner,
} from "../services/workflow/control-flow/qa-remediation-file-owner.js";
import {
  createQaFileOwnerRuntime, type QaFileOwnerRuntime,
} from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { reconcileQaRemediationReservation } from "../services/workflow/control-flow/qa-remediation-reconcile.js";
import { WORKFLOW_ATTEMPT_PROOF_KEY } from "../services/heartbeat-finalization/workflow-attempt-proof.js";
import {
  createReplacementRootNotifications, withReplacementRootNotificationDb,
} from "../services/issue-assignment-wakeup.js";

const SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../services/workflow/control-flow");
const NATIVE_HELPER = join(SOURCE_DIR, "qa-remediation-file-owner.py");
const PYTHON = process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON
  ?? process.env.PYTHON
  ?? process.env.PATH?.split(delimiter).map((part) => join(part, "python3"))
    .find((candidate) => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
if (!PYTHON) throw new Error("A Python 3 executable is required for native root-lifetime tests");

const BEFORE = "before source\n";
const AFTER = "after source\n";
const workspaces = new Set<string>();
const clients = new Set<Db>();
const owners = new Set<Awaited<ReturnType<QaFileOwnerRuntime["begin"]>>>();
const barriers = new Set<ReplaceBarrier>();
const activeGates = new Set<{ release(): Promise<void>; remove(): Promise<void> }>();
const cleanupReleases = new Set<() => void>();
const pendingRootCalls = new Set<Promise<unknown>>();
let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let lockRoot = "";

interface TestDb { readonly db: Db; readonly applicationName: string; }
type WakeBinding = Pick<typeof agentWakeupRequests.$inferSelect,
  | "id" | "companyId" | "agentId" | "source" | "triggerDetail" | "reason" | "qualityAcceptance" | "payload"
  | "status" | "coalescedCount" | "requestedByActorType" | "requestedByActorId" | "idempotencyKey" | "runId"
  | "requestedAt" | "claimedAt" | "finishedAt" | "error" | "requestKind" | "issueId" | "missionId"
  | "workflowRunId" | "workflowStepRunId" | "workflowExecutionGeneration" | "createdAt" | "updatedAt">;
interface World {
  readonly companyId: string;
  readonly missionId: string;
  readonly runId: string;
  readonly producer: typeof workflowStepRuns.$inferSelect;
  readonly producerWakeId: string;
  readonly qa: typeof workflowStepRuns.$inferSelect;
  readonly qaIssue: typeof issues.$inferSelect;
  readonly verifier: string;
  readonly file: string;
  readonly dir: string;
  readonly verdictId: string;
  readonly heartbeatId: string;
  readonly verdictWakeId: string;
  readonly seedWakes: readonly WakeBinding[];
}

function makeDb(label: string): TestDb {
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "db";
  const applicationName = `c5-${safeLabel.slice(0, 23)}-${randomUUID()}`;
  if (Buffer.byteLength(applicationName, "ascii") > 63) throw new Error("test application_name exceeds PostgreSQL's identifier limit");
  const connection = new URL(postgres.connectionString);
  connection.searchParams.set("application_name", applicationName);
  const db = createDb(connection.toString());
  clients.add(db);
  return { db, applicationName };
}

function sha(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceExactlyOnce(source: string, find: string, replacement: string): string {
  const first = source.indexOf(find);
  if (first < 0 || source.indexOf(find, first + find.length) >= 0) {
    throw new Error(`frame fixture find string must occur exactly once: ${find}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + find.length)}`;
}

function wakeBinding(row: typeof agentWakeupRequests.$inferSelect): WakeBinding {
  return {
    id: row.id, companyId: row.companyId, agentId: row.agentId, source: row.source,
    triggerDetail: row.triggerDetail, reason: row.reason, qualityAcceptance: row.qualityAcceptance, payload: row.payload,
    status: row.status, coalescedCount: row.coalescedCount, requestedByActorType: row.requestedByActorType,
    requestedByActorId: row.requestedByActorId, idempotencyKey: row.idempotencyKey, runId: row.runId,
    requestedAt: row.requestedAt, claimedAt: row.claimedAt, finishedAt: row.finishedAt, error: row.error,
    requestKind: row.requestKind, issueId: row.issueId, missionId: row.missionId, workflowRunId: row.workflowRunId,
    workflowStepRunId: row.workflowStepRunId, workflowExecutionGeneration: row.workflowExecutionGeneration,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

async function wakeBindingsFor(db: Db, companyId: string): Promise<WakeBinding[]> {
  const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
  return rows.map(wakeBinding).sort((left, right) => left.id.localeCompare(right.id));
}

async function expectSeedWakeSnapshot(world: World, db: Db): Promise<void> {
  expect(world.seedWakes.map((wake) => wake.id)).toEqual([world.producerWakeId, world.verdictWakeId].sort());
  expect(await wakeBindingsFor(db, world.companyId)).toEqual(world.seedWakes);
}

async function expectWakeSnapshot(world: World, db: Db, expected: readonly WakeBinding[]): Promise<void> {
  expect(await wakeBindingsFor(db, world.companyId)).toEqual([...expected].sort((left, right) => left.id.localeCompare(right.id)));
}

async function assertCommittedV2Completion(world: World, db: Db) {
  const [preparationEvent] = await rowsFor(world, QA_REMEDIATION_PREPARATION_EVENT_TYPE, db);
  if (!preparationEvent) throw new Error("durable v2 preparation was not found");
  const preparation = parseQaRemediationPreparation(preparationEvent.payload);
  expect(preparationEvent.id).toBe(preparation.preparationId);
  const [completionEvent] = await rowsFor(world, QA_REMEDIATION_COMPLETION_EVENT_TYPE, db);
  if (!completionEvent) throw new Error("durable v2 completion was not found");
  const completion = parseQaRemediationCompletion(completionEvent.payload);
  expect(completionEvent.id).toBe(completion.completionId);
  expect(completionEvent.idempotencyKey).toBe(qaRemediationCompletionKey(preparation));
  expect(completionEvent).toMatchObject({ companyId: world.companyId, missionId: world.missionId, workflowRunId: world.runId,
    workflowStepRunId: preparation.producer.stepRunId, issueId: preparation.producer.issueId,
    executionGeneration: preparation.producer.executionGeneration, eventType: QA_REMEDIATION_COMPLETION_EVENT_TYPE });
  expect(completion).toMatchObject({ preparationId: preparation.preparationId, companyId: preparation.companyId,
    missionId: preparation.missionId, workflowRunId: preparation.workflowRunId,
    dispatchAuthorityVersion: preparation.dispatchAuthorityVersion, producer: preparation.producer });
  expect(preparation.verdicts).toHaveLength(1);
  const verdict = preparation.verdicts[0]!;
  expect(verdict.eventId).toBe(world.verdictId);
  expect(verdict.heartbeatRunId).toBe(world.heartbeatId);
  const idempotencyKey = qaRemediationRefireV2WakeKey(preparation, verdict.qa.stepRunId, verdict.eventId);
  const allWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, world.companyId));
  const matchingWakes = allWakes.filter((wake) => wake.idempotencyKey === idempotencyKey);
  expect(matchingWakes).toHaveLength(1);
  const wake = matchingWakes[0]!;
  expect(wake.status).toBe("queued");
  const receipt = {
    kind: "v2_refire" as const, wakeupRequestId: wake.id, idempotencyKey, agentId: world.verifier,
    issueId: verdict.qa.issueId, stepRunId: verdict.qa.stepRunId, stepId: verdict.qa.stepId,
    executionGeneration: verdict.qa.executionGeneration, sourceVerdictEventId: verdict.eventId, statusAtCommit: "queued",
  };
  expect(completion.wakes).toEqual([receipt]);
  expect(wake).toMatchObject({ id: receipt.wakeupRequestId, companyId: preparation.companyId,
    agentId: world.verifier, source: "assignment", requestKind: "workflow_resume", issueId: verdict.qa.issueId,
    missionId: preparation.missionId, workflowRunId: preparation.workflowRunId, workflowStepRunId: verdict.qa.stepRunId,
    workflowExecutionGeneration: verdict.qa.executionGeneration, status: receipt.statusAtCommit, idempotencyKey });
  expect(wake.payload?.qaRemediationCompletion).toEqual({
    preparationEventId: preparation.preparationId, sourceVerdictEventId: verdict.eventId,
  });
  expect(wake.payload?.[WORKFLOW_ATTEMPT_PROOF_KEY]).toEqual({
    schemaVersion: 1, companyId: preparation.companyId, agentId: world.verifier, issueId: verdict.qa.issueId,
    missionId: preparation.missionId, workflowRunId: preparation.workflowRunId, stepRunId: verdict.qa.stepRunId,
    executionGeneration: verdict.qa.executionGeneration, retryCount: verdict.qa.retryCount,
    iterationIndex: verdict.qa.iterationIndex, wakeupRequestId: wake.id, parentHeartbeatRunId: null,
  });
  return { completion, wake: wakeBinding(wake) };
}

async function workspace(label: string): Promise<{ readonly dir: string; readonly file: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `c5-root-${label}-`)));
  workspaces.add(dir);
  const file = join(dir, "report.md");
  await writeFile(file, BEFORE, { mode: 0o600 });
  return { dir, file };
}

async function seedWorld(db: Db, label: string): Promise<World> {
  const { dir, file } = await workspace(label);
  const seeded = await seedInternalAdmissionWorld(db, dir, lockRoot,
    { file, bytes: Buffer.from(BEFORE), find: "before", replace: "after" });
  fixtureClosers.add(seeded.close);
  const u = seeded.unit;
  const seedWakes = await wakeBindingsFor(db, u.companyId);
  return { companyId: u.companyId, missionId: u.missionId, runId: u.runId, producer: u.producer,
    producerWakeId: u.producerWakeupRequestId, qa: u.qa, qaIssue: u.qaIssue, verifier: u.verifierId,
    file: u.file, dir, verdictId: u.verdictEventId, heartbeatId: u.verdictHeartbeatId,
    verdictWakeId: u.automaticQaWakeupRequestId, seedWakes };
}

const requestOf = (world: World) => ({ companyId: world.companyId, missionId: world.missionId,
  workflowRunId: world.runId, producerStepRunId: world.producer.id, qaStepRunIds: [world.qa.id] });

function nativeRuntime(
  helperPath = NATIVE_HELPER,
  capture?: (owner: Awaited<ReturnType<QaFileOwnerRuntime["begin"]>>) => void,
  wrapClose?: (owner: Awaited<ReturnType<QaFileOwnerRuntime["begin"]>>) => Awaited<ReturnType<QaFileOwnerRuntime["begin"]>>,
): QaFileOwnerRuntime {
  const runtime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! });
  if (helperPath === NATIVE_HELPER && !capture && !wrapClose) {
    return {
      capability: runtime.capability,
      async begin(targets, options) {
        const owner = await runtime.begin(targets, options);
        owners.add(owner);
        return owner;
      },
    };
  }
  return {
    capability: Promise.resolve({ status: "configured", scope: "configuration-only", lockRoot,
      pythonCommand: PYTHON!, helperPath }),
    async begin(targets, options) {
      const base = await QaRemediationFileOwner.begin({ lockRoot, targets, pythonCommand: PYTHON!, helperPath,
        onEvent: options?.onEvent, signal: options?.signal });
      owners.add(base);
      capture?.(base);
      const owner = wrapClose ? wrapClose(base) : base;
      if (owner !== base) owners.add(owner);
      return owner;
    },
  };
}

async function rootCall(world: World, db: Db, runtime: QaFileOwnerRuntime,
  notifications = createReplacementRootNotifications()) {
  const job = withReplacementRootNotificationDb(db, notifications,
    () => reconcileQaRemediationReservation(db, requestOf(world), runtime));
  pendingRootCalls.add(job);
  try { return { result: await job, notifications }; }
  finally { pendingRootCalls.delete(job); }
}

async function rowsFor(world: World, eventType: string, db: Db) {
  return db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, world.companyId), eq(workflowTransitionEvents.workflowRunId, world.runId),
    eq(workflowTransitionEvents.eventType, eventType)));
}

function waitFor<T>(promise: Promise<T>, label: string, ms = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  })]).finally(() => { if (timer) clearTimeout(timer); });
}

async function until<T>(read: () => Promise<T | null>, label: string, ms = 12_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value !== null) return value;
    await new Promise<void>((resolveNow) => setImmediate(resolveNow));
  }
  throw new Error(`${label} was not observed before deadline`);
}

async function rootBackendPid(observer: Db, applicationName: string): Promise<number> {
  const row = await until(async () => {
    const rows = await observer.$client.unsafe(
      "SELECT pid, application_name, datname, backend_type, state, query FROM pg_stat_activity WHERE application_name = $1 AND datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'",
      [applicationName],
    );
    if (rows.length > 1) throw new Error(`expected one root backend, found ${rows.length}`);
    return rows.length === 1 ? rows[0]! : null;
  }, `idle root backend ${applicationName}`);
  expect(String(row.application_name)).toBe(applicationName);
  expect(String(row.datname)).toBeTruthy();
  expect(String(row.backend_type)).toBe("client backend");
  expect(String(row.state)).toMatch(/^idle in transaction/);
  return Number(row.pid);
}

async function waitForBackendGone(observer: Db, pid: number): Promise<void> {
  await until(async () => {
    const rows = await observer.$client.unsafe("SELECT pid FROM pg_stat_activity WHERE pid = $1::integer", [pid]);
    return rows.length === 0 ? true : null;
  }, `backend ${pid} disappearance`);
}

async function installGate(controller: Db, world: World, deferred = false) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const functionName = `c5_root_gate_${suffix}`;
  const triggerName = `c5_root_gate_trigger_${suffix}`;
  const key = Math.floor(Math.random() * 1_000_000) + 100_000;
  const body = deferred
    ? `BEGIN IF NEW.event_type = 'qa_remediation_completed' AND NEW.workflow_run_id = '${world.runId}' THEN PERFORM pg_advisory_xact_lock_shared(${key}, 1); END IF; RETURN NEW; END`
    : `BEGIN IF NEW.event_type = 'qa_remediation_completed' AND NEW.workflow_run_id = '${world.runId}' THEN PERFORM pg_advisory_xact_lock_shared(${key}, 1); END IF; RETURN NEW; END`;
  await controller.$client.unsafe(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ ${body} $$`);
  if (deferred) {
    await controller.$client.unsafe(`CREATE CONSTRAINT TRIGGER ${triggerName} AFTER INSERT ON workflow_transition_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`);
  } else {
    await controller.$client.unsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON workflow_transition_events FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`);
  }
  await controller.$client.unsafe("SELECT pg_advisory_lock($1, 1)", [key]);
  let released = false, removed = false;
  const gate = {
    async release() {
      if (released) return;
      await controller.$client.unsafe("SELECT pg_advisory_unlock($1, 1)", [key]);
      released = true;
    },
    async remove() {
      if (removed) return;
      await controller.$client.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON workflow_transition_events`);
      await controller.$client.unsafe(`DROP FUNCTION IF EXISTS public.${functionName}()`);
      removed = true;
      activeGates.delete(gate);
    },
  };
  activeGates.add(gate);
  return gate;
}

interface ReplaceBarrier {
  readonly helperPath: string;
  readonly before: Promise<{ readonly src: string; readonly dst: string }>;
  readonly after: Promise<{ readonly src: string; readonly dst: string }>;
  replace(): void;
  returnFromReplace(): void;
  close(): Promise<void>;
}

async function replaceBarrier(label: string): Promise<ReplaceBarrier> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `c5-root-barrier-${label}-`)));
  workspaces.add(dir);
  const server: Server = createServer();
  await new Promise<void>((resolveNow, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveNow);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test barrier did not bind a TCP port");
  let socket: Socket | null = null, buffer = "";
  let resolveBefore!: (value: { src: string; dst: string }) => void;
  let resolveAfter!: (value: { src: string; dst: string }) => void;
  const before = new Promise<{ src: string; dst: string }>((resolveNow) => { resolveBefore = resolveNow; });
  const after = new Promise<{ src: string; dst: string }>((resolveNow) => { resolveAfter = resolveNow; });
  server.once("connection", (accepted) => {
    socket = accepted;
    accepted.setEncoding("utf8");
    accepted.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const event = JSON.parse(line) as { phase: string; src: string; dst: string };
        if (event.phase === "before") resolveBefore(event);
        if (event.phase === "after") resolveAfter(event);
        index = buffer.indexOf("\n");
      }
    });
  });
  const helperPath = join(dir, "gated-owner.py");
  const script = [
    "import json, os, runpy, socket",
    `HELPER = ${JSON.stringify(NATIVE_HELPER)}`,
    `PORT = ${address.port}`,
    "real_replace = os.replace",
    "def gated_replace(src, dst):",
    "    connection = socket.create_connection(('127.0.0.1', PORT), timeout=30)",
    "    connection.sendall((json.dumps({'phase':'before','src':src,'dst':dst})+'\\n').encode())",
    "    if connection.recv(128).strip() != b'replace': os._exit(97)",
    "    result = real_replace(src, dst)",
    "    connection.sendall((json.dumps({'phase':'after','src':src,'dst':dst})+'\\n').encode())",
    "    if connection.recv(128).strip() != b'return': os._exit(98)",
    "    connection.close()",
    "    return result",
    "os.replace = gated_replace",
    "runpy.run_path(HELPER, run_name='__main__')",
    "",
  ].join("\n");
  await writeFile(helperPath, script, { mode: 0o600 });
  let closed = false;
  const barrier: ReplaceBarrier = {
    helperPath, before, after,
    replace() { if (!socket) throw new Error("native replace barrier has no connected helper"); socket.write("replace\n"); },
    returnFromReplace() { if (!socket) throw new Error("native replace barrier has no connected helper"); socket.write("return\n"); },
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      barriers.delete(barrier);
      return new Promise<void>((resolveNow) => server.close(() => resolveNow()));
    },
  };
  barriers.add(barrier);
  return barrier;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function contenderRuntime(target: string) {
  const lockWait = deferred<string>();
  const ownerPromise = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! })
    .begin([target], { onEvent: (event) => lockWait.resolve(event.target) });
  const owner = await Promise.race([ownerPromise.then((value) => { owners.add(value); return { ready: value }; }),
    lockWait.promise.then((value) => ({ waiting: value }))]);
  return { ownerPromise, ...owner };
}

describe.sequential("qa remediation owned-root lifetime", () => {
  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("qa-remediation-root-lifetime-");
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "c5-root-locks-")));
    lockRoot = join(scratch, "guards");
    await mkdir(lockRoot, { mode: 0o700 });
    lockRoot = await realpath(lockRoot);
  }, 120_000);

  afterEach(async () => {
    for (const owner of owners) {
      try { await owner.abort(); } catch { /* settled root calls preserve cleanup errors */ }
    }
    for (const gate of activeGates) {
      try { await gate.release(); } catch { /* owning test reports DB cleanup failures */ }
    }
    for (const release of cleanupReleases) release();
    cleanupReleases.clear();
    await Promise.allSettled([...pendingRootCalls]);
    for (const gate of [...activeGates]) {
      try { await gate.remove(); } catch { /* owning test reports DB cleanup failures */ }
    }
    for (const barrier of [...barriers]) {
      try { await barrier.close(); } catch { /* owning test reports process/pipe failures */ }
    }
    const results = await Promise.allSettled([...owners].map((owner) => owner.abort()));
    owners.clear();
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "native owners were not observed stopped");
    await Promise.all([...fixtureClosers].map(close => close()));
    fixtureClosers.clear();
    for (const dir of workspaces) await rm(dir, { recursive: true, force: true });
    workspaces.clear();
  });

  afterAll(async () => {
    const results = await Promise.allSettled([...clients].map((db) => db.$client.end({ timeout: 5 })));
    clients.clear();
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "test DB sessions did not close");
    await postgres?.cleanup();
    if (lockRoot) await rm(dirname(lockRoot), { recursive: true, force: true });
  }, 120_000);

  it("commits before clean owner close, merges only private notifications, and lets an unrelated mission progress", async () => {
    const rootDb = makeDb("normal"), observer = makeDb("observer"), controller = makeDb("controller");
    const first = await seedWorld(rootDb.db, "normal"), unrelated = await seedWorld(observer.db, "unrelated");
    const gate = await installGate(controller.db, first);
    const callerNotifications = createReplacementRootNotifications();
    const priorAgent = randomUUID(), priorWake = randomUUID();
    callerNotifications.agentIds.add(priorAgent);
    callerNotifications.correctionWakeupRequestIds.add(priorWake);
    let settled = false;
    const firstJob = rootCall(first, rootDb.db, nativeRuntime(), callerNotifications).finally(() => { settled = true; });
    const pid = await until(async () => {
      const rows = await observer.db.$client.unsafe(
        "SELECT pid, query FROM pg_stat_activity WHERE application_name = $1 AND state = 'active' AND wait_event_type = 'Lock'",
        [rootDb.applicationName],
      );
      const row = rows.find((candidate) => /insert into [\"]?workflow_transition_events/i.test(String(candidate.query)));
      return row ? Number(row.pid) : null;
    }, "completion INSERT lock barrier");
    expect(pid).toBeGreaterThan(0);
    expect(settled).toBe(false);
    const contender = await contenderRuntime(first.file);
    expect("waiting" in contender).toBe(true);
    if ("waiting" in contender) expect(contender.waiting).toBe(first.file);

    const unrelatedResult = await waitFor(rootCall(unrelated, observer.db, nativeRuntime()), "unrelated mission progress");
    expect(unrelatedResult.result.outcome).toBe("completed");
    expect(await readFile(unrelated.file, "utf8")).toBe(AFTER);
    expect(settled).toBe(false);
    expect([...callerNotifications.agentIds]).toEqual([priorAgent]);
    expect([...callerNotifications.correctionWakeupRequestIds]).toEqual([priorWake]);
    await gate.release();
    void pid;
    const completed = await waitFor(firstJob, "guarded root completion");
    expect(completed.result.outcome).toBe("completed");
    expect(completed.result).toMatchObject({ created: true });
    expect([...callerNotifications.agentIds]).toContain(priorAgent);
    expect([...callerNotifications.agentIds]).toContain(first.verifier);
    expect(callerNotifications.correctionWakeupRequestIds).toContain(priorWake);
    expect(await readFile(first.file, "utf8")).toBe(AFTER);
    if ("waiting" in contender) {
      const contenderOwner = await waitFor(contender.ownerPromise, "contender guard release");
      expect(await contenderOwner.close()).toEqual({ code: 0, signal: null });
    }
    await gate.remove();
  }, 60_000);

  it.each([
    { label: "before real replace", afterReplace: false },
    { label: "after real replace before helper result", afterReplace: true },
  ])("tracks the callback and guard through backend loss $label", async ({ label, afterReplace }) => {
    const rootDb = makeDb(`disconnect-${label}`), observer = makeDb("observer");
    const world = await seedWorld(rootDb.db, `disconnect-${label}`);
    const barrier = await replaceBarrier(label.replace(/[^a-z]/gi, "-"));
    await expectSeedWakeSnapshot(world, observer.db);
    let settled = false;
    const rootJob = rootCall(world, rootDb.db, nativeRuntime(barrier.helperPath)).finally(() => { settled = true; });
    await waitFor(barrier.before, "pre-replace pipe barrier");
    if (afterReplace) {
      barrier.replace();
      await waitFor(barrier.after, "post-replace pipe barrier");
      expect(await readFile(world.file, "utf8")).toBe(AFTER);
    }
    const contender = await contenderRuntime(world.file);
    expect("waiting" in contender).toBe(true);
    if ("waiting" in contender) expect(contender.waiting).toBe(world.file);
    const pid = await rootBackendPid(observer.db, rootDb.applicationName);
    expect(settled).toBe(false);
    const [terminated] = await observer.db.$client.unsafe("SELECT pg_terminate_backend($1::integer) AS terminated", [pid]);
    expect(terminated?.terminated).toBe(true);
    await waitForBackendGone(observer.db, pid);
    const result = await waitFor(rootJob, "callback cleanup after backend loss");
    expect(result.result).toMatchObject({ outcome: "held" });
    expect(result.notifications.agentIds.size).toBe(0);
    expect(result.notifications.correctionWakeupRequestIds.size).toBe(0);
    expect(await rowsFor(world, "qa_remediation_completed", observer.db)).toHaveLength(0);
    expect((await rowsFor(world, QA_REMEDIATION_PREPARATION_EVENT_TYPE, observer.db)).length).toBe(1);
    await expectSeedWakeSnapshot(world, observer.db);
    expect(await readFile(world.file, "utf8")).toBe(afterReplace ? AFTER : BEFORE);
    if ("waiting" in contender) {
      const contenderOwner = await waitFor(contender.ownerPromise, "contender after old owner exit");
      expect(await contenderOwner.close()).toEqual({ code: 0, signal: null });
    }
    await barrier.close();
    const retry = await rootCall(world, rootDb.db, nativeRuntime(), result.notifications);
    expect(retry.result.outcome).toBe("completed");
    if (retry.result.outcome !== "completed") throw new Error("scoped retry did not complete");
    expect(retry.result.created).toBe(true);
    const committed = await assertCommittedV2Completion(world, observer.db);
    expect(retry.result.completion).toEqual(committed.completion);
    await expectWakeSnapshot(world, observer.db, [...world.seedWakes, committed.wake]);
    expect((await rowsFor(world, "qa_remediation_completed", observer.db))).toHaveLength(1);
    expect(await readFile(world.file, "utf8")).toBe(AFTER);
  }, 60_000);

  it("a failed transaction setup before callback entry reaps its owner and retains only the durable preparation", async () => {
    const rootDb = makeDb("begin-failure"), observer = makeDb("observer");
    const world = await seedWorld(rootDb.db, "begin-failure");
    await expectSeedWakeSnapshot(world, observer.db);
    let owner: Awaited<ReturnType<QaFileOwnerRuntime["begin"]>> | undefined;
    const base = nativeRuntime(NATIVE_HELPER, (started) => { owner = started; });
    const failBeforeTransaction: QaFileOwnerRuntime = {
      capability: base.capability,
      async begin(targets, options) {
        const acquired = await base.begin(targets, options);
        // Closing the real pool after durable prepare and helper-ready makes the
        // driver's next transaction setup fail before it can admit its callback.
        await rootDb.db.$client.end({ timeout: 5 });
        return acquired;
      },
    };
    const caller = createReplacementRootNotifications();
    await expect(rootCall(world, rootDb.db, failBeforeTransaction, caller)).rejects.toThrow();
    clients.delete(rootDb.db);
    expect(owner).toBeDefined();
    expect((await owner!.awaitExit())?.signal).toBe("SIGKILL");
    expect(caller.agentIds.size).toBe(0);
    expect(caller.correctionWakeupRequestIds.size).toBe(0);
    expect(await readFile(world.file, "utf8")).toBe(BEFORE);
    expect(await rowsFor(world, QA_REMEDIATION_PREPARATION_EVENT_TYPE, observer.db)).toHaveLength(1);
    expect(await rowsFor(world, "qa_remediation_completed", observer.db)).toHaveLength(0);
    await expectSeedWakeSnapshot(world, observer.db);
    const retryDb = makeDb("begin-reentry");
    const retry = await rootCall(world, retryDb.db, nativeRuntime(), caller);
    expect(retry.result.outcome).toBe("completed");
    if (retry.result.outcome !== "completed") throw new Error("scoped progress after failed setup did not complete");
    expect(retry.result.created).toBe(true);
    const committed = await assertCommittedV2Completion(world, observer.db);
    expect(retry.result.completion).toEqual(committed.completion);
    await expectWakeSnapshot(world, observer.db, [...world.seedWakes, committed.wake]);
    expect(await readFile(world.file, "utf8")).toBe(AFTER);
  }, 60_000);

  it("rolls back when the helper dies during an outstanding completion call and retains the published actual", async () => {
    const rootDb = makeDb("completion-loss"), observer = makeDb("observer"), controller = makeDb("controller");
    const world = await seedWorld(rootDb.db, "completion-loss");
    const gate = await installGate(controller.db, world);
    let owner: Awaited<ReturnType<QaFileOwnerRuntime["begin"]>> | undefined;
    const runtime = nativeRuntime(NATIVE_HELPER, (started) => { owner = started; });
    const caller = createReplacementRootNotifications();
    const job = rootCall(world, rootDb.db, runtime, caller);
    const pid = await until(async () => {
      const rows = await observer.db.$client.unsafe(
        "SELECT pid, query FROM pg_stat_activity WHERE application_name = $1 AND state = 'active' AND wait_event_type = 'Lock'",
        [rootDb.applicationName],
      );
      const row = rows.find((candidate) => /insert into [\"]?workflow_transition_events/i.test(String(candidate.query)));
      return row ? Number(row.pid) : null;
    }, "completion call backend barrier");
    expect(owner).toBeDefined();
    expect(pid).toBeGreaterThan(0);
    const exit = await owner!.abort();
    expect(exit.actualResult).toBe("unknown");
    expect(exit.exit?.signal).toBe("SIGKILL");
    await gate.release();
    const result = await waitFor(job, "completion callback settlement");
    expect(result.result).toMatchObject({ outcome: "held" });
    expect(caller.agentIds.size).toBe(0);
    expect(caller.correctionWakeupRequestIds.size).toBe(0);
    expect(await readFile(world.file, "utf8")).toBe(AFTER);
    expect(await rowsFor(world, "qa_remediation_completed", observer.db)).toHaveLength(0);
    expect((await rowsFor(world, QA_REMEDIATION_PREPARATION_EVENT_TYPE, observer.db))).toHaveLength(1);
    await gate.remove();
  }, 60_000);

  it("requests rollback when an unexpected helper exit follows native success before callback return", async () => {
    const rootDb = makeDb("publish-exit"), observer = makeDb("observer");
    const world = await seedWorld(rootDb.db, "publish-exit");
    const nativeReturned = deferred<void>(), allowCallback = deferred<void>();
    const releaseCallback = () => allowCallback.resolve();
    cleanupReleases.add(releaseCallback);
    let baseOwner: Awaited<ReturnType<QaFileOwnerRuntime["begin"]>> | undefined;
    const runtime: QaFileOwnerRuntime = {
      capability: Promise.resolve({ status: "configured", scope: "configuration-only", lockRoot,
        pythonCommand: PYTHON!, helperPath: NATIVE_HELPER }),
      async begin(targets, options) {
        const base = await QaRemediationFileOwner.begin({ lockRoot, targets, pythonCommand: PYTHON!, helperPath: NATIVE_HELPER,
          onEvent: options?.onEvent, signal: options?.signal });
        baseOwner = base;
        owners.add(base);
        return {
          targets: () => base.targets(),
          async publish(items) {
            const result = await base.publish(items);
            nativeReturned.resolve();
            await allowCallback.promise;
            return result;
          },
          abort: () => base.abort(),
          awaitExit: () => base.awaitExit(),
          close: () => base.close(),
        } as unknown as Awaited<ReturnType<QaFileOwnerRuntime["begin"]>>;
      },
    };
    const caller = createReplacementRootNotifications();
    let settled = false;
    const job = rootCall(world, rootDb.db, runtime, caller).finally(() => { settled = true; });
    await waitFor(nativeReturned.promise, "native publication receipt");
    expect(await readFile(world.file, "utf8")).toBe(AFTER);
    expect(settled).toBe(false);
    const exit = await baseOwner!.abort();
    expect(exit.actualResult).toBe("unknown");
    expect(exit.exit?.signal).toBe("SIGKILL");
    releaseCallback();
    cleanupReleases.delete(releaseCallback);
    const result = await waitFor(job, "callback rollback after native owner loss");
    expect(result.result).toMatchObject({ outcome: "held" });
    expect(caller.agentIds.size).toBe(0);
    expect(caller.correctionWakeupRequestIds.size).toBe(0);
    expect(await rowsFor(world, "qa_remediation_completed", observer.db)).toHaveLength(0);
    expect((await rowsFor(world, QA_REMEDIATION_PREPARATION_EVENT_TYPE, observer.db))).toHaveLength(1);
    expect(await readFile(world.file, "utf8")).toBe(AFTER);
  }, 60_000);

  it("reports helper loss while COMMIT is held without claiming rollback, then reentry recognizes the durable completion", async () => {
    const rootDb = makeDb("commit-loss"), observer = makeDb("observer"), controller = makeDb("controller");
    const world = await seedWorld(rootDb.db, "commit-loss");
    await expectSeedWakeSnapshot(world, observer.db);
    const gate = await installGate(controller.db, world, true);
    let owner: Awaited<ReturnType<QaFileOwnerRuntime["begin"]>> | undefined;
    const runtime = nativeRuntime(NATIVE_HELPER, (started) => { owner = started; });
    const caller = createReplacementRootNotifications();
    const priorAgent = randomUUID(), priorCorrectionWake = randomUUID();
    caller.agentIds.add(priorAgent);
    caller.correctionWakeupRequestIds.add(priorCorrectionWake);
    let settled = false;
    const job = rootCall(world, rootDb.db, runtime, caller).finally(() => { settled = true; });
    const pid = await until(async () => {
      const rows = await observer.db.$client.unsafe(
        "SELECT pid, query FROM pg_stat_activity WHERE application_name = $1 AND state = 'active' AND wait_event_type = 'Lock'",
        [rootDb.applicationName],
      );
      const row = rows.find((candidate) => /commit/i.test(String(candidate.query)));
      return row ? Number(row.pid) : null;
    }, "deferred COMMIT barrier");
    expect(owner).toBeDefined();
    expect(settled).toBe(false);
    const exit = await owner!.abort();
    expect(exit.actualResult).toBe("unknown");
    expect(exit.exit?.signal).toBe("SIGKILL");
    expect(settled).toBe(false);
    await gate.release();
    const result = await waitFor(job, "transaction result after helper loss");
    expect(result.result).toMatchObject({ outcome: "held", reason: "owner_lost" });
    expect([...caller.agentIds].sort()).toEqual([priorAgent]);
    expect([...caller.correctionWakeupRequestIds]).toEqual([priorCorrectionWake]);
    expect(await rowsFor(world, "qa_remediation_completed", observer.db)).toHaveLength(1);
    const committed = await assertCommittedV2Completion(world, observer.db);
    const committedWakeSnapshot = [...world.seedWakes, committed.wake].sort((left, right) => left.id.localeCompare(right.id));
    await expectWakeSnapshot(world, observer.db, committedWakeSnapshot);
    const reentry = await rootCall(world, rootDb.db, nativeRuntime(), caller);
    expect(reentry.result).toMatchObject({ outcome: "completed", created: false });
    if (reentry.result.outcome !== "completed") throw new Error("durable completion reentry did not complete");
    expect(reentry.result.completion).toEqual(committed.completion);
    expect(reentry.result.notifications).toEqual({ agentIds: [world.verifier],
      wakeupRequestIds: [committed.completion.wakes[0]!.wakeupRequestId] });
    expect([...caller.agentIds].sort()).toEqual([priorAgent, world.verifier].sort());
    expect([...caller.correctionWakeupRequestIds]).toEqual([priorCorrectionWake]);
    await expectWakeSnapshot(world, observer.db, committedWakeSnapshot);
    expect(await rowsFor(world, "qa_remediation_completed", observer.db)).toHaveLength(1);
    await gate.remove();
    void pid;
  }, 60_000);

  it("withholds notification promotion when commit is known but native close exits abnormally", async () => {
    const rootDb = makeDb("close-loss"), observer = makeDb("observer");
    const world = await seedWorld(rootDb.db, "close-loss");
    const closeStarted = deferred<void>(), allowClose = deferred<void>();
    const releaseClose = () => allowClose.resolve();
    cleanupReleases.add(releaseClose);
    let baseOwner: Awaited<ReturnType<QaFileOwnerRuntime["begin"]>> | undefined;
    const runtime = nativeRuntime(NATIVE_HELPER, (started) => { baseOwner = started; }, (base) => ({
      targets: () => base.targets(),
      publish: (items) => base.publish(items),
      abort: () => base.abort(),
      awaitExit: () => base.awaitExit(),
      async close() { closeStarted.resolve(); await allowClose.promise; return base.close(); },
    } as unknown as Awaited<ReturnType<QaFileOwnerRuntime["begin"]>>));
    const caller = createReplacementRootNotifications();
    const rootJob = rootCall(world, rootDb.db, runtime, caller);
    await waitFor(closeStarted.promise, "post-commit close gate");
    expect(await rowsFor(world, "qa_remediation_completed", observer.db)).toHaveLength(1);
    expect(baseOwner).toBeDefined();
    const exit = await baseOwner!.abort();
    expect(exit.exit?.signal).toBe("SIGKILL");
    releaseClose();
    cleanupReleases.delete(releaseClose);
    const result = await waitFor(rootJob, "unclean close settlement");
    expect(result.result).toMatchObject({ outcome: "held", reason: "owner_lost" });
    expect(caller.agentIds).toHaveLength(0);
    expect(caller.correctionWakeupRequestIds).toHaveLength(0);
    expect(await rowsFor(world, "qa_remediation_completed", observer.db)).toHaveLength(1);
  }, 60_000);

  it("holds when locked preparation targets drift from the acquired owner, and holds unsupported payload sizes", async () => {
    const rootDb = makeDb("target-drift"), observer = makeDb("observer");
    const world = await seedWorld(rootDb.db, "target-drift");
    const drift = nativeRuntime();
    const wrapper: QaFileOwnerRuntime = {
      capability: drift.capability,
      async begin(targets, options) {
        const owner = await drift.begin(targets, options);
        owners.add(owner);
        const rows = await rootDb.db.select().from(workflowTransitionEvents).where(and(
          eq(workflowTransitionEvents.companyId, world.companyId), eq(workflowTransitionEvents.workflowRunId, world.runId),
          eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
        const row = rows[0];
        if (!row) throw new Error("durable preparation was not present before native acquire returned");
        const altered = structuredClone(row.payload) as unknown as QaRemediationPreparation;
        const replacementTarget = join(world.dir, "drifted.md");
        altered.files = altered.files.map((file) => ({ ...file, path: replacementTarget }));
        altered.verdicts = altered.verdicts.map((verdict) => {
          const items = verdict.items.map((item) => ({ ...item, file: replacementTarget }));
          return { ...verdict, items, remediationsHash: hashQaCorrectionPayload(items) };
        });
        await rootDb.db.update(workflowTransitionEvents).set({ payload: altered }).where(eq(workflowTransitionEvents.id, row.id));
        return owner;
      },
    };
    const result = await rootCall(world, rootDb.db, wrapper);
    expect(result.result).toMatchObject({ outcome: "held", reason: "owner_target_mismatch" });
    expect(await readFile(world.file, "utf8")).toBe(BEFORE);
    expect(await rowsFor(world, "qa_remediation_completed", observer.db)).toHaveLength(0);

    const payloadDb = makeDb("payload-size");
    const payloadWorld = await seedWorld(payloadDb.db, "payload-size");
    const prepared = await prepareQaRemediationReservation(payloadDb.db, requestOf(payloadWorld));
    expect(prepared.outcome).toBe("prepared");
    if (prepared.outcome !== "prepared") return;
    const parsed = parseQaRemediationPreparation({ ...prepared.preparation,
      files: prepared.preparation.files.map((file) => ({ ...file, afterByteSize: QA_REMEDIATION_MAX_FILE_BYTES + 1 })) });
    const owner = await createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! }).begin([payloadWorld.file]);
    owners.add(owner);
    const authority: QaRemediationPublicationAuthority = { reservationEventId: parsed.preparationId,
      dispatchAuthorityVersion: parsed.dispatchAuthorityVersion, allowedFiles: new Set([payloadWorld.file]), allowedDirs: [payloadWorld.dir] };
    const held = await publishQaRemediationPreparation(parsed, authority, owner);
    expect(held).toMatchObject({ outcome: "held", reason: "unsupported_payload_size" });
    expect(await readFile(payloadWorld.file, "utf8")).toBe(BEFORE);
    expect(await owner.close()).toEqual({ code: 0, signal: null });
  }, 60_000);

  it("holds same-target preparation payload drift against the exact committed snapshot", async () => {
    const rootDb = makeDb("payload-drift"), observer = makeDb("observer");
    const world = await seedWorld(rootDb.db, "payload-drift");
    const base = nativeRuntime();
    const alteredRuntime: QaFileOwnerRuntime = {
      capability: base.capability,
      async begin(targets, options) {
        const owner = await base.begin(targets, options);
        owners.add(owner);
        const rows = await rootDb.db.select().from(workflowTransitionEvents).where(and(
          eq(workflowTransitionEvents.companyId, world.companyId), eq(workflowTransitionEvents.workflowRunId, world.runId),
          eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
        const row = rows[0];
        if (!row) throw new Error("durable preparation was not present before native acquire returned");
        const altered = structuredClone(row.payload) as unknown as QaRemediationPreparation;
        altered.verdicts = altered.verdicts.map((verdict) => {
          const items = verdict.items.map((item) => ({ ...item, replace: "same-target-payload-drift" }));
          return { ...verdict, items, remediationsHash: hashQaCorrectionPayload(items) };
        });
        await rootDb.db.update(workflowTransitionEvents).set({ payload: altered }).where(eq(workflowTransitionEvents.id, row.id));
        return owner;
      },
    };
    const result = await rootCall(world, rootDb.db, alteredRuntime);
    expect(result.result).toMatchObject({ outcome: "held", reason: "invalid_reservation" });
    expect(await readFile(world.file, "utf8")).toBe(BEFORE);
    expect(await rowsFor(world, "qa_remediation_completed", observer.db)).toHaveLength(0);
    expect((await rowsFor(world, QA_REMEDIATION_PREPARATION_EVENT_TYPE, observer.db))).toHaveLength(1);
  }, 60_000);

  it("preserves the real native applied prefix and io_error result when a later target disappears", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "c5-root-prefix-")));
    workspaces.add(dir);
    const first = join(dir, "a.txt"), secondDir = join(dir, "z"), second = join(secondDir, "b.txt");
    await mkdir(secondDir);
    const beforeA = "A old\n", afterA = "A new\n", beforeB = "B old\n", afterB = "B new\n";
    await writeFile(first, beforeA, { mode: 0o600 });
    await writeFile(second, beforeB, { mode: 0o600 });
    const items = [
      { op: "string_replace" as const, file: first, find: "old", replace: "new" },
      { op: "string_replace" as const, file: second, find: "old", replace: "new" },
    ];
    const preparation: QaRemediationPreparation = {
      schemaVersion: "workflow.qa-remediation.prepare.v2", preparationId: randomUUID(), companyId: randomUUID(),
      missionId: randomUUID(), workflowRunId: randomUUID(), dispatchAuthorityVersion: 1,
      producer: { stepRunId: randomUUID(), stepId: "producer", issueId: randomUUID(), executionGeneration: 1, retryCount: 0, iterationIndex: 0 },
      verdicts: [{ eventId: randomUUID(), heartbeatRunId: randomUUID(),
        qa: { stepRunId: randomUUID(), stepId: "qa", issueId: randomUUID(), executionGeneration: 1, retryCount: 0, iterationIndex: 0 },
        items, remediationsHash: hashQaCorrectionPayload(items) }],
      files: [
        { path: first, beforeSha256: sha(beforeA), afterSha256: sha(afterA), beforeByteSize: Buffer.byteLength(beforeA), afterByteSize: Buffer.byteLength(afterA) },
        { path: second, beforeSha256: sha(beforeB), afterSha256: sha(afterB), beforeByteSize: Buffer.byteLength(beforeB), afterByteSize: Buffer.byteLength(afterB) },
      ],
      preparedAt: new Date().toISOString(),
    };
    const barrier = await replaceBarrier("partial-prefix");
    const owner = await QaRemediationFileOwner.begin({ lockRoot, targets: preparation.files.map((file) => file.path).sort(),
      pythonCommand: PYTHON!, helperPath: barrier.helperPath });
    owners.add(owner);
    const authority: QaRemediationPublicationAuthority = { reservationEventId: preparation.preparationId,
      dispatchAuthorityVersion: preparation.dispatchAuthorityVersion, allowedFiles: new Set(), allowedDirs: [dir] };
    const publication = publishQaRemediationPreparation(preparation, authority, owner);
    const before = await waitFor(barrier.before, "first real native replace");
    expect(before.dst).toBe(first);
    barrier.replace();
    await waitFor(barrier.after, "first real replace completion");
    await rm(secondDir, { recursive: true, force: true });
    barrier.returnFromReplace();
    const result = await waitFor(publication, "native partial publication result");
    expect(result.outcome).toBe("io_error");
    if (result.outcome !== "io_error") throw new Error("expected the native io_error outcome");
    expect(result.files.map((file) => [file.file, file.status])).toEqual([
      [first, "applied"], [second, "io_error"],
    ]);
    expect(await readFile(first, "utf8")).toBe(afterA);
    expect(await owner.close()).toEqual({ code: 0, signal: null });
    await barrier.close();
  }, 60_000);

  it("holds the complete serialized native frame before sending any partial item set", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "c5-root-frame-")));
    workspaces.add(dir);
    const specs: { path: string; before: string; beforeBytes: Buffer; afterBytes: Buffer;
      items: { op: "string_replace"; file: string; find: string; replace: string }[] }[] = [];
    for (let index = 0; index < 50; index += 1) {
      const target = join(dir, `file-${String(index).padStart(2, "0")}.txt`);
      const items = Array.from({ length: 20 }, (_, itemIndex) => ({ op: "string_replace" as const,
        file: target, find: `[[C5_TOKEN_${index}_${itemIndex}]]`, replace: String.fromCharCode(65 + (index % 26)).repeat(8000) }));
      const before = items.map((item) => item.find).join("|");
      let after = before;
      for (const item of items) {
        expect(before.split(item.find).length - 1).toBe(1);
        after = replaceExactlyOnce(after, item.find, item.replace);
      }
      const beforeBytes = Buffer.from(before, "utf8"), afterBytes = Buffer.from(after, "utf8");
      expect(beforeBytes.byteLength).toBeLessThan(QA_REMEDIATION_MAX_FILE_BYTES);
      expect(afterBytes.byteLength).toBeLessThan(QA_REMEDIATION_MAX_FILE_BYTES);
      await writeFile(target, before, { mode: 0o600 });
      specs.push({ path: target, before, beforeBytes, afterBytes, items });
    }
    const preparation: QaRemediationPreparation = {
      schemaVersion: "workflow.qa-remediation.prepare.v2", preparationId: randomUUID(), companyId: randomUUID(),
      missionId: randomUUID(), workflowRunId: randomUUID(), dispatchAuthorityVersion: 1,
      producer: { stepRunId: randomUUID(), stepId: "producer", issueId: randomUUID(), executionGeneration: 1, retryCount: 0, iterationIndex: 0 },
      verdicts: specs.map((spec, index) => ({ eventId: randomUUID(), heartbeatRunId: randomUUID(),
        qa: { stepRunId: randomUUID(), stepId: `qa-${index}`, issueId: randomUUID(), executionGeneration: 1, retryCount: 0, iterationIndex: 0 },
        items: spec.items, remediationsHash: hashQaCorrectionPayload(spec.items) })),
      files: specs.map((spec) => ({ path: spec.path, beforeSha256: sha(spec.beforeBytes), afterSha256: sha(spec.afterBytes),
        beforeByteSize: spec.beforeBytes.byteLength, afterByteSize: spec.afterBytes.byteLength })),
      preparedAt: new Date().toISOString(),
    };
    const frameItems = specs.map((spec) => ({ target: spec.path, beforeSha256: sha(spec.beforeBytes),
      beforeSize: spec.beforeBytes.byteLength, afterSha256: sha(spec.afterBytes), afterSize: spec.afterBytes.byteLength,
      bytesB64: spec.afterBytes.toString("base64") }));
    const serializedFrame = `${JSON.stringify({ v: FILE_OWNER_PROTOCOL_VERSION,
      id: "00000000-0000-4000-8000-000000000000", op: "publish", items: frameItems })}\n`;
    expect(Buffer.byteLength(serializedFrame, "utf8")).toBeGreaterThan(8 * 1024 * 1024);
    const nativeOwner = await createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! })
      .begin(preparation.files.map((file) => file.path).sort());
    owners.add(nativeOwner);
    let publishAdmissions = 0;
    const owner = {
      targets: () => nativeOwner.targets(),
      publish: (items: Parameters<typeof nativeOwner.publish>[0]) => {
        publishAdmissions += 1;
        return nativeOwner.publish(items);
      },
      abort: () => nativeOwner.abort(),
      awaitExit: () => nativeOwner.awaitExit(),
      close: () => nativeOwner.close(),
    } as typeof nativeOwner;
    const held = await publishQaRemediationPreparation(preparation, {
      reservationEventId: preparation.preparationId, dispatchAuthorityVersion: preparation.dispatchAuthorityVersion,
      allowedFiles: new Set(), allowedDirs: [dir],
    }, owner);
    expect(held).toMatchObject({ outcome: "held", reason: "unsupported_frame_size" });
    expect(publishAdmissions).toBe(0);
    const originals = await Promise.all(specs.map((spec) => readFile(spec.path)));
    expect(originals).toEqual(specs.map((spec) => spec.beforeBytes));
    expect(originals.map(sha)).toEqual(specs.map((spec) => sha(spec.beforeBytes)));
    expect(await owner.close()).toEqual({ code: 0, signal: null });
  }, 60_000);
});
