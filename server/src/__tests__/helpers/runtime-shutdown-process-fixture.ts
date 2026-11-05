import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import detectPort from "detect-port";
import { createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { waitForHeartbeatExecutionsToDrain } from "../../services/heartbeat-execution-tracker.js";
import { resolveDevTsxLoaderPath } from "../../services/plugin-loader.js";
import { installRuntimeShutdownParentWorkflowAdmission } from "./runtime-shutdown-admission.js";
import { captureRuntimeShutdownDiagnostics } from "./runtime-shutdown-diagnostics.js";

type LockGate = { pid: number; release(): void; done: Promise<void> };
type ServerChild = {
  child: ChildProcess; url: string; applicationName: string; dbSession: Record<string, unknown>;
  tsxLoaderPath: string; sourcePins: Array<{ path: string; sha256: string }>;
  logs(): string; signal(signal: "SIGTERM" | "SIGINT" | "SIGKILL"): void;
  waitExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export const recordingToolPath = fileURLToPath(new URL("./runtime-shutdown-recording-tool.mjs", import.meta.url));
const entryPath = fileURLToPath(new URL("../../index.ts", import.meta.url));
const pluginWorkerPath = fileURLToPath(new URL("../fixtures/plugin-job-rpc-worker.cjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const sourcePaths = [entryPath, fileURLToPath(new URL("../../app.ts", import.meta.url)),
  fileURLToPath(new URL("../../routes/plugins.ts", import.meta.url)),
  fileURLToPath(new URL("../../routes/tool-definitions.ts", import.meta.url)),
  fileURLToPath(new URL("../../routes/tool-progress.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/tools/progress-store.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/runtime-execution-lifecycle.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/workflow/native-scheduler.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/workflow/native-reconciler.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/workflow/dag-engine.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/workflow/core-tool-executor.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/workflow/resume/serialization.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/workflow/agent-api.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/workflow/registered-artifact-storage.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/mission-owner-supervision-monitor.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/missions.ts", import.meta.url)),
  fileURLToPath(new URL("../helpers/mission-supervision-lifecycle.ts", import.meta.url)),
  fileURLToPath(new URL("../helpers/legacy-html-manual.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/plugin-loader.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/plugin-job-rpc.ts", import.meta.url)),
  fileURLToPath(new URL("../../services/plugin-worker-manager.ts", import.meta.url)),
  pluginWorkerPath,
  fileURLToPath(new URL("../runtime-shutdown-process.integration.test.ts", import.meta.url)),
  fileURLToPath(new URL("../http-handler-shutdown-process.integration.test.ts", import.meta.url)),
  fileURLToPath(new URL("./runtime-shutdown-process-fixture.ts", import.meta.url)),
  fileURLToPath(new URL("./http-shutdown-recording-tool.mjs", import.meta.url)),
  fileURLToPath(new URL("./runtime-shutdown-recording-tool.mjs", import.meta.url))];
const masterKey = "5".repeat(64);

export async function startRuntimeShutdownProcessFixture(options: { parentWorkflowAdmission?: boolean } = {}) {
  const embedded = await startEmbeddedPostgresTestDatabase("runtime-shutdown-process-");
  const db = createDb(embedded.connectionString);
  const expectedDatabase = await db.$client.unsafe(`select current_database() as name,
    (select oid::text from pg_database where datname = current_database()) as oid,
    inet_server_addr()::text as address, inet_server_port() as port`).then((rows) => rows[0]!);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "runtime-shutdown-process-")));
  const children = new Set<ServerChild>();
  const ownedProcessPids = new Set<number>();
  let nextServerId = 0;
  const admission = options.parentWorkflowAdmission ? installRuntimeShutdownParentWorkflowAdmission(db) : null;
  // [P6 opt-in only] Parent shares the children's synthetic secrets master key for the whole fixture
  // lifetime (cross-process mismatch class); restored in cleanup after tracked parent work drained.
  const priorParentSecretsKey = options.parentWorkflowAdmission ? process.env.PAPERCLIP_SECRETS_MASTER_KEY : undefined;
  if (options.parentWorkflowAdmission) process.env.PAPERCLIP_SECRETS_MASTER_KEY = masterKey;

  async function waitFor<T>(read: () => Promise<T | null | false>, label: string, timeoutMs = 60_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const value = await read();
      if (value !== null && value !== false) return value as T;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const diagnostics = await captureRuntimeShutdownDiagnostics({ db, label,
      servers: Array.from(children, (server) => ({ pid: server.child.pid ?? null, applicationName: server.applicationName, sourcePins: server.sourcePins })),
      ownedProcessPids: [...ownedProcessPids] }).catch(() => null);
    throw new Error("Timed out waiting for " + label + (diagnostics ? "; diagnostics: " + diagnostics.path : ""));
  }

  async function pins(loaderPath: string) {
    const paths = [...sourcePaths, loaderPath];
    return Promise.all(paths.map(async (file) => ({ path: path.relative(repoRoot, file),
      sha256: createHash("sha256").update(await readFile(file)).digest("hex") })));
  }

  async function startServer(homeOverride?: string, extraEnv: Record<string, string> = {}): Promise<ServerChild> {
    const loader = resolveDevTsxLoaderPath();
    if (!loader) throw new Error("Existing server tsx loader is unavailable");
    const port = await detectPort();
    const applicationName = `runtime-shutdown-${process.pid}-${nextServerId++}`;
    const serverDatabaseUrl = new URL(embedded.connectionString);
    serverDatabaseUrl.searchParams.set("application_name", applicationName);
    const sourcePins = await pins(loader);
    const home = homeOverride ?? path.join(root, "home-" + port);
    await mkdir(home, { recursive: true });
    const child = spawn(process.execPath, ["--import", loader, entryPath], {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      env: {
        ...process.env, HOME: home, PAPERCLIP_HOME: home, DATABASE_URL: serverDatabaseUrl.toString(),
        PAPERCLIP_PUBLIC_URL: `http://127.0.0.1:${port}`,
        HOST: "127.0.0.1", PORT: String(port), PAPERCLIP_MIGRATION_PROMPT: "never",
        PAPERCLIP_MIGRATION_AUTO_APPLY: "false", PAPERCLIP_DB_BACKUP_ENABLED: "false",
        PAPERCLIP_SECRETS_MASTER_KEY: masterKey, PAPERCLIP_SECRETS_MASTER_KEY_FILE: path.join(home, "unused.key"),
        HEARTBEAT_SCHEDULER_ENABLED: "false",
        WORKFLOW_NATIVE_SCHEDULER_ENABLED: "true",
        WORKFLOW_PLUGIN_RECONCILER_DISABLED: "true",
        ...extraEnv,
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (data) => { output += data.toString(); });
    child.stderr?.on("data", (data) => { output += data.toString(); });
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => { exit = { code, signal }; resolve(exit); });
    });
    const server: ServerChild = {
      child, url: "http://127.0.0.1:" + port, applicationName, dbSession: {}, tsxLoaderPath: loader,
      sourcePins, logs: () => output,
      signal(signal) { if (child.exitCode === null && child.signalCode === null) child.kill(signal); },
      async waitExit(timeoutMs = 60_000) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const done = await Promise.race([exited, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Server child did not exit. " + output.slice(-4000))), timeoutMs);
          })]);
          children.delete(server);
          return done;
        } finally { if (timer) clearTimeout(timer); }
      },
    };
    children.add(server);
    try {
      await waitFor(async () => {
        if (exit) throw new Error("Server child exited before ready. " + output.slice(-4000));
        let response: Response;
        try {
          response = await fetch(server.url + "/api/health");
        } catch { return null; }
        if (!response.ok) return null;
        let session: Record<string, unknown> | undefined;
        try {
          [session] = await db.$client.unsafe(`select datname as name,
            (select oid::text from pg_database where datname = current_database()) as oid,
            application_name as application_name,
            inet_server_addr()::text as address, inet_server_port() as port from pg_stat_activity
            where application_name = $1 limit 1`, [applicationName]);
        } catch { return null; }
        if (!session) return null;
        for (const key of ["name", "oid", "address", "port"] as const) {
          if (String(session[key]) !== String(expectedDatabase[key])) {
            throw new Error("Server child connected to a different embedded database");
          }
        }
        server.dbSession = session;
        return true;
      }, "server child ready", 90_000);
    } catch (error) {
      server.signal("SIGKILL");
      throw error;
    }
    return server;
  }

  async function preparePluginFixture(files: { eventsFile: string; recordFile: string; gateFile: string; nonce: string }) {
    const home = path.join(root, "plugin-home"), packageName = "runtime-shutdown-rpc-fixture";
    const packagePath = path.join(home, ".paperclip", "plugins", packageName);
    await mkdir(packagePath, { recursive: true });
    const env = { RUNTIME_SHUTDOWN_PLUGIN_MODE: "relay", RUNTIME_SHUTDOWN_PLUGIN_FIXTURE_PATH: pluginWorkerPath,
      RUNTIME_SHUTDOWN_PLUGIN_EVENTS_FILE: files.eventsFile, RUNTIME_SHUTDOWN_RECORD_FILE: files.recordFile,
      RUNTIME_SHUTDOWN_GATE_FILE: files.gateFile, RUNTIME_SHUTDOWN_NONCE: files.nonce };
    // The worker manager sanitizes worker env and loader worker options carry no env, so the map
    // above reaches the server process only. Re-inject exactly these explicit fixture values atop
    // the generated worker before the recording tool runs: per-key ??= preserves a child-set
    // RUNTIME_SHUTDOWN_PLUGIN_MODE=result instead of overwriting back to relay and recursing.
    // Values are embedded as JSON.stringify literals — no shell, no interpolation.
    const bootstrap = "const fixtureEnv = " + JSON.stringify(env) + ";\n"
      + "for (const key of Object.keys(fixtureEnv)) process.env[key] ??= fixtureEnv[key];\n";
    await writeFile(path.join(packagePath, "worker.mjs"), bootstrap + (await readFile(recordingToolPath, "utf8")));
    const manifest = { id: "fixture.plugin", displayName: "Shutdown RPC Fixture", version: "1.0.0", apiVersion: 1,
      description: "Runtime shutdown integration fixture", author: "Paperclip test", categories: ["workflow"],
      capabilities: ["agent.tools.register"], entrypoints: { worker: "./worker.mjs" }, tools: [{ name: "publish",
        displayName: "Publish", description: "Record a late shutdown result", parametersSchema: {
          type: "object", properties: { marker: { type: "string" } }, required: ["marker"],
        } }] };
    return { home, packageName, packagePath, manifest, env };
  }

  function recordEvidence(caseName: string, server: ServerChild, gate: Record<string, unknown> = {}) {
    const record = { schemaVersion: "runtime-shutdown-process-evidence.v1", caseName,
      testRunnerPid: process.pid, serverPid: server.child.pid, applicationName: server.applicationName,
      runtime: { nodeVersion: process.version, executablePath: process.execPath,
        entryPath: path.relative(repoRoot, entryPath), tsxLoaderPath: server.tsxLoaderPath },
      database: server.dbSession, sourcePins: server.sourcePins, gate };
    process.stdout.write("RUNTIME_SHUTDOWN_EVIDENCE " + JSON.stringify(record) + "\n");
    return record;
  }

  async function events(recordFile: string) {
    try {
      const rows = (await readFile(recordFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      for (const row of rows) {
        if (row.schemaVersion === "runtime-shutdown-recording-tool.v1" && Number.isInteger(row.identity?.pid)) {
          if (row.event === "started") ownedProcessPids.add(Number(row.identity.pid));
          if (row.event === "completed" || row.event === "cancelled") ownedProcessPids.delete(Number(row.identity.pid));
        }
        if (row.schemaVersion === "runtime-shutdown-plugin-relay.v1") {
          if (row.event === "relay-started") { ownedProcessPids.add(Number(row.wrapperPid)); ownedProcessPids.add(Number(row.workerPid)); }
          if (row.event === "worker-exit") ownedProcessPids.delete(Number(row.workerPid));
          if (row.event === "relay-exit") ownedProcessPids.delete(Number(row.wrapperPid));
        }
      }
      return rows;
    }
    catch { return []; }
  }

  async function holdWorkflowStepRun(stepRunId: string): Promise<LockGate> {
    let unlock!: () => void;
    const releaseWait = new Promise<void>((resolve) => { unlock = resolve; });
    let pid = 0;
    let locked = false;
    const done = db.$client.begin(async (tx) => {
      const [{ pid: backendPid }] = await tx.unsafe("select pg_backend_pid() as pid");
      pid = Number(backendPid);
      await tx.unsafe("select id from workflow_step_runs where id = $1::uuid for update", [stepRunId]);
      locked = true;
      await releaseWait;
    });
    await waitFor(async () => locked ? true : null, "workflow queue step row lock");
    return { pid, release: unlock, done };
  }

  async function holdSecretVersions(): Promise<LockGate> {
    let unlock!: () => void;
    const releaseWait = new Promise<void>((resolve) => { unlock = resolve; });
    let pid = 0;
    let locked = false;
    const done = db.$client.begin(async (tx) => {
      const [{ pid: backendPid }] = await tx.unsafe("select pg_backend_pid() as pid");
      pid = Number(backendPid);
      await tx.unsafe("lock table company_secret_versions in access exclusive mode");
      locked = true;
      await releaseWait;
    });
    await waitFor(async () => locked ? true : null, "secret-version table lock");
    return { pid, release: unlock, done };
  }

  async function waitForBlocker(lockPid: number, queryPart: string, applicationName: string, timeoutMs = 60_000) {
    return waitFor(async () => {
      const rows = await db.$client.unsafe(`select pid, query, pg_blocking_pids(pid) as blockers
        from pg_stat_activity where datname = current_database() and application_name = $1 and pid <> pg_backend_pid()`,
      [applicationName]);
      return rows.find((row) => String(row.query).toLowerCase().includes(queryPart.toLowerCase())
        && Array.isArray(row.blockers) && row.blockers.some((pid) => Number(pid) === lockPid)) ?? null;
    }, "backend blocked by PID " + lockPid + " on " + queryPart, timeoutMs);
  }

  async function waitForProcessExit(pid: number) {
    return waitFor(async () => {
      try { process.kill(pid, 0); return null; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") { ownedProcessPids.delete(pid); return true; }
        throw error;
      }
    }, "owned recording process " + pid + " exit", 15_000);
  }

  return {
    db, embedded, root, masterKey, waitFor, startServer, preparePluginFixture, events, holdWorkflowStepRun, holdSecretVersions, waitForBlocker, waitForProcessExit,
    recordEvidence,
    async cleanup() {
      admission?.restore();
      for (const server of children) server.signal("SIGKILL");
      await Promise.all(Array.from(children, (server) => server.waitExit().catch(() => null)));
      // Drain tracked parent heartbeat work while the synthetic key is still aligned; a drain failure
      // is remembered and rethrown after cleanup — never silently swallowed, never claimed as success.
      const drainError = options.parentWorkflowAdmission
        ? await waitForHeartbeatExecutionsToDrain(db).then(() => null, (error: unknown) => error)
        : null;
      try {
        for (const name of await readdir(root)) {
          if (!name.endsWith(".jsonl")) continue;
          await events(path.join(root, name));
        }
        for (const pid of ownedProcessPids) {
          try { process.kill(pid, "SIGTERM"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        await Promise.all(Array.from(ownedProcessPids, (pid) => waitForProcessExit(pid).catch(() => null)));
        await db.$client.end({ timeout: 5 });
        await embedded.cleanup();
        execFileSync("chmod", ["-R", "u+w", root]);
        await rm(root, { recursive: true, force: true });
      } finally {
        if (options.parentWorkflowAdmission) {
          if (priorParentSecretsKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
          else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorParentSecretsKey;
        }
      }
      if (drainError !== null) throw drainError;
    },
    async writeGate(file: string) { await writeFile(file, "release\n"); },
  };
}
