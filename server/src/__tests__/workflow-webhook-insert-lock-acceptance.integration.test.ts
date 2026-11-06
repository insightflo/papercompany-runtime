import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companies, toolDefinitions, workflowRuns, workflowWebhookConfigs, workflowWebhookDeliveries } from "@paperclipai/db";
import { signWorkflowWebhook } from "../services/workflow/webhook-signature.js";
import { secretService } from "../services/secrets.js";
import { workflowService } from "../services/workflow/engine.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { startRuntimeShutdownProcessFixture } from "./helpers/runtime-shutdown-process-fixture.js";

let f: Awaited<ReturnType<typeof startRuntimeShutdownProcessFixture>>;
const priorKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
beforeAll(async () => {
  f = await startRuntimeShutdownProcessFixture();
  process.env.PAPERCLIP_SECRETS_MASTER_KEY = f.masterKey;
}, 120_000);
afterAll(async () => {
  try { await f?.cleanup(); }
  finally {
    if (priorKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorKey;
  }
}, 120_000);

it("serializes concurrent receipt insertion and later binding across two actual webhook servers", async () => {
  const companyId = randomUUID(), ownerId = randomUUID(), secret = "local-webhook-insert-secret";
  const marker = path.join(f.root, `${companyId}-calls.txt`), script = path.join(f.root, `${companyId}-record.mjs`);
  await writeFile(script, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'called\\n'); console.log(JSON.stringify({ok:true}));`);
  await f.db.insert(companies).values({ id: companyId, name: "Webhook insert race", issuePrefix: `I${companyId.slice(0, 7)}`,
    timezone: "Asia/Seoul", workProductRoot: f.root });
  await f.db.insert(agents).values({ id: ownerId, companyId, name: "Owner", status: "paused" });
  await f.db.insert(toolDefinitions).values({ companyId, name: "record-once", adapterType: "builtin",
    adapterConfig: { command: `"${process.execPath}" "${script}"`, workingDirectory: f.root } });
  setWorkflowToolStepExecutor(async () => { throw new Error("setup executor must not run"); });
  let definition: Awaited<ReturnType<typeof workflowService.createDefinition>>;
  try {
    definition = await workflowService.createDefinition(f.db, { companyId, name: "Webhook insert race", status: "active",
      steps: [{ id: "record", name: "Record", type: "tool", agentId: "", toolNames: ["record-once"], toolArgs: {}, dependencies: [] }] });
  } finally { setWorkflowToolStepExecutor(null); }
  const secretRef = `workflow-webhook:${definition.id}`;
  await secretService(f.db).create(companyId, { name: secretRef, provider: "local_encrypted", value: secret });
  await f.db.insert(workflowWebhookConfigs).values({ companyId, workflowId: definition.id, secretRef, enabled: true, secretLast4: "cret" });
  const firstServer = await f.startServer(), secondServer = await f.startServer();
  expect(firstServer.child.pid).not.toBe(secondServer.child.pid);
  const receiptGate = await f.db.$client.reserve(), runGate = await f.db.$client.reserve();
  const receiptKey = 78432320, runKey = 78432321;
  const receiptTrigger = `webhook_receipt_${definition.id.replaceAll("-", "")}`;
  const runTrigger = `webhook_run_${definition.id.replaceAll("-", "")}`;
  let receiptHeld = false, runHeld = false, first: Promise<Response> | undefined, second: Promise<Response> | undefined;
  try {
    const [{ pid: receiptGatePid }] = await receiptGate`select pg_backend_pid() as pid`;
    const [{ pid: runGatePid }] = await runGate`select pg_backend_pid() as pid`;
    await receiptGate`select pg_advisory_lock(${receiptKey})`; receiptHeld = true;
    await runGate`select pg_advisory_lock(${runKey})`; runHeld = true;
    await f.db.$client.unsafe(`create function ${receiptTrigger}() returns trigger language plpgsql as $$ begin if NEW.workflow_id = '${definition.id}' then perform pg_advisory_xact_lock(${receiptKey}); end if; return NEW; end $$`);
    await f.db.$client.unsafe(`create trigger ${receiptTrigger} after insert on workflow_webhook_deliveries for each row execute function ${receiptTrigger}()`);
    await f.db.$client.unsafe(`create function ${runTrigger}() returns trigger language plpgsql as $$ begin if NEW.workflow_id = '${definition.id}' then perform pg_advisory_xact_lock(${runKey}); end if; return NEW; end $$`);
    await f.db.$client.unsafe(`create trigger ${runTrigger} before insert on workflow_runs for each row execute function ${runTrigger}()`);
    const blocked = async (applicationName: string, blocker: number, query?: RegExp) => f.waitFor(async () => {
      const rows = await f.db.$client`select pid, application_name, pg_blocking_pids(pid) as blockers, query from pg_stat_activity where datname = current_database()`;
      const row = rows.find(item => item.application_name === applicationName && (item.blockers as number[]).includes(blocker)
        && (!query || query.test(String(item.query))));
      return row ? Number(row.pid) : null;
    }, "two-stage webhook lock", 45_000);
    const body = JSON.stringify({ event: "same-delivery" }), timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signWorkflowWebhook(secret, timestamp, "shared-key", body);
    const post = (url: string) => fetch(`${url}/api/webhooks/workflows/${definition.id}`, { method: "POST",
      headers: { "content-type": "application/json", "x-timestamp": timestamp, "x-idempotency-key": "shared-key", "x-signature": signature },
      body, signal: AbortSignal.timeout(120_000) });
    first = post(firstServer.url); void first.catch(() => {});
    const receiptOwnerPid = await blocked(firstServer.applicationName, Number(receiptGatePid));
    expect(await f.db.select().from(workflowWebhookDeliveries).where(eq(workflowWebhookDeliveries.workflowId, definition.id))).toHaveLength(0);
    second = post(secondServer.url); void second.catch(() => {});
    const insertWaiterPid = await blocked(secondServer.applicationName, receiptOwnerPid, /insert into "workflow_webhook_deliveries"/i);
    expect(insertWaiterPid).not.toBe(receiptOwnerPid);
    await receiptGate`select pg_advisory_unlock(${receiptKey})`; receiptHeld = false;
    const bindOwner = await f.waitFor(async () => {
      const rows = await f.db.$client`select pid, application_name, pg_blocking_pids(pid) as blockers from pg_stat_activity where datname = current_database()`;
      const row = rows.find(item => [firstServer.applicationName, secondServer.applicationName].includes(String(item.application_name))
        && (item.blockers as number[]).includes(Number(runGatePid)));
      return row ? { pid: Number(row.pid), app: String(row.application_name) } : null;
    }, "binding transaction waits at run insert", 45_000);
    const waiterApp = bindOwner.app === firstServer.applicationName ? secondServer.applicationName : firstServer.applicationName;
    const receiptWaiterPid = await blocked(waiterApp, bindOwner.pid);
    const receipts = await f.db.select().from(workflowWebhookDeliveries).where(eq(workflowWebhookDeliveries.workflowId, definition.id));
    expect(receipts).toHaveLength(1); expect(receipts[0]!.runId).toBeNull();
    expect(await f.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, definition.id))).toHaveLength(0);
    await runGate`select pg_advisory_unlock(${runKey})`; runHeld = false;
    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.status)).toEqual([202, 202]);
    const results = await Promise.all(responses.map(response => response.json() as Promise<{ runId: string }>));
    expect(results[0]!.runId).toBe(results[1]!.runId);
    await f.waitFor(async () => {
      const [run] = await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, results[0]!.runId));
      return run?.status === "completed" ? true : null;
    }, "webhook insert race completed", 90_000);
    const runs = await f.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, definition.id));
    const finished = await f.db.select().from(workflowWebhookDeliveries).where(eq(workflowWebhookDeliveries.workflowId, definition.id));
    expect(runs).toHaveLength(1); expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ id: receipts[0]!.id, runId: runs[0]!.id });
    expect(await readFile(marker, "utf8")).toBe("called\n");
    firstServer.signal("SIGTERM"); secondServer.signal("SIGTERM");
    expect((await firstServer.waitExit()).code).toBe(0); expect((await secondServer.waitExit()).code).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("called\n");
    f.recordEvidence("t16a-webhook-two-stage-insert", firstServer, { companyId, workflowId: definition.id, runId: runs[0]!.id,
      receiptId: receipts[0]!.id, receiptOwnerPid, insertWaiterPid, bindOwnerPid: bindOwner.pid, receiptWaiterPid,
      serverPids: [firstServer.child.pid, secondServer.child.pid] });
  } finally {
    if (receiptHeld) await receiptGate`select pg_advisory_unlock(${receiptKey})`;
    if (runHeld) await runGate`select pg_advisory_unlock(${runKey})`;
    await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
    receiptGate.release(); runGate.release();
    await f.db.$client.unsafe(`drop trigger if exists ${receiptTrigger} on workflow_webhook_deliveries`);
    await f.db.$client.unsafe(`drop function if exists ${receiptTrigger}()`);
    await f.db.$client.unsafe(`drop trigger if exists ${runTrigger} on workflow_runs`);
    await f.db.$client.unsafe(`drop function if exists ${runTrigger}()`);
  }
}, 240_000);
