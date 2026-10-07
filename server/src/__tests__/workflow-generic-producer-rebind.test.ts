import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, createDb, issueWorkProducts, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { genericProducerFixture } from "./helpers/generic-producer-rebind-fixture.js";
import { workProductService } from "../services/work-products.js";
import { selectSameRunWorkProduct } from "../services/workflow/workproduct-same-run.js";

// Missing automatic authority, weakened identity proof, or duplicate issuance must break this suite.
describe("generic generation-only producer recovery", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, dir: string;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("generic-rebind-"); db = createDb(temp.connectionString);
    dir = await mkdtemp(path.join(os.tmpdir(), "generic-rebind-"));
  }, 60000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await temp?.cleanup(); await rm(dir, { recursive: true, force: true }); });
  const fixture = (options?: Parameters<typeof genericProducerFixture>[2]) => genericProducerFixture(db, dir, options);
  it.each([['researcher', 'collect'], ['engineer', 'convert'], ['pm', 'assemble']])(
    "automatically authorizes unrelated role %s / step %s", async (role, stepId) => {
      const f = await fixture({ role, stepId });
      expect(await f.select()).toMatchObject({ product: { id: f.product.id }, producer: { executionGeneration: 1 } });
      const row = await f.read();
      expect(row.sourceExecutionGeneration).toBe(1);
      expect(row.metadata!.workflowProducerRebind).toMatchObject({ fromGeneration: 1, reboundAtGeneration: 3,
        sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", byteSize: 2,
        reboundBy: { actorType: "system", actorId: "workproduct-selector" }, reason: "automatic_producer_provenance_rebind" });
      expect(await f.events()).toHaveLength(1);
      expect((await f.events())[0].payload).toMatchObject({ transition: "producer_provenance_rebound",
        reboundBy: { actorType: "system", actorId: "workproduct-selector" } });
    });
  it.each(["running", "completed", "failed"])("does not require a failed run (%s)", async runStatus => {
    const f = await fixture({ runStatus }); await expect(f.select()).resolves.toMatchObject({ product: { id: f.product.id } });
  });
  it.each(["companyId", "missionId", "workflowRunId", "stepRunId", "stepId", "retryCount", "iterationIndex", "createdByRunId"])(
    "fails closed for non-generation mismatch: %s", async field => {
      const f = await fixture();
      if (field === "createdByRunId") await f.patchProduct({ createdByRunId: null });
      else await f.patchProducer({ [field]: field === "retryCount" || field === "iterationIndex" ? 9 : field === "stepId" ? "other" : randomUUID() });
      await expect(f.select()).rejects.toThrow("workproduct_selector_stale_producer");
      expect(await f.events()).toEqual([]); expect((await f.read()).metadata!.workflowProducerRebind).toBeUndefined();
    });
  it.each(["heartbeat", "attempt"])("does not authorize an unproven %s", async reason => {
    const f = await fixture();
    if (reason === "heartbeat") await f.patchHeartbeat({ workflowStepRunId: f.consumerId });
    else await db.update(agentWakeupRequests).set({ status: "coalesced" }).where(eq(agentWakeupRequests.id, f.admission.wakeId));
    await expect(f.select()).rejects.toThrow("workproduct_selector_stale_producer");
    expect(await f.events()).toEqual([]);
  });
  it.each(["hash", "size", "both"])("rejects a changed production seal (%s)", async part => {
    const f = await fixture({ sealed: true });
    await f.patchProducer({ sha256: part === "size" ? createHash("sha256").update("{}").digest("hex") : "0".repeat(64),
      byteSize: part === "hash" ? 2 : 9 });
    await expect(f.select()).rejects.toThrow("workproduct_selector_stale_producer"); expect(await f.events()).toEqual([]);
  });
  it("rejects disk mutation against the production-time seal", async () => {
    const f = await fixture({ sealed: true }); await writeFile(f.file, "[]");
    await expect(f.select()).rejects.toThrow("workproduct_selector_stale_producer");
    expect(await f.events()).toEqual([]);
  });
  it("uses legacy issuance-time bytes, then checks every consumption", async () => {
    const f = await fixture(); await writeFile(f.file, "legacy");
    await expect(f.select()).resolves.toMatchObject({ product: { id: f.product.id } });
    expect((await f.read()).metadata!.workflowProducerRebind).toMatchObject({ byteSize: 6 });
    await writeFile(f.file, "changed");
    await expect(f.select()).rejects.toThrow("workproduct_selector_rebind_bytes_mismatch");
    expect(await f.events()).toHaveLength(1);
  });
  it.each(["archived", "missing", "duplicate", "remote"])("keeps existing rejection for %s", async reason => {
    const f = await fixture();
    // Current-generation path retains its existing local/cardinality errors without requesting repair.
    await db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, f.stepRunId));
    if (reason === "archived") await f.patchProduct({ status: "archived" });
    if (reason === "missing") await db.delete(issueWorkProducts).where(eq(issueWorkProducts.id, f.product.id));
    if (reason === "duplicate") { const row = await f.read(); await db.insert(issueWorkProducts).values({ ...row, id: randomUUID(), isPrimary: false }); }
    if (reason === "remote") await f.patchProduct({ provider: "web", metadata: { workflowProducer: (await f.read()).metadata!.workflowProducer }, url: "https://example.test/file" });
    await expect(f.select()).rejects.toThrow(reason === "remote" ? "workproduct_selector_not_local" : "workproduct_selector_not_exactly_one");
    expect(await f.events()).toEqual([]);
  });
  it("does not issue for archived pinned products or backwards generation", async () => {
    const f = await fixture(); await f.patchProduct({ status: "archived" });
    await expect(selectSameRunWorkProduct(db, { ...f.scope, pinnedId: f.product.id })).rejects.toThrow("workproduct_selector_stale_producer");
    await f.patchProduct({ status: "active" }); await f.patchProducer({ executionGeneration: 4 });
    await expect(f.select()).rejects.toThrow("workproduct_selector_stale_producer"); expect(await f.events()).toEqual([]);
  });
  it("serializes concurrent consumers with one marker and one event", async () => {
    const f = await fixture();
    const selected = await Promise.all([f.select(), f.select()]);
    expect(selected.map(s => s.product.id)).toEqual([f.product.id, f.product.id]);
    expect(await f.events()).toHaveLength(1);
  });
  it("rolls back the consumer locks before issuing, then commits the frozen pin", async () => {
    const f = await fixture();
    expect(await f.resolve()).toEqual({ input: f.file });
    expect(await f.pins()).toHaveLength(1); expect(await f.events()).toHaveLength(1);
  });
  it("seals new registration and restamp bytes without weakening stale writes", async () => {
    const f = await fixture({ sealed: true });
    expect(f.originalProducer).toMatchObject({ sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", byteSize: 2 });
    await expect(workProductService(db).restampProducer(f.product.id, f.heartbeatId, {})).rejects.toThrow("workproduct_producer_stale_generation");
    await db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, f.stepRunId));
    await writeFile(f.file, "new bytes");
    const row = await workProductService(db).restampProducer(f.product.id, f.heartbeatId, {});
    expect(row!.metadata!.workflowProducer).toMatchObject({ sha256: createHash("sha256").update("new bytes").digest("hex"), byteSize: 9 });
  });
});
