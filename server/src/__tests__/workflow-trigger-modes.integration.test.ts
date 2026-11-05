import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request, { type Response } from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agents, companies, createDb, toolDefinitions, workflowRuns, workflowRunSlots,
  workflowStepRuns, workflowWebhookConfigs, workflowWebhookDeliveries } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";
import { webhookRawBodyErrorHandler, workflowWebhookRoutes } from "../routes/workflow-webhooks.js";
import { secretService } from "../services/secrets.js";
import { workflowService } from "../services/workflow/engine.js";
import { createNativeWorkflowScheduler } from "../services/workflow/native-scheduler.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor, syncWorkflowRunState } from "../services/workflow/dag-engine.js";

let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>, root: string, app: express.Express;
const originalMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
const webhookSecret = "local-test-webhook-secret";

beforeAll(async () => {
  process.env.PAPERCLIP_SECRETS_MASTER_KEY = Buffer.alloc(32, 23).toString("base64");
  pg = await startEmbeddedPostgresTestDatabase("trigger-modes-");
  db = createDb(pg.connectionString);
  root = await mkdtemp(path.join(os.tmpdir(), "trigger-modes-"));
  app = express();
  app.use("/api/webhooks/workflows", express.raw({ limit: "64kb", type: "application/json" }), webhookRawBodyErrorHandler);
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "board", userId: "board-user", companyIds: [],
    source: "local_implicit", isInstanceAdmin: true }; next(); });
  app.use("/api", workflowWebhookRoutes(db));
  app.use("/api", workflowRoutes(db));
  app.use(errorHandler);
  setWorkflowToolStepExecutor(async r => {
    const result = await executeCoreWorkflowTool({ db, companyId: r.companyId, agentId: r.agentId,
      agentName: r.agentName, toolName: r.toolName, parameters: r.args ?? {}, requestId: r.requestId,
      workflowRunId: r.workflowRunId, stepRunId: r.stepRunId, stepId: r.stepId });
    await completeWorkflowToolStepFromResult(db, { companyId: r.companyId, workflowRunId: r.workflowRunId,
      stepRunId: r.stepRunId, stepId: r.stepId, requestId: r.requestId, toolName: r.toolName,
      success: result.status === 200, stdout: result.body.content ?? "", data: result.body.data,
      stderr: result.body.stderr ?? "", error: result.body.error });
    return { accepted: true as const };
  });
}, 60_000);

