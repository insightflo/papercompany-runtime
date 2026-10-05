import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { WorkflowVerdictFinding } from "@paperclipai/shared";
import { ensureQaSourceDefectOwnerCard } from "../services/workflow/qa-source-defect-owner-card.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { FINDINGS_MIXED, FINDINGS_SOURCE_ONLY, seedQaSourceDefectScenario } from "./helpers/qa-source-defect-seed.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip QA card title tests: ${support.reason ?? "unsupported"}`);
const artifact: WorkflowVerdictFinding = {
  id: "mobile-overflow", summary: "Report table overflows on mobile", layer: "artifact",
};
const cases: Array<{
  name: string;
  findings: WorkflowVerdictFinding[];
  priorFindings?: WorkflowVerdictFinding[];
  en: string;
  ko: string;
  scopeEn: string;
  scopeKo: string;
}> = [
  { name: "source only", findings: FINDINGS_SOURCE_ONLY, en: "source data", ko: "원천 데이터",
    scopeEn: "All findings concern source data (collection stage)", scopeKo: "전부 원천 데이터(수집 단계) 문제" },
  { name: "mixed", findings: FINDINGS_MIXED, en: "source data + output", ko: "원천 데이터 + 산출물",
    scopeEn: "Mixed: source data + output problems", scopeKo: "혼합: 원천 데이터 + 산출물 문제" },
  { name: "artifact only", findings: [artifact], en: "output", ko: "산출물",
    scopeEn: "All findings concern output problems (production stage)", scopeKo: "전부 산출물(생산 단계) 문제" },
  { name: "empty legacy findings", findings: [], en: "source data", ko: "원천 데이터",
    scopeEn: "Not submitted (legacy review)", scopeKo: "제출 없음(구버전 판정)" },
  {
    name: "recurring artifact promoted to effective source layer", findings: [artifact], priorFindings: [artifact],
    en: "source data", ko: "원천 데이터",
    scopeEn: "All findings concern source data (collection stage) — 1 recurring finding (repeated from the previous rejection)",
    scopeKo: "전부 원천 데이터(수집 단계) 문제 — 같은 사유 재발 1건(직전 반려에서 반복)",
  },
];

describeDb("QA owner card title reflects effective structured finding layers", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-layer-card-title-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it.each(["en", "ko"] as const)("%s: long quoted evidence stays within persisted text limits", async (language) => {
    const summary = "원문 Raw QA evidence: `do not translate`\n".repeat(150);
    const findings: WorkflowVerdictFinding[] = [{ id: "long-finding", summary, layer: "source_data" }];
    const seed = await seedQaSourceDefectScenario(db, findings);
    await db.update(companies).set({ defaultLanguage: language }).where(eq(companies.id, seed.companyId));
    const result = await ensureQaSourceDefectOwnerCard({
      db, companyId: seed.companyId, missionId: seed.missionId, workflowRunId: seed.runId,
      producerStepId: "producer-" + "x".repeat(90), iteration: 0, maxIterations: 2, findings,
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }], linkIssueId: null,
    });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error(`Unexpected card outcome: ${result.outcome}`);
    const [card] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, result.decisionId));
    expect(card!.continuationMode).toBe("none");
    expect(card!.title.length).toBeLessThanOrEqual(200);
    expect(card!.title).toContain("producer-" + "x".repeat(90));
    // The write schema trims a sliced trailing space/newline before persistence.
    expect(card!.description!.length).toBeLessThanOrEqual(4000);
    expect(card!.description!.length).toBeGreaterThan(3900);
    expect(card!.definition.humanReview!.interpretation.length).toBeLessThanOrEqual(4000);
    expect(card!.definition.humanReview!.interpretation.length).toBeGreaterThan(3900);
    expect(card!.definition.humanReview!.evidence[0]!.description).toBe(`- [source_data] (long-finding) ${summary}`.slice(0, 1000).trim());
    for (const option of card!.definition.options) {
      expect(option.facts.every(({ value }) => value.length <= 200)).toBe(true);
      expect(option.facts[2]!.value).toBe(`[source_data] ${summary}`.slice(0, 200).trim());
    }
  });

  it.each(cases.flatMap((testCase) => (["en", "ko"] as const).map((language) => ({ ...testCase, language }))))(
    "$name ($language): company language, raw evidence, stable replay and continuation", async ({ findings, priorFindings, en, ko, scopeEn, scopeKo, language }) => {
    const seed = await seedQaSourceDefectScenario(db, findings, { priorFindings });
    await db.update(companies).set({ defaultLanguage: language }).where(eq(companies.id, seed.companyId));
    const title = language === "ko"
      ? `품질검수(QA) 반려 — ${ko} 결함, 처리 방침 선택 필요 (produce · 재작업 0/2회)`
      : `Quality review (QA) rejected — ${en} defects, choose next steps (produce · rework 0/2)`;
    const input = {
      db, companyId: seed.companyId, missionId: seed.missionId, workflowRunId: seed.runId,
      producerStepId: "produce", iteration: 0, maxIterations: 2, findings,
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }], linkIssueId: seed.oversightIssueId,
    };
    const created = await ensureQaSourceDefectOwnerCard(input);
    expect(created.outcome).toBe("created");
    if (created.outcome !== "created") throw new Error(`Unexpected card outcome: ${created.outcome}`);
    const [card] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, created.decisionId));
    expect(card).toMatchObject({
      title,
      requestKey: `qa-source-defect:${seed.runId}:produce:0`,
      sourceType: "workflow_qa_rejection", sourceId: `${seed.runId}:produce:0`,
      sourceContext: { missionId: seed.missionId, workflowRunId: seed.runId },
      issueId: seed.oversightIssueId, continuationMode: "issue_current_assignee", interactionType: "single_select",
    });
    expect(card!.definition.options.map(({ id }) => id)).toEqual([
      "rerun_source_collection", "extra_producer_rework", "maintenance_issue", "replan_mission", "cancel",
    ]);
    expect(card!.definition.humanReview!.decisionSubject).toBe(language === "ko"
      ? "품질검수를 통과하지 못한 결과물의 처리 방침을 정해 주세요"
      : "Choose how to handle the results that did not pass quality review");
    expect(card!.definition.options.map(({ label }) => label)).toEqual(language === "ko"
      ? ["자료 수집 다시 실행", "생산자 재작업 1회 더 허용", "유지보수 업무로 넘기기", "미션 재계획", "조치 없이 닫기"]
      : ["Run data collection again", "Allow one more producer rework", "Hand off to maintenance", "Replan the mission", "Close without action"]);
    expect(card!.definition.actions.map(({ id, outcome, requiresSelection }) => ({ id, outcome, requiresSelection }))).toEqual([
      { id: "submit", outcome: "submit", requiresSelection: true },
      { id: "dismiss", outcome: "hold", requiresSelection: false },
    ]);
    for (const finding of findings) {
      const badge = priorFindings ? "source_data*" : finding.layer;
      const rawLine = `- [${badge}] (${finding.id}) ${finding.summary}`;
      expect(card!.description).toContain(rawLine);
      expect(card!.definition.humanReview!.interpretation).toContain(rawLine);
      expect(card!.definition.humanReview!.evidence[0]!.description).toContain(rawLine);
      expect(card!.definition.options[0]!.facts).toContainEqual({
        label: `${language === "ko" ? "결함" : "Finding"} ${finding.id}`,
        value: `[${badge}] ${finding.summary}`, status: "known",
      });
    }
    for (const option of card!.definition.options) {
      expect(option.facts[0]!.value).toBe(language === "ko" ? scopeKo : scopeEn);
    }
    if (findings.length === 0) {
      const review = card!.definition.humanReview!;
      expect(review.interpretation.split("\n").slice(0, 2)).toEqual(language === "ko" ? [
        "품질검수(QA)의 결함 항목(findings)이 제출되지 않았습니다(구버전 판정).",
        "결함 범위는 확인되지 않았습니다. 처리 방침을 선택하기 전에 품질검수 업무와 관련 증거를 살펴 원천 데이터 문제인지 산출물 문제인지 확인해 주세요.",
      ] : [
        "Quality review (QA) findings were not submitted (legacy review).",
        "The defect scope is unknown. Inspect the quality review task and related evidence to determine whether the problem concerns source data or output before choosing an action.",
      ]);
      expect(review.questions).toEqual([language === "ko"
        ? "처리 방침을 선택하기 전에 품질검수 업무와 관련 증거를 살펴 결함 범위를 확인할 수 있을까요?"
        : "Can you inspect the quality review task and related evidence to confirm the defect scope before choosing an action?"]);
      expect(review.recommendedNextStep).toBe(language === "ko"
        ? "먼저 품질검수 업무와 관련 증거를 살펴 결함 범위를 확인한 뒤 처리 방침을 선택해 주세요."
        : "First inspect the quality review task and related evidence to confirm the defect scope, then choose an action.");
      for (const option of card!.definition.options) {
        expect(option.facts[1]!.value).toBe(language === "ko" ? "사용 0/2회" : "Used 0/2");
      }
    }
    expect(card!.description).toContain(`- QA step \`qa-validate\` (issue ${seed.qaIssueId})`);
    if (priorFindings) expect(card!.definition.options[0]!.facts[0]!.value).toContain(language === "ko"
      ? "같은 사유 재발 1건(직전 반려에서 반복)" : "1 recurring finding (repeated from the previous rejection)");
    const hash = card!.requestHash;
    const replay = await ensureQaSourceDefectOwnerCard(input);
    expect(replay).toEqual({ outcome: "replayed", decisionId: created.decisionId });
    const [replayedCard] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, created.decisionId));
    expect(replayedCard!.requestHash).toBe(hash);
    expect(await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, seed.companyId))).toHaveLength(1);

    await operatorDecisionWriteService(db).resolve(created.decisionId, {
      actionId: "submit", selectedOptionIds: ["extra_producer_rework"], comment: null,
    }, "title-test-board");
    const continuations = await db.select().from(operatorDecisionContinuations)
      .where(eq(operatorDecisionContinuations.operatorDecisionId, created.decisionId));
    expect(continuations).toHaveLength(1);
    expect(continuations[0]).toMatchObject({ companyId: seed.companyId, issueId: seed.oversightIssueId, state: "pending" });
  });
});
