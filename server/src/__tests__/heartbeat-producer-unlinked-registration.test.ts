import { adapter, database, drain, fixture, flag, stopped } from "./helpers/heartbeat-producer-fixture.js";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { heartbeatRuns, workflowStepRuns } from "@paperclipai/db";
import { workProductService } from "../services/work-products.js";

// [2026-10-17 라이브 결함 재현] 스텝과 연결되지 않은 하트비트(assignment, execution_scope_kind NULL,
//   workflow_step_run_id NULL)가 스텝 이슈에 산출물을 등록하면 봉인 없이 등록되고 소비 selector가
//   workproduct_selector_provenance_missing 로 하드 실패했다(2026-09-30 manual-onboarding-publish-* 동일 서명).
//   같은-런 펜스(product.createdByRunId === producer.heartbeatRunId === 연결된 디스패치 하트비트) 때문에
//   미연결 신원의 등록은 사후 어떤 봉인·재바인딩으로도 소비 불가 → 스텝 바인딩 이슈에서는 명시 거부.
async function unlinkedRegistrar(f: Awaited<ReturnType<typeof fixture>>, db: ReturnType<typeof database>) {
  const [row] = await db.insert(heartbeatRuns).values({
    companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
    invocationSource: "assignment", triggerDetail: "system", status: "running",
    startedAt: new Date(), contextSnapshot: { issueId: f.issueId, source: "unlinked_registration_test" },
  }).returning();
  return row!;
}

it("unlinked registration heartbeat is rejected on a step-bound issue even with a provable dispatch heartbeat", async () => {
  await flag(false); // 라이브 실패 서명과 동일한 레거시 클레임(v1 파이널리제이션 OFF)
  const f = await fixture(), db = database();
  // 실제 디스패치: 연결된 하트비트 D가 존재해도(세대·시도증명 재현 가능) 미연결 신원 등록은 거부된다.
  let dispatchRunId = "";
  adapter.mockReset().mockImplementation(async ({ runId }: { runId: string }) => { dispatchRunId = runId; return stopped; });
  await f.wake(); await drain();
  const dispatch = await f.readRun(dispatchRunId);
  expect(dispatch.workflowStepRunId).toBe(f.stepRunId);
  expect(dispatch.workflowExecutionGeneration).toBe(7);

  const registrar = await unlinkedRegistrar(f, db);
  expect(registrar.workflowStepRunId).toBeNull();
  expect(registrar.workflowExecutionGeneration).toBeNull();

  await expect(f.register(registrar.id)).rejects.toThrow("workproduct_producer_unlinked_registration");
  // 거부된 등록은 기록을 남기지 않는다 — 독 기록 원천 차단.
  const products = await workProductService(db).listForIssue(f.issueId);
  expect(products).toHaveLength(0);
});

it("unlinked registration on an issue without step binding stays allowed (no seal, current behavior)", async () => {
  await flag(false);
  const f = await fixture(), db = database();
  adapter.mockReset().mockImplementation(async () => stopped);
  // 스텝 바인딩 제거 — 일반 이슈로 전환. 미연결 신원 등록은 봉인 없이 성공(현행 계약 유지).
  await db.delete(workflowStepRuns).where(eq(workflowStepRuns.id, f.stepRunId));
  const registrar = await unlinkedRegistrar(f, db);
  const product = await f.register(registrar.id);
  expect(product).toBeTruthy();
  expect(product?.metadata?.workflowProducer).toBeUndefined();
});

it("linked registration heartbeat keeps sealing and consuming (regression fence)", async () => {
  await flag(false);
  const f = await fixture(), db = database();
  let dispatchRunId = "";
  adapter.mockReset().mockImplementation(async ({ runId }: { runId: string }) => { dispatchRunId = runId; return stopped; });
  await f.wake(); await drain();
  const dispatch = await f.readRun(dispatchRunId);
  expect(dispatch.workflowStepRunId).toBe(f.stepRunId);

  const product = await f.register(dispatchRunId);
  expect(product?.metadata?.workflowProducer).toMatchObject({
    schemaVersion: "workflow.work-product-producer.v1",
    stepRunId: f.stepRunId, executionGeneration: 7, heartbeatRunId: dispatchRunId,
  });
  await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, f.stepRunId));
  const selected = await f.select();
  expect(selected.product.id).toBe(product!.id);
});
