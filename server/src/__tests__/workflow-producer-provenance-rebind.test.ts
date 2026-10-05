import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, issueWorkProducts,
  workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workProductService } from "../services/work-products.js";
import { selectOfficialWorkProduct } from "../services/workflow/workproduct-selector.js";
import { rebindProducerProvenance } from "../services/workflow/producer-provenance-rebind.js";
import { workflowRoutes } from "../routes/workflows.js";
import { errorHandler } from "../middleware/index.js";
import { createFrozenRun } from "./helpers/workflow-frozen-execution-fixture.js";
import { admittedProducer } from "./helpers/admitted-producer.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, dir: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("producer-rebind-"); db = createDb(temp.connectionString);
  dir = await mkdtemp(path.join(os.tmpdir(), "producer-rebind-")); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(dir, { recursive: true, force: true }); });

/**
 * [파일 목적] board producer provenance rebind — 런 회복으로 생산자 세대만 뒤처진 workProduct 를
 *   재귀속하면 (1) 재바인딩 전 셀렉터는 stale_producer 로 거부 (2) 서비스는 fail-closed 조건 통과 시
 *   귀속/마커/권한 이벤트를 기록 (3) 셀렉터가 재바인딩 산출물을 수용 (4) 바이트 변조 시 재거부,
 *   그리고 비-세대 불일치·미완료 생산자·활성 런 등은 거부함을 검증한다.
 */
async function fixture() {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), workflowId = randomUUID();
  const runId = randomUUID(), stepId = randomUUID(), heartbeatId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Rebind", issuePrefix: companyId.slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Writer" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Write" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Rebind", stepsJson: [] });
  await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, triggeredBy: "board" });
  await db.insert(workflowStepRuns).values({ id: stepId, workflowRunId: runId, stepId: "write", issueId,
    status: "completed", executionGeneration: 1, startedAt: new Date("2026-01-01") });
  await admittedProducer(db, { companyId, agentId, issueId, stepRunId: stepId, heartbeatId });
  const file = path.join(dir, `${issueId}.json`); await writeFile(file, "{}");
  const product = await workProductService(db).createForIssue(issueId, companyId, { provider: "local_file",
    type: "document", title: "content.json", status: "active", createdByRunId: heartbeatId, metadata: { path: file } });
  // 회복(recovery)이 런 세대를 진행시킨 상황 재현: 생산자 행만 세대 3으로, 런은 failed.
  await db.update(workflowStepRuns).set({ executionGeneration: 3 }).where(eq(workflowStepRuns.id, stepId));
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, runId));
  const select = () => selectOfficialWorkProduct(db, { companyId, workflowRunId: runId, stepId: "write",
    selector: { type: "document", title: "content.json" } });
  const rebind = () => rebindProducerProvenance(db, { companyId, workflowRunId: runId, producerStepId: "write",
    productId: product!.id, actor: { actorType: "board", actorId: "local-board" } });
  const readProduct = async () => (await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id)))[0]!;
  const rebindEvents = async () => (await db.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.workflowRunId, runId)))
    .filter((event) => event.reason === "board_producer_provenance_rebind");
  return { companyId, issueId, runId, stepId, product, select, rebind, readProduct, rebindEvents, file };
}

it("selector fences the producer product before rebind", async () => {
  const f = await fixture();
  await expect(f.select()).rejects.toThrow("workproduct_selector_stale_producer");
});

it("rebind records a forward-valid marker and an authority transition, preserving production truth", async () => {
  const f = await fixture();
  const result = await f.rebind();
  expect(result).toMatchObject({ status: "rebound", fromGeneration: 1, reboundAtGeneration: 3 });
  const row = await f.readProduct();
  expect(row.sourceExecutionGeneration).toBe(1);
  expect((row.metadata!.workflowProducer as Record<string, unknown>).executionGeneration).toBe(1);
  const marker = row.metadata!.workflowProducerRebind as Record<string, unknown>;
  expect(marker).toMatchObject({ fromGeneration: 1, reboundAtGeneration: 3, reason: "board_producer_provenance_rebind" });
  expect(typeof marker.sha256).toBe("string");
  const events = await f.rebindEvents();
  expect(events).toHaveLength(1);
  expect(events[0]!.idempotencyKey).toBe(`producer-provenance-rebind:${f.product!.id}:1`);
});

