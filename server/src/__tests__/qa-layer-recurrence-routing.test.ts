// server/src/__tests__/qa-layer-recurrence-routing.test.ts
//
// [purpose] [qa layer feedback loop] 재발(직전 세대와 같은 finding id) 승격의 loop-driver 라우팅 통합 검증.
//   (재발-only) 선언 artifact 지만 직전 세대에 같은 id → 유효 계층 source_data 로 승격되어
//     source_only 경로(생산자 리셋 0 + iteration 불변 + 오너 카드 1장)를 탄다.
//   (혼합 재발) 신규 artifact + 재발 → 기존 재작업 경로(리셋 1) + 카드 1장 + 재작업 feedback 에
//     '생산자 범위 밖(재발 승격)' 태그.
//   (비재발) id 불일치 → 현행 동작과 100% 동일(재작업 + 카드, 태그 없음, 승격 0건).
//   (카드 결정성) 같은 입력으로 두 번 빌드 시 동일 카드(replay) + 재발 마커 [source_data*] 렌더.

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
import { seedQaSourceDefectScenario } from "./helpers/qa-source-defect-seed.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip qa layer recurrence routing tests: ${support.reason ?? "unsupported"}`);

const RECURRING_ARTIFACT = { id: "kr-index-missing", summary: "kr_index artifact absent from collect step", layer: "artifact" as const };
const NEW_ARTIFACT = { id: "mobile-overflow", summary: "report table overflows on mobile", layer: "artifact" as const };

async function runBackEdgePass(
  db: ReturnType<typeof createDb>,
  seed: Awaited<ReturnType<typeof seedQaSourceDefectScenario>>,
) {
  const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, seed.runId));
  return applyBackEdgeReworkPass({
    db,
    run: { id: seed.runId, companyId: seed.companyId, status: "running", missionId: seed.missionId },
    steps: seed.steps as Parameters<typeof applyBackEdgeReworkPass>[0]["steps"],
    stepRuns,
    predsByStepId: new Map([
      ["qa-validate", { status: "failed" as const, isQaGate: true, verdict: "request_changes" as const }],
    ]),
  });
}

async function loadProducer(db: ReturnType<typeof createDb>, runId: string) {
  const [producer] = await db.select().from(workflowStepRuns)
    .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, "produce")));
  return producer!;
}

