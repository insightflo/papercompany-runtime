// @vitest-environment node
// Server-owned PG stop ordering: a started HTTP execution finalizes durably before the owned DB stops, stop precedes exit, and the actual survives restart.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import detectPort from "detect-port";
import { and, eq } from "drizzle-orm";
import {
  agentToolGrants, agents, companies, createDb, pluginToolExecutionReceipts, toolDefinitions,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDevTsxLoaderPath } from "../services/plugin-loader.js";
import { secretService } from "../services/secrets.js";
import { startRuntimeShutdownProcessFixture } from "./helpers/runtime-shutdown-process-fixture.js";
import { createStageRecorder, killLeakedOwnedPostgres, postmasterPidOf } from "./helpers/owned-postgres-shutdown-diagnostics.js";

const recorderPath = fileURLToPath(new URL("./helpers/http-shutdown-recording-tool.mjs", import.meta.url));
const entryPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const pinPaths = [entryPath, recorderPath, fileURLToPath(new URL("./helpers/runtime-shutdown-process-fixture.ts", import.meta.url)),
  fileURLToPath(import.meta.url)];
const ownedLogPort = /Using embedded PostgreSQL because no DATABASE_URL set \(dataDir=([^\n]+?), port=(\d+)\)/;
type Fixture = Awaited<ReturnType<typeof startRuntimeShutdownProcessFixture>>;
type OwnedServer = Awaited<ReturnType<Fixture["startServer"]>> & { dataDir: string; ownedPort: number; configPath: string; home: string };
type OwnedSpec = { dataDir: string; configPath: string };
let fixture: Fixture | undefined;

async function eventRows(file: string) {
  try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function track<T>(pending: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> {
  pending.add(promise);
  void promise.then(() => pending.delete(promise), () => pending.delete(promise));
  return promise;
}

async function portClosed(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("error", () => resolve(true));
    socket.once("connect", () => { socket.destroy(); resolve(false); });
  });
}