it("selector accepts the rebound product end-to-end", async () => {
  const f = await fixture();
  await f.rebind();
  const selected = await f.select();
  expect(selected.product.id).toBe(f.product!.id);
  expect(selected.producer.executionGeneration).toBe(1);
});

it("selector keeps accepting the rebound product after further generation advances (rerun/recovery)", async () => {
  const f = await fixture();
  await f.rebind();
  // 재발사(rerun)/회복이 세대를 진행시켜도 마커는 유효해야 한다.
  await db.update(workflowStepRuns).set({ executionGeneration: 5 }).where(eq(workflowStepRuns.id, f.stepId));
  await expect(f.select()).resolves.toMatchObject({ product: { id: f.product!.id } });
  await db.update(workflowStepRuns).set({ executionGeneration: 9 }).where(eq(workflowStepRuns.id, f.stepId));
  await expect(f.select()).resolves.toMatchObject({ product: { id: f.product!.id } });
});

it("selector re-verifies rebound bytes on every consumption", async () => {
  const f = await fixture();
  await f.rebind();
  await writeFile(f.file, "{\"tampered\":true}");
  await expect(f.select()).rejects.toThrow("workproduct_selector_rebind_bytes_mismatch");
  await writeFile(f.file, "{}");
  await expect(f.select()).resolves.toMatchObject({ product: { id: f.product!.id } });
});

it("second rebind is idempotent and writes no duplicate authority transition", async () => {
  const f = await fixture();
  await f.rebind();
  await db.update(workflowStepRuns).set({ executionGeneration: 4 }).where(eq(workflowStepRuns.id, f.stepId));
  await expect(f.rebind()).resolves.toMatchObject({ status: "already_rebound", fromGeneration: 1 });
  expect(await f.rebindEvents()).toHaveLength(1);
});

it("refuses an active (non-failed) run", async () => {
  const f = await fixture();
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  await expect(f.rebind()).rejects.toThrow("producer_rebind_run_not_failed");
});

it("refuses an incomplete producer step", async () => {
  const f = await fixture();
  await db.update(workflowStepRuns).set({ status: "pending" }).where(eq(workflowStepRuns.id, f.stepId));
  await expect(f.rebind()).rejects.toThrow("producer_rebind_producer_not_completed");
});

it("refuses staleness that is not generation-only (retryCount drift)", async () => {
  const f = await fixture();
  const row = await f.readProduct();
  const producer = row.metadata!.workflowProducer as Record<string, unknown>;
  await db.update(issueWorkProducts).set({ metadata: { ...row.metadata!,
    workflowProducer: { ...producer, retryCount: 5 } } }).where(eq(issueWorkProducts.id, row.id));
  await expect(f.rebind()).rejects.toThrow("producer_rebind_not_generation_only");
});

it("refuses an unlinked producer heartbeat", async () => {
  const f = await fixture();
  const row = await f.readProduct();
  const heartbeatRunId = (row.metadata!.workflowProducer as Record<string, unknown>).heartbeatRunId as string;
  await db.update(heartbeatRuns).set({ workflowStepRunId: randomUUID() }).where(eq(heartbeatRuns.id, heartbeatRunId));
  await expect(f.rebind()).rejects.toThrow("producer_rebind_heartbeat_unlinked");
});

// ---- route 레벨: board producer-provenance rebind API (펜스 경로 + 회복 확장 분기) ----

const UNCHANGED_FENCE_422 = "Only steps fenced by a stale-producer or delegated-provenance selector error can rebind or promote producer provenance";

function boardApp(database: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId: "route-board" } as typeof req.actor;
    next();
  });
  app.use("/api", workflowRoutes(database));
  app.use(errorHandler);
  return app;
}

/** [route fixture] 실제 store(createWorkflowRun)로 얼려진 실행정의 스냅숏을 가진 런 + 완료된 생산자
 *   (admittedProducer 실제 등록) + 소비 단계. 소비 상태/오류는 인자로 넣어 "펜스가 지워진" 상황을 재현한다.
 *   서비스 층 증명 사슬 구성(하트비트, 로컬 파일, 세대 불일치)은 위 fixture 와 동일하다. */