describeDb("qa layer feedback loop — recurrence promotion routing", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-recurrence-route-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("recurrence-only (declared artifact, same id as prior generation) → source_only: no reset, iteration unchanged, 1 owner card", async () => {
    const seed = await seedQaSourceDefectScenario(db, [RECURRING_ARTIFACT], { priorFindings: [RECURRING_ARTIFACT] });

    const result = await runBackEdgePass(db, seed);
    expect(result.reworkedCount).toBe(0);

    const producer = await loadProducer(db, seed.runId);
    expect(producer.status).toBe("completed");
    expect(producer.iterationIndex).toBe(0); // 한도 미소모

    const routed = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, seed.runId),
      eq(workflowTransitionEvents.eventType, "qa_source_defect_routed"),
    ));
    expect(routed).toHaveLength(1);
    const routedPayload = routed[0]!.payload as Record<string, unknown>;
    expect(routedPayload.route).toBe("source_only");
    expect(routedPayload.promotedFindingIds).toEqual(["kr-index-missing"]);
    // 라우팅 이벤트의 findings 는 선언 계층 원본 그대로(불변 — 설계 §4.4).
    expect(routedPayload.findings).toEqual([RECURRING_ARTIFACT]);

    // 카드 1장 — 유효 계층(승격) 기준으로 렌더: 재발 마커 [source_data*] + 재발 승격 fact.
    const [card] = await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, seed.companyId),
      eq(operatorDecisions.requestKey, seed.requestKey),
    ));
    expect(card).toBeDefined();
    const rendered = JSON.stringify(card!.definition);
    expect(rendered).toContain("[source_data*] (kr-index-missing)");
    expect(rendered).not.toContain("[artifact] (kr-index-missing)");
    expect(rendered).toContain("All findings concern source data (collection stage) — 1 recurring finding (repeated from the previous rejection)");
  });

  it("mixed recurrence (new artifact + recurring) → reset 1 + card 1 + rework feedback tags '생산자 범위 밖(재발 승격)'", async () => {
    const seed = await seedQaSourceDefectScenario(
      db,
      [RECURRING_ARTIFACT, NEW_ARTIFACT],
      { priorFindings: [RECURRING_ARTIFACT] },
    );

    const result = await runBackEdgePass(db, seed);
    expect(result.reworkedCount).toBe(1);

    const producer = await loadProducer(db, seed.runId);
    expect(producer.status).toBe("pending");
    expect(producer.iterationIndex).toBe(1);

    const routed = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, seed.runId),
      eq(workflowTransitionEvents.eventType, "qa_source_defect_routed"),
    ));
    expect(routed).toHaveLength(1);
    const routedPayload = routed[0]!.payload as Record<string, unknown>;
    expect(routedPayload.route).toBe("mixed");
    expect(routedPayload.promotedFindingIds).toEqual(["kr-index-missing"]);

    const [card] = await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, seed.companyId),
      eq(operatorDecisions.requestKey, seed.requestKey),
    ));
    expect(card).toBeDefined();

    // 재작업 계약 feedback: 재발 승격 항목이 '생산자 범위 밖(재발 승격)' 태그로 병기된다(표시 전용).
    const metadata = (producer.metadata ?? {}) as Record<string, unknown>;
    const contract = metadata.workflowReworkContract as { qaFeedbacks: Array<{ feedback: string | null }> } | undefined;
    expect(contract).toBeDefined();
    const feedback = contract!.qaFeedbacks[0]!.feedback ?? "";
    expect(feedback).toContain("생산자 범위 밖(재발 승격)");
    expect(feedback).toContain("(kr-index-missing)");
    // 신규 artifact 항목은 태그 대상이 아니다.
    expect(feedback).not.toContain("(mobile-overflow)");
  });

  it("non-recurrence (id mismatch) → current behavior 100%: reset 1 + card, no promotion, no source-scope tag", async () => {
    const seed = await seedQaSourceDefectScenario(
      db,
      [NEW_ARTIFACT],
      { priorFindings: [RECURRING_ARTIFACT] }, // id 불일치 — 재발 아님
    );

    const result = await runBackEdgePass(db, seed);
    expect(result.reworkedCount).toBe(1);

    const producer = await loadProducer(db, seed.runId);
    expect(producer.status).toBe("pending");
    expect(producer.iterationIndex).toBe(1);

    const routed = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, seed.runId),
      eq(workflowTransitionEvents.eventType, "qa_source_defect_routed"),
    ));
    expect(routed).toHaveLength(1);
    const routedPayload = routed[0]!.payload as Record<string, unknown>;
    expect(routedPayload.route).toBe("mixed");
    expect(routedPayload.promotedFindingIds).toEqual([]);

    const [card] = await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, seed.companyId),
      eq(operatorDecisions.requestKey, seed.requestKey),
    ));
    expect(card).toBeDefined();
    // 승격 없음 — 마커/재발 팩트 미출현, 선언 계층 그대로 렌더.
    const rendered = JSON.stringify(card!.definition);
    expect(rendered).toContain("[artifact] (mobile-overflow)");
    expect(rendered).not.toContain("[source_data"); // [source_data] / [source_data*] 배지 미출현
    expect(rendered).not.toContain("recurring finding");

    const metadata = (producer.metadata ?? {}) as Record<string, unknown>;
    const contract = metadata.workflowReworkContract as { qaFeedbacks: Array<{ feedback: string | null }> } | undefined;
    const feedback = contract!.qaFeedbacks[0]!.feedback ?? "";
    expect(feedback).not.toContain("생산자 범위 밖");
  });

  it("card determinism: two ensures with the same declared findings replay the same decision (recurrence markers included)", async () => {
    const seed = await seedQaSourceDefectScenario(db, [RECURRING_ARTIFACT], { priorFindings: [RECURRING_ARTIFACT] });
    const base = {
      db,
      companyId: seed.companyId,
      missionId: seed.missionId,
      workflowRunId: seed.runId,
      producerStepId: "produce",
      iteration: 0,
      maxIterations: 2,
      // 두 생성 지점((a) loop-driver, (b) supervision) 모두 선언 findings 만 넘긴다 —
      // 승격 계산은 ensure 내부 빌더 입력 직전 1회 수행되므로 같은 입력 → 같은 requestHash.
      findings: [RECURRING_ARTIFACT],
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }],
      linkIssueId: seed.oversightIssueId,
    };

    const first = await ensureQaSourceDefectOwnerCard(base);
    expect(first.outcome).toBe("created");
    const second = await ensureQaSourceDefectOwnerCard(base);
    expect(second.outcome).toBe("replayed");
    expect(second.decisionId).toBe(first.decisionId);

    const [card] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, first.decisionId));
    const rendered = JSON.stringify(card!.definition);
    expect(rendered).toContain("[source_data*] (kr-index-missing)");
    expect(rendered).toContain("All findings concern source data (collection stage) — 1 recurring finding (repeated from the previous rejection)");
  });
});
