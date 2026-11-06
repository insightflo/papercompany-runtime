import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, workflowDefinitions, workflowWebhookDeliveries } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let legacy: ReturnType<typeof createDb>;

beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("t16a-webhook-signed-migration-");
  db = createDb(temp.connectionString);
  await db.$client.unsafe("CREATE DATABASE t16a_webhook_upgrade");
  const url = new URL(temp.connectionString);
  url.pathname = "/t16a_webhook_upgrade";
  legacy = createDb(url.toString());
}, 120_000);

afterAll(async () => {
  await legacy?.$client.end();
  await db?.$client.end();
  await temp?.cleanup();
}, 60_000);

it("applies the real migration and exposes the signed-message schema on a fresh database", async () => {
  const [table] = await db.$client`SELECT to_regclass('public.workflow_webhook_signed_messages')::text AS name`;
  expect(table?.name).toBe("workflow_webhook_signed_messages");
  const { workflowWebhookSignedMessages } = await import("@paperclipai/db");
  const companyId = randomUUID(), workflowId = randomUUID(), deliveryId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Webhook schema test", issuePrefix: `W${companyId.slice(0, 7)}` });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Webhook schema test" });
  await db.insert(workflowWebhookDeliveries).values({ id: deliveryId, companyId, workflowId, idempotencyKey: "fresh" });
  await db.insert(workflowWebhookSignedMessages).values({ companyId, workflowId, deliveryId, messageHash: "a".repeat(64) });
  const rows = await db.select().from(workflowWebhookSignedMessages).where(eq(workflowWebhookSignedMessages.deliveryId, deliveryId));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ companyId, workflowId, deliveryId, messageHash: "a".repeat(64) });
}, 60_000);

it("preserves existing receipts on upgrade and enforces unique, scoped, cascading aliases", async () => {
  const q = legacy.$client;
  await q.unsafe(`CREATE TABLE workflow_webhook_deliveries (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, workflow_id uuid NOT NULL,
    idempotency_key text NOT NULL, run_id uuid, received_at timestamptz NOT NULL DEFAULT now())`);
  await q.unsafe(`CREATE UNIQUE INDEX workflow_webhook_deliveries_idempotency_uq
    ON workflow_webhook_deliveries (company_id, workflow_id, idempotency_key)`);
  const companyA = randomUUID(), companyB = randomUUID(), workflowA = randomUUID(), workflowB = randomUUID();
  const first = randomUUID(), second = randomUUID(), other = randomUUID(), runId = randomUUID();
  await q`INSERT INTO workflow_webhook_deliveries (id, company_id, workflow_id, idempotency_key, run_id)
    VALUES (${first}, ${companyA}, ${workflowA}, 'first', ${runId}),
           (${second}, ${companyA}, ${workflowA}, 'second', NULL),
           (${other}, ${companyB}, ${workflowB}, 'other', NULL)`;
  const migration = await readFile(new URL("../../../packages/db/src/migrations/0128_workflow_webhook_signed_messages.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await q.unsafe(statement);
  }
  const before = await q`SELECT id, run_id FROM workflow_webhook_deliveries WHERE id = ${first}`;
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ id: first, run_id: runId });
  const hash = "b".repeat(64);
  await q`INSERT INTO workflow_webhook_signed_messages (company_id, workflow_id, delivery_id, message_hash)
    VALUES (${companyA}, ${workflowA}, ${first}, ${hash}), (${companyB}, ${workflowB}, ${other}, ${hash})`;
  await expect(q`INSERT INTO workflow_webhook_signed_messages (company_id, workflow_id, delivery_id, message_hash)
    VALUES (${companyA}, ${workflowA}, ${second}, ${hash})`).rejects.toMatchObject({ code: "23505" });
  await expect(q`INSERT INTO workflow_webhook_signed_messages (company_id, workflow_id, delivery_id, message_hash)
    VALUES (${companyA}, ${workflowA}, ${other}, ${"c".repeat(64)})`).rejects.toMatchObject({ code: "23503" });
  await expect(q`INSERT INTO workflow_webhook_deliveries (id, company_id, workflow_id, idempotency_key)
    VALUES (${randomUUID()}, ${companyA}, ${workflowA}, 'second')`).rejects.toMatchObject({ code: "23505" });
  await q`DELETE FROM workflow_webhook_deliveries WHERE id = ${first}`;
  const remaining = await q`SELECT delivery_id FROM workflow_webhook_signed_messages`;
  expect(remaining).toHaveLength(1);
  expect(remaining[0]?.delivery_id).toBe(other);
}, 60_000);
