// server/src/__tests__/qa-source-defect-owner-card-integration.test.ts
//
// [purpose] QA 반려 결함 계층(source_data/artifact) 라우팅 + 오너 인터랙티브 카드 통합 검증.
//   (a) findings 전부 source_data → 생산자 리셋 안 함(iteration 불변) + operator_decisions 행 생성.
//   (b) findings 혼합(artifact 포함) → 기존 재작업 경로(리셋) + 카드 생성 + 재작업 계약에 '생산자 범위 밖' 병기.
//   (c) findings 없음(구버전 판정) → 기존 동작(리셋, 카드 없음).
//   (d) 카드 해결 → 기존 continuation 워커 입력(operator_decision_continuations) 생성.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  operatorDecisionContinuations,
  operatorDecisions,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { applyBackEdgeReworkPass } from "../services/workflow/control-flow/loop-driver.js";
import {
  ensureQaSourceDefectOwnerCard,
} from "../services/workflow/qa-source-defect-owner-card.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import {
  FINDINGS_MIXED,
  FINDINGS_SOURCE_ONLY,
  seedQaSourceDefectScenario as seedScenario,
} from "./helpers/qa-source-defect-seed.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip qa-source-defect owner card tests: ${support.reason ?? "unsupported"}`);

describeDb("qa source-defect layer routing + owner card", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-src-defect-card-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("(a) all-source_data findings: producer NOT reset, iteration unchanged, owner card created", async () => {
    const seed = await seedScenario(db, FINDINGS_SOURCE_ONLY);
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

    // Producer untouched — no reset, no cap consumption.
    const [producer] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "produce")));
    expect(producer.status).toBe("completed");
    expect(producer.iterationIndex).toBe(0);

    // Durable routing evidence event.
    const routed = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, seed.runId),
      eq(workflowTransitionEvents.eventType, "qa_source_defect_routed"),
    ));
    expect(routed).toHaveLength(1);
    expect((routed[0]!.payload as Record<string, unknown>).cardRequestKey).toBe(seed.requestKey);

    // Owner card: single_select, continuation to the owner-assigned oversight issue, human review packet present.
    const [card] = await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, seed.companyId),
      eq(operatorDecisions.requestKey, seed.requestKey),
    ));
    expect(card).toBeDefined();
    expect(card!.status).toBe("pending");
    expect(card!.interactionType).toBe("single_select");
    expect(card!.continuationMode).toBe("issue_current_assignee");
    expect(card!.issueId).toBe(seed.oversightIssueId);
    expect(card!.definition.humanReview).not.toBeNull();
    // The fixture's default company language is English; the caller must load it too.
    expect(card!.title).toBe("Quality review (QA) rejected — source data defects, choose next steps (produce · rework 0/2)");
    expect(card!.definition.humanReview!.decisionSubject).toBe("Choose how to handle the results that did not pass quality review");
    expect(card!.definition.options[0]!.label).toBe("Run data collection again");
    const optionIds = card!.definition.options.map((option) => option.id);
    expect(optionIds).toEqual(["rerun_source_collection", "extra_producer_rework", "maintenance_issue", "replan_mission", "cancel"]);
  });

  it("(b) mixed findings: producer reset (legacy path), card created, rework contract tags source-scope items", async () => {
    const seed = await seedScenario(db, FINDINGS_MIXED);
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
    expect(result.reworkedCount).toBe(1);

    const [producer] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "produce")));
    expect(producer.status).toBe("pending");
    expect(producer.iterationIndex).toBe(1);

    // Mixed path also raises the owner card (same request key space).
    const [card] = await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, seed.companyId),
      eq(operatorDecisions.requestKey, seed.requestKey),
    ));
    expect(card).toBeDefined();

    // Rework contract carries the source-scope annotation for source_data findings.
    const metadata = (producer.metadata ?? {}) as Record<string, unknown>;
    const contract = metadata.workflowReworkContract as { qaFeedbacks: Array<{ feedback: string | null }> } | undefined;
    expect(contract).toBeDefined();
    const feedback = (contract!.qaFeedbacks[0]!.feedback ?? "");
    expect(feedback).toContain("생산자 범위 밖");
    expect(feedback).toContain("kr-index-missing");
    // The artifact finding stays in the plain feedback body (no scope tag needed).
    expect(feedback).toContain("source data incomplete");
  });

  it("(c) no findings (legacy verdict): producer reset, NO card, NO routing event", async () => {
    const seed = await seedScenario(db, null);
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
    expect(result.reworkedCount).toBe(1);

    const [producer] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "produce")));
    expect(producer.status).toBe("pending");

    const cards = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.companyId, seed.companyId));
    expect(cards).toHaveLength(0);
    const routed = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, seed.runId),
      eq(workflowTransitionEvents.eventType, "qa_source_defect_routed"),
    ));
    expect(routed).toHaveLength(0);
  });

  it("(d) resolving the card creates the existing continuation row for the owner-assigned issue", async () => {
    const seed = await seedScenario(db, FINDINGS_SOURCE_ONLY);
    const ensured = await ensureQaSourceDefectOwnerCard({
      db,
      companyId: seed.companyId,
      missionId: seed.missionId,
      workflowRunId: seed.runId,
      producerStepId: "produce",
      iteration: 0,
      maxIterations: 2,
      findings: FINDINGS_SOURCE_ONLY,
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }],
      linkIssueId: seed.oversightIssueId,
    });
    expect(ensured.outcome).toBe("created");

    // requestKey idempotency: a second ensure for the same generation replays (no duplicate card).
    const again = await ensureQaSourceDefectOwnerCard({
      db,
      companyId: seed.companyId,
      missionId: seed.missionId,
      workflowRunId: seed.runId,
      producerStepId: "produce",
      iteration: 0,
      maxIterations: 2,
      findings: FINDINGS_SOURCE_ONLY,
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }],
      linkIssueId: seed.oversightIssueId,
    });
    expect(again.outcome).toBe("replayed");
    expect(again.decisionId).toBe(ensured.decisionId);

    // Resolution → existing continuation chain input (worker wakes the oversight issue assignee).
    const write = operatorDecisionWriteService(db);
    const { decision } = await write.resolve(ensured.decisionId, {
      actionId: "submit",
      selectedOptionIds: ["rerun_source_collection"],
      comment: "collect step must regenerate kr_index",
    }, "test-operator");
    expect(decision.status).toBe("resolved");
    expect(decision.result!.selectedOptionIds).toEqual(["rerun_source_collection"]);

    const [continuation] = await db.select().from(operatorDecisionContinuations)
      .where(eq(operatorDecisionContinuations.operatorDecisionId, ensured.decisionId));
    expect(continuation).toBeDefined();
    expect(continuation!.issueId).toBe(seed.oversightIssueId);
    expect(continuation!.state).toBe("pending");
  });

  it("(e) supersede: a newer iteration replaces earlier pending cards — never duplicate pending cards", async () => {
    const seed = await seedScenario(db, FINDINGS_SOURCE_ONLY);
    const base = {
      db,
      companyId: seed.companyId,
      missionId: seed.missionId,
      workflowRunId: seed.runId,
      producerStepId: "produce",
      maxIterations: 3,
      findings: FINDINGS_SOURCE_ONLY,
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }],
      linkIssueId: seed.oversightIssueId,
    };

    const iter0 = await ensureQaSourceDefectOwnerCard({ ...base, iteration: 0 });
    expect(iter0.outcome).toBe("created");
    const iter1 = await ensureQaSourceDefectOwnerCard({ ...base, iteration: 1 });
    expect(iter1.outcome).toBe("created");

    // The older pending card is superseded (cancelled), only the newest stays pending.
    const cards = await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, seed.companyId),
      eq(operatorDecisions.sourceType, "workflow_qa_rejection"),
    ));
    expect(cards).toHaveLength(2);
    const byIteration = new Map(cards.map((card) => [card.requestKey.split(":").pop(), card.status]));
    expect(byIteration.get("0")).toBe("cancelled");
    expect(byIteration.get("1")).toBe("pending");

    // Replay of the newest iteration must not cancel itself or create a third card.
    const replay = await ensureQaSourceDefectOwnerCard({ ...base, iteration: 1 });
    expect(replay.outcome).toBe("replayed");
    expect(replay.decisionId).toBe(iter1.decisionId);
    const pendingCount = await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, seed.companyId),
      eq(operatorDecisions.sourceType, "workflow_qa_rejection"),
      eq(operatorDecisions.status, "pending"),
    ));
    expect(pendingCount).toHaveLength(1);
  });
});
