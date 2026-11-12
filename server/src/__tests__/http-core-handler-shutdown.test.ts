import { randomUUID } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import {
  agentToolGrants,
  agents,
  companyMemberships,
  pluginToolExecutionReceipts,
  toolDefinitions,
  type Db,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, createAppRuntimeShutdownController } from "../app.js";
import { HttpHandlerFinalizationHeldError } from "../services/http-handler-lifetime.js";
import {
  deferredBeforeStartSchema, runtimeExecutionLifecycle, type RuntimeExecutionIdentity,
} from "../services/runtime-execution-lifecycle.js";
import {
  seedCompanyOnly,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";

type Fixture = Extract<ExecutionDefinitionFixture, { supported: true }>;
let fixture: Fixture | undefined;
let db!: Db;
let app!: Awaited<ReturnType<typeof createApp>>;
let tempRoot = "";
let companyId = "";
let userId = "";
let agentId = "";
let toolSequence = 0;
let originalCreateScope: typeof runtimeExecutionLifecycle.createScope | undefined;
const identities: RuntimeExecutionIdentity[] = [];
const pendingHttpRequests = new Set<Promise<unknown>>();
const releasedChildPids = new Set<number>();
let ownedChildMarker = "";
let begunChildResponseSettled = true;
const authGate = deferred<void>();
let authWaiters = 0;
let authWaitersReady!: () => void;
const authReady = new Promise<void>((resolve) => { authWaitersReady = resolve; });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function seedCommand() {
  const name = `h2b-core-${++toolSequence}-${randomUUID()}`;
  const [tool] = await db.insert(toolDefinitions)
    .values({ companyId, name, adapterType: "builtin", adapterConfig: { command: process.execPath } })
    .returning({ id: toolDefinitions.id });
  if (!tool) throw new Error("http_core_tool_seed_failed");
  await db.insert(agentToolGrants).values({ companyId, agentId, toolId: tool.id, grantedBy: "h2b-test" });
  return name;
}

function post(url: string, body: Record<string, unknown>, options: { session?: boolean; origin?: string; holdAuth?: boolean } = {}) {
  let call = request(app).post(url).set("Origin", options.origin ?? "http://localhost:3100");
  if (options.session !== false) call = call.set("x-session", "yes");
  if (options.holdAuth) call = call.set("x-hold-auth", "yes");
  const response = call.send(body).then((value) => value);
  pendingHttpRequests.add(response);
  void response.then(() => pendingHttpRequests.delete(response), () => pendingHttpRequests.delete(response));
  return response;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const joinPendingHttpRequests = (timeoutMs = 5_000) => settlesWithin(Promise.allSettled([...pendingHttpRequests]), timeoutMs);

async function readChildPids(file: string): Promise<number[]> {
  try {
    return [...new Set((await readFile(file, "utf8")).trim().split("\n").filter(Boolean)
      .map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function releaseOwnedChildren(file: string): Promise<void> {
  for (const pid of await readChildPids(file)) {
    if (releasedChildPids.has(pid)) continue;
    try {
      if (process.kill(pid, "SIGUSR1")) releasedChildPids.add(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") releasedChildPids.add(pid);
      else throw error;
    }
  }
}

const runContext = (runId = randomUUID()) => ({ agentId, runId, companyId });

const commandBody = (tool: string, runId: string, script: string, idempotencyKey?: string) => ({
  tool,
  parameters: ["-e", script],
  runContext: runContext(runId),
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});

async function rowsFor(runId: string, tool: string) {
  return db.select().from(pluginToolExecutionReceipts).where(and(eq(pluginToolExecutionReceipts.companyId, companyId),
    eq(pluginToolExecutionReceipts.runId, runId), eq(pluginToolExecutionReceipts.tool, tool)));
}

async function waitForFile(file: string): Promise<void> {
  if (existsSync(file)) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      error ? reject(error) : resolve();
    };
    const watcher = watch(path.dirname(file), (_event, name) => {
      if (name?.toString() === path.basename(file) && existsSync(file)) finish();
    });
    watcher.on("error", finish);
    const timer = setTimeout(() => finish(new Error(`child_start_marker_not_seen:${file}`)), 15_000);
    if (existsSync(file)) finish();
  });
}

async function waitUntilBlocked(observer: Db, blockerPid: number, expected: { runId: string; tool: string }) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await observer.execute(sql`
      select pid, pg_blocking_pids(pid) as blockers, query
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and ${blockerPid} = any(pg_blocking_pids(pid))
        and query ilike '%tool_definitions%'
    `) as unknown as Array<{ pid: number; blockers: number[]; query: string }>;
    const blocked = rows.filter((row) => row.blockers.includes(blockerPid));
    const receipts = await rowsFor(expected.runId, expected.tool);
    if (blocked.length === 1 && receipts.length === 1 && receipts[0]?.status === "executing") {
      return { query: blocked[0]!.query, receipt: receipts[0]! };
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`tool_definitions_wait_not_attributed_to_receipt_${expected.runId}_${blockerPid}`);
}

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "http-core-handler-shutdown-"));
  const started = await startExecutionDefinitionFixture("http-core-handler-shutdown-");
  if (!started.supported) throw new Error(started.reason);
  fixture = started;
  db = started.db;
  const seeded = await seedCompanyOnly(started.sql, `H2B${randomUUID().replace(/-/gu, "").slice(0, 8)}`);
  companyId = seeded.companyId;
  userId = randomUUID();
  const [agent] = await db.insert(agents).values({ companyId, name: "H2b HTTP agent" }).returning({ id: agents.id });
  if (!agent) throw new Error("http_core_agent_seed_failed");
  agentId = agent.id;
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active" });
  const appRoot = path.join(tempRoot, "plugins");
  await mkdir(appRoot, { recursive: true });
  originalCreateScope = runtimeExecutionLifecycle.createScope;
  runtimeExecutionLifecycle.createScope = (identity) => { identities.push(identity); return originalCreateScope!(identity); };
  app = await createApp(db, {
    uiMode: "none", serverPort: 3100, storageService: {} as never,
    deploymentMode: "authenticated", deploymentExposure: "public", allowedHostnames: [], bindHost: "127.0.0.1",
    authReady: true, companyDeletionEnabled: false, localPluginDir: appRoot,
    resolveSession: async (req) => {
      if (req.header("x-hold-auth") === "yes") {
        authWaiters += 1;
        if (authWaiters === 2) authWaitersReady();
        await authGate.promise;
      }
      if (req.header("x-session") !== "yes") return null;
      return { session: { id: "h2b-session", userId }, user: { id: userId } };
    },
  });
}, 120_000);

