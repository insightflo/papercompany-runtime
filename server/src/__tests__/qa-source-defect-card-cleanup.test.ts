// server/src/__tests__/qa-source-defect-card-cleanup.test.ts
//
// [purpose] QA 원천 결함 오너 카드의 "상황 해소 시 자동 취소" 검증.
//   pending 카드는 다음 경우 무효가 되어야 자동 cancel 된다(감사 로그 동반):
//   (1) 런이 completed/cancelled 로 종결 — 카드가 묻는 조치가 더 이상 의미 없음.
//   (2) 런이 진행 중이더라도, 카드가 지적한 generation 이후의 생산자 generation 이
//       완료되고 해당 백엣지 QA 전원이 completed(통과) 로 확정된 경우.
//   런이 failed 로 종결된 경우는 카드가 여전히 유효한 에스컬레이션이므로 유지한다.
//   (3) 멱등 — 이미 취소된 카드에 재호출해도 오류 없음.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  missions,
  operatorDecisions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  ensureQaSourceDefectOwnerCard,
  cancelResolvedQaSourceDefectOwnerCards,
} from "../services/workflow/qa-source-defect-owner-card.js";
import type { EdgeBearingStep } from "../services/workflow/control-flow/edge-condition.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip qa-source-defect card cleanup tests: ${support.reason ?? "unsupported host"}`);

type StepRun = typeof workflowStepRuns.$inferSelect;

const FINDINGS = [
  { id: "src-1", summary: "source rows empty", layer: "source_data" as const },
];

function buildSteps(agentId: string): EdgeBearingStep[] {
  return [
    {
      id: "produce",
      dependencies: ["collect"],
      conditionalDependencies: [{ stepId: "qa-validate", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 }],
    } as unknown as EdgeBearingStep,
    { id: "qa-validate", dependencies: ["produce"] } as unknown as EdgeBearingStep,
  ];
}

interface Seed {
  companyId: string;
  runId: string;
  workflowRunId: string;
  cardId: string;
}

async function seed(db: Db, opts: {
  runStatus: string;
  producerIteration: number;
  producerStatus: string;
  qaStatus: string;
  cardIteration: number;
}): Promise<Seed> {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "CleanupCo", issuePrefix: `CC${randomUUID().slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values({ id: agentId, companyId, name: "owner", role: "mission_owner", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "cleanup mission", status: "active" });

  const producerIssue = await db.insert(issues).values({ companyId, missionId, title: "produce", description: "produce", status: "done", assigneeAgentId: agentId }).returning({ id: issues.id });
  const qaIssue = await db.insert(issues).values({ companyId, missionId, title: "qa-validate", description: "qa", status: "done", assigneeAgentId: agentId }).returning({ id: issues.id });

  const wfId = randomUUID();
  const runId = randomUUID();
  await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: `cleanup-wf-${randomUUID().slice(0, 6)}`, stepsJson: buildSteps(agentId) });
  await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, missionId, status: opts.runStatus, triggeredBy: "test" });

  const now = new Date();
  await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: "produce", companyId, issueId: producerIssue[0]!.id,
    status: opts.producerStatus, iterationIndex: opts.producerIteration, completedAt: now,
  });
  await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: "qa-validate", companyId, issueId: qaIssue[0]!.id,
    status: opts.qaStatus, iterationIndex: 0, completedAt: now,
  });

  const card = await ensureQaSourceDefectOwnerCard({
    db,
    companyId,
    missionId,
    workflowRunId: runId,
    producerStepId: "produce",
    iteration: opts.cardIteration,
    maxIterations: 2,
    findings: FINDINGS,
    qaRefs: [{ qaStepId: "qa-validate", qaIssueId: qaIssue[0]!.id }],
    linkIssueId: null,
  });
  if (card.outcome !== "created" && card.outcome !== "replayed") {
    throw new Error(`card seed failed: ${card.outcome} ${"message" in card ? card.message : ""}`);
  }
  return { companyId, runId, workflowRunId: runId, cardId: card.decisionId };
}

async function cardStatus(db: Db, id: string): Promise<string> {
  const [row] = await db.select({ status: operatorDecisions.status }).from(operatorDecisions).where(eq(operatorDecisions.id, id));
  return row?.status ?? "missing";
}

async function stepRunsFor(db: Db, runId: string): Promise<StepRun[]> {
  return db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
}

describeEP("qa source-defect owner card auto-cancel on resolution", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-card-cleanup-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("cancels pending cards when the workflow run completed", async () => {
    const seedRow = await seed(db, { runStatus: "completed", producerIteration: 2, producerStatus: "completed", qaStatus: "completed", cardIteration: 0 });
    const result = await cancelResolvedQaSourceDefectOwnerCards({
      db, companyId: seedRow.companyId, run: { id: seedRow.runId, status: "completed" }, steps: buildSteps("ignored"), stepRuns: await stepRunsFor(db, seedRow.runId),
    });
    expect(result.cancelled).toBe(1);
    expect(await cardStatus(db, seedRow.cardId)).toBe("cancelled");
  });

  it("keeps pending cards when the workflow run failed (owner action still needed)", async () => {
    const seedRow = await seed(db, { runStatus: "failed", producerIteration: 2, producerStatus: "failed", qaStatus: "failed", cardIteration: 2 });
    const result = await cancelResolvedQaSourceDefectOwnerCards({
      db, companyId: seedRow.companyId, run: { id: seedRow.runId, status: "failed" }, steps: buildSteps("ignored"), stepRuns: await stepRunsFor(db, seedRow.runId),
    });
    expect(result.cancelled).toBe(0);
    expect(await cardStatus(db, seedRow.cardId)).toBe("pending");
  });

  it("cancels pending cards when a later producer generation completed and every back-edge QA passed (run still active)", async () => {
    const seedRow = await seed(db, { runStatus: "running", producerIteration: 2, producerStatus: "completed", qaStatus: "completed", cardIteration: 0 });
    const result = await cancelResolvedQaSourceDefectOwnerCards({
      db, companyId: seedRow.companyId, run: { id: seedRow.runId, status: "running" }, steps: buildSteps("ignored"), stepRuns: await stepRunsFor(db, seedRow.runId),
    });
    expect(result.cancelled).toBe(1);
    expect(await cardStatus(db, seedRow.cardId)).toBe("cancelled");
  });

  it("keeps pending cards when the later generation's QA is still failing (a newer rejection may be in flight)", async () => {
    const seedRow = await seed(db, { runStatus: "running", producerIteration: 1, producerStatus: "completed", qaStatus: "failed", cardIteration: 0 });
    const result = await cancelResolvedQaSourceDefectOwnerCards({
      db, companyId: seedRow.companyId, run: { id: seedRow.runId, status: "running" }, steps: buildSteps("ignored"), stepRuns: await stepRunsFor(db, seedRow.runId),
    });
    expect(result.cancelled).toBe(0);
    expect(await cardStatus(db, seedRow.cardId)).toBe("pending");
  });

  it("is idempotent — a second cleanup call does not error or resurrect", async () => {
    const seedRow = await seed(db, { runStatus: "completed", producerIteration: 1, producerStatus: "completed", qaStatus: "completed", cardIteration: 1 });
    for (let i = 0; i < 2; i += 1) {
      await cancelResolvedQaSourceDefectOwnerCards({
        db, companyId: seedRow.companyId, run: { id: seedRow.runId, status: "completed" }, steps: buildSteps("ignored"), stepRuns: await stepRunsFor(db, seedRow.runId),
      });
    }
    expect(await cardStatus(db, seedRow.cardId)).toBe("cancelled");
  });
});