afterAll(async () => {
  setWorkflowToolStepExecutor(null);
  try {
    await db?.$client.end({ timeout: 5 });
    await pg?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  } finally {
    if (originalMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = originalMasterKey;
  }
});

async function world() {
  const companyId = randomUUID(), ownerId = randomUUID();
  const marker = path.join(root, `${companyId}.calls`), script = path.join(root, `${companyId}.mjs`);
  await writeFile(script, `import fs from 'node:fs';
const mode=process.argv[process.argv.indexOf('--mode')+1];
fs.appendFileSync(${JSON.stringify(marker)},mode+'\\n'); console.log(JSON.stringify({mode}));`);
  await db.insert(companies).values({ id: companyId, name: "Trigger modes", issuePrefix: `T${companyId.slice(0, 7)}`,
    timezone: "Asia/Seoul", workProductRoot: root });
  await db.insert(agents).values({ id: ownerId, companyId, name: "Owner", status: "paused" });
  await db.insert(toolDefinitions).values({ companyId, name: "record-trigger", adapterType: "builtin",
    adapterConfig: { command: `${process.execPath} ${script}`, workingDirectory: root } });
  const definition = (mode: string, schedule?: string) => workflowService.createDefinition(db, {
    companyId, name: `Mode ${mode}`, status: "active", timezone: "Asia/Seoul", schedule,
    steps: [{ id: "record", name: "Record", type: "tool", agentId: "", toolNames: ["record-trigger"],
      toolArgs: { mode }, dependencies: [] }],
  });
  const enableWebhook = async (workflowId: string) => {
    const secretRef = `workflow-webhook:${workflowId}`;
    await secretService(db).create(companyId, { name: secretRef, provider: "local_encrypted", value: webhookSecret });
    await db.insert(workflowWebhookConfigs).values({ companyId, workflowId, secretRef, enabled: true, secretLast4: "cret" });
  };
  const postWebhook = (workflowId: string, key: string) => {
    const body = JSON.stringify({ event: "local-test" }), timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", webhookSecret).update(`${timestamp}.${body}`).digest("hex");
    return request(app).post(`/api/webhooks/workflows/${workflowId}`).set("Content-Type", "application/json")
      .set("X-Timestamp", timestamp).set("X-Idempotency-Key", key).set("X-Signature", signature).send(body);
  };
  const calls = async () => (await readFile(marker, "utf8")).trim().split("\n").filter(Boolean);
  return { companyId, ownerId, marker, definition, enableWebhook, postWebhook, calls };
}

it("executes manual, active scheduled and signed webhook triggers once through real local tools", async () => {
  const f = await world();
  const manual = await f.definition("manual");
  const scheduled = await f.definition("scheduled", "* * * * *");
  const webhook = await f.definition("webhook");
  await f.enableWebhook(webhook.id);

  const response = await request(app).post(`/api/workflows/${manual.id}/runs`).send({ triggerSource: "manual" });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect((await processQueuedWorkflowToolStepRuns(db)).executedCount).toBe(1);
  await syncWorkflowRunState(db, response.body.runId);

  const scheduler = createNativeWorkflowScheduler({ db, mode: "active" });
  const now = new Date(Date.now() + 5_000);
  await scheduler.tick(now); await scheduler.tick(now);
  const slots = await db.select().from(workflowRunSlots).where(eq(workflowRunSlots.workflowDefinitionId, scheduled.id));
  const scheduledRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, scheduled.id));
  expect(slots).toHaveLength(1); expect(scheduledRuns).toHaveLength(1);
  expect(scheduledRuns[0]).toMatchObject({ companyId: f.companyId, triggerSource: "schedule", scheduledSlotId: slots[0]!.id });

  const first = await f.postWebhook(webhook.id, "local-delivery");
  const replay = await f.postWebhook(webhook.id, "local-delivery");
  expect(first.status, JSON.stringify(first.body)).toBe(202);
  expect(replay.status).toBe(202); expect(replay.body.runId).toBe(first.body.runId);
  expect((await processQueuedWorkflowToolStepRuns(db)).executedCount).toBe(1);
  await syncWorkflowRunState(db, first.body.runId);
  const deliveries = await db.select().from(workflowWebhookDeliveries).where(eq(workflowWebhookDeliveries.workflowId, webhook.id));
  expect(deliveries).toHaveLength(1); expect(deliveries[0]?.runId).toBe(first.body.runId);
  expect(await f.calls()).toEqual(["manual", "scheduled", "webhook"]);
  const rows = await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, f.companyId));
  expect(rows).toHaveLength(3); expect(rows.every(row => row.status === "completed")).toBe(true);
  expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, first.body.runId)))
    .toEqual([expect.objectContaining({ stepId: "record", status: "completed" })]);
  console.info("T16A_M09_MODES", JSON.stringify({ companyId: f.companyId, manualRunId: response.body.runId,
    scheduledRunId: scheduledRuns[0]!.id, webhookRunId: first.body.runId, calls: await f.calls() }));
}, 60_000);

it("serializes concurrent identical signed webhook deliveries before starting any duplicate work", async () => {
  const f = await world(), workflow = await f.definition("webhook-race");
  await f.enableWebhook(workflow.id);
  const lock = await db.$client.reserve(), lockKey = 78432313;
  const [{ pid }] = await lock`select pg_backend_pid() as pid`;
  await lock`select pg_advisory_lock(${lockKey})`;
  const trigger = `webhook_gate_${workflow.id.replaceAll("-", "")}`;
  await db.$client.unsafe(`create function ${trigger}() returns trigger language plpgsql as $$ begin if NEW.workflow_id = '${workflow.id}' then perform pg_advisory_xact_lock(${lockKey}); end if; return NEW; end $$`);
  await db.$client.unsafe(`create trigger ${trigger} before insert on workflow_runs for each row execute function ${trigger}()`);
  let held = true;
  const first = Promise.resolve(f.postWebhook(workflow.id, "same-delivery"));
  let second: Promise<Response> | undefined;
  void first.catch(() => {});
  try {
    const waitForBlocked = async (blockerIds: number[], excluded: number[] = []) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const rows = await db.$client`select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity where datname = current_database()`;
        const row = rows.find(r => !excluded.includes(Number(r.pid)) && (r.blockers as number[]).some(id => blockerIds.includes(Number(id))));
        if (row) return Number(row.pid);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("webhook transaction did not reach the observed lock");
    };
    const firstPid = await waitForBlocked([Number(pid)]);
    expect(await db.select().from(workflowWebhookDeliveries).where(eq(workflowWebhookDeliveries.workflowId, workflow.id))).toHaveLength(0);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflow.id))).toHaveLength(0);
    expect(existsSync(f.marker)).toBe(false);
    second = Promise.resolve(f.postWebhook(workflow.id, "same-delivery"));
    void second.catch(() => {});
    const secondPid = await waitForBlocked([Number(pid), firstPid], [firstPid]);
    expect(secondPid).not.toBe(firstPid);
    await lock`select pg_advisory_unlock(${lockKey})`; held = false;
    const responses = await Promise.all([first, second]);
    const dispatch = await processQueuedWorkflowToolStepRuns(db);
    const runs = await db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, f.companyId), eq(workflowRuns.workflowId, workflow.id)));
    const deliveries = await db.select().from(workflowWebhookDeliveries).where(eq(workflowWebhookDeliveries.workflowId, workflow.id));
    const calls = await f.calls();
    console.info("T16A_M09_WEBHOOK_RACE", JSON.stringify({ companyId: f.companyId, workflowId: workflow.id,
      statuses: responses.map(r => r.status), runIds: responses.map(r => r.body.runId),
      runs: runs.map(r => r.id), deliveries: deliveries.length, calls, executed: dispatch.executedCount }));
    expect(responses.map(r => r.status)).toEqual([202, 202]);
    expect(responses[0]!.body.runId).toBe(responses[1]!.body.runId);
    expect(runs).toHaveLength(1); expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.runId).toBe(runs[0]!.id); expect(dispatch.executedCount).toBe(1);
    expect(calls).toEqual(["webhook-race"]);
  } finally {
    if (held) await lock`select pg_advisory_unlock(${lockKey})`;
    await Promise.allSettled([first, ...(second ? [second] : [])]);
    lock.release();
    await db.$client.unsafe(`drop trigger ${trigger} on workflow_runs`);
    await db.$client.unsafe(`drop function ${trigger}()`);
  }
}, 60_000);

