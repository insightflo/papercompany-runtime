// @vitest-environment node
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import detectPort from "detect-port";
import { and, eq } from "drizzle-orm";
import {
  activityLog, agentToolGrants, agents, companies, pluginToolExecutionReceipts, toolDefinitions,
  toolExecutionHeartbeats,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { secretService } from "../services/secrets.js";
import { startRuntimeShutdownProcessFixture } from "./helpers/runtime-shutdown-process-fixture.js";

const recorderPath = fileURLToPath(new URL("./helpers/http-shutdown-recording-tool.mjs", import.meta.url));
type Fixture = Awaited<ReturnType<typeof startRuntimeShutdownProcessFixture>>;
type LockClient = Awaited<ReturnType<Fixture["db"]["$client"]["reserve"]>>;
let fixture: Fixture | undefined;

async function eventRows(file: string) {
  try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function track<T>(pending: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> {
  pending.add(promise);
  void promise.then(() => pending.delete(promise), () => pending.delete(promise));
  return promise;
}

async function readJson(response: Response) {
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

beforeAll(async () => { fixture = await startRuntimeShutdownProcessFixture(); }, 120_000);
afterAll(async () => { await fixture?.cleanup(); });

describe("HTTP handler lifetime in a real server process", () => {
  it("preserves a begun HTTP result, admits its callback after signals, and holds receipt failure", async () => {
    const f = fixture!;
    const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
    const progressTrigger = `h4_cb_${suffix}_trigger`, progressFunction = `h4_cb_${suffix}_fn`;
    const eventsFile = path.join(f.root, `http-${suffix}.jsonl`);
    const certFile = path.join(f.root, `http-${suffix}.crt`), keyFile = path.join(f.root, `http-${suffix}.key`);
    await writeFile(eventsFile, "");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile,
      "-out", certFile, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
    const toolPort = await detectPort(), tlsPort = await detectPort(toolPort + 1);
    const peer = spawn(process.execPath, [recorderPath], { env: { ...process.env,
      H4_HTTP_PORT: String(toolPort), H4_TLS_PORT: String(tlsPort), H4_HTTP_EVENTS_FILE: eventsFile,
      H4_TLS_CERT_FILE: certFile, H4_TLS_KEY_FILE: keyFile, H4_EXPECTED_AUTH: "h4-auth-secret",
      NODE_EXTRA_CA_CERTS: certFile,
    }, stdio: ["ignore", "pipe", "pipe"] });
    let peerOutput = "";
    peer.stdout?.on("data", (data) => { peerOutput += data.toString(); });
    peer.stderr?.on("data", (data) => { peerOutput += data.toString(); });
    const peerExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      peer.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const peerUrl = `http://127.0.0.1:${toolPort}`;
    const tlsBase = `https://127.0.0.1:${tlsPort}`;
    const control = async (action: string, body: unknown = {}) => readJson(await fetch(`${peerUrl}/control/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    const pending = new Set<Promise<unknown>>();
    let server: Awaited<ReturnType<Fixture["startServer"]>> | undefined;
    let shutdownFailureTrigger = false;
    let progressTriggerInstalled = false;
    const lockClients = new Set<LockClient>();
    const request = (target: string, input: Record<string, unknown>, key?: string, signal?: AbortSignal) =>
      track(pending, fetch(`${target}/api/plugins/tools/execute`, {
        method: "POST", signal, headers: { "content-type": "application/json", Origin: target,
          ...(key ? { "idempotency-key": key } : {}) },
        body: JSON.stringify({ tool: httpToolName, parameters: input.parameters,
          runContext: { companyId, agentId, runId: input.runId },
          ...(key ? { idempotencyKey: key } : {}) }),
      }).then(readJson));
    let companyId = "", agentId = "", httpToolName = "";
    let mainRequest: Promise<{ status: number; body: Record<string, any> }> | undefined;
    let preparationRequest: Promise<{ status: number; body: Record<string, any> }> | undefined;
    let preparationRun = "", preparationTool = "";
    let marker = "";

    try {
      await f.waitFor(async () => (await eventRows(eventsFile)).some((row) => row.event === "peer-ready")
        && (await eventRows(eventsFile)).some((row) => row.event === "callback-proxy-ready") || null, "HTTP recorder ready")
        .catch((error: unknown) => { throw new Error(`${String(error)}\n${peerOutput}`); });
      server = await f.startServer(undefined, {
        PAPERCLIP_PUBLIC_URL: tlsBase,
        NODE_EXTRA_CA_CERTS: certFile,
      });
      f.recordEvidence("http-handler-lifetime", server, { callbackBase: tlsBase, recorderPid: peer.pid,
        gates: ["tool-definitions", "progress-heartbeat", "execution-receipt"] });
      expect(server.sourcePins).toContainEqual(expect.objectContaining({ path: "server/src/index.ts" }));
      expect(server.sourcePins).toContainEqual(expect.objectContaining({ path: "server/src/services/tools/progress-store.ts" }));
      await control("target", { target: server.url });

      const [company] = await f.db.insert(companies).values({ name: `H4 HTTP ${suffix}`, issuePrefix: `H4${suffix}` }).returning();
      if (!company) throw new Error("h4_company_seed_failed");
      companyId = company.id;
      const [agent] = await f.db.insert(agents).values({ companyId, name: `H4 Agent ${suffix}` }).returning();
      if (!agent) throw new Error("h4_agent_seed_failed");
      agentId = agent.id;
      const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      process.env.PAPERCLIP_SECRETS_MASTER_KEY = f.masterKey;
      let authSecretId: string;
      try {
        authSecretId = (await secretService(f.db).create(companyId, {
          name: `h4-http-secret-${suffix}`, provider: "local_encrypted", value: "h4-auth-secret",
        })).id;
      } finally {
        if (previousMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
        else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
      }
      httpToolName = `h4-http-${suffix}`;
      const [httpTool] = await f.db.insert(toolDefinitions).values({ companyId, name: httpToolName,
        adapterType: "http", adapterConfig: { url: `${peerUrl}/tool`, method: "POST", allowInsecureUrl: true,
          auth: { type: "header", headerName: "X-H4-Auth", secretId: authSecretId, version: "latest" },
          response: { resultField: "result" }, progress: { version: 1, idleTimeoutMs: 30_000,
            maxDurationMs: 60_000, stages: [{ key: "running", unit: "items" }] } },
      }).returning({ id: toolDefinitions.id });
      if (!httpTool) throw new Error("h4_http_tool_seed_failed");
      preparationTool = `h4-prepared-${suffix}`;
      marker = path.join(f.root, `must-not-start-${suffix}`);
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require("node:fs").writeFileSync(${JSON.stringify(marker)},"started")`)}`;
      const [prepared] = await f.db.insert(toolDefinitions).values({ companyId, name: preparationTool,
        adapterType: "builtin", adapterConfig: { command } }).returning({ id: toolDefinitions.id });
      await f.db.insert(agentToolGrants).values([
        { companyId, agentId, toolId: httpTool.id, grantedBy: "h4-process-test" },
        { companyId, agentId, toolId: prepared!.id, grantedBy: "h4-process-test" },
      ]);

      const unkeyedRun = randomUUID();
      const unkeyed = await request(server.url, { runId: unkeyedRun, parameters: { nonce: `h4-unkeyed-${suffix}` } });
      expect(unkeyed.status).toBe(200);
      expect(unkeyed.body.data).toEqual({ value: `actual:h4-unkeyed-${suffix}` });
      const unkeyedRows = await f.db.select().from(pluginToolExecutionReceipts).where(and(
        eq(pluginToolExecutionReceipts.runId, unkeyedRun), eq(pluginToolExecutionReceipts.tool, httpToolName)));
      expect(unkeyedRows).toHaveLength(1);
      expect(unkeyedRows[0]).toMatchObject({ status: "completed", resultStatus: 200, resultBody: unkeyed.body });
      expect(unkeyedRows[0]!.idempotencyKey).not.toBe("");
      const unkeyedEvents = await eventRows(eventsFile);
      expect(unkeyedEvents.find((row) => row.event === "tool-started" && row.nonce === `h4-unkeyed-${suffix}`))
        .toMatchObject({ requestId: unkeyedRows[0]!.id });
      expect(unkeyedEvents.find((row) => row.event === "tool-result" && row.nonce === `h4-unkeyed-${suffix}`))
        .toMatchObject({ requestId: unkeyedRows[0]!.id });

      const keyedNonce = `h4-keyed-${suffix}`, keyedRun = randomUUID(), key = `h4-effect-${suffix}`;
      const abort = new AbortController();
      mainRequest = request(server.url, { runId: keyedRun, parameters: { nonce: keyedNonce, hold: true } }, key, abort.signal);
      let mainSettled = false;
      void mainRequest.then(() => { mainSettled = true; }, () => { mainSettled = true; });
      const started = await f.waitFor(async () => (await eventRows(eventsFile)).find((row) =>
        row.event === "tool-started" && row.nonce === keyedNonce) ?? null, "begun HTTP tool request");
      const [begunReceipt] = await f.db.select().from(pluginToolExecutionReceipts).where(and(
        eq(pluginToolExecutionReceipts.runId, keyedRun), eq(pluginToolExecutionReceipts.tool, httpToolName)));
      if (!begunReceipt) throw new Error("h4_begun_receipt_missing");
      expect(begunReceipt).toMatchObject({ id: started.requestId, idempotencyKey: key, status: "executing" });
      expect(started.requestId).toBe(begunReceipt.id);
      expect(mainSettled).toBe(false);
      expect(started.pid).toBe(peer.pid);
      expect(started.executionId).toBeTruthy();
      expect(started.callbackUrl).toBe(`${tlsBase}/api/companies/${companyId}/tool-executions/${started.executionId}/progress`);
      const heartbeatBefore = (await f.db.select().from(toolExecutionHeartbeats)
        .where(eq(toolExecutionHeartbeats.id, started.executionId)))[0];
      if (!heartbeatBefore) throw new Error("h4_progress_row_missing");
      expect(heartbeatBefore).toMatchObject({ id: started.executionId, requestId: begunReceipt.id, companyId,
        toolId: httpTool.id, adapterType: "http", workflowRunId: null, stepRunId: null, stepId: null,
        executionGeneration: null, retryCount: null, iterationIndex: null, sequence: 0 });
      expect(started.executionId).not.toBe(begunReceipt.runId);

      preparationRun = randomUUID();
      const prepLock = await f.db.$client.reserve();
      lockClients.add(prepLock);
      await prepLock.unsafe("begin");
      const [{ pid: prepBlockerPid }] = await prepLock.unsafe("select pg_backend_pid() as pid") as unknown as [{ pid: number }];
      await prepLock.unsafe("lock table tool_definitions in access exclusive mode");
      preparationRequest = track(pending, fetch(`${server.url}/api/plugins/tools/execute`, {
        method: "POST", headers: { "content-type": "application/json", Origin: server.url,
          "idempotency-key": `h4-prep-${suffix}` }, body: JSON.stringify({ tool: preparationTool,
          parameters: {}, idempotencyKey: `h4-prep-${suffix}`, runContext: { companyId, agentId, runId: preparationRun } }),
      }).then(readJson));
      let preparationSettled = false;
      void preparationRequest.then(() => { preparationSettled = true; }, () => { preparationSettled = true; });
      const prepReceipt = await f.waitFor(async () => {
        const rows = await f.db.select().from(pluginToolExecutionReceipts).where(and(
          eq(pluginToolExecutionReceipts.runId, preparationRun), eq(pluginToolExecutionReceipts.tool, preparationTool)));
        return rows[0]?.status === "executing" ? rows[0] : null;
      }, "prepared request receipt");
      const prepBlocked = await f.waitForBlocker(prepBlockerPid, "tool_definitions", server.applicationName);
      expect(prepBlocked.query.toLowerCase()).toContain("tool_definitions");
      expect(preparationSettled).toBe(false);

      expect(server.child.kill("SIGTERM")).toBe(true);
      expect(server.child.kill("SIGINT")).toBe(true);
      await f.waitFor(() => server!.logs().includes("Server shutting down") || null, "signal shutdown entry");
      expect((await serverSession(f, server)).length).toBeGreaterThan(0);
      await prepLock.unsafe("rollback");
      prepLock.release();
      lockClients.delete(prepLock);
      const deferred = await bounded(preparationRequest!, "prepared_request");
      expect(deferred.status).toBe(503);
      expect(deferred.body.deferredBeforeStart).toEqual({ kind: "deferred_before_start", version: 1,
        reasonCode: "runtime_shutting_down", requestId: prepReceipt.id, executionId: preparationRun,
        attemptId: prepReceipt.id, executionGeneration: 1, externalStarted: false });
      expect(existsSync(marker)).toBe(false);
      expect(await f.db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, prepReceipt.id)))
        .toHaveLength(0);

      const progressLock = await f.db.$client.reserve();
      lockClients.add(progressLock);
      await progressLock.unsafe("begin");
      const [{ pid: progressBlockerPid }] = await progressLock.unsafe("select pg_backend_pid() as pid") as unknown as [{ pid: number }];
      const callbackBarrierKey = `h4-progress-update-${started.executionId}`;
      const callbackApplicationName = `h4-callback-${suffix}`;
      await progressLock.unsafe("select pg_advisory_xact_lock(hashtext($1), 0)", [callbackBarrierKey]);
      progressTriggerInstalled = true;
      await f.db.$client.unsafe(`CREATE FUNCTION ${progressFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.id = '${started.executionId}'::uuid AND OLD.sequence = 0 AND NEW.sequence = 1 THEN
            PERFORM set_config('application_name', '${callbackApplicationName}', true);
            PERFORM pg_advisory_xact_lock(hashtext('${callbackBarrierKey}'), 0);
          END IF;
          RETURN NEW;
        END $$`);
      await f.db.$client.unsafe(`CREATE TRIGGER ${progressTrigger} BEFORE UPDATE ON tool_execution_heartbeats
        FOR EACH ROW EXECUTE FUNCTION ${progressFunction}()`);
      await control(`callback/${keyedNonce}`);
      const callbackPath = `/api/companies/${companyId}/tool-executions/${started.executionId}/progress`;
      const proxyStarted = await f.waitFor(async () => (await eventRows(eventsFile)).find((row) =>
        row.event === "callback-proxy-started" && row.path === callbackPath) ?? null, "callback proxy forwarding");
      expect(proxyStarted).toMatchObject({ path: callbackPath, target: `${server.url}${callbackPath}` });
      const progressBlocked = await f.waitForBlocker(progressBlockerPid, "tool_execution_heartbeats",
        callbackApplicationName, 1_500);
      expect(progressBlocked.query.toLowerCase()).toContain("update");
      expect(progressBlocked.query.toLowerCase()).toContain("tool_execution_heartbeats");
      expect(progressBlocked.blockers.map(Number)).toContain(progressBlockerPid);
      abort.abort();
      await progressLock.unsafe("rollback");
      progressLock.release();
      lockClients.delete(progressLock);
      await expect(mainRequest).rejects.toMatchObject({ name: "AbortError" });
      expect((await serverSession(f, server)).length).toBeGreaterThan(0);
      const callbackResult = await f.waitFor(async () => (await eventRows(eventsFile)).find((row) =>
        row.event === "callback-result" && row.nonce === keyedNonce) ?? null, "authenticated callback result");
      expect(callbackResult).toMatchObject({ executionId: started.executionId, status: 200, body: { accepted: true } });
      const heartbeatAdvanced = (await f.db.select().from(toolExecutionHeartbeats)
        .where(eq(toolExecutionHeartbeats.id, started.executionId)))[0]!;
      const progressAudit = await f.db.select().from(activityLog).where(and(
        eq(activityLog.entityId, started.executionId), eq(activityLog.action, "tool_progress.advanced")));
      expect(heartbeatAdvanced).toMatchObject({ sequence: 1, stageIndex: 0, current: 1, total: 2, state: "active" });
      expect(heartbeatAdvanced.policy).toEqual(heartbeatBefore.policy);
      expect(heartbeatAdvanced.startedAt).toEqual(heartbeatBefore.startedAt);
      expect(progressAudit).toHaveLength(1);
      await f.db.$client.unsafe(`DROP TRIGGER ${progressTrigger} ON tool_execution_heartbeats`);
      await f.db.$client.unsafe(`DROP FUNCTION ${progressFunction}()`);
      progressTriggerInstalled = false;

      const receiptLock = await f.db.$client.reserve();
      lockClients.add(receiptLock);
      await receiptLock.unsafe("begin");
      const [{ pid: receiptBlockerPid }] = await receiptLock.unsafe("select pg_backend_pid() as pid") as unknown as [{ pid: number }];
      await receiptLock.unsafe("select id from plugin_tool_execution_receipts where id = $1 for update", [begunReceipt!.id]);
      await control(`result/${keyedNonce}`);
      const receiptBlocked = await f.waitForBlocker(receiptBlockerPid, "plugin_tool_execution_receipts", server.applicationName);
      expect(receiptBlocked.query.toLowerCase()).toContain("plugin_tool_execution_receipts");
      expect((await f.db.select().from(pluginToolExecutionReceipts)
        .where(eq(pluginToolExecutionReceipts.id, begunReceipt!.id)))[0]).toMatchObject({ status: "executing" });
      expect((await serverSession(f, server)).length).toBeGreaterThan(0);
      await receiptLock.unsafe("rollback");
      receiptLock.release();
      lockClients.delete(receiptLock);
      const expectedBody = { content: JSON.stringify({ value: `actual:${keyedNonce}` }),
        data: { value: `actual:${keyedNonce}` }, tool: httpToolName, source: "core" };
      const completed = await f.waitFor(async () => {
        const rows = await f.db.select().from(pluginToolExecutionReceipts)
          .where(eq(pluginToolExecutionReceipts.id, begunReceipt!.id));
        return rows[0]?.status === "completed" ? rows[0] : null;
      }, "begun receipt commit");
      expect(completed).toMatchObject({ status: "completed", resultStatus: 200, resultBody: expectedBody });
      const keyedEvents = await eventRows(eventsFile);
      const keyedStarts = keyedEvents.filter((row) => row.event === "tool-started" && row.nonce === keyedNonce);
      expect(keyedStarts).toHaveLength(1);
      expect(keyedStarts[0]).toMatchObject({ requestId: begunReceipt.id, executionId: heartbeatBefore!.id,
        callbackUrl: `${tlsBase}${callbackPath}` });
      expect(keyedEvents.find((row) => row.event === "tool-result" && row.nonce === keyedNonce))
        .toMatchObject({ requestId: begunReceipt.id, result: { result: { value: `actual:${keyedNonce}` } } });

      const gracefulExit = await server.waitExit(30_000);
      expect(gracefulExit).toEqual({ code: 0, signal: null });
      expect(server.logs()).toContain("Server shutdown completed");
      expect(server.logs().match(/Server shutting down/g)).toHaveLength(1);
      expect(await serverSession(f, server)).toHaveLength(0);

      server = await f.startServer(undefined, { PAPERCLIP_PUBLIC_URL: tlsBase, NODE_EXTRA_CA_CERTS: certFile });
      const failRun = randomUUID(), failKey = `h4-failure-${suffix}`, failNonce = `h4-failure-${suffix}`;
      await f.db.$client.unsafe(`CREATE FUNCTION h4_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.idempotency_key = '${failKey}' AND NEW.status = 'completed' THEN
          RAISE EXCEPTION 'h4_receipt_write_failed'; END IF; RETURN NEW; END $$`);
      await f.db.$client.unsafe(`CREATE TRIGGER h4_reject_receipt BEFORE UPDATE ON plugin_tool_execution_receipts
        FOR EACH ROW EXECUTE FUNCTION h4_reject_receipt()`);
      shutdownFailureTrigger = true;
      const failed = await request(server.url, { runId: failRun, parameters: { nonce: failNonce } }, failKey);
      expect(failed.status).toBe(500);
      await f.db.$client.unsafe("DROP TRIGGER h4_reject_receipt ON plugin_tool_execution_receipts");
      await f.db.$client.unsafe("DROP FUNCTION h4_reject_receipt()");
      shutdownFailureTrigger = false;
      const failedReceipt = (await f.db.select().from(pluginToolExecutionReceipts).where(and(
        eq(pluginToolExecutionReceipts.runId, failRun), eq(pluginToolExecutionReceipts.tool, httpToolName))))[0]!;
      expect(failedReceipt).toMatchObject({ status: "executing", resultStatus: null, resultBody: null, completedAt: null });
      const failureEventsBeforeRetry = await eventRows(eventsFile);
      expect(failureEventsBeforeRetry.filter((row) => row.event === "tool-started" && row.nonce === failNonce)).toHaveLength(1);
      expect(failureEventsBeforeRetry.find((row) => row.event === "tool-result" && row.nonce === failNonce))
        .toMatchObject({ result: { result: { value: `actual:${failNonce}` } } });
      expect((await request(server.url, { runId: failRun, parameters: { nonce: failNonce } }, failKey)).status).toBe(409);
      expect((await eventRows(eventsFile).then((rows) => rows.filter((row) => row.event === "tool-started" && row.nonce === failNonce))))
        .toHaveLength(1);

      expect(server.child.kill("SIGTERM")).toBe(true);
      await f.waitFor(() => server!.logs().includes("Shutdown held; database remains open") || null, "sticky finalization hold");
      expect(server.child.exitCode).toBeNull();
      expect((await serverSession(f, server)).length).toBeGreaterThan(0);
      server.signal("SIGKILL");
      const heldExit = await server.waitExit(10_000);
      expect(heldExit.signal).toBe("SIGKILL");
    } finally {
      for (const client of lockClients) {
        await client.unsafe("rollback").catch(() => undefined);
        client.release();
      }
      if (progressTriggerInstalled) {
        await f.db.$client.unsafe(`DROP TRIGGER IF EXISTS ${progressTrigger} ON tool_execution_heartbeats`).catch(() => undefined);
        await f.db.$client.unsafe(`DROP FUNCTION IF EXISTS ${progressFunction}()`).catch(() => undefined);
      }
      if (shutdownFailureTrigger) {
        await f.db.$client.unsafe("DROP TRIGGER IF EXISTS h4_reject_receipt ON plugin_tool_execution_receipts").catch(() => undefined);
        await f.db.$client.unsafe("DROP FUNCTION IF EXISTS h4_reject_receipt()").catch(() => undefined);
      }
      for (const promise of pending) await bounded(Promise.allSettled([promise]), "pending_http").catch(() => undefined);
      if (server && server.child.exitCode === null && server.child.signalCode === null) {
        server.signal("SIGKILL");
        await server.waitExit(10_000).catch(() => undefined);
      }
      if (peer.exitCode === null && peer.signalCode === null) {
        await fetch(`${peerUrl}/shutdown`, { method: "POST" }).catch(() => undefined);
        const exited = await bounded(peerExit, "recorder_exit", 5_000).catch(() => null);
        if (!exited && peer.exitCode === null) peer.kill("SIGKILL");
      }
      if (peer.exitCode === null && peer.signalCode === null) peer.kill("SIGKILL");
      void peerOutput;
    }
  }, 180_000);
});

async function serverSession(f: Fixture, server: Awaited<ReturnType<Fixture["startServer"]>>) {
  return await f.db.$client.unsafe(`select pid from pg_stat_activity where datname = current_database()
    and application_name = $1`, [server.applicationName]);
}
