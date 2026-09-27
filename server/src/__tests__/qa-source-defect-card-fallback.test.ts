// server/src/__tests__/qa-source-defect-card-fallback.test.ts
//
// [purpose] [fail-closed] source-only findings 라우팅에서 오너 카드 확보에 실패하면(conflict 등)
//   에스컬레이션을 성공으로 취급하지 않고 기존 재작업 경로로 폴백하는지 검증.
//   버그: 이전까지 escalateQaSourceDefectToOwner 가 ensureQaSourceDefectOwnerCard 결과를 무시하고
//   항상 true 를 반환 — 카드 없이 재작업도 없이 런이 방치될 수 있었다.

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  operatorDecisions,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { applyBackEdgeReworkPass } from "../services/workflow/control-flow/loop-driver.js";
import { ensureQaSourceDefectOwnerCard } from "../services/workflow/qa-source-defect-owner-card.js";
import {
  FINDINGS_SOURCE_ONLY,
  seedQaSourceDefectScenario,
} from "./helpers/qa-source-defect-seed.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip qa-source-defect card fallback tests: ${support.reason ?? "unsupported"}`);

describeDb("qa source-defect escalation fail-closed (card secure failure)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-src-defect-fb-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("card conflict (same requestKey, different generation content) falls back to producer rework — run is never abandoned", async () => {
    const seed = await seedQaSourceDefectScenario(db, FINDINGS_SOURCE_ONLY);

    // 동일 requestKey 에 '다른 세대 콘텐츠'(다른 findings) 카드를 선생성 — 이후 ensure 는
    //   requestHash 가 달라 conflict 로 실패한다(자연 DB 수준 실패 시뮬레이션).
    const preexisting = await ensureQaSourceDefectOwnerCard({
      db,
      companyId: seed.companyId,
      missionId: seed.missionId,
      workflowRunId: seed.runId,
      producerStepId: "produce",
      iteration: 0,
      maxIterations: 2,
      findings: [{ id: "stale-finding", summary: "content from another generation", layer: "source_data" }],
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }],
      linkIssueId: seed.oversightIssueId,
    });
    expect(preexisting.outcome).toBe("created");

    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, seed.runId));
    const predsByStepId = new Map([
      ["qa-validate", { status: "failed" as const, isQaGate: true, verdict: "request_changes" as const }],
    ]);

    const result = await applyBackEdgeReworkPass({
      db,
      run: { id: seed.runId, companyId: seed.companyId, status: "running", missionId: seed.missionId },
      steps: seed.steps as Parameters<typeof applyBackEdgeReworkPass>[0]["steps"],
      stepRuns,
      predsByStepId,
    });

    // 폴백: 카드 확보 실패 → 리셋 스킵 않음. producer 재작업으로 진입(iteration 소모 정상).
    expect(result.reworkedCount).toBe(1);
    const [producer] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "produce")));
    expect(producer.status).toBe("pending");
    expect(producer.iterationIndex).toBe(1);

    // 카드는 선존재 분쟁 행 1건뿐 — 이번 세대 카드가 새로 생기지 않는다(conflict 기각).
    const cards = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.companyId, seed.companyId));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.requestKey).toBe(seed.requestKey);

    // 라우팅 사실(감사 이벤트)은 여전히 기록된다 — 실패해도 원천이 유지되지 않는 건 아니다.
    const routed = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, seed.runId),
      eq(workflowTransitionEvents.eventType, "qa_source_defect_routed"),
    ));
    expect(routed).toHaveLength(1);
    expect((routed[0]!.payload as Record<string, unknown>).route).toBe("source_only");
  });

  it("card secured (created/replayed) keeps the source_only skip — no producer reset, iteration unchanged", async () => {
    const seed = await seedQaSourceDefectScenario(db, FINDINGS_SOURCE_ONLY);
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, seed.runId));
    const predsByStepId = new Map([
      ["qa-validate", { status: "failed" as const, isQaGate: true, verdict: "request_changes" as const }],
    ]);

    const result = await applyBackEdgeReworkPass({
      db,
      run: { id: seed.runId, companyId: seed.companyId, status: "running", missionId: seed.missionId },
      steps: seed.steps as Parameters<typeof applyBackEdgeReworkPass>[0]["steps"],
      stepRuns,
      predsByStepId,
    });
    expect(result.reworkedCount).toBe(0);
    const [producer] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "produce")));
    expect(producer.status).toBe("completed");
    expect(producer.iterationIndex).toBe(0);
    const [card] = await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, seed.companyId),
      eq(operatorDecisions.requestKey, seed.requestKey),
    ));
    expect(card).toBeDefined();
    expect(card!.status).toBe("pending");
  });
});
