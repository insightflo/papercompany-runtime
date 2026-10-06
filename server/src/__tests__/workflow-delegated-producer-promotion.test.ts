import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, issueWorkProducts,
  missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workProductService } from "../services/work-products.js";
import { selectOfficialWorkProduct } from "../services/workflow/workproduct-selector.js";
import { promoteDelegatedProducerProvenance } from "../services/workflow/producer-provenance-rebind.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, dir: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("producer-promotion-"); db = createDb(temp.connectionString);
  dir = await mkdtemp(path.join(os.tmpdir(), "producer-promotion-")); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(dir, { recursive: true, force: true }); });

/**
 * [파일 목적 — #323 delegated producer promotion] 소유자 언블록(mission_owner_unblock_source)이
 *   남긴 위임 귀속 workProduct 는 같은 럼 셀렉터가 귀속 파싱 단계에서 확정 거부한다
 *   (workproduct_selector_provenance_missing). 보드 승격은 (1) 승격 전 거부 (2) 서비스가
 *   합성 강한 귀속 + 승격 마커 + 원본 위임 기록 보존 + 권한 이벤트를 남기고 (3) 셀렉터가
 *   승격 산출물을 수용하며 세대 진행에도 유효하고 (4) 바이트 변조 시 재거부하며 (5) 멱등하고
 *   (6) 위임이 아닌 산출물·스코프 불일치를 거부함을 검증한다.
 */
async function fixture() {
  const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID();
  const sourceIssueId = randomUUID(), unblockIssueId = randomUUID(), workflowId = randomUUID();
  const runId = randomUUID(), stepId = randomUUID();
  const delegatedHeartbeatId = randomUUID(), originalHeartbeatId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Promotion", issuePrefix: companyId.slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner" });
  await db.insert(missions).values({ id: missionId, companyId, title: "Promotion", ownerAgentId: agentId, status: "active" });
  await db.insert(issues).values([
    { id: sourceIssueId, companyId, missionId, title: "Build" },
    { id: unblockIssueId, companyId, missionId, title: "[Unblock] Build" },
  ]);
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Promotion", stepsJson: [] });
  await db.insert(workflowRuns).values({ id: runId, companyId, missionId, workflowId, triggeredBy: "board" });
  await db.insert(workflowStepRuns).values({ id: stepId, workflowRunId: runId, stepId: "build", issueId: sourceIssueId,
    status: "completed", executionGeneration: 3, startedAt: new Date("2026-01-01") });
  // 위임 생산 하트비트(소유자의 언블록 실행 — 생산자 stepRun 이 아닌 위임 이슈에 연결)와
  // 원래 실패한 생산 시도 하트비트(감사용)를 재현한다.
  await db.insert(heartbeatRuns).values([
    { id: delegatedHeartbeatId, companyId, agentId, issueId: unblockIssueId, status: "succeeded", startedAt: new Date("2026-01-01T02:00:00Z") },
    { id: originalHeartbeatId, companyId, agentId, issueId: sourceIssueId, workflowStepRunId: stepId,
      workflowExecutionGeneration: 0, status: "failed", startedAt: new Date("2026-01-01T01:00:00Z") },
  ]);
  const file = path.join(dir, `${sourceIssueId}.json`); await writeFile(file, "{}");
  // 실제 위임 등록은 언블록 사슬(위임 API)을 통해 일어나므로, 테스트는 라이브 행 상태를
  // 그대로 재현한다: createdByRunId = 위임 하트비트, 귀속 = 위임 기록.
  const product = await workProductService(db).createForIssue(sourceIssueId, companyId, { provider: "local_file",
    type: "document", title: "content.json", status: "active", metadata: { path: file } });
  const delegated = {
    schemaVersion: "workflow.delegated-work-product-producer.v1" as const,
    kind: "mission_owner_unblock_source" as const,
    companyId, missionId, sourceIssueId, delegatedFromIssueId: unblockIssueId,
    heartbeatRunId: delegatedHeartbeatId, executionGeneration: null,
  };
  const [row] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id));
  await db.update(issueWorkProducts).set({ createdByRunId: delegatedHeartbeatId,
    metadata: { ...row!.metadata, workflowProducer: delegated } })
    .where(eq(issueWorkProducts.id, product!.id));
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, runId));
  const select = () => selectOfficialWorkProduct(db, { companyId, workflowRunId: runId, stepId: "build",
    selector: { type: "document", title: "content.json" } });
  const promote = () => promoteDelegatedProducerProvenance(db, { companyId, workflowRunId: runId, producerStepId: "build",
    productId: product!.id, actor: { actorType: "board", actorId: "local-board" } });
  const readProduct = async () => (await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id)))[0]!;
  const promoteEvents = async () => (await db.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.workflowRunId, runId)))
    .filter((event) => event.reason === "board_delegated_producer_promotion");
  return { companyId, missionId, sourceIssueId, unblockIssueId, runId, stepId, delegatedHeartbeatId,
    product, delegated, select, promote, readProduct, promoteEvents, file };
}

