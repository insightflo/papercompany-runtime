import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  judgmentCalls,
  judgmentDefinitions,
  missionPlanQaVerdicts,
  missions,
} from "@paperclipai/db";
import type { JudgmentAnswer } from "@paperclipai/shared";
import { PLAN_QA_PRESCREEN_DEFINITION_NAME, seedPlanQaPrescreenDefinitions } from "../services/judgment/plan-qa-shadow.js";
import { computePlanQaShadowStats } from "../services/judgment/plan-qa-shadow-stats.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping plan-qa shadow stats tests: ${support.reason ?? "unsupported"}`);
}

function overallAnswer(value: string, confidence = 0.8): JudgmentAnswer[] {
  return [
    { name: "overall", type: "choice", value, confidence },
    { name: "steps_have_verification", type: "noul", value: 0.9 },
    { name: "requirements_covered", type: "noul", value: 0.9 },
  ];
}

describeEP("computePlanQaShadowStats (embedded DB)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let otherCompanyId: string;
  let definitionId: string;
  const missionIds = new Map<string, string>();
  let hashSeq = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("planqa-shadow-stats-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Stats Co", status: "active", issuePrefix: "STT1" },
      { id: otherCompanyId, name: "Stats Co 2", status: "active", issuePrefix: "STT2" },
    ]);
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Stats Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const missionId = randomUUID();
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "통계 미션",
      status: "planning",
    });
    missionIds.set(companyId, missionId);
    // 타사 미션(verdict FK 용)
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "Stats Agent 2",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const otherMissionId = randomUUID();
    await db.insert(missions).values({
      id: otherMissionId,
      companyId: otherCompanyId,
      ownerAgentId: otherAgentId,
      title: "통계 미션 2",
      status: "planning",
    });
    missionIds.set(otherCompanyId, otherMissionId);

    // 감사행 FK 용 정의(시더로 v1 생성 후 id 조회)
    await seedPlanQaPrescreenDefinitions(db, { companyId });
    const [definition] = await db
      .select({ id: judgmentDefinitions.id })
      .from(judgmentDefinitions)
      .where(
        and(
          eq(judgmentDefinitions.companyId, companyId),
          eq(judgmentDefinitions.name, PLAN_QA_PRESCREEN_DEFINITION_NAME),
        ),
      )
      .limit(1);
    definitionId = definition.id;

    // --- 시나리오(관측 창 내, companyId) ---
    // v1 pass        → 최신 observed low_risk (과거 observed needs_full_qa 도 있음 — 최신 승리)
    // v2 request_chg → low_risk        (후보 불일치 + 놓침)
    // v3 request_chg → needs_full_qa
    // v4 pass        → needs_full_qa
    // v5 request_chg → 관측 없음
    // v6 pending     → low_risk        (pending 은 수정요구 계열 아님)
    // v7 request_chg → error 감사행만 있음(미평가)
    // v8(창 밖, 30일 전) request_chg → low_risk — 창 필터로 제외
    // 타사 데이터    → companyId 필터로 제외 확인용
    const v1 = await insertVerdict("pass", new Date());
    await insertCall(v1, "needs_full_qa", new Date(Date.now() - 3 * 60_000));
    await insertCall(v1, "low_risk", new Date());
    const v2 = await insertVerdict("request_changes", new Date());
    await insertCall(v2, "low_risk", new Date());
    const v3 = await insertVerdict("request_changes", new Date());
    await insertCall(v3, "needs_full_qa", new Date());
    const v4 = await insertVerdict("pass", new Date());
    await insertCall(v4, "needs_full_qa", new Date());
    await insertVerdict("request_changes", new Date()); // v5 — 관측 없음
    const v6 = await insertVerdict("pending", new Date());
    await insertCall(v6, "low_risk", new Date());
    const v7 = await insertVerdict("request_changes", new Date());
    await insertErrorCall(v7, new Date());
    const v8 = await insertVerdict("request_changes", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    await insertCall(v8, "low_risk", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    // 타사: request_chg + low_risk (companyId 필터 시 집계되면 안 됨)
    const otherVerdict = await insertVerdict("request_changes", new Date(), otherCompanyId);
    await insertCall(otherVerdict, "low_risk", new Date(), otherCompanyId);
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  async function insertVerdict(verdict: string, createdAt: Date, company = companyId): Promise<string> {
    const id = randomUUID();
    hashSeq += 1;
    // verdict 는 companyId+planQaIssueId+decisionHash 유니크 — verdict 마다 별도 이슈 사용
    const planQaIssueId = randomUUID();
    await db.insert(issues).values({
      id: planQaIssueId,
      companyId: company,
      title: `QA-${hashSeq}`,
      status: "todo",
      createdAt,
    });
    await db.insert(missionPlanQaVerdicts).values({
      id,
      companyId: company,
      missionId: missionIds.get(company)!,
      planQaIssueId,
      decisionHash: `stats-hash-${hashSeq}`,
      verdict,
      createdAt,
      updatedAt: createdAt,
      diagnostics: [],
    });
    return id;
  }

  async function insertCall(
    verdictId: string,
    overall: string,
    createdAt: Date,
    company = companyId,
  ): Promise<void> {
    await db.insert(judgmentCalls).values({
      companyId: company,
      definitionId,
      definitionVersion: 1,
      contextType: "mission_plan_qa",
      contextId: verdictId,
      correlationKey: `mission_plan_qa:${verdictId}`,
      inputState: {},
      questions: [],
      answers: overallAnswer(overall),
      outcome: "observed",
      attempts: 1,
      createdAt,
    });
  }

  async function insertErrorCall(verdictId: string, createdAt: Date): Promise<void> {
    await db.insert(judgmentCalls).values({
      companyId,
      definitionId,
      definitionVersion: 1,
      contextType: "mission_plan_qa",
      contextId: verdictId,
      correlationKey: `mission_plan_qa:${verdictId}`,
      inputState: {},
      questions: [],
      answers: null,
      outcome: "error",
      error: "network_error: boom",
      attempts: 3,
      createdAt,
    });
  }

  it("3지표(생략 후보율/후보 불일치율/놓침률)를 정확히 계산한다", async () => {
    const stats = await computePlanQaShadowStats(db, { companyId, days: 7 });

    // 창 내 verdict: v1~v7 (v8 창 밖 제외, 타사 제외)
    expect(stats.totalVerdicts).toBe(7);
    // 평가 완료(judged): v1,v2,v3,v4,v6 — v5(관측 없음), v7(error 만) 제외
    expect(stats.judged).toBe(5);
    // low_risk: v1(최신), v2, v6
    expect(stats.skipCandidates).toBe(3);
    expect(stats.skipCandidateRate).toBeCloseTo(3 / 5, 9);
    // low_risk ∧ 수정요구 계열: v2 만 (v6 pending 제외)
    expect(stats.candidateMismatches).toBe(1);
    expect(stats.candidateMismatchRate).toBeCloseTo(1 / 3, 9);
    // 수정요구 계열 중 관측됨: v2,v3 (v5 미관측, v7 error, v8 창 밖)
    expect(stats.revisionFamilyJudged).toBe(2);
    expect(stats.missRate).toBeCloseTo(1 / 2, 9);
    expect(stats.windowDays).toBe(7);
    expect(stats.companyId).toBe(companyId);
  });

  it("회사 필터 없이 조회하면 타사 데이터도 포함된다", async () => {
    const stats = await computePlanQaShadowStats(db, { days: 7 });
    // 타사 1건 추가: totalVerdicts 8, judged 6, low_risk 4(불일치 2)
    expect(stats.totalVerdicts).toBe(8);
    expect(stats.judged).toBe(6);
    expect(stats.skipCandidates).toBe(4);
    expect(stats.candidateMismatches).toBe(2);
    expect(stats.missRate).toBeCloseTo(2 / 3, 9);
  });

  it("데이터가 없으면 null 비율과 0 카운트를 반환한다", async () => {
    const stats = await computePlanQaShadowStats(db, { companyId: randomUUID(), days: 7 });
    expect(stats.totalVerdicts).toBe(0);
    expect(stats.judged).toBe(0);
    expect(stats.skipCandidateRate).toBeNull();
    expect(stats.candidateMismatchRate).toBeNull();
    expect(stats.missRate).toBeNull();
  });
});
