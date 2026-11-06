import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { agents, companies, createDb, toolDefinitions, workflowRuns, workflowWebhookConfigs,
  workflowWebhookDeliveries, workflowWebhookSignedMessages } from "@paperclipai/db";
import { seedWebhookFixture } from "./helpers/workflow-run-input-http-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { startRuntimeShutdownProcessFixture } from "./helpers/runtime-shutdown-process-fixture.js";
import { logger } from "../middleware/logger.js";
import { secretService } from "../services/secrets.js";
import { workflowService } from "../services/workflow/engine.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { legacyWebhookMessageHash, signWorkflowWebhook, verifyWebhookSignature } from "../services/workflow/webhook-signature.js";

const { heartbeatWakeup } = vi.hoisted(() => ({ heartbeatWakeup: vi.fn() }));
vi.mock("../services/heartbeat.js", async (original) => ({
  ...await original<typeof import("../services/heartbeat.js")>(),
  heartbeatService: () => ({ wakeup: heartbeatWakeup }),
}));
vi.mock("../services/issue-assignment-wakeup.js", async (original) => {
  const actual = await original<typeof import("../services/issue-assignment-wakeup.js")>();
  return { ...actual, queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) =>
    actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup: heartbeatWakeup } }) };
});

let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", Buffer.alloc(32, 31).toString("base64"));
  pg = await startEmbeddedPostgresTestDatabase("workflow-webhook-v2-");
  db = createDb(pg.connectionString);
}, 120_000);
beforeEach(() => { heartbeatWakeup.mockReset(); heartbeatWakeup.mockResolvedValue({ id: "local-test-wakeup" }); });
afterAll(async () => {
  try { await db?.$client.end({ timeout: 5 }); }
  finally { vi.unstubAllEnvs(); await pg?.cleanup(); }
});