async function routeFixture(input: {
  steps: unknown[];
  producerStepId: string;
  consumerStepId: string;
  consumerStatus?: string;
  runStatus?: string;
  consumerMetadata?: Record<string, unknown>;
}) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), workflowId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "RebindRoute", issuePrefix: companyId.slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Builder" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Build" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "RebindRoute", stepsJson: input.steps as never });
  const run = await createFrozenRun(db, { workflowId, companyId });
  const [producerStepRun] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: input.producerStepId,
    issueId, status: "completed", executionGeneration: 0, startedAt: new Date("2026-01-01") }).returning();
  const admitted = await admittedProducer(db, { companyId, agentId, issueId, stepRunId: producerStepRun!.id, heartbeatId: randomUUID() });
  const file = path.join(dir, `${issueId}.json`); await writeFile(file, "{}");
  const product = await workProductService(db).createForIssue(issueId, companyId, { provider: "local_file",
    type: "document", title: "content.json", status: "active", createdByRunId: admitted.heartbeatId, metadata: { path: file } });
  const [consumerStepRun] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: input.consumerStepId,
    issueId: null, status: input.consumerStatus ?? "skipped", executionGeneration: 3, startedAt: new Date("2026-01-02"),
    ...(input.consumerMetadata ? { metadata: input.consumerMetadata as never } : {}) }).returning();
  // 회복(recovery)/리컨실러가 세대를 진행시키고 런을 종료-실패로 닫은 상황 재현.
  await db.update(workflowStepRuns).set({ executionGeneration: 3 }).where(eq(workflowStepRuns.id, producerStepRun!.id));
  await db.update(workflowRuns).set({ status: input.runStatus ?? "failed" }).where(eq(workflowRuns.id, run.id));
  const rebind = () => request(boardApp(db)).post(`/api/workflow-step-runs/${consumerStepRun!.id}/rebind-producer-provenance`)
    .send({ producerStepId: input.producerStepId, productId: product!.id });
  return { companyId, run, producerStepRun, consumerStepRun, product, rebind };
}

it("route: board rebinds when the reconciler erased the fence (skipped consumer, transitive downstream of producer)", async () => {
  const f = await routeFixture({
    steps: [
      { id: "build", name: "Build", agentId: "", dependencies: [], type: "tool" },
      { id: "assemble", name: "Assemble", agentId: "", dependencies: ["build"], type: "tool" },
      { id: "publish", name: "Publish", agentId: "", dependencies: ["assemble"], type: "tool" },
    ],
    producerStepId: "build",
    consumerStepId: "publish",
    consumerStatus: "skipped",
  });
  const res = await f.rebind();
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ status: "rebound", fromGeneration: 0, reboundAtGeneration: 3 });
});

it("route: rebind is rejected when the consumer has no dependency path from the producer step", async () => {
  const f = await routeFixture({
    steps: [
      { id: "build", name: "Build", agentId: "", dependencies: [], type: "tool" },
      { id: "publish", name: "Publish", agentId: "", dependencies: [], type: "tool" },
    ],
    producerStepId: "build",
    consumerStepId: "publish",
    consumerStatus: "skipped",
  });
  const res = await f.rebind();
  expect(res.status).toBe(422);
  expect(res.body.error).toBe(UNCHANGED_FENCE_422);
});

it("route: rebind stays rejected when the run is not failed (no recovery branch)", async () => {
  const f = await routeFixture({
    steps: [
      { id: "build", name: "Build", agentId: "", dependencies: [], type: "tool" },
      { id: "publish", name: "Publish", agentId: "", dependencies: ["build"], type: "tool" },
    ],
    producerStepId: "build",
    consumerStepId: "publish",
    consumerStatus: "skipped",
    runStatus: "running",
  });
  const res = await f.rebind();
  expect(res.status).toBe(422);
  expect(res.body.error).toBe(UNCHANGED_FENCE_422);
});

it("route: fenced path is unchanged — eligible dispatch error still rebinds without needing ancestry", async () => {
  const f = await routeFixture({
    steps: [
      { id: "build", name: "Build", agentId: "", dependencies: [], type: "tool" },
      { id: "publish", name: "Publish", agentId: "", dependencies: [], type: "tool" },
    ],
    producerStepId: "build",
    consumerStepId: "publish",
    consumerStatus: "failed",
    consumerMetadata: { toolInvocation: { dispatchError: "workproduct_selector_stale_producer" } },
  });
  const res = await f.rebind();
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ status: "rebound" });
});