afterAll(async () => {
  authGate.resolve();
  if (app) {
    runtimeExecutionLifecycle.beginShutdown("SIGTERM");
    app.runtimeShutdown.stopStarts();
    app.runtimeShutdown.sealHttpIngress();
    if (ownedChildMarker && !begunChildResponseSettled) {
      await releaseOwnedChildren(ownedChildMarker).catch(() => undefined);
    }
    if (!(await joinPendingHttpRequests())) {
      throw new Error("http_core_handler_pending_requests_not_settled; shared database left undisposed");
    }
    if (!(await settlesWithin(app.runtimeShutdown.drain(), 5_000))) throw new Error("http_drain_cleanup_timeout");
    if (!(await settlesWithin(app.runtimeShutdown.drainHttpCallbacks(), 5_000))) throw new Error("callback_drain_cleanup_timeout");
    if (!(await settlesWithin(app.runtimeShutdown.dispose(), 5_000))) throw new Error("runtime_dispose_cleanup_timeout");
  }
  if (originalCreateScope) runtimeExecutionLifecycle.createScope = originalCreateScope;
  await fixture?.cleanup().catch(() => undefined);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

describe("HTTP core execute shutdown", () => {
  it("admits canonical and alias requests before auth and joins the held auth stage", async () => {
    const arrivals: Promise<unknown>[] = [];
    try {
      const canonical = post("/api/plugins/tools/execute", {}, { holdAuth: true });
      arrivals.push(canonical);
      const alias = post("/plugins/tools/execute", {}, { holdAuth: true });
      arrivals.push(alias);
      if (!(await settlesWithin(authReady, 5_000))) throw new Error("both_http_auth_arrivals_not_observed");
      let drained = false;
      const drain = app.runtimeShutdown.drainHttpProducers().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      authGate.resolve();
      if (!(await settlesWithin(Promise.all([canonical, alias]), 5_000))) throw new Error("held_auth_responses_not_settled");
      const [canonicalResponse, aliasResponse] = await Promise.all([canonical, alias]);
      expect(canonicalResponse.status).toBe(400);
      expect(aliasResponse.status).toBe(400);
      if (!(await settlesWithin(drain, 5_000))) throw new Error("held_auth_drain_not_settled");
      await drain;
      expect(drained).toBe(true);
    } finally {
      authGate.resolve();
      await settlesWithin(Promise.allSettled(arrivals), 5_000);
    }
  }, 20_000);

  it("finishes auth errors and synchronous Origin denial without claiming receipts", async () => {
    const tool = await seedCommand();
    const body = commandBody(tool, randomUUID(), "process.stdout.write('must-not-start')", "auth-never-claimed");
    expect((await post("/api/plugins/tools/execute", body, { session: false })).status).toBe(401);
    expect((await post("/api/plugins/tools/execute", body, { origin: "https://evil.example" })).status).toBe(403);
    const crossCompany = {
      ...body,
      runContext: { ...runContext(), companyId: randomUUID() },
    };
    expect((await post("/api/plugins/tools/execute", crossCompany)).status).toBe(403);
    await expect(app.runtimeShutdown.drainHttpProducers()).resolves.toBeUndefined();
    expect(await rowsFor(body.runContext.runId as string, tool)).toHaveLength(0);
  });

  it("replays keyed responses and gives unkeyed alias calls private one-request receipts", async () => {
    const keyedTool = await seedCommand();
    const keyedRun = randomUUID();
    const keyedMarker = path.join(tempRoot, "keyed-starts");
    const keyedScript = `require('node:fs').appendFileSync(${JSON.stringify(keyedMarker)}, 'x');process.stdout.write('keyed-result')`;
    const keyedBody = commandBody(keyedTool, keyedRun, keyedScript, "h2b-keyed");
    const first = await post("/api/plugins/tools/execute", keyedBody);
    const replay = await post("/api/plugins/tools/execute", keyedBody);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers["x-idempotent-replay"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(await rowsFor(keyedRun, keyedTool)).toMatchObject([{ status: "completed", resultStatus: 200, resultBody: first.body }]);
    expect(await readFile(keyedMarker, "utf8")).toBe("x");

    const unkeyedTool = await seedCommand();
    const unkeyedRun = randomUUID();
    const unkeyedMarker = path.join(tempRoot, "unkeyed-starts");
    const unkeyedBody = commandBody(unkeyedTool, unkeyedRun, `require('node:fs').appendFileSync(${JSON.stringify(unkeyedMarker)}, 'x');process.stdout.write('unkeyed-result')`);
    const firstUnkeyed = await post("/plugins/tools/execute", unkeyedBody);
    const secondUnkeyed = await post("/plugins/tools/execute", unkeyedBody);
    expect(firstUnkeyed.status).toBe(200);
    expect(secondUnkeyed.status).toBe(200);
    expect(firstUnkeyed.headers["x-idempotent-replay"]).toBeUndefined();
    const unkeyedRows = await rowsFor(unkeyedRun, unkeyedTool);
    expect(unkeyedRows).toHaveLength(2);
    expect(unkeyedRows.every((row) => row.status === "completed")).toBe(true);
    expect(new Set(unkeyedRows.map((row) => row.idempotencyKey)).size).toBe(2);
    for (const row of unkeyedRows) expect(identities).toContainEqual({ requestId: row.id,
      executionId: unkeyedRun, attemptId: row.id, executionGeneration: 1 });
    expect(await readFile(unkeyedMarker, "utf8")).toBe("xx");
  });

  it("holds a failed actual-result commit and keeps the same key from starting twice", async () => {
    const tool = await seedCommand();
    const runId = randomUUID();
    const marker = path.join(tempRoot, "commit-failure-starts");
    const sqlClient = fixture!.sql;
    await sqlClient`CREATE FUNCTION h2b_reject_receipt_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.idempotency_key = 'h2b-commit-failure' AND NEW.status = 'completed' THEN
        RAISE EXCEPTION 'h2b_receipt_commit_rejected'; END IF; RETURN NEW; END $$`;
    await sqlClient`CREATE TRIGGER h2b_reject_receipt_completion BEFORE UPDATE ON plugin_tool_execution_receipts
      FOR EACH ROW EXECUTE FUNCTION h2b_reject_receipt_completion()`;
    const body = commandBody(tool, runId, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x');process.stdout.write('original-commit-result')`, "h2b-commit-failure");
    const failed = await post("/api/plugins/tools/execute", body);
    await sqlClient`DROP TRIGGER h2b_reject_receipt_completion ON plugin_tool_execution_receipts`;
    await sqlClient`DROP FUNCTION h2b_reject_receipt_completion()`;
    expect(failed.status).toBe(500);
    const [row] = await rowsFor(runId, tool);
    expect(row).toMatchObject({ status: "executing", resultStatus: null, resultBody: null, completedAt: null });
    expect((await post("/api/plugins/tools/execute", body)).status).toBe(409);
    expect(await readFile(marker, "utf8")).toBe("x");
    const hold = await app.runtimeShutdown.drainHttpProducers().then(() => null, (error: unknown) => error);
    expect(hold).toBeInstanceOf(HttpHandlerFinalizationHeldError);
    const evidence = (hold as HttpHandlerFinalizationHeldError).heldFinalizations[0]?.evidence as Record<string, any>;
    expect(evidence).toMatchObject({ receipt: { id: row.id }, originalResult: { status: 200, body: { content: "original-commit-result" } },
      response: { status: 200, body: { content: "original-commit-result" } } });
  });

  it("preserves a begun child and refuses a prepared HTTP start after the shared stop", async () => {
    const begunTool = await seedCommand();
    const begunRun = randomUUID();
    const childMarker = path.join(tempRoot, "begun-child.pid");
    ownedChildMarker = childMarker;
    begunChildResponseSettled = false;
    let locker: Db | undefined;
    let observer: Db | undefined;
    let heldClient: Awaited<ReturnType<Db["$client"]["reserve"]>> | undefined;
    let pausedResponsePromise: ReturnType<typeof post> | undefined;
    let lockReleased = false;
    try {
      const begunBody = commandBody(begunTool, begunRun,
        `const fs=require('node:fs');const keepalive=setInterval(()=>{},1000);keepalive.ref();let releasing=false;process.on('SIGUSR1',()=>{if(releasing)return;releasing=true;clearInterval(keepalive);process.stdout.write('http-original-result',()=>process.exit(0))});fs.appendFileSync(${JSON.stringify(childMarker)},String(process.pid)+'\\n')`,
        "h2b-begun");
      const begunResponsePromise = post("/api/plugins/tools/execute", begunBody);
      void begunResponsePromise.then(() => { begunChildResponseSettled = true; }, () => { begunChildResponseSettled = true; });
      await waitForFile(childMarker);
      // [ci-s1] Linux inotify 는 open(O_CREAT) 0바이트 생성 시점에도 이벤트를 낸다. 존재만 보고 즉시
      //   읽으면 appendFileSync 기록 전 빈 파일("")로 [] 를 얻는다 — PID 1개가 기록될 때까지 폴링한다.
      await vi.waitFor(async () => {
        expect(await readChildPids(childMarker)).toHaveLength(1);
      }, { timeout: 15_000, interval: 20 });
      const begunRows = await rowsFor(begunRun, begunTool);
      expect(begunRows).toHaveLength(1);
      const begunReceipt = begunRows[0]!;
      expect(begunReceipt.status).toBe("executing");
      expect((await post("/api/plugins/tools/execute", begunBody)).status).toBe(409);
      expect(await readChildPids(childMarker)).toHaveLength(1);

      const pausedTool = await seedCommand();
      const pausedRun = randomUUID();
      const pausedMarker = path.join(tempRoot, "paused-child-started");
      const pausedBody = commandBody(pausedTool, pausedRun, `require('node:fs').writeFileSync(${JSON.stringify(pausedMarker)},'started')`, "h2b-paused");
      locker = fixture!.openConnection();
      observer = fixture!.openConnection();
      heldClient = await locker.$client.reserve();
      await heldClient.unsafe("begin");
      await heldClient.unsafe("lock table tool_definitions in access exclusive mode");
      const [{ pid }] = await heldClient.unsafe("select pg_backend_pid() as pid") as unknown as [{ pid: number }];
      pausedResponsePromise = post("/api/plugins/tools/execute", pausedBody);
      let pausedResponseSettled = false;
      void pausedResponsePromise.then(() => { pausedResponseSettled = true; }, () => { pausedResponseSettled = true; });
      const blockedPreparation = await waitUntilBlocked(observer, Number(pid), { runId: pausedRun, tool: pausedTool });
      const pausedReceipt = blockedPreparation.receipt;
      expect(pausedResponseSettled).toBe(false);
      let drainSettled = false;
      let drainError: unknown;
      const drain = app.runtimeShutdown.drainHttpProducers().then(
        () => { drainSettled = true; },
        (error: unknown) => { drainError = error; drainSettled = true; },
      );
      runtimeExecutionLifecycle.beginShutdown("SIGTERM");
      app.runtimeShutdown.stopStarts();
      expect((await post("/api/plugins/tools/execute", pausedBody)).status).toBe(503);
      expect((await post("/plugins/tools/execute", pausedBody)).status).toBe(503);
      await Promise.resolve();
      expect(drainSettled).toBe(false);
      expect(begunChildResponseSettled).toBe(false);
      expect((await rowsFor(begunRun, begunTool))[0]).toMatchObject({ id: begunReceipt.id, status: "executing" });

      await heldClient.unsafe("rollback");
      lockReleased = true;
      if (!(await settlesWithin(pausedResponsePromise, 5_000))) throw new Error("paused_http_response_not_settled");
      const pausedResponse = await pausedResponsePromise;
      expect(pausedResponse.status).toBe(503);
      const proof = deferredBeforeStartSchema.safeParse(pausedResponse.body.deferredBeforeStart);
      expect(proof.success).toBe(true);
      if (!proof.success) throw new Error("http_paused_start_proof_invalid");
      expect(proof.data).toEqual({
        kind: "deferred_before_start", version: 1, reasonCode: "runtime_shutting_down",
        requestId: pausedReceipt?.id, executionId: pausedRun, attemptId: pausedReceipt?.id,
        executionGeneration: 1, externalStarted: false,
      });
      expect(existsSync(pausedMarker)).toBe(false);
      expect(await rowsFor(pausedRun, pausedTool)).toHaveLength(0);

      const [childPid] = await readChildPids(childMarker);
      const signalSent = process.kill(childPid!, "SIGUSR1");
      if (signalSent) releasedChildPids.add(childPid!);
      expect(signalSent).toBe(true);
      if (!(await settlesWithin(begunResponsePromise, 5_000))) throw new Error("begun_http_response_not_settled");
      const begunResponse = await begunResponsePromise;
      expect(begunResponse.status).toBe(200);
      expect(begunResponse.body.content).toBe("http-original-result");
      const completedRows = await rowsFor(begunRun, begunTool);
      expect(completedRows).toHaveLength(1);
      expect(completedRows[0]).toMatchObject({ id: begunReceipt.id, status: "completed",
        resultStatus: 200, resultBody: begunResponse.body });
      expect(await readChildPids(childMarker)).toHaveLength(1);
      expect(identities).toContainEqual({ requestId: begunReceipt?.id, executionId: begunRun,
        attemptId: begunReceipt?.id, executionGeneration: 1 });
      expect(identities).toContainEqual({ requestId: pausedReceipt?.id, executionId: pausedRun,
        attemptId: pausedReceipt?.id, executionGeneration: 1 });

      if (!(await settlesWithin(drain, 5_000))) throw new Error("shutdown_http_drain_not_settled");
      await drain;
      expect(drainSettled).toBe(true);
      expect(drainError).toBeInstanceOf(HttpHandlerFinalizationHeldError);
      const freshHold = await app.runtimeShutdown.drainHttpProducers().then(() => null, (error: unknown) => error);
      expect(freshHold).toBeInstanceOf(HttpHandlerFinalizationHeldError);
    } finally {
      authGate.resolve();
      if (heldClient) {
        if (!lockReleased) await heldClient.unsafe("rollback").catch(() => undefined);
        heldClient.release();
      }
      await releaseOwnedChildren(childMarker).catch(() => undefined);
      if (pausedResponsePromise) await settlesWithin(pausedResponsePromise, 5_000);
      await joinPendingHttpRequests();
      await locker?.$client.end({ timeout: 5 }).catch(() => undefined);
      await observer?.$client.end({ timeout: 5 }).catch(() => undefined);
    }
  }, 60_000);

  it("runs a fresh HTTP producer check on each later drain", async () => {
    const events: string[] = [];
    const controller = createAppRuntimeShutdownController({
      stopStarts: () => events.push("stop"),
      drainStartup: async () => { events.push("startup"); },
      drainProducers: async () => { events.push("producers"); },
      drainHttpProducers: async () => { events.push("http"); },
      shutdownPlugins: async () => { events.push("plugins"); },
      drainExecutions: async () => { events.push("executions"); },
      drainHeartbeats: async () => { events.push("heartbeats"); },
      disposeResources: async () => { events.push("dispose"); },
    });
    await controller.drain();
    await controller.drain();
    expect(events).toEqual([
      "stop", "startup", "producers", "http", "plugins", "executions", "heartbeats",
      "http", "executions", "heartbeats",
    ]);
  });
});