async function startOwnedServer(f: Fixture, spec?: OwnedSpec): Promise<OwnedServer> {
  const port = await detectPort();
  const ownedPort = await detectPort(port + 1);
  const dataDir = spec?.dataDir ?? path.join(f.root, `owned-pg-${ownedPort}`);
  const configPath = spec?.configPath ?? path.join(f.root, `owned-config-${ownedPort}.json`);
  if (!spec) {
    await writeFile(configPath, JSON.stringify({
      $meta: { version: 1, updatedAt: new Date().toISOString(), source: "onboard" },
      database: { embeddedPostgresDataDir: dataDir, embeddedPostgresPort: ownedPort },
      // "server" is required in paperclipConfigSchema; omitting it makes readConfigFile() fail silently to null (observed 2026-10-30 invocation 2).
      server: {},
      logging: { mode: "file", logDir: path.join(f.root, "logs") },
    }));
  }
  const home = path.join(f.root, `owned-home-${port}`);
  await mkdir(home, { recursive: true });
  const loader = resolveDevTsxLoaderPath();
  if (!loader) throw new Error("Existing server tsx loader is unavailable");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PAPERCLIP_HOME: home,
    PAPERCLIP_CONFIG: configPath, HOST: "127.0.0.1", PORT: String(port),
    PAPERCLIP_PUBLIC_URL: `http://127.0.0.1:${port}`, PAPERCLIP_MIGRATION_PROMPT: "never",
    PAPERCLIP_MIGRATION_AUTO_APPLY: "false", PAPERCLIP_DB_BACKUP_ENABLED: "false",
    PAPERCLIP_SECRETS_MASTER_KEY: f.masterKey, PAPERCLIP_SECRETS_MASTER_KEY_FILE: path.join(home, "unused.key"),
    HEARTBEAT_SCHEDULER_ENABLED: "false", WORKFLOW_NATIVE_SCHEDULER_ENABLED: "true",
    WORKFLOW_PLUGIN_RECONCILER_DISABLED: "true" };
  delete env.DATABASE_URL;
  const sourcePins = await Promise.all(pinPaths.map(async (file) => ({ path: path.relative(repoRoot, file),
    sha256: createHash("sha256").update(await readFile(file)).digest("hex") })));
  const child = spawn(process.execPath, ["--import", loader, entryPath], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (data) => { output += data.toString(); });
  child.stderr?.on("data", (data) => { output += data.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const server: OwnedServer = { child, url: "http://127.0.0.1:" + port, applicationName: `owned-pg-${ownedPort}`,
    dbSession: {}, tsxLoaderPath: loader, sourcePins, dataDir, ownedPort, configPath, home, logs: () => output,
    signal(signal) { if (child.exitCode === null && child.signalCode === null) child.kill(signal); },
    async waitExit(timeoutMs = 60_000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([exited, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Owned server child did not exit. " + output.slice(-4000))), timeoutMs);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    } };
  try {
    server.ownedPort = await f.waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Owned server exited before ready. " + output.slice(-4000));
      try { const response = await fetch(server.url + "/api/health"); if (!response.ok) return null; }
      catch { return null; }
      const match = ownedLogPort.exec(output);
      return match && match[1] === dataDir && existsSync(path.join(dataDir, "postmaster.pid")) ? Number(match[2]) : null;
    }, "owned server ready", 150_000);
  } catch (error) {
    server.signal("SIGKILL");
    const cleanup = await killLeakedOwnedPostgres(f, server).then(() => "", (e: unknown) => `; ${String(e)}`);
    throw new Error(`${String(error)}${cleanup}\n${output.slice(-4000)}`);
  }
  return server;
}

beforeAll(async () => { fixture = await startRuntimeShutdownProcessFixture(); }, 120_000);
afterAll(async () => { await fixture?.cleanup(); });

describe("Server-owned PostgreSQL shutdown ordering in a real server process", () => {
  it("finalizes the started HTTP execution before stopping the owned database, exits, and persists the actual across restart", async () => {
    const f = fixture!;
    const diag = createStageRecorder();
    diag.mark("test-start");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
    const eventsFile = path.join(f.root, `owned-http-${suffix}.jsonl`);
    const certFile = path.join(f.root, `owned-http-${suffix}.crt`), keyFile = path.join(f.root, `owned-http-${suffix}.key`);
    await writeFile(eventsFile, "");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile,
      "-out", certFile, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
    const toolPort = await detectPort(), tlsPort = await detectPort(toolPort + 1);
    const peer = spawn(process.execPath, [recorderPath], { env: { ...process.env,
      H4_HTTP_PORT: String(toolPort), H4_TLS_PORT: String(tlsPort), H4_HTTP_EVENTS_FILE: eventsFile,
      H4_TLS_CERT_FILE: certFile, H4_TLS_KEY_FILE: keyFile, H4_EXPECTED_AUTH: "owned-auth-secret",
    }, stdio: ["ignore", "pipe", "pipe"] });
    let peerOutput = "";
    peer.stdout?.on("data", (data) => { peerOutput += data.toString(); });
    peer.stderr?.on("data", (data) => { peerOutput += data.toString(); });
    const peerExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      peer.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const peerUrl = `http://127.0.0.1:${toolPort}`;
    const control = async (action: string, body: unknown = {}) => await (await fetch(`${peerUrl}/control/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })).json();
    const pending = new Set<Promise<unknown>>();
    const lockClients: Array<Awaited<ReturnType<Fixture["db"]["$client"]["reserve"]>>> = [];
    const dbClients: Array<{ end(options: { timeout: number }): Promise<void> }> = [];
    let first: OwnedServer | undefined, second: OwnedServer | undefined, spec: OwnedSpec | undefined;
    const cleanupFailures: string[] = [];
    let postmasterPid: number | null = null;
    try {
      await f.waitFor(async () => (await eventRows(eventsFile)).some((row) => row.event === "peer-ready")
        && (await eventRows(eventsFile)).some((row) => row.event === "callback-proxy-ready") || null, "HTTP recorder ready")
        .catch((error: unknown) => { throw new Error(`${String(error)}\n${peerOutput}`); });
      first = await startOwnedServer(f);
      spec = { dataDir: first.dataDir, configPath: first.configPath };
      f.recordEvidence("owned-postgres-shutdown", first, { recorderPid: peer.pid, gates: ["owned-postgres-start", "receipt-finalize-before-stop"] });
      postmasterPid = postmasterPidOf(path.join(first.dataDir, "postmaster.pid"));
      expect(postmasterPid).toBeTruthy();
      const ownedDb = createDb(`postgres://paperclip:paperclip@127.0.0.1:${first.ownedPort}/paperclip`);
      dbClients.push(ownedDb.$client);
      diag.mark("seed-before");
      const [company] = await ownedDb.insert(companies).values({ name: `Owned PG ${suffix}`, issuePrefix: `OP${suffix}` }).returning();
      if (!company) throw new Error("owned_company_seed_failed");
      const [agent] = await ownedDb.insert(agents).values({ companyId: company.id, name: `Owned Agent ${suffix}` }).returning();
      if (!agent) throw new Error("owned_agent_seed_failed");
      const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = f.masterKey;
      let secretId: string;
      try {
        secretId = (await secretService(ownedDb).create(company.id, {
          name: `owned-http-secret-${suffix}`, provider: "local_encrypted", value: "owned-auth-secret",
        })).id;
      } finally {
        if (previousMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
        else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
      }
      const toolName = `owned-http-${suffix}`;
      const [httpTool] = await ownedDb.insert(toolDefinitions).values({ companyId: company.id, name: toolName,
        adapterType: "http", adapterConfig: { url: `${peerUrl}/tool`, method: "POST", allowInsecureUrl: true,
          auth: { type: "header", headerName: "X-H4-Auth", secretId, version: "latest" },
          response: { resultField: "result" } } }).returning({ id: toolDefinitions.id });
      if (!httpTool) throw new Error("owned_http_tool_seed_failed");
      await ownedDb.insert(agentToolGrants).values({ companyId: company.id, agentId: agent.id,
        toolId: httpTool.id, grantedBy: "owned-pg-process-test" });
      diag.mark("seed-after");

      const nonce = `owned-${suffix}`, runId = randomUUID(), idem = `owned-effect-${suffix}`;
      const mainResponse = track(pending, fetch(`${first.url}/api/plugins/tools/execute`, {
        method: "POST", headers: { "content-type": "application/json", Origin: first.url, "idempotency-key": idem },
        body: JSON.stringify({ tool: toolName, parameters: { nonce, hold: true }, idempotencyKey: idem,
          runContext: { companyId: company.id, agentId: agent.id, runId } }),
      }).then(async (r) => ({ status: r.status, body: await r.json() as Record<string, any> })));
      diag.mark("heldreceipt");
      const started = await f.waitFor(async () => (await eventRows(eventsFile))
        .find((row) => row.event === "tool-started" && row.nonce === nonce) ?? null, "held tool-started recorded");
      const begunReceipt = await f.waitFor(async () => (await ownedDb.select().from(pluginToolExecutionReceipts).where(and(
        eq(pluginToolExecutionReceipts.runId, runId), eq(pluginToolExecutionReceipts.tool, toolName))))[0] ?? null, "held receipt executing");
      expect(begunReceipt.status).toBe("executing");
      expect(started.requestId).toBe(begunReceipt.id);

      expect(first.child.kill("SIGTERM")).toBe(true);
      diag.mark("sigterm");
      await f.waitFor(() => first!.logs().includes("Server shutting down") || null, "shutdown begin logged");

      diag.mark("lockacquire");
      const lock = await ownedDb.$client.reserve();
      lockClients.push(lock);
      await lock.unsafe("begin");
      const [{ pid: lockPid }] = await lock.unsafe<{ pid: number }>("select pg_backend_pid() as pid");
      await lock.unsafe(`select id from plugin_tool_execution_receipts where id = '${begunReceipt.id}' for update`);
      diag.mark("peerrelease");
      await control(`result/${encodeURIComponent(nonce)}`);
      const blocked = await f.waitFor(async () => {
        const rows = await ownedDb.$client.unsafe(`select pid, left(query, 120) as query from pg_stat_activity
          where wait_event_type = 'Lock' and pg_blocking_pids(pid) @> array[$1::int]
          and query ilike '%plugin_tool_execution_receipts%'`, [lockPid]);
        return rows[0] ?? null;
      }, "owned DB shows the shutdown-time receipt update blocked");
      diag.mark("blockedobservation");
      expect(blocked.pid).toBeGreaterThan(0);
      expect(first.logs()).not.toContain("Stopping embedded PostgreSQL");
      const stillExecuting = (await ownedDb.select().from(pluginToolExecutionReceipts).where(
        eq(pluginToolExecutionReceipts.id, begunReceipt.id)))[0]!;
      expect(stillExecuting.status).toBe("executing");

      diag.mark("rollback");
      await lock.unsafe("rollback");
      lock.release();
      const response = await bounded(mainResponse, "main_response", 15_000).catch(() => null);
      if (response) {
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual({ value: `actual:${nonce}` });
      }
      diag.mark("firstexit");
      const exit = await first.waitExit(30_000);
      expect(exit).toEqual({ code: 0, signal: null });
      expect(first.logs()).toContain("Stopping embedded PostgreSQL");
      expect(first.logs()).toContain("Server shutdown completed");
      expect(first.logs().match(/Server shutting down/g)).toHaveLength(1);
      await f.waitForProcessExit(postmasterPid!);
      await f.waitFor(() => !existsSync(path.join(first!.dataDir, "postmaster.pid")) || null, "postmaster.pid removed");
      await f.waitFor(async () => (await portClosed(first!.ownedPort)) || null, "owned postgres port closed");

      second = await startOwnedServer(f, spec);
      diag.mark("restart-ready");
      expect(second.logs()).toContain("Embedded PostgreSQL cluster already exists");
      const restartDb = createDb(`postgres://paperclip:paperclip@127.0.0.1:${second.ownedPort}/paperclip`);
      dbClients.push(restartDb.$client);
      diag.mark("readreceipt");
      const persisted = (await restartDb.select().from(pluginToolExecutionReceipts).where(
        eq(pluginToolExecutionReceipts.id, begunReceipt.id)))[0]!;
      expect(persisted).toMatchObject({ status: "completed", resultStatus: 200, idempotencyKey: idem });
      expect(JSON.stringify(persisted.resultBody)).toContain(`actual:${nonce}`);
      expect(second.child.kill("SIGTERM")).toBe(true);
      diag.mark("secondexit");
      const secondExit = await second.waitExit(30_000);
      expect(secondExit).toEqual({ code: 0, signal: null });
      expect(second.logs()).toContain("Server shutdown completed");
    } catch (primaryError) {
      diag.captureFailure(primaryError, first, second);
      throw primaryError;
    } finally {
      diag.mark("cleanup");
      for (const client of lockClients) {
        await client.unsafe("rollback").catch(() => undefined);
        client.release();
      }
      for (const promise of pending) await bounded(Promise.allSettled([promise]), "pending_http").catch(() => undefined);
      for (const server of [first, second]) {
        if (server && server.child.exitCode === null && server.child.signalCode === null) { server.signal("SIGKILL"); await server.waitExit(10_000).catch(() => undefined); }
      }
      for (const server of [first, second]) if (server) {
        await killLeakedOwnedPostgres(f, server).catch((e: unknown) => cleanupFailures.push(String(e)));
      }
      if (peer.exitCode === null && peer.signalCode === null) {
        await fetch(`${peerUrl}/shutdown`, { method: "POST" }).catch(() => undefined);
        const exited = await bounded(peerExit, "recorder_exit", 5_000).catch(() => null);
        if (!exited && peer.exitCode === null) peer.kill("SIGKILL");
      }
      if (peer.exitCode === null && peer.signalCode === null) peer.kill("SIGKILL");
      for (const client of dbClients) await client.end({ timeout: 5 }).catch(() => undefined);
      void peerOutput;
      if (cleanupFailures.length > 0) throw new Error(cleanupFailures.join("; "));
    }
  }, 300_000);
});