it("selector fences the delegated product before promotion", async () => {
  const f = await fixture();
  await expect(f.select()).rejects.toThrow("workproduct_selector_provenance_missing");
});

it("promotion synthesizes strong provenance, preserves the delegated origin, and records authority", async () => {
  const f = await fixture();
  const result = await f.promote();
  expect(result).toMatchObject({ status: "promoted", fromGeneration: 3 });
  const row = await f.readProduct();
  expect(row.metadata!.workflowProducer).toMatchObject({ schemaVersion: "workflow.work-product-producer.v1",
    companyId: f.companyId, missionId: f.missionId, workflowRunId: f.runId, stepRunId: f.stepId,
    stepId: "build", executionGeneration: 3, retryCount: 0, iterationIndex: 0,
    heartbeatRunId: f.delegatedHeartbeatId });
  const marker = row.metadata!.workflowProducerPromotion as Record<string, unknown>;
  expect(marker).toMatchObject({ fromGeneration: 3, promotedAtGeneration: 3, sourceKind: "mission_owner_unblock_source",
    delegatedFromIssueId: f.unblockIssueId, delegatedHeartbeatRunId: f.delegatedHeartbeatId,
    originalAttemptHeartbeatRunId: expect.any(String), reason: "board_delegated_producer_promotion" });
  // 원본 위임 기록은 원문 그대로 보존된다(생산 사실 위조 금지).
  expect(row.metadata!.workflowProducerDelegatedOrigin).toEqual(f.delegated);
  const events = await f.promoteEvents();
  expect(events).toHaveLength(1);
  expect(events[0]!.idempotencyKey).toBe(`producer-delegated-promotion:${f.product!.id}:3`);
});

it("selector accepts the promoted product end-to-end", async () => {
  const f = await fixture();
  await f.promote();
  const selected = await f.select();
  expect(selected.product.id).toBe(f.product!.id);
  expect(selected.producer.executionGeneration).toBe(3);
});

it("selector keeps accepting the promoted product after further generation advances (rerun/recovery)", async () => {
  const f = await fixture();
  await f.promote();
  await db.update(workflowStepRuns).set({ executionGeneration: 5 }).where(eq(workflowStepRuns.id, f.stepId));
  await expect(f.select()).resolves.toMatchObject({ product: { id: f.product!.id } });
  await db.update(workflowStepRuns).set({ executionGeneration: 9 }).where(eq(workflowStepRuns.id, f.stepId));
  await expect(f.select()).resolves.toMatchObject({ product: { id: f.product!.id } });
});

it("selector re-verifies promoted bytes on every consumption", async () => {
  const f = await fixture();
  await f.promote();
  await writeFile(f.file, "{\"tampered\":true}");
  await expect(f.select()).rejects.toThrow("workproduct_selector_promotion_bytes_mismatch");
  await writeFile(f.file, "{}");
  await expect(f.select()).resolves.toMatchObject({ product: { id: f.product!.id } });
});

it("second promotion is idempotent and writes no duplicate authority transition", async () => {
  const f = await fixture();
  await f.promote();
  await db.update(workflowStepRuns).set({ executionGeneration: 4 }).where(eq(workflowStepRuns.id, f.stepId));
  await expect(f.promote()).resolves.toMatchObject({ status: "already_promoted", fromGeneration: 3 });
  expect(await f.promoteEvents()).toHaveLength(1);
});

it("refuses a product whose provenance is not delegated", async () => {
  const f = await fixture();
  const row = await f.readProduct();
  const { workflowProducer: _delegated, ...rest } = row.metadata!;
  await db.update(issueWorkProducts).set({ metadata: rest }).where(eq(issueWorkProducts.id, row.id));
  await expect(f.promote()).rejects.toThrow("producer_promotion_not_delegated");
});

it("refuses a delegated record whose scope does not match the producer step", async () => {
  const f = await fixture();
  const row = await f.readProduct();
  await db.update(issueWorkProducts).set({ metadata: { ...row.metadata!,
    workflowProducer: { ...f.delegated, sourceIssueId: randomUUID() } } }).where(eq(issueWorkProducts.id, row.id));
  await expect(f.promote()).rejects.toThrow("producer_promotion_delegated_scope_mismatch");
});

it("refuses an active (non-failed) run", async () => {
  const f = await fixture();
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  await expect(f.promote()).rejects.toThrow("producer_rebind_run_not_failed");
});

it("refuses an unlinked delegated heartbeat", async () => {
  const f = await fixture();
  // 위임 하트비트가 다른 이슈에 연결돼 있으면 위임 기록과 정합하지 않다(FK 유효한 이슈로 변경).
  await db.update(heartbeatRuns).set({ issueId: f.sourceIssueId }).where(eq(heartbeatRuns.id, f.delegatedHeartbeatId));
  await expect(f.promote()).rejects.toThrow("producer_promotion_heartbeat_unlinked");
});
