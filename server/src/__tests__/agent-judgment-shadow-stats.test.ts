import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  judgmentCalls,
  judgmentDefinitions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import type { JudgmentAnswer, JudgmentDefinitionSnapshot } from "@paperclipai/shared";
import { AGENT_JUDGMENT_DEFINITION_NAME } from "../services/judgment/agent-judgment-tool.js";
import { AGENT_JUDGMENT_SHADOW_DEFINITION_NAME } from "../services/judgment/agent-judgment-shadow.js";
import {
  JEV_QA_STEP_ID,
  JEV_VALIDATOR_STEP_ID,
  computeAgentJudgmentShadowStats,
  computeAgentShadowGroundTruth,
  normalizeStepRunStatus,
} from "../services/judgment/agent-judgment-shadow-stats.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping agent-judgment shadow stats tests: ${support.reason ?? "unsupported"}`);
}

describe("computeAgentShadowGroundTruth — 순수 분기(DB 도메인)", () => {
  it("validator 행 없음 → unknown", () => {
    expect(computeAgentShadowGroundTruth(null, null)).toBe("unknown");
  });

  it("validator 미종결(skipped/pending/running/미지정 값) → unknown(qa 와 무관)", () => {
    expect(computeAgentShadowGroundTruth("skipped", null)).toBe("unknown");
    expect(computeAgentShadowGroundTruth("running", "completed")).toBe("unknown");
    expect(computeAgentShadowGroundTruth("pending", null)).toBe("unknown");
    expect(computeAgentShadowGroundTruth("weird", "completed")).toBe("unknown");
  });

  it("validator failed → failed(qa 와 무관)", () => {
    expect(computeAgentShadowGroundTruth("failed", null)).toBe("failed");
    expect(computeAgentShadowGroundTruth("failed", "completed")).toBe("failed");
  });

  it("validator completed + qa 없음 → success", () => {
    expect(computeAgentShadowGroundTruth("completed", null)).toBe("success");
  });

  it("validator completed + qa 종결 실패 → failed", () => {
    expect(computeAgentShadowGroundTruth("completed", "failed")).toBe("failed");
  });

  it("validator completed + qa 미종결(skipped) → unknown(긍정 확인 없음)", () => {
    expect(computeAgentShadowGroundTruth("completed", "skipped")).toBe("unknown");
  });

  it("validator completed + qa completed → success", () => {
    expect(computeAgentShadowGroundTruth("completed", "completed")).toBe("success");
  });

  it("normalizeStepRunStatus 도메인 매핑", () => {
    expect(normalizeStepRunStatus("completed")).toBe("success");
    expect(normalizeStepRunStatus("failed")).toBe("failed");
    expect(normalizeStepRunStatus("skipped")).toBe("unknown");
    expect(normalizeStepRunStatus("pending")).toBe("unknown");
    expect(normalizeStepRunStatus("running")).toBe("unknown");
    expect(normalizeStepRunStatus(null)).toBe("unknown");
  });
});

const snapshot: JudgmentDefinitionSnapshot = {
  description: "테스트용 최소 스냅샷",
  stateAssembly: { kind: "inline-ref", notes: "stub" },
  questions: [],
  policy: { notes: "stub", thresholds: {} },
};

/** 실제 공급자 계약: noul value 는 P(yes) 0~1 숫자(null=무답). */
function noul(name: string, pYes: number | null): JudgmentAnswer {
  return { name, type: "noul", value: pYes };
}

const v2LowRisk: JudgmentAnswer[] = [noul("complete_html", 0.9), noul("claims_grounded", 0.85)];
const v2NeedsReview: JudgmentAnswer[] = [noul("complete_html", 0.9), noul("claims_grounded", 0.1)];
const v2NoConfidence: JudgmentAnswer[] = [noul("complete_html", 0.9), noul("claims_grounded", null)];

function v1Answers(overall: string): JudgmentAnswer[] {
  return [{ name: "overall", type: "choice", value: overall, confidence: 0.9 }];
}

