// server/src/__tests__/qa-layer-recurrence-routing.test.ts
//
// [purpose] Verify recurrence stays diagnostic while official source findings retain bounded routing.

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
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
import { FINDINGS_MIXED, FINDINGS_SOURCE_ONLY, seedQaSourceDefectScenario } from "./helpers/qa-source-defect-seed.js";

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

describeDb("qa layer feedback loop — cause-preserving recurrence routing", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-recurrence-route-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("recurring artifact keeps its cause, reworks within cap, and does not create a source card", async () => {
    const seed = await seedQaSourceDefectScenario(db, [RECURRING_ARTIFACT], { priorFindings: [RECURRING_ARTIFACT] });

    const result = await runBackEdgePass(db, seed);
    expect(result.reworkedCount).toBe(1);

    const producer = await loadProducer(db, seed.runId);
    expect(producer.status).toBe("pending");
    expect(producer.iterationIndex).toBe(1);
    expect(producer.metadata ?? {}).not.toHaveProperty("qaReworkCapBoost");

    const routed = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, seed.runId),
      eq(workflowTransitionEvents.eventType, "qa_source_defect_routed"),
    ));
    expect(routed).toHaveLength(0);
    expect(await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, seed.companyId),
      eq(operatorDecisions.requestKey, seed.requestKey),
    ))).toHaveLength(0);

    const stepRunIds = (await db.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, seed.runId))).map((row) => row.id);
    const wakeupsBefore = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, seed.runId));
    expect((await runBackEdgePass(db, seed)).reworkedCount).toBe(0);
    expect((await loadProducer(db, seed.runId)).iterationIndex).toBe(1);
    expect((await db.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, seed.runId))).map((row) => row.id)).toEqual(stepRunIds);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, seed.runId))).toEqual(wakeupsBefore);
  });

  it("a recurring finding in a mixed artifact set does not become source scope", async () => {
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
    expect(routed).toHaveLength(0);
    expect(await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, seed.companyId),
      eq(operatorDecisions.requestKey, seed.requestKey),
    ))).toHaveLength(0);

    const metadata = (producer.metadata ?? {}) as Record<string, unknown>;
    const contract = metadata.workflowReworkContract as { qaFeedbacks: Array<{ feedback: string | null }> } | undefined;
    expect(contract).toBeDefined();
    const feedback = contract!.qaFeedbacks[0]!.feedback ?? "";
    expect(feedback).not.toContain("생산자 범위 밖(재발 승격)");
    expect(feedback).not.toContain("[source_data]");
  });

  it("non-recurrence (id mismatch) artifact-only → rework only: reset 1, NO card, NO routing event", async () => {
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

    // Without an explicitly declared source_data finding, artifact-only QA uses the existing rework path.
    const routed = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, seed.runId),
      eq(workflowTransitionEvents.eventType, "qa_source_defect_routed"),
    ));
    expect(routed).toHaveLength(0);

    const cards = await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, seed.companyId),
      eq(operatorDecisions.requestKey, seed.requestKey),
    ));
    expect(cards).toHaveLength(0);

    const metadata = (producer.metadata ?? {}) as Record<string, unknown>;
    const contract = metadata.workflowReworkContract as { qaFeedbacks: Array<{ feedback: string | null }> } | undefined;
    const feedback = contract!.qaFeedbacks[0]!.feedback ?? "";
    expect(feedback).not.toContain("생산자 범위 밖");
  });

  it("explicit source findings retain bounded source-only routing and a neutral, idempotent card", async () => {
    const seed = await seedQaSourceDefectScenario(db, FINDINGS_SOURCE_ONLY);
    const result = await runBackEdgePass(db, seed);
    expect(result.reworkedCount).toBe(0);
    const producer = await loadProducer(db, seed.runId);
    expect(producer.status).toBe("completed");
    expect(producer.iterationIndex).toBe(0);

    const routed = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, seed.runId),
      eq(workflowTransitionEvents.eventType, "qa_source_defect_routed"),
    ));
    expect(routed).toHaveLength(1);
    expect(routed[0]!.payload).toMatchObject({ route: "source_only", findings: FINDINGS_SOURCE_ONLY, promotedFindingIds: [] });

    const [card] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.requestKey, seed.requestKey));
    expect(card).toBeDefined();
    expect(card!.definition.options.map(({ id }) => id)).toEqual([
      "rerun_source_collection", "extra_producer_rework", "maintenance_issue", "replan_mission", "cancel",
    ]);
    expect(card!.definition.options.every((option) => !option.recommended)).toBe(true);
    expect(card!.definition.humanReview!.recommendedNextStep).not.toContain("rerun_source_collection");
    expect(card!.definition.humanReview!.recommendedNextStep).not.toContain("recommended");

    const input = {
      db, companyId: seed.companyId, missionId: seed.missionId, workflowRunId: seed.runId,
      producerStepId: "produce", iteration: 0, maxIterations: 2, findings: FINDINGS_SOURCE_ONLY,
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }], linkIssueId: seed.oversightIssueId,
    };
    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, seed.runId));
    const replay = await ensureQaSourceDefectOwnerCard(input);
    expect(replay).toMatchObject({ outcome: "replayed", decisionId: card!.id });
    expect((await runBackEdgePass(db, seed)).reworkedCount).toBe(0);
    expect(await db.select().from(operatorDecisions).where(eq(operatorDecisions.requestKey, seed.requestKey))).toHaveLength(1);
    expect(await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, seed.runId),
      eq(workflowTransitionEvents.eventType, "qa_source_defect_routed"),
    ))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, seed.runId))).toEqual(wakeups);
  });

  it("explicit mixed findings retain the source cause without recommending broad collection", async () => {
    const seed = await seedQaSourceDefectScenario(db, FINDINGS_MIXED);
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
    expect(routed[0]!.payload).toMatchObject({ route: "mixed", findings: FINDINGS_MIXED, promotedFindingIds: [] });
    const [card] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.requestKey, seed.requestKey));
    expect(card).toBeDefined();
    const collection = card!.definition.options.find(({ id }) => id === "rerun_source_collection");
    expect(collection).toBeDefined();
    expect(collection!.recommended).toBeUndefined();
    expect(card!.definition.options.map(({ id }) => id)).toEqual([
      "rerun_source_collection", "extra_producer_rework", "maintenance_issue", "replan_mission", "cancel",
    ]);
    const metadata = (producer.metadata ?? {}) as Record<string, unknown>;
    const contract = metadata.workflowReworkContract as { qaFeedbacks: Array<{ feedback: string | null }> } | undefined;
    expect(contract!.qaFeedbacks[0]!.feedback).toContain("생산자 범위 밖 — 원천 데이터 결함");
    expect(contract!.qaFeedbacks[0]!.feedback).not.toContain("재발 승격");
  });

  it("recurrence does not create work or bypass an exhausted producer cap", async () => {
    const seed = await seedQaSourceDefectScenario(db, [RECURRING_ARTIFACT], { priorFindings: [RECURRING_ARTIFACT] });
    await db.update(workflowStepRuns).set({ iterationIndex: 2 }).where(and(
      eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "produce"),
    ));
    const result = await runBackEdgePass(db, seed);
    const producer = await loadProducer(db, seed.runId);
    expect(result.reworkedCount).toBe(0);
    expect(producer.status).toBe("completed");
    expect(producer.iterationIndex).toBe(2);
    expect(producer.metadata).not.toHaveProperty("qaReworkCapBoost");
    expect(await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, seed.runId),
      eq(workflowTransitionEvents.eventType, "qa_source_defect_routed"),
    ))).toHaveLength(0);
    expect(await db.select().from(operatorDecisions).where(eq(operatorDecisions.requestKey, seed.requestKey))).toHaveLength(0);
  });

  it("card replay keeps the recurring artifact cause and never recommends source collection", async () => {
    const seed = await seedQaSourceDefectScenario(db, [RECURRING_ARTIFACT], { priorFindings: [RECURRING_ARTIFACT] });
    const base = {
      db,
      companyId: seed.companyId,
      missionId: seed.missionId,
      workflowRunId: seed.runId,
      producerStepId: "produce",
      iteration: 0,
      maxIterations: 2,
      // Both creation paths use declared findings and the same diagnostic recurrence lookup.
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
    expect(rendered).toContain("[artifact] (kr-index-missing)");
    expect(rendered).not.toContain("[source_data*]");
    expect(card!.definition.options.find(({ id }) => id === "rerun_source_collection")?.recommended).toBeUndefined();
    expect(rendered).toMatch(/declared cause unchanged|선언 원인 유지/);
  });
});
