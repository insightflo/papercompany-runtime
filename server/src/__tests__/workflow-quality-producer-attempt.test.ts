import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentWakeupRequests, createDb, issueWorkProducts, qualityActions,
  workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { qualityProducerFixture } from "./helpers/quality-producer-fixture.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, dir: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("quality-producer-"); db = createDb(temp.connectionString);
  dir = await mkdtemp(path.join(os.tmpdir(), "quality-producer-")); }, 60000);
afterAll(async () => { await temp?.cleanup(); if (dir) await rm(dir, { recursive: true, force: true }); });

it("registers a scheduler-launched quality retry and selects its official output after tracking is cleared", async () => {
  const f = await qualityProducerFixture(db, dir);
  expect((await f.schedule()).result).toBe("scheduled");
  const { heartbeatId, wakeId } = await f.admit();
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
  expect(wake.idempotencyKey).toBe(`quality-action-wake:${f.actionId}:${f.stepRunId}:g8:a1`);
  await db.update(workflowStepRuns).set({ metadata: { qualityActionId: f.actionId } }).where(eq(workflowStepRuns.id, f.stepRunId));
  const product = await f.register(heartbeatId);
  expect(product?.metadata.workflowProducer).toMatchObject({ executionGeneration: 8, retryCount: 1, heartbeatRunId: heartbeatId });
  expect((await f.select()).product.id).toBe(product!.id);
});
it("keeps quality delivery attempt 2 distinct from generic retry 1", async () => {
  const f = await qualityProducerFixture(db, dir); await f.schedule();
  await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.authorAgentId,
    issueId: f.issueId, workflowRunId: f.workflowRunId, workflowStepRunId: f.stepRunId,
    workflowExecutionGeneration: 8, source: "automation", status: "skipped",
    idempotencyKey: `quality-action-wake:${f.actionId}:${f.stepRunId}:g8:a1` });
  const { heartbeatId, wakeId } = await f.admit();
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
  expect(wake.idempotencyKey).toBe(`quality-action-wake:${f.actionId}:${f.stepRunId}:g8:a2`);
  expect((await f.register(heartbeatId))?.metadata.workflowProducer).toMatchObject({ retryCount: 1 });
  expect((await f.select()).producer.retryCount).toBe(1);
});
it("registers the next legitimate retry from its own scheduling record", async () => {
  const f = await qualityProducerFixture(db, dir); await f.schedule(); await f.admit();
  await f.schedule(); const { heartbeatId } = await f.admit();
  const product = await f.register(heartbeatId);
  expect(product?.metadata.workflowProducer).toMatchObject({ executionGeneration: 9, retryCount: 2 });
  expect((await f.select()).product.id).toBe(product!.id);
});
it("never re-registers the old quality heartbeat after the next reset, pending or completed", async () => {
  const f = await qualityProducerFixture(db, dir); await f.schedule();
  const old = await f.admit(); await f.register(old.heartbeatId);
  await f.schedule();
  await expect(f.register(old.heartbeatId)).rejects.toThrow("workproduct_producer_stale_generation");
  await f.admit();
  await expect(f.register(old.heartbeatId)).rejects.toThrow("workproduct_producer_stale_generation");
  await expect(f.select()).rejects.toThrow("workproduct_selector_stale_producer");
});
it("derives retry number from the original wake's earlier scheduling ledger, not current retryCount", async () => {
  const f = await qualityProducerFixture(db, dir); await f.schedule(); const old = await f.admit();
  await f.schedule();
  // Simulate a legacy same-generation reset: an old wake must not acquire retry 2.
  await db.update(workflowStepRuns).set({ executionGeneration: 8, status: "completed", startedAt: new Date(0) })
    .where(eq(workflowStepRuns.id, f.stepRunId));
  await expect(f.register(old.heartbeatId)).rejects.toThrow("workproduct_producer_attempt_unproven");
});
it("accepts initial quality delivery without inventing a generic retry", async () => {
  const f = await qualityProducerFixture(db, dir), { heartbeatId } = await f.admit();
  const product = await f.register(heartbeatId);
  expect(product?.metadata.workflowProducer).toMatchObject({ executionGeneration: 7, retryCount: 0 });
  expect((await f.select()).product.id).toBe(product!.id);
});
it.each(["malformed", "old-generation", "future-generation", "wrong-attempt", "noncanonical", "missing-receipt",
  "wrong-intent", "wrong-input", "foreign-action", "foreign-binding", "foreign-agent", "foreign-issue",
  "foreign-run", "foreign-company", "foreign-mission", "coalesced", "coalesced-status", "wrong-receipt-run",
  "missing-ledger", "malformed-ledger", "future-ledger"])("rejects %s quality evidence with no output write", async reason => {
  const f = await qualityProducerFixture(db, dir); await f.schedule(); const { heartbeatId, wakeId } = await f.admit();
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
  const receipt = { ...wake.qualityAcceptance! };
  const patch: Partial<typeof agentWakeupRequests.$inferInsert> = {};
  if (reason === "malformed") patch.idempotencyKey = `${wake.idempotencyKey}:suffix`;
  if (reason === "old-generation") patch.idempotencyKey = wake.idempotencyKey!.replace(":g8:", ":g7:");
  if (reason === "future-generation") patch.idempotencyKey = wake.idempotencyKey!.replace(":g8:", ":g9:");
  if (reason === "wrong-attempt") patch.idempotencyKey = wake.idempotencyKey!.replace(":a1", ":a2");
  if (reason === "noncanonical") patch.idempotencyKey = wake.idempotencyKey!.replace(":a1", ":a01");
  if (reason === "missing-receipt") patch.qualityAcceptance = null;
  if (reason === "wrong-intent") patch.qualityAcceptance = { ...receipt, intentKey: "wrong" };
  if (reason === "wrong-input") patch.qualityAcceptance = { ...receipt, inputHash: "ff".repeat(32) };
  if (reason === "foreign-action") patch.idempotencyKey = wake.idempotencyKey!.replace(f.actionId, randomUUID());
  if (reason === "foreign-binding") await db.update(qualityActions).set({ canonicalBinding: {
    companyId: f.companyId, actionId: f.actionId, missionId: f.missionId, workflowRunId: f.workflowRunId,
    issueId: f.issueId, stepRunId: randomUUID() } }).where(eq(qualityActions.id, f.actionId));
  if (reason === "foreign-agent") patch.agentId = f.verifierAgentId;
  if (reason === "foreign-issue") patch.issueId = randomUUID();
  if (reason === "foreign-run") patch.workflowRunId = randomUUID();
  if (reason === "foreign-company") patch.companyId = f.otherCompanyId;
  if (reason === "foreign-mission") patch.missionId = f.sourceMissionId;
  if (reason === "coalesced") patch.runId = randomUUID();
  if (reason === "coalesced-status") patch.status = "coalesced";
  if (reason === "wrong-receipt-run") patch.qualityAcceptance = { ...receipt, heartbeatRunId: randomUUID() };
  if (reason === "missing-ledger") await db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.stepRunId));
  if (reason === "malformed-ledger") await db.update(workflowTransitionEvents).set({ payload: { retryNumber: 1 } })
    .where(eq(workflowTransitionEvents.workflowStepRunId, f.stepRunId));
  if (reason === "future-ledger") await db.update(workflowTransitionEvents).set({ createdAt: new Date(Date.now() + 60000) })
    .where(eq(workflowTransitionEvents.workflowStepRunId, f.stepRunId));
  if (Object.keys(patch).length) await db.update(agentWakeupRequests).set(patch).where(eq(agentWakeupRequests.id, wakeId));
  await expect(f.register(heartbeatId)).rejects.toThrow("workproduct_producer_attempt_unproven");
  expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.issueId))).toEqual([]);
});
