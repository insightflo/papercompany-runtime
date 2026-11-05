import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { progressTokenHash } from "../services/tools/progress-policy.js";
import { event, progressDatabase } from "./helpers/tool-progress.js";
import { progressRecord } from "./helpers/tool-progress-records.js";

type Fixture = Awaited<ReturnType<typeof progressDatabase>>;
type ProgressRecord = Awaited<ReturnType<typeof progressRecord>>;
let fixture: Fixture | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let baseUrl = "";
let tempRoot = "";
let releaseBlocker: (() => Promise<void>) | undefined;
let cleanupSafe = true;
const pendingHttp = new Set<Promise<unknown>>();
const capability = "h3-http-progress-capability";

function track<T>(promise: Promise<T>): Promise<T> {
  pendingHttp.add(promise);
  void promise.then(() => pendingHttp.delete(promise), () => pendingHttp.delete(promise));
  return promise;
}

function progressPath(record: ProgressRecord): string {
  return `/api/companies/${record.scope.companyId}/tool-executions/${record.row.id}/progress`;
}

function send(input: {
  path: string;
  body?: string;
  token?: string;
  session?: boolean;
  origin?: string;
  method?: string;
  signal?: AbortSignal;
}): Promise<{ status: number; body: unknown }> {
  return track(fetch(`${baseUrl}${input.path}`, {
    method: input.method ?? "POST",
    headers: {
      ...(input.method === "GET" ? {} : { "Content-Type": "application/json" }),
      ...(input.token ? { "X-Papercompany-Progress-Token": input.token } : {}),
      ...(input.session ? { "x-test-session": "yes" } : {}),
      ...(input.origin ? { Origin: input.origin } : {}),
    },
    ...(input.body === undefined || input.method === "GET" ? {} : { body: input.body }),
    ...(input.signal ? { signal: input.signal } : {}),
  }).then(async (response) => ({ status: response.status, body: await response.json() })));
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

async function resolvesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForBlockedProgress(blockerPid: number, executionId: string): Promise<string> {
  const observer = fixture!.reader;
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const rows = await observer.execute(sql`
      select pid, pg_blocking_pids(pid) as blockers, query
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and ${blockerPid} = any(pg_blocking_pids(pid))
        and query ilike '%tool_execution_heartbeats%'
    `) as unknown as Array<{ pid: number; blockers: number[]; query: string }>;
    const matching = rows.filter((row) => row.blockers.includes(blockerPid));
    if (matching.length === 1 && /tool_execution_heartbeats/i.test(matching[0]!.query)) {
      return matching[0]!.query;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`progress_receipt_lock_wait_not_observed:${executionId}:${blockerPid}`);
}

function watchResponseClose(targetServer: Server, pathName: string) {
  let listener: ((request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void) | undefined;
  let resolve!: (closedBeforeFinish: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  listener = (request, response) => {
    if (request.url?.split("?", 1)[0] !== pathName) return;
    targetServer.off("request", listener!);
    response.once("close", () => resolve(!response.writableFinished));
  };
  targetServer.on("request", listener);
  return { promise, cancel: () => listener && targetServer.off("request", listener) };
}

beforeAll(async () => {
  fixture = await progressDatabase();
  tempRoot = await mkdtemp(path.join(tmpdir(), "http-callback-handler-shutdown-"));
  const pluginRoot = path.join(tempRoot, "plugins");
  await mkdir(pluginRoot, { recursive: true });
  app = await createApp(fixture.db, {
    uiMode: "none", serverPort: 3100, storageService: {} as never,
    deploymentMode: "authenticated", deploymentExposure: "public", allowedHostnames: [], bindHost: "127.0.0.1",
    authReady: true, companyDeletionEnabled: false, localPluginDir: pluginRoot,
    resolveSession: async (request) => {
      if (request.header("x-test-session") !== "yes") return null;
      const userId = randomUUID();
      return { session: { id: "h3-session", userId }, user: { id: userId } };
    },
  });
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("callback_test_server_address_missing");
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  let safeToDisposeDb = true;
  let appDisposed = false;
  if (app) {
    app.runtimeShutdown.stopStarts();
    app.runtimeShutdown.sealHttpIngress();
    await releaseBlocker?.();
    if (!(await resolvesWithin(app.runtimeShutdown.drainHttpCallbacks(), 5_000))) safeToDisposeDb = false;
    if (!(await settlesWithin(Promise.allSettled([...pendingHttp]), 5_000))) safeToDisposeDb = false;
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (!cleanupSafe) safeToDisposeDb = false;
  if (app && safeToDisposeDb) {
    appDisposed = await resolvesWithin(app.runtimeShutdown.dispose(), 20_000);
    if (!appDisposed) safeToDisposeDb = false;
  }
  if (fixture && safeToDisposeDb) await fixture.cleanup();
  if (tempRoot && (!app || appDisposed)) await rm(tempRoot, { recursive: true, force: true });
  if (!safeToDisposeDb) throw new Error("HTTP callbacks did not drain; embedded database left undisposed");
}, 60_000);

describe("HTTP progress callback shutdown lifetime", () => {
  it("keeps authenticated progress persistence alive across stop, seal, and client abort", async () => {
    let abort: AbortController | undefined;
    let responseClose: ReturnType<typeof watchResponseClose> | undefined;
    try {
      const ordinary = await progressRecord(fixture!.db, fixture!.reader, "http", progressTokenHash(capability));
      const original = await ordinary.read();
      const originalAudit = await ordinary.audit();

      const denied = await send({ path: progressPath(ordinary), body: JSON.stringify(event(ordinary.row.id)), token: "wrong" });
      expect(denied.status).toBe(401);
      await expect(app!.runtimeShutdown.drainHttpCallbacks()).resolves.toBeUndefined();
      expect(await ordinary.read()).toEqual(original);
      expect(await ordinary.audit()).toEqual(originalAudit);

      const schemaError = await send({ path: progressPath(ordinary), body: "{}", token: capability });
      expect(schemaError.status).toBe(400);
      await expect(app!.runtimeShutdown.drainHttpCallbacks()).resolves.toBeUndefined();
      expect(await ordinary.read()).toEqual(original);
      expect(await ordinary.audit()).toEqual(originalAudit);

      const originDenied = await send({
        path: progressPath(ordinary), body: JSON.stringify(event(ordinary.row.id)), token: capability,
        session: true, origin: "https://untrusted.example",
      });
      expect(originDenied.status).toBe(403);
      await expect(app!.runtimeShutdown.drainHttpCallbacks()).resolves.toBeUndefined();
      expect(await ordinary.read()).toEqual(original);
      expect(await ordinary.audit()).toEqual(originalAudit);

      const accepted = await send({ path: progressPath(ordinary), body: JSON.stringify(event(ordinary.row.id, 1, 2)), token: capability });
      expect(accepted).toEqual({ status: 200, body: { accepted: true } });
      await expect(app!.runtimeShutdown.drainHttpCallbacks()).resolves.toBeUndefined();
      const advanced = await ordinary.read();
      expect(advanced).toMatchObject({ sequence: 1, current: 2, state: "active", policy: ordinary.row.policy });
      expect(advanced.startedAt).toEqual(ordinary.row.startedAt);
      expect(advanced.startedAt.getTime() + advanced.policy.maxDurationMs)
        .toBe(ordinary.row.startedAt.getTime() + ordinary.row.policy.maxDurationMs);
      expect((await ordinary.audit()).filter((row) => row.action === "tool_progress.advanced")).toHaveLength(1);

      await ordinary.store.finish(ordinary.scope.companyId, ordinary.row.id, "succeeded");
      const terminalRow = await ordinary.read();
      const terminalAudit = await ordinary.audit();
      const terminal = await send({ path: progressPath(ordinary), body: JSON.stringify(event(ordinary.row.id, 2, 3)), token: capability });
      expect(terminal.status).toBe(409);
      await expect(app!.runtimeShutdown.drainHttpCallbacks()).resolves.toBeUndefined();
      expect(await ordinary.read()).toEqual(terminalRow);
      expect(await ordinary.audit()).toEqual(terminalAudit);

      const blocked = await progressRecord(fixture!.db, fixture!.reader, "http", progressTokenHash(capability));
      const late = await progressRecord(fixture!.db, fixture!.reader, "http", progressTokenHash(capability));
      app!.runtimeShutdown.stopStarts();
      await app!.runtimeShutdown.drainHttpProducers();
      const lookalike = await send({ path: `${progressPath(late)}-extra`, body: JSON.stringify(event(late.row.id)), token: capability });
      expect(lookalike.status).toBe(404);
      const wrongMethod = await send({ path: progressPath(late), method: "GET", token: capability });
      expect(wrongMethod.status).toBe(404);

      const blocker = await fixture!.db.$client.reserve();
      let blockerReleased = false;
      releaseBlocker = async () => {
        if (blockerReleased) return;
        blockerReleased = true;
        await blocker.unsafe("rollback").catch(() => undefined);
        blocker.release();
        releaseBlocker = undefined;
      };
      await blocker.unsafe("begin");
      await blocker.unsafe("select id from tool_execution_heartbeats where id = $1 for update", [blocked.row.id]);
      const [{ pid }] = await blocker.unsafe("select pg_backend_pid() as pid") as unknown as [{ pid: number }];
      const blockedBefore = await blocked.read();
      const blockedAuditBefore = await blocked.audit();
      abort = new AbortController();
      responseClose = watchResponseClose(server!, progressPath(blocked));
      const originalRequest = send({
        path: progressPath(blocked), body: JSON.stringify(event(blocked.row.id, 1, 2)), token: capability, signal: abort.signal,
      });
      let requestSettled = false;
      void originalRequest.then(() => { requestSettled = true; }, () => { requestSettled = true; });
      const blockedQuery = await waitForBlockedProgress(Number(pid), blocked.row.id);
      expect(blockedQuery).toMatch(/tool_execution_heartbeats/i);
      expect(requestSettled).toBe(false);

      let callbackDrainSettled = false;
      const callbackDrain = app!.runtimeShutdown.drainHttpCallbacks();
      void callbackDrain.then(
        () => { callbackDrainSettled = true; },
        () => { callbackDrainSettled = true; },
      );
      app!.runtimeShutdown.sealHttpIngress();
      const lateBefore = await late.read();
      const lateAuditBefore = await late.audit();
      const lateResponse = await send({ path: progressPath(late), body: JSON.stringify(event(late.row.id)), token: capability });
      expect(lateResponse.status).toBe(503);
      expect(await late.read()).toEqual(lateBefore);
      expect(await late.audit()).toEqual(lateAuditBefore);

      abort.abort();
      await expect(originalRequest).rejects.toMatchObject({ name: "AbortError" });
      expect(await settlesWithin(responseClose.promise, 1_000)).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(callbackDrainSettled).toBe(false);
      expect(await blocked.read()).toEqual(blockedBefore);
      expect(await blocked.audit()).toEqual(blockedAuditBefore);

      await releaseBlocker?.();
      expect(await settlesWithin(callbackDrain, 5_000)).toBe(true);
      await expect(callbackDrain).resolves.toBeUndefined();
      const committed = await blocked.read();
      expect(committed).toMatchObject({ sequence: 1, current: 2, state: "active", policy: blocked.row.policy });
      expect(committed.startedAt).toEqual(blocked.row.startedAt);
      expect(committed.startedAt.getTime() + committed.policy.maxDurationMs)
        .toBe(blocked.row.startedAt.getTime() + blocked.row.policy.maxDurationMs);
      const committedAudit = await blocked.audit();
      const advances = committedAudit.filter((row) => row.action === "tool_progress.advanced");
      expect(advances).toHaveLength(1);
      expect(advances[0]).toMatchObject({ entityId: blocked.row.id, details: { sequence: 1, current: 2 } });
    } finally {
      app?.runtimeShutdown.stopStarts();
      app?.runtimeShutdown.sealHttpIngress();
      abort?.abort();
      await releaseBlocker?.();
      responseClose?.cancel();
      if (app && !(await resolvesWithin(app.runtimeShutdown.drainHttpCallbacks(), 5_000))) cleanupSafe = false;
      if (!(await settlesWithin(Promise.allSettled([...pendingHttp]), 5_000))) cleanupSafe = false;
    }
  }, 30_000);
});
