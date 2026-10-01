import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
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
  title: string;
}> = [
  { name: "source only", findings: FINDINGS_SOURCE_ONLY, title: "QA 반려 원천 데이터 결함 — 오너 결정 필요 (produce iter 0)" },
  { name: "mixed", findings: FINDINGS_MIXED, title: "QA 반려 원천+산출물 결함 — 오너 결정 필요 (produce iter 0)" },
  { name: "artifact only", findings: [artifact], title: "QA 반려 산출물 결함 — 오너 결정 필요 (produce iter 0)" },
  { name: "empty legacy findings", findings: [], title: "QA 반려 원천 데이터 결함 — 오너 결정 필요 (produce iter 0)" },
  {
    name: "recurring artifact promoted to effective source layer", findings: [artifact], priorFindings: [artifact],
    title: "QA 반려 원천 데이터 결함 — 오너 결정 필요 (produce iter 0)",
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

  it.each(cases)("$name: accurate title, stable identity/options and continuation", async ({ findings, priorFindings, title }) => {
    const seed = await seedQaSourceDefectScenario(db, findings, { priorFindings });
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
    const replay = await ensureQaSourceDefectOwnerCard(input);
    expect(replay).toEqual({ outcome: "replayed", decisionId: created.decisionId });
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