it("rolls back the receipt with run creation and accepts the same key after a failed insert", async () => {
  const f = await world(), workflow = await f.definition("webhook-rollback");
  await f.enableWebhook(workflow.id);
  const trigger = `webhook_fail_${workflow.id.replaceAll("-", "")}`;
  await db.$client.unsafe(`create function ${trigger}() returns trigger language plpgsql as $$ begin if NEW.workflow_id = '${workflow.id}' then raise exception 'injected run insert failure'; end if; return NEW; end $$`);
  await db.$client.unsafe(`create trigger ${trigger} before insert on workflow_runs for each row execute function ${trigger}()`);
  try {
    const failed = await f.postWebhook(workflow.id, "retry-after-rollback");
    expect(failed.status).toBe(500);
    expect(await db.select().from(workflowWebhookDeliveries).where(eq(workflowWebhookDeliveries.workflowId, workflow.id))).toHaveLength(0);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflow.id))).toHaveLength(0);
    expect(existsSync(f.marker)).toBe(false);
  } finally {
    await db.$client.unsafe(`drop trigger ${trigger} on workflow_runs`);
    await db.$client.unsafe(`drop function ${trigger}()`);
  }
  const retry = await f.postWebhook(workflow.id, "retry-after-rollback");
  expect(retry.status, JSON.stringify(retry.body)).toBe(202);
  expect((await processQueuedWorkflowToolStepRuns(db)).executedCount).toBe(1);
  expect(await f.calls()).toEqual(["webhook-rollback"]);
  const receipts = await db.select().from(workflowWebhookDeliveries).where(eq(workflowWebhookDeliveries.workflowId, workflow.id));
  expect(receipts).toHaveLength(1); expect(receipts[0]!.runId).toBe(retry.body.runId);
}, 60_000);

it("reuses and starts a committed pending run after an interrupted first start", async () => {
  const f = await world(), workflow = await f.definition("webhook-resume");
  await f.enableWebhook(workflow.id);
  const start = vi.spyOn(workflowService, "startPreparedRun").mockRejectedValueOnce(new Error("injected interruption before start"));
  try {
    const failed = await f.postWebhook(workflow.id, "retry-after-commit");
    expect(failed.status).toBe(500);
    const receipts = await db.select().from(workflowWebhookDeliveries).where(eq(workflowWebhookDeliveries.workflowId, workflow.id));
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflow.id));
    expect(receipts).toHaveLength(1); expect(runs).toHaveLength(1);
    expect(receipts[0]!.runId).toBe(runs[0]!.id); expect(runs[0]!.status).toBe("pending");
    expect(existsSync(f.marker)).toBe(false);
    const retry = await f.postWebhook(workflow.id, "retry-after-commit");
    expect(retry.status, JSON.stringify(retry.body)).toBe(202);
    expect(retry.body.runId).toBe(runs[0]!.id);
    expect((await processQueuedWorkflowToolStepRuns(db)).executedCount).toBe(1);
    const replay = await f.postWebhook(workflow.id, "retry-after-commit");
    expect(replay.body.runId).toBe(runs[0]!.id);
    expect((await processQueuedWorkflowToolStepRuns(db)).executedCount).toBe(0);
    expect(await f.calls()).toEqual(["webhook-resume"]);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflow.id))).toHaveLength(1);
  } finally { start.mockRestore(); }
}, 60_000);