// Independent protocol implementation: do not import the production sender or verifier.
function v2(secret: string, timestamp: string, key: string, body: Buffer): string {
  const parts = [Buffer.from(timestamp, "utf8"), Buffer.from(key.trim(), "utf8"), body];
  const frames = parts.flatMap((part) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(part.length);
    return [length, part];
  });
  return `v2=${crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from("papercompany-webhook-v2\0"), ...frames])).digest("hex")}`;
}
function v1(secret: string, timestamp: string, body: Buffer): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body.toString("utf8")}`).digest("hex");
}
function post(f: Awaited<ReturnType<typeof seedWebhookFixture>>, timestamp: string, key: string, body: Buffer, signature: string) {
  return request(f.app).post(`/api/webhooks/workflows/${f.workflowId}`)
    .set("Content-Type", "application/json").set("X-Timestamp", timestamp)
    .set("X-Idempotency-Key", key).set("X-Signature", signature).send(body.toString("utf8"));
}
async function receipts(workflowId: string) {
  return db.select().from(workflowWebhookDeliveries).where(eq(workflowWebhookDeliveries.workflowId, workflowId));
}
async function aliases(workflowId: string) {
  return db.select().from(workflowWebhookSignedMessages).where(eq(workflowWebhookSignedMessages.workflowId, workflowId));
}

it("accepts a correctly framed v2 request and rejects an altered key without another receipt or run", async () => {
  const f = await seedWebhookFixture(db, []);
  const ts = String(Math.floor(Date.now() / 1000));
  const body = Buffer.from(JSON.stringify({ topic: "한글 v2" }));
  const signature = v2(f.secret, ts, "signed-key", body);
  const accepted = await post(f, ts, "signed-key", body, signature);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
  expect(typeof accepted.body.runId).toBe("string");
  const before = await receipts(f.workflowId);
  expect(before).toHaveLength(1);
  expect(before[0]?.runId).toBe(accepted.body.runId);
  const changed = await post(f, ts, "altered-key", body, signature);
  expect(changed.status).toBe(401);
  expect(await receipts(f.workflowId)).toHaveLength(1);
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, f.workflowId))).toHaveLength(1);
  expect(await aliases(f.workflowId)).toHaveLength(0);
}, 120_000);

it("binds every valid v1 signed message to the first receipt even after a changed key or a re-signed retry", async () => {
  const f = await seedWebhookFixture(db, []);
  const ts = String(Math.floor(Date.now() / 1000));
  const body = Buffer.from('{"event":"first"}');
  const signature = v1(f.secret, ts, body);
  const warning = vi.spyOn(logger, "warn");
  const first = await post(f, ts, "original-key", body, signature);
  expect(first.status, JSON.stringify(first.body)).toBe(202);
  const changedKey = await post(f, ts, "changed-key", body, signature);
  expect(changedKey.status).toBe(202);
  expect(changedKey.body.runId).toBe(first.body.runId);
  const body2 = Buffer.from('{"event":"resigned"}');
  const ts2 = String(Number(ts) + 1);
  const signature2 = v1(f.secret, ts2, body2);
  const retry = await post(f, ts2, "original-key", body2, signature2);
  expect(retry.status).toBe(202);
  expect(retry.body.runId).toBe(first.body.runId);
  const changedRetryKey = await post(f, ts2, "another-key", body2, signature2);
  expect(changedRetryKey.status).toBe(202);
  expect(changedRetryKey.body.runId).toBe(first.body.runId);
  const all = await receipts(f.workflowId);
  expect(all).toHaveLength(1);
  expect(all[0]?.runId).toBe(first.body.runId);
  const bindings = await aliases(f.workflowId);
  expect(bindings).toHaveLength(2);
  expect(bindings.every((item) => item.deliveryId === all[0]?.id)).toBe(true);
  expect(warning).toHaveBeenCalledWith({ companyId: f.companyId, workflowId: f.workflowId },
    "Legacy webhook v1 signature accepted; migrate to v2");
  const warningData = JSON.stringify(warning.mock.calls);
  for (const value of [f.secret, signature, body.toString(), "original-key"]) expect(warningData).not.toContain(value);
  warning.mockRestore();
}, 120_000);

it("serializes concurrent v1 requests with one signed message and different header keys", async () => {
  const f = await seedWebhookFixture(db, []);
  const ts = String(Math.floor(Date.now() / 1000));
  const body = Buffer.from('{"event":"race"}');
  const signature = v1(f.secret, ts, body);
  const result = await Promise.all([post(f, ts, "race-a", body, signature), post(f, ts, "race-b", body, signature)]);
  expect(result.map((response) => response.status)).toEqual([202, 202]);
  expect(result[0]?.body.runId).toBe(result[1]?.body.runId);
  expect(await receipts(f.workflowId)).toHaveLength(1);
  expect(await aliases(f.workflowId)).toHaveLength(1);
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, f.workflowId))).toHaveLength(1);
}, 120_000);

it("rejects a v1 message and key that already resolve to different receipts", async () => {
  const f = await seedWebhookFixture(db, []);
  const ts = String(Math.floor(Date.now() / 1000));
  const a = Buffer.from('{"event":"a"}'), b = Buffer.from('{"event":"b"}');
  const aSig = v1(f.secret, ts, a), bSig = v1(f.secret, ts, b);
  const first = await post(f, ts, "key-a", a, aSig);
  const second = await post(f, ts, "key-b", b, bSig);
  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  expect(first.body.runId).not.toBe(second.body.runId);
  const collision = await post(f, ts, "key-b", a, aSig);
  expect(collision.status).toBe(409);
  expect(await receipts(f.workflowId)).toHaveLength(2);
  expect(await aliases(f.workflowId)).toHaveLength(2);
}, 120_000);

it("keeps identical legacy signed messages scoped to their own company and workflow", async () => {
  const a = await seedWebhookFixture(db, []), b = await seedWebhookFixture(db, []);
  const ts = String(Math.floor(Date.now() / 1000)), body = Buffer.from('{"event":"same"}');
  const first = await post(a, ts, "key-a", body, v1(a.secret, ts, body));
  const second = await post(b, ts, "key-b", body, v1(b.secret, ts, body));
  expect(first.status).toBe(202); expect(second.status).toBe(202);
  expect(first.body.runId).not.toBe(second.body.runId);
  const [left] = await aliases(a.workflowId), [right] = await aliases(b.workflowId);
  expect(left?.messageHash).toBe(right?.messageHash);
  expect(left?.companyId).not.toBe(right?.companyId);
  expect(left?.deliveryId).not.toBe(right?.deliveryId);
}, 120_000);

it("enforces v2 framing, exact body bytes, malformed signatures and secret rotation", () => {
  expect(signWorkflowWebhook("vector-secret", "1700000000", " idempotency ", Buffer.from('{"x":"한"}')))
    .toBe("v2=e159e25e58cf2a5dbb45a78816c0a56285e00c2b86f3e21dd40eb287a06d8a67");
  const ts = String(Math.floor(Date.now() / 1000));
  const body = Buffer.from('{"topic":"한글"}'), secret = "previous-local-secret", key = "signed-key";
  const signature = v2(secret, ts, key, body);
  expect(signWorkflowWebhook(secret, ts, key, body)).toBe(signature);
  const secrets = [{ value: "current-local-secret" }, { value: secret, expiresAt: new Date(Date.now() + 60_000) }];
  const input = { timestamp: ts, rawBody: body, idempotencyKey: key, signature, secrets };
  expect(verifyWebhookSignature(input)).toBe(true);
  expect(verifyWebhookSignature({ ...input, rawBody: Buffer.from('{"topic":"other"}') })).toBe(false);
  expect(verifyWebhookSignature({ ...input, idempotencyKey: "changed" })).toBe(false);
  expect(verifyWebhookSignature({ ...input, signature: `${signature}00` })).toBe(false);
  expect(verifyWebhookSignature({ ...input, timestamp: String(Number(ts) - 301) })).toBe(false);
  expect(verifyWebhookSignature({ ...input, secrets: [{ value: secret, expiresAt: new Date(Date.now() - 1) }] })).toBe(false);
});

it("uses the same decoded-byte equivalence as the legacy signature verifier", () => {
  const a = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d]);
  const b = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0x81, 0x22, 0x7d]);
  expect(a.equals(b)).toBe(false);
  expect(v1("local-secret", "123", a)).toBe(v1("local-secret", "123", b));
  expect(legacyWebhookMessageHash("123", a)).toBe(legacyWebhookMessageHash("123", b));
});

it("serializes a changed-key legacy replay across two real servers before starting the tool once", async () => {
  const f = await startRuntimeShutdownProcessFixture();
  const savedKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  process.env.PAPERCLIP_SECRETS_MASTER_KEY = f.masterKey;
  const companyId = crypto.randomUUID(), ownerId = crypto.randomUUID(), secret = "local-two-server-v1-secret";
  const marker = path.join(f.root, `${companyId}-calls.txt`), script = path.join(f.root, `${companyId}-record.mjs`);
  let gate: Awaited<ReturnType<typeof f.db.$client.reserve>> | undefined, held = false;
  let first: Promise<Response> | undefined, second: Promise<Response> | undefined;
  try {
    await writeFile(script, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'called\\n'); console.log(JSON.stringify({ok:true}));`);
    await f.db.insert(companies).values({ id: companyId, name: "Legacy signature race", issuePrefix: `R${companyId.slice(0, 7)}`,
      timezone: "Asia/Seoul", workProductRoot: f.root });
    await f.db.insert(agents).values({ id: ownerId, companyId, name: "Owner", status: "paused" });
    await f.db.insert(toolDefinitions).values({ companyId, name: "record-once", adapterType: "builtin",
      adapterConfig: { command: `"${process.execPath}" "${script}"`, workingDirectory: f.root } });
    setWorkflowToolStepExecutor(async () => { throw new Error("setup executor must not run"); });
    let definition: Awaited<ReturnType<typeof workflowService.createDefinition>>;
    try { definition = await workflowService.createDefinition(f.db, { companyId, name: "Legacy race", status: "active",
      steps: [{ id: "record", name: "Record", type: "tool", agentId: "", toolNames: ["record-once"], toolArgs: {}, dependencies: [] }] }); }
    finally { setWorkflowToolStepExecutor(null); }
    const secretRef = `workflow-webhook:${definition.id}`;
    await secretService(f.db).create(companyId, { name: secretRef, provider: "local_encrypted", value: secret });
    await f.db.insert(workflowWebhookConfigs).values({ companyId, workflowId: definition.id, secretRef, enabled: true, secretLast4: "cret" });
    const a = await f.startServer(), b = await f.startServer();
    expect(a.child.pid).not.toBe(b.child.pid);
    gate = await f.db.$client.reserve();
    const [{ pid: gatePid }] = await gate`select pg_backend_pid() as pid`;
    const lockKey = 78432324, trigger = `webhook_v1_${definition.id.replaceAll("-", "")}`;
    await gate`select pg_advisory_lock(${lockKey})`; held = true;
    await f.db.$client.unsafe(`create function ${trigger}() returns trigger language plpgsql as $$ begin if NEW.workflow_id = '${definition.id}' then perform pg_advisory_xact_lock(${lockKey}); end if; return NEW; end $$`);
    await f.db.$client.unsafe(`create trigger ${trigger} before insert on workflow_webhook_deliveries for each row execute function ${trigger}()`);
    const ts = String(Math.floor(Date.now() / 1000)), body = '{"event":"same-v1"}';
    const signature = v1(secret, ts, Buffer.from(body));
    const send = (url: string, key: string) => fetch(`${url}/api/webhooks/workflows/${definition.id}`, { method: "POST",
      headers: { "content-type": "application/json", "x-timestamp": ts, "x-idempotency-key": key, "x-signature": signature }, body });
    const blocked = (applicationName: string, blocker: number) => f.waitFor(async () => {
      const rows = await f.db.$client`select pid, application_name, pg_blocking_pids(pid) as blockers from pg_stat_activity where datname = current_database()`;
      const row = rows.find(item => item.application_name === applicationName && (item.blockers as number[]).includes(blocker));
      return row ? Number(row.pid) : null;
    }, "legacy webhook admission lock", 45_000);
    first = send(a.url, "original-key"); void first.catch(() => {});
    const firstPid = await blocked(a.applicationName, Number(gatePid));
    second = send(b.url, "changed-key"); void second.catch(() => {});
    expect(await blocked(b.applicationName, firstPid)).not.toBe(firstPid);
    await gate`select pg_advisory_unlock(${lockKey})`; held = false;
    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.status)).toEqual([202, 202]);
    const results = await Promise.all(responses.map(response => response.json() as Promise<{ runId: string }>));
    expect(results[0]?.runId).toBe(results[1]?.runId);
    await f.waitFor(async () => {
      const [run] = await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, results[0]!.runId));
      return run?.status === "completed" ? true : null;
    }, "legacy multi-server run completed", 90_000);
    expect(await f.db.select().from(workflowWebhookDeliveries).where(eq(workflowWebhookDeliveries.workflowId, definition.id))).toHaveLength(1);
    expect(await f.db.select().from(workflowWebhookSignedMessages).where(eq(workflowWebhookSignedMessages.workflowId, definition.id))).toHaveLength(1);
    expect(await readFile(marker, "utf8")).toBe("called\n");
    a.signal("SIGTERM"); b.signal("SIGTERM");
    expect((await a.waitExit()).code).toBe(0); expect((await b.waitExit()).code).toBe(0);
  } finally {
    if (held && gate) await gate`select pg_advisory_unlock(${78432324})`;
    await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
    gate?.release();
    try { await f.cleanup(); }
    finally { if (savedKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; else process.env.PAPERCLIP_SECRETS_MASTER_KEY = savedKey; }
  }
}, 240_000);
