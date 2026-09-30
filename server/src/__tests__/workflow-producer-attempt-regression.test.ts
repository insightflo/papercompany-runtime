import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, issueWorkProducts,
  workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workProductService } from "../services/work-products.js";
import { selectOfficialWorkProduct } from "../services/workflow/workproduct-selector.js";
import { admittedProducer } from "./helpers/admitted-producer.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, dir: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("producer-attempt-"); db = createDb(temp.connectionString);
  dir = await mkdtemp(path.join(os.tmpdir(), "producer-attempt-")); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), workflowId = randomUUID();
  const runId = randomUUID(), stepId = randomUUID(); let heartbeatId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Producer", issuePrefix: companyId.slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Writer" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Write" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Producer", stepsJson: [] });
  await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, triggeredBy: "board" });
  await db.insert(workflowStepRuns).values({ id: stepId, workflowRunId: runId, stepId: "write", issueId,
    status: "completed", executionGeneration: 1, startedAt: new Date("2026-01-01") });
  await admittedProducer(db, { companyId, agentId, issueId, stepRunId: stepId, heartbeatId });
  const file = path.join(dir, `${issueId}.json`); await writeFile(file, "{}");
  const register = () => workProductService(db).createForIssue(issueId, companyId, { provider: "local_file",
    type: "document", title: "content.json", status: "active", createdByRunId: heartbeatId, metadata: { path: file } });
  const select = () => selectOfficialWorkProduct(db, { companyId, workflowRunId: runId, stepId: "write",
    selector: { type: "document", title: "content.json" } });
  const wake = async (patch: Partial<typeof agentWakeupRequests.$inferInsert> = {}) => {
    const id = randomUUID(); heartbeatId = randomUUID();
    await db.update(workflowStepRuns).set({ retryCount: 1 }).where(eq(workflowStepRuns.id, stepId));
    await admittedProducer(db, { companyId, agentId, issueId, stepRunId: stepId, heartbeatId, wakeId: id });
    // Corrupt AFTER actual admission; never have the writer manufacture a foreign proof.
    if (Object.keys(patch).length) await db.update(agentWakeupRequests).set(patch).where(eq(agentWakeupRequests.id, id));
  };
  return { companyId, agentId, issueId, runId, stepId, get heartbeatId() { return heartbeatId; }, register, select, wake };
}
it("never relabels an old heartbeat as retry 1 while legacy retry is pending with no start", async () => {
  const f = await fixture();
  await db.update(workflowStepRuns).set({ status: "pending", retryCount: 1, startedAt: null }).where(eq(workflowStepRuns.id, f.stepId));
  await expect(f.register()).rejects.toThrow("workproduct_producer_attempt_unproven");
  expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.issueId))).toEqual([]);
});
it("selector rejects previously restamped stale heartbeat after retry finishes", async () => {
  const f = await fixture(), product = await f.register();
  await db.update(workflowStepRuns).set({ retryCount: 1, startedAt: new Date("2026-02-01") }).where(eq(workflowStepRuns.id, f.stepId));
  await db.update(issueWorkProducts).set({ metadata: { ...product!.metadata,
    workflowProducer: { ...(product!.metadata.workflowProducer as object), retryCount: 1 } } }).where(eq(issueWorkProducts.id, product!.id));
  await expect(f.select()).rejects.toThrow(/workproduct_selector/);
});
it("uses the heartbeat's own scoped retry wake, including after retry tracking was cleared", async () => {
  const f = await fixture(); await f.wake();
  await db.update(workflowStepRuns).set({ retryCount: 1, metadata: {} }).where(eq(workflowStepRuns.id, f.stepId));
  const product = await f.register();
  expect(product?.metadata.workflowProducer).toMatchObject({ retryCount: 1, heartbeatRunId: f.heartbeatId });
  expect((await f.select()).product.id).toBe(product!.id);
});
it.each(["foreign-step", "foreign-run", "foreign-agent", "foreign-company", "foreign-issue", "foreign-generation", "coalesced-old-run"])("rejects %s wake evidence", async reason => {
  const f = await fixture();
  const patch: Partial<typeof agentWakeupRequests.$inferInsert> = reason === "foreign-step" ? { workflowStepRunId: randomUUID() }
    : reason === "foreign-run" ? { workflowRunId: randomUUID() }
    : reason === "foreign-issue" ? { issueId: randomUUID() }
    : reason === "foreign-generation" ? { workflowExecutionGeneration: 2 }
    : reason === "coalesced-old-run" ? { runId: randomUUID() }
    : {};
  if (reason === "foreign-company") {
    patch.companyId = randomUUID(); await db.insert(companies).values({ id: patch.companyId, name: "Other", issuePrefix: patch.companyId.slice(0, 8) });
  }
  if (reason === "foreign-agent") {
    patch.agentId = randomUUID(); await db.insert(agents).values({ id: patch.agentId, companyId: f.companyId, name: "Other" });
  }
  await f.wake(patch);
  await db.update(workflowStepRuns).set({ retryCount: 1 }).where(eq(workflowStepRuns.id, f.stepId));
  await expect(f.register()).rejects.toThrow("workproduct_producer_attempt_unproven");
});
it("does not promote an unclaimed retry even when its wake key matches", async () => {
  const f = await fixture(); await f.wake();
  await db.update(heartbeatRuns).set({ status: "queued", startedAt: null }).where(eq(heartbeatRuns.id, f.heartbeatId));
  await expect(f.register()).rejects.toThrow("workproduct_producer_attempt_unproven");
});
it("rejects an old heartbeat after iteration reset even if its retry key still matches", async () => {
  const f = await fixture(); await f.wake();
  await db.update(workflowStepRuns).set({ retryCount: 1, iterationIndex: 1, startedAt: new Date("2026-02-01") }).where(eq(workflowStepRuns.id, f.stepId));
  await expect(f.register()).rejects.toThrow("workproduct_producer_attempt_unproven");
});
it("does not infer retry identity from caller heartbeat context or current step metadata", async () => {
  const f = await fixture();
  await db.update(workflowStepRuns).set({ retryCount: 1, metadata: { workflowRetry: { retryNumber: 1 } } }).where(eq(workflowStepRuns.id, f.stepId));
  await db.update(heartbeatRuns).set({ contextSnapshot: { retryCount: 1 } }).where(eq(heartbeatRuns.id, f.heartbeatId));
  await expect(f.register()).rejects.toThrow("workproduct_producer_attempt_unproven");
});
