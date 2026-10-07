import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companies, createDb, issues, issueWorkProducts, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { workProductService } from "../services/work-products.js";

const abcSeal = { sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", byteSize: 3 };
const binarySeal = { sha256: "f913f951fee20a999f5360abd89d13db26473126d9c5942dcc37b29eeef7dacb", byteSize: 4 };
const authorityKeys = ["workflowProducerRebind", "workflowProducerPromotion", "workflowProducerDelegatedOrigin"] as const;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>, dir: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("producer-seal-");
  db = createDb(temp.connectionString);
  const cache = path.join(os.homedir(), ".cache/generic-stale-producer-rebind");
  await mkdir(cache, { recursive: true });
  dir = await mkdtemp(path.join(cache, "seal-files-"));
}, 60000);
afterAll(async () => {
  await (db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end();
  await temp?.cleanup();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function fixture(provider = "local_file") {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
  const runId = randomUUID(), stepRunId = randomUUID(), heartbeatId = randomUUID(), workflowId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Seal", issuePrefix: `S${companyId.replaceAll("-", "")}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Writer" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Write" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Seal", stepsJson: [] });
  await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, triggeredBy: "board" });
  await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId: runId, stepId: "write", issueId,
    status: "running", startedAt: new Date("2026-01-01"), executionGeneration: 4, retryCount: 0, iterationIndex: 0 });
  await admittedProducer(db, { companyId, agentId, issueId, stepRunId, heartbeatId, status: "running" });
  const file = path.join(dir, `${issueId}.bin`);
  await writeFile(file, "abc");
  const svc = workProductService(db);
  const create = (metadata: Record<string, unknown> = {}, createdByRunId: string | null = heartbeatId) => svc.createForIssue(issueId, companyId,
    { provider, type: "document", title: "content.bin", status: "active", createdByRunId, metadata: { path: file, ...metadata } });
  return { companyId, agentId, issueId, stepRunId, heartbeatId, file, svc, create };
}

// Break: trusting the caller's seal or omitting the DB-persisted byte measurement.
it("seals newly registered local workflow bytes instead of caller-forged provenance", async () => {
  const f = await fixture();
  await writeFile(f.file, Buffer.from([0, 255, 195, 169]));
  const product = await f.create({ workflowProducer: { ...abcSeal, heartbeatRunId: randomUUID() } });
  const [stored] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id));
  expect(stored.metadata?.workflowProducer).toMatchObject({ ...binarySeal, heartbeatRunId: f.heartbeatId, executionGeneration: 4 });
  expect(product?.metadata?.workflowProducer).toEqual(stored.metadata?.workflowProducer);
});

// Break: old issuance authority survives a new producer stamp, or bytes are not remeasured.
it("restamps the current admitted attempt with a new seal and clears obsolete authority markers", async () => {
  const f = await fixture();
  const product = await f.create({ note: "keep" });
  const markers = Object.fromEntries(authorityKeys.map(key => [key, { authorityIdempotencyKey: "old-attempt" }]));
  await db.update(issueWorkProducts).set({ metadata: { ...product!.metadata, ...markers } }).where(eq(issueWorkProducts.id, product!.id));
  await db.update(workflowStepRuns).set({ iterationIndex: 1 }).where(eq(workflowStepRuns.id, f.stepRunId));
  const nextHeartbeatId = randomUUID();
  await admittedProducer(db, { ...f, heartbeatId: nextHeartbeatId, status: "running" });
  await writeFile(f.file, Buffer.from([0, 255, 195, 169]));
  const restamped = await f.svc.restampProducer(product!.id, nextHeartbeatId,
    { workflowProducer: { ...abcSeal }, ...markers, registeredByRunId: nextHeartbeatId });
  expect(restamped?.metadata?.workflowProducer).toMatchObject({ ...binarySeal, heartbeatRunId: nextHeartbeatId, iterationIndex: 1 });
  expect(restamped?.metadata).toMatchObject({ note: "keep", registeredByRunId: nextHeartbeatId });
  for (const key of authorityKeys) expect(restamped?.metadata).not.toHaveProperty(key);
  const [stored] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id));
  expect(stored.createdByRunId).toBe(nextHeartbeatId);
  expect(stored.metadata).toEqual(restamped?.metadata);
});

// Break: a new product imports caller-authored rebind/promotion authority.
it("creation strips caller-authored producer authority markers", async () => {
  const f = await fixture();
  const product = await f.create(Object.fromEntries(authorityKeys.map(key => [key, { forged: true }])));
  for (const key of authorityKeys) expect(product?.metadata).not.toHaveProperty(key);
});

// Break: a metadata patch replaces the production seal or persisted marker authority.
it("ordinary metadata patches preserve the seal and DB authority, not supplied replacements", async () => {
  const f = await fixture(), product = await f.create();
  const markers = Object.fromEntries(authorityKeys.map(key => [key, { authorityIdempotencyKey: "trusted-existing" }]));
  await db.update(issueWorkProducts).set({ metadata: { ...product!.metadata, ...markers } }).where(eq(issueWorkProducts.id, product!.id));
  const updated = await f.svc.update(product!.id, { metadata: { path: f.file, note: "patched",
    workflowProducer: { sha256: "0".repeat(64), byteSize: 999 },
    ...Object.fromEntries(authorityKeys.map(key => [key, { forged: true }])) } });
  expect(updated?.metadata?.workflowProducer).toEqual(product?.metadata?.workflowProducer);
  expect(updated?.metadata).toMatchObject({ ...markers, note: "patched" });
  const withoutMarkers = await f.svc.update(product!.id, { metadata: { path: f.file } });
  expect(withoutMarkers?.metadata).toMatchObject(markers);
});

// Break: a missing local file becomes an unsealed new producer with legacy treatment.
it("an unreadable restamp rolls back producer changes rather than downgrading to legacy absence", async () => {
  const f = await fixture(), product = await f.create();
  await rm(f.file);
  await expect(f.svc.restampProducer(product!.id, f.heartbeatId, { note: "bad" })).rejects.toThrow("workproduct_producer_file_unreadable");
  expect(await f.svc.getById(product!.id)).toEqual(product);
});

// Break: empty bytes are incorrectly treated as absent evidence.
it("records a paired seal for an empty file", async () => {
  const f = await fixture();
  await writeFile(f.file, "");
  const product = await f.create();
  expect(product?.metadata?.workflowProducer).toMatchObject({ sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", byteSize: 0 });
});

// Break: ordinary or nonlocal registrations acquire invented production byte authority.
it("does not invent producer seals for ordinary issues or remote products", async () => {
  const f = await fixture();
  expect((await f.create({}, null))?.metadata).not.toHaveProperty("workflowProducer");
  const remote = await fixture("github");
  const product = await remote.create();
  expect(product?.metadata?.workflowProducer).toMatchObject({ heartbeatRunId: remote.heartbeatId });
  expect(product?.metadata?.workflowProducer).not.toHaveProperty("sha256");
  expect(product?.metadata?.workflowProducer).not.toHaveProperty("byteSize");
});

// Break: sealing moves a stale write past the existing attempt/generation fence.
it("rejects stale restamps before changing a previously recorded seal", async () => {
  const f = await fixture(), product = await f.create();
  await db.update(workflowStepRuns).set({ executionGeneration: 5 }).where(eq(workflowStepRuns.id, f.stepRunId));
  await writeFile(f.file, "changed");
  await expect(f.svc.restampProducer(product!.id, f.heartbeatId, {})).rejects.toThrow("workproduct_producer_stale_generation");
  expect(await f.svc.getById(product!.id)).toEqual(product);
});
