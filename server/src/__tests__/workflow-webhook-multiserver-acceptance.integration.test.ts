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

it("serializes the same signed webhook across two actual servers and runs its local tool once", async () => {
  const companyId = randomUUID(), ownerId = randomUUID(), secret = "local-multiserver-secret";
  const marker = path.join(f.root, `${companyId}-calls.txt`), script = path.join(f.root, `${companyId}-record.mjs`);
  await writeFile(script, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'called\\n'); console.log(JSON.stringify({ok:true}));`);
  await f.db.insert(companies).values({ id: companyId, name: "Webhook multi-server", issuePrefix: `W${companyId.slice(0, 7)}`,
    timezone: "Asia/Seoul", workProductRoot: f.root });
  await f.db.insert(agents).values({ id: ownerId, companyId, name: "Owner", status: "paused" });
  await f.db.insert(toolDefinitions).values({ companyId, name: "record-once", adapterType: "builtin",
    adapterConfig: { command: `"${process.execPath}" "${script}"`, workingDirectory: f.root } });
  // The runner seeds the definition only; execution must occur in the two real servers.
  setWorkflowToolStepExecutor(async () => { throw new Error("setup executor must not run"); });
  let definition: Awaited<ReturnType<typeof workflowService.createDefinition>>;
  try {
    definition = await workflowService.createDefinition(f.db, { companyId, name: "Multi-server webhook", status: "active",
      steps: [{ id: "record", name: "Record", type: "tool", agentId: "", toolNames: ["record-once"], toolArgs: {}, dependencies: [] }] });
  } finally { setWorkflowToolStepExecutor(null); }
  const secretRef = `workflow-webhook:${definition.id}`;
  await secretService(f.db).create(companyId, { name: secretRef, provider: "local_encrypted", value: secret });
  await f.db.insert(workflowWebhookConfigs).values({ companyId, workflowId: definition.id, secretRef, enabled: true, secretLast4: "cret" });
  const firstServer = await f.startServer(), secondServer = await f.startServer();
  expect(firstServer.child.pid).not.toBe(secondServer.child.pid);
  const gate = await f.db.$client.reserve(), lockKey = 78432319;
  const [{ pid: gatePid }] = await gate`select pg_backend_pid() as pid`;
  await gate`select pg_advisory_lock(${lockKey})`;
  const trigger = `webhook_multiserver_${definition.id.replaceAll("-", "")}`;
  await f.db.$client.unsafe(`create function ${trigger}() returns trigger language plpgsql as $$ begin if NEW.workflow_id = '${definition.id}' then perform pg_advisory_xact_lock(${lockKey}); end if; return NEW; end $$`);
  await f.db.$client.unsafe(`create trigger ${trigger} before insert on workflow_runs for each row execute function ${trigger}()`);
  let held = true, second: Promise<Response> | undefined;
  const body = JSON.stringify({ event: "same-delivery" }), timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signWorkflowWebhook(secret, timestamp, "shared-key", body);
  const post = (url: string) => fetch(`${url}/api/webhooks/workflows/${definition.id}`, { method: "POST",
    headers: { "content-type": "application/json", "x-timestamp": timestamp, "x-idempotency-key": "shared-key", "x-signature": signature }, body });
  const first = post(firstServer.url); void first.catch(() => {});
  try {
    const blocked = async (applicationName: string, blocker: number) => f.waitFor(async () => {
      const rows = await f.db.$client`select pid, application_name, pg_blocking_pids(pid) as blockers from pg_stat_activity where datname = current_database()`;
      const found = rows.find(row => row.application_name === applicationName && (row.blockers as number[]).includes(blocker));
      return found ? Number(found.pid) : null;
    }, "multi-server webhook lock", 30_000);
    const firstPid = await blocked(firstServer.applicationName, Number(gatePid));
    const admitted = await f.db.select().from(workflowWebhookDeliveries).where(eq(workflowWebhookDeliveries.workflowId, definition.id));
    expect(admitted).toHaveLength(1); expect(admitted[0]!.runId).toBeNull();
    expect(await f.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, definition.id))).toHaveLength(0);
    second = post(secondServer.url); void second.catch(() => {});
    const secondPid = await blocked(secondServer.applicationName, firstPid);
    expect(secondPid).not.toBe(firstPid);
    await gate`select pg_advisory_unlock(${lockKey})`; held = false;
    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.status)).toEqual([202, 202]);
    const results = await Promise.all(responses.map(response => response.json() as Promise<{ runId: string }>));
    expect(results[0]!.runId).toBe(results[1]!.runId);
    await f.waitFor(async () => {
      const [run] = await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, results[0]!.runId));
      return run?.status === "completed" ? true : null;
    }, "multi-server webhook completed", 90_000);
    expect(await readFile(marker, "utf8")).toBe("called\n");
    const runs = await f.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, definition.id));
    const deliveries = await f.db.select().from(workflowWebhookDeliveries).where(eq(workflowWebhookDeliveries.workflowId, definition.id));
    expect(runs).toHaveLength(1); expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ id: admitted[0]!.id, runId: runs[0]!.id });
    firstServer.signal("SIGTERM"); secondServer.signal("SIGTERM");
    expect((await firstServer.waitExit()).code).toBe(0); expect((await secondServer.waitExit()).code).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("called\n");
    f.recordEvidence("t16a-webhook-multiserver", firstServer, { companyId, workflowId: definition.id,
      runId: runs[0]!.id, receiptId: admitted[0]!.id, serverPids: [firstServer.child.pid, secondServer.child.pid], dbPids: [firstPid, secondPid] });
  } finally {
    if (held) await gate`select pg_advisory_unlock(${lockKey})`;
    await Promise.allSettled([first, ...(second ? [second] : [])]);
    gate.release();
    await f.db.$client.unsafe(`drop trigger ${trigger} on workflow_runs`);
    await f.db.$client.unsafe(`drop function ${trigger}()`);
  }
}, 240_000);