describeEP("computeAgentJudgmentShadowStats (embedded DB)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let workflowId = "";
  let v1DefId = "";
  let shadowDefId = "";

  async function insertCall(
    contextId: string,
    defId: string,
    answers: JudgmentAnswer[] | null,
    createdAt: Date,
  ): Promise<void> {
    await db.insert(judgmentCalls).values({
      companyId,
      definitionId: defId,
      definitionVersion: 1,
      contextType: "workflow_step",
      contextId,
      correlationKey: `workflow_step:${contextId}`,
      inputState: {},
      questions: [],
      answers,
      outcome: "observed",
      attempts: 1,
      createdAt,
    });
  }

  async function scenario(options: {
    v1: string;
    v1Old?: string;
    shadow?: JudgmentAnswer[];
    shadowOld?: JudgmentAnswer[];
    validator?: string;
    qa?: string;
    at?: { now: Date; old: Date };
  }): Promise<void> {
    const base = options.at ?? { now: new Date(), old: new Date(Date.now() - 5 * 60_000) };
    const runId = randomUUID();
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "test",
      createdAt: base.now,
    });
    const contextId = `wfr:${runId}:step:${randomUUID()}`;
    await insertCall(contextId, v1DefId, v1Answers(options.v1Old ?? options.v1), base.old);
    await insertCall(contextId, v1DefId, v1Answers(options.v1), base.now);
    if (options.shadow) {
      await insertCall(contextId, shadowDefId, options.shadowOld ?? options.shadow, base.old);
      await insertCall(contextId, shadowDefId, options.shadow, base.now);
    }
    if (options.validator) {
      await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: JEV_VALIDATOR_STEP_ID, status: options.validator });
    }
    if (options.qa) {
      await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: JEV_QA_STEP_ID, status: options.qa });
    }
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-shadow-stats-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Agent Shadow Stats Co",
      status: "active",
      issuePrefix: "AGST",
    });
    const [workflow] = await db
      .insert(workflowDefinitions)
      .values({ companyId, name: "jev-tech-scout" })
      .returning({ id: workflowDefinitions.id });
    workflowId = workflow.id;
    const [v1Def] = await db
      .insert(judgmentDefinitions)
      .values({ companyId, name: AGENT_JUDGMENT_DEFINITION_NAME, version: 1, isActive: true, providerId: "typesafe", modelId: "jev-1.13.0", definition: snapshot })
      .returning({ id: judgmentDefinitions.id });
    v1DefId = v1Def.id;
    const [shadowDef] = await db
      .insert(judgmentDefinitions)
      .values({ companyId, name: AGENT_JUDGMENT_SHADOW_DEFINITION_NAME, version: 1, isActive: true, providerId: "typesafe", modelId: "jev-1.13.0", definition: snapshot })
      .returning({ id: judgmentDefinitions.id });
    shadowDefId = shadowDef.id;

    // c1: v1/v2 모두 최신 low_risk(과거 needs_full_review 행 존재 — 최신 승리) + 정답 success
    await scenario({ v1: "low_risk", v1Old: "needs_full_review", shadow: v2LowRisk, shadowOld: v2NeedsReview, validator: "completed", qa: "completed" });
    // c2: v1/v2 needs_full_review + 정답 failed
    await scenario({ v1: "needs_full_review", shadow: v2NeedsReview, validator: "failed" });
    // c3: v1/v2 low_risk 오탐(정답 failed)
    await scenario({ v1: "low_risk", shadow: v2LowRisk, validator: "failed" });
    // c4: 섀도 행 없음(관측 미실행)
    await scenario({ v1: "low_risk", validator: "completed" });
    // c5: 섀도 행 있으나 verdict 계산 불가(무답 null)
    await scenario({ v1: "low_risk", shadow: v2NoConfidence, validator: "completed" });
    // c6: 정답측 행 없음(unknown) + v1/v2 불일치
    await scenario({ v1: "needs_full_review", shadow: v2LowRisk });
    // c7: 창 밖(30일 전) — days=7 에서 제외
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await scenario({ v1: "low_risk", shadow: v2LowRisk, validator: "completed", at: { now: monthAgo, old: new Date(monthAgo.getTime() - 5 * 60_000) } });
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("지표 수학을 정확히 계산한다(비율·null 분모)", async () => {
    const stats = await computeAgentJudgmentShadowStats(db, { companyId, days: 7 });
    expect(stats.windowDays).toBe(7);
    expect(stats.companyId).toBe(companyId);
    expect(stats.totalPrescreens).toBe(6); // c1~c6(c7 창 밖)
    expect(stats.shadowed).toBe(5); // c1,c2,c3,c5,c6
    expect(stats.judged).toBe(4); // c1,c2,c3,c6(c5 verdict 불가)
    expect(stats.validatorConfirmed).toBe(1); // c1
    expect(stats.validatorFailed).toBe(2); // c2,c3
    expect(stats.validatorUnknown).toBe(1); // c6
    expect(stats.skipCandidates).toBe(3); // c1,c3,c6
    expect(stats.skipCandidateRate).toBeCloseTo(3 / 4, 9);
    expect(stats.candidateMismatches).toBe(1); // c3
    expect(stats.candidateMismatchRate).toBeCloseTo(1 / 3, 9);
    expect(stats.revisionFamilyJudged).toBe(2); // c2,c3
    expect(stats.missRate).toBeCloseTo(1 / 2, 9);
    expect(stats.v1LowRisk).toBe(2); // c1,c3
    expect(stats.v1LowRiskMismatches).toBe(1); // c3
    expect(stats.v2v1AgreementRate).toBeCloseTo(3 / 4, 9); // c6 만 불일치
  });

  it("관측 창(days) 파라미터를 반영한다", async () => {
    const stats = await computeAgentJudgmentShadowStats(db, { companyId, days: 45 });
    expect(stats.totalPrescreens).toBe(7); // c7 포함
    expect(stats.judged).toBe(5);
  });

  it("validatorStepId 오버라이드 시 정답측을 못 찾아 unknown 이 된다", async () => {
    const stats = await computeAgentJudgmentShadowStats(db, { companyId, days: 7, validatorStepId: "other-validator" });
    expect(stats.judged).toBe(4);
    expect(stats.validatorUnknown).toBe(4);
    expect(stats.validatorConfirmed).toBe(0);
    expect(stats.validatorFailed).toBe(0);
  });

  it("noulYesFloor 상향 시 judged 0 — 비율은 null", async () => {
    const stats = await computeAgentJudgmentShadowStats(db, { companyId, days: 7, noulYesFloor: 0.95 });
    expect(stats.judged).toBe(0);
    expect(stats.skipCandidates).toBe(0);
    expect(stats.skipCandidateRate).toBeNull();
    expect(stats.v2v1AgreementRate).toBeNull();
  });

  it("데이터 없는 회사는 0 카운트·null 비율", async () => {
    const stats = await computeAgentJudgmentShadowStats(db, { companyId: randomUUID(), days: 7 });
    expect(stats.totalPrescreens).toBe(0);
    expect(stats.shadowed).toBe(0);
    expect(stats.judged).toBe(0);
    expect(stats.skipCandidateRate).toBeNull();
    expect(stats.candidateMismatchRate).toBeNull();
    expect(stats.missRate).toBeNull();
    expect(stats.v2v1AgreementRate).toBeNull();
  });
});
