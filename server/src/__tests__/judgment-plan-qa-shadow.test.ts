import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  judgmentCalls,
  judgmentDefinitions,
  missionPlanArtifacts,
  missionPlanQaVerdicts,
  missions,
} from "@paperclipai/db";
import type { JudgmentAskResult } from "@paperclipai/shared";
import { createJudgmentService, type JudgmentService } from "../services/judgment/judgment-service.js";
import type { JudgmentProvider } from "../services/judgment/provider.js";
import {
  assemblePlanQaShadowState,
  buildPlanQaPrescreenDefinition,
  createPlanQaShadowLoop,
  ensurePlanQaPrescreenDefinition,
  PLAN_QA_PRESCREEN_DEFINITION_NAME,
  PLAN_QA_PRESCREEN_MODEL_ID,
  resolvePlanQaShadowConfig,
  resolvePlanQaShadowOwnership,
  runPlanQaShadowPass,
  seedPlanQaPrescreenDefinitions,
} from "../services/judgment/plan-qa-shadow.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping plan-qa shadow tests: ${support.reason ?? "unsupported"}`);
}

// ---------------------------------------------------------------------------
// 단위 테스트(DB 불필요)
// ---------------------------------------------------------------------------

describe("plan-qa-shadow — 게이트/설정", () => {
  it("PAPERCLIP_JUDGMENT_ENABLED off(기본)면 루프 미등록 상태다", () => {
    expect(resolvePlanQaShadowOwnership({}).enabled).toBe(false);
    expect(resolvePlanQaShadowOwnership({ PAPERCLIP_JUDGMENT_ENABLED: "0" }).enabled).toBe(false);
  });

  it("PAPERCLIP_JUDGMENT_ENABLED=1 이면 활성화된다", () => {
    expect(resolvePlanQaShadowOwnership({ PAPERCLIP_JUDGMENT_ENABLED: "1" }).enabled).toBe(true);
    expect(resolvePlanQaShadowOwnership({ PAPERCLIP_JUDGMENT_ENABLED: "true" }).enabled).toBe(true);
  });

  it("maxPerTick/lookbackDays env 오버라이드와 기본값(3/7)을 지킨다", () => {
    expect(resolvePlanQaShadowConfig({})).toEqual({ maxPerTick: 3, lookbackDays: 7 });
    expect(
      resolvePlanQaShadowConfig({
        PAPERCLIP_JUDGMENT_SHADOW_MAX_PER_TICK: "5",
        PAPERCLIP_JUDGMENT_SHADOW_LOOKBACK_DAYS: "14",
      }),
    ).toEqual({ maxPerTick: 5, lookbackDays: 14 });
    // 비정상 값은 기본값으로 폴백
    expect(
      resolvePlanQaShadowConfig({
        PAPERCLIP_JUDGMENT_SHADOW_MAX_PER_TICK: "-1",
        PAPERCLIP_JUDGMENT_SHADOW_LOOKBACK_DAYS: "abc",
      }),
    ).toEqual({ maxPerTick: 3, lookbackDays: 7 });
  });
});

describe("plan-qa-shadow — 정의 스냅샷", () => {
  it("overall choice 3선택지 + noul 2질문 + thresholds 메모를 포함한다", () => {
    const definition = buildPlanQaPrescreenDefinition();
    expect(definition.questions).toHaveLength(3);
    const overall = definition.questions[0];
    expect(overall.name).toBe("overall");
    expect(overall.type).toBe("choice");
    expect(overall.criteria).toEqual({
      low_risk: "계획이 명확·저위험으로 전체 QA 없이 진행 가능해 보임",
      needs_full_qa: "불확실·고위험 신호가 있어 전체 QA 필요",
      insufficient_evidence: "근거 부족으로 판단 불가",
    });
    expect(definition.questions[1]).toMatchObject({ name: "steps_have_verification", type: "noul" });
    expect(definition.questions[2]).toMatchObject({ name: "requirements_covered", type: "noul" });
    expect(definition.policy.thresholds).toEqual({ overall_confidence_min: 0.6 });
    // state 조립 규칙이 notes 에 문서화되어 있다
    expect(definition.stateAssembly.notes).toContain("plan");
    expect(definition.stateAssembly.notes).toContain("제외");
  });

  it("트랙 C0 — 묶음 정책 메타: purpose 를 가진다(정의=1 purpose)", () => {
    const definition = buildPlanQaPrescreenDefinition();
    expect(definition.purpose).toBe("plan-qa-prescreen-observation");
    // 3질문이 하나의 purpose 를 공유 — 질문마다 개별 정책 필드는 없다
    for (const question of definition.questions) {
      expect((question as Record<string, unknown>).purpose).toBeUndefined();
    }
    // originClass 는 secret 이 아니어야 한다(섀도 관측은 내부 문서 반출용)
    expect(definition.originClass ?? "internal").not.toBe("secret");
  });
});

describe("plan-qa-shadow — state 조립", () => {
  it("계획 원문·계약·미션 메타만 포함하고 자기 평가 문구는 제외한다", () => {
    const artifact = {
      id: randomUUID(),
      companyId: randomUUID(),
      missionId: randomUUID(),
      revision: 2,
      status: "active",
      ownerAgentId: randomUUID(),
      missionGoal: "목표",
      refs: { doc: "x" },
      assumptions: ["가정"],
      requiredInputs: ["입력"],
      successCriteria: ["기준"],
      risks: ["위험"],
      steps: [{ step: 1, verify: "실행 후 산물 확인" }],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const state = assemblePlanQaShadowState(
      artifact,
      { checks: [{ id: "c1" }] },
      { id: artifact.missionId, title: "미션", status: "planning" },
    ) as Record<string, unknown>;

    // 포함: 원문·계약·메타만
    expect(Object.keys(state).sort()).toEqual(["mission", "plan", "quality_contract"]);
    expect((state.plan as Record<string, unknown>).missionGoal).toBe("목표");
    expect((state.plan as Record<string, unknown>).steps).toEqual(artifact.steps);
    expect(state.quality_contract).toEqual({ checks: [{ id: "c1" }] });
    expect(state.mission).toEqual({ id: artifact.missionId, title: "미션", status: "planning" });
    // 제외: verdict 값/diagnostics 등 자기 평가 문구를 받는 필드 자체가 없다
    expect(JSON.stringify(state)).not.toContain("request_changes");
    expect(JSON.stringify(state)).not.toContain("diagnostics");
  });
});

// ---------------------------------------------------------------------------
// 임베디드 PG 통합 테스트
// ---------------------------------------------------------------------------

function scriptedProvider(script: (input: unknown) => JudgmentAskResult): JudgmentProvider & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    id: "typesafe",
    async ask(input) {
      calls.push(input);
      return script(input);
    },
    get calls() {
      return calls;
    },
  };
}

const okLowRisk: JudgmentAskResult = {
  status: "ok",
  answers: [
    { name: "overall", type: "choice", value: "low_risk", confidence: 0.9 },
    { name: "steps_have_verification", type: "noul", value: 0.8 },
    { name: "requirements_covered", type: "noul", value: 0.9 },
  ],
  modelVersion: PLAN_QA_PRESCREEN_MODEL_ID,
  usage: { inputTokens: 100, outputTokens: 10 },
  attempts: 1,
  latencyMs: 5,
};

const errorResult: JudgmentAskResult = {
  status: "error",
  error: "network_error",
  message: "fetch failed",
  attempts: 3,
  latencyMs: 100,
};

describeEP("plan-qa shadow reconciler (embedded DB)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let missionId: string;
  let issueId: string;
  let hashSeq = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("planqa-shadow-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Shadow Co",
      status: "active",
      issuePrefix: "SHD1",
    });
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Shadow Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    missionId = randomUUID();
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "섀도 관측 미션",
      status: "planning",
    });
    issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "PLAN-QA 이슈",
      status: "todo",
    });
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  let artifactRevision = 0;

  async function insertArtifact(): Promise<string> {
    const id = randomUUID();
    artifactRevision += 1; // (missionId, revision) 유니크 — 번호 증가
    await db.insert(missionPlanArtifacts).values({
      id,
      companyId,
      missionId,
      revision: artifactRevision,
      ownerAgentId: agentId,
      missionGoal: "계획 목표",
      refs: {},
      assumptions: ["가정1"],
      requiredInputs: [],
      successCriteria: ["기준1"],
      risks: [],
      steps: [{ step: 1, verify: "산물 확인" }],
    });
    return id;
  }

  async function insertVerdict(options: {
    artifactId?: string | null;
    verdict?: string;
    qualityContract?: Record<string, unknown> | null;
  }): Promise<string> {
    const id = randomUUID();
    hashSeq += 1;
    await db.insert(missionPlanQaVerdicts).values({
      id,
      companyId,
      missionId,
      missionPlanArtifactId: options.artifactId ?? null,
      planQaIssueId: issueId,
      decisionHash: `hash-${hashSeq}`,
      verdict: options.verdict ?? "request_changes",
      qualityContract: options.qualityContract ?? null,
      diagnostics: [],
    });
    return id;
  }

  it("시더가 v1 정의를 만들고 idempotent 하게 재실행된다", async () => {
    const first = await seedPlanQaPrescreenDefinitions(db, { companyId });
    expect(first).toEqual({ companies: 1, seeded: 1 });

    const second = await seedPlanQaPrescreenDefinitions(db, { companyId });
    expect(second).toEqual({ companies: 1, seeded: 0 });

    const [definition] = await db
      .select()
      .from(judgmentDefinitions)
      .where(eq(judgmentDefinitions.companyId, companyId));
    expect(definition.name).toBe(PLAN_QA_PRESCREEN_DEFINITION_NAME);
    expect(definition.version).toBe(1);
    expect(definition.isActive).toBe(true);
    expect(definition.modelId).toBe(PLAN_QA_PRESCREEN_MODEL_ID);
    expect(definition.definition.questions).toHaveLength(3);
    expect(definition.definition.purpose).toBe("plan-qa-prescreen-observation");
  });

  it("신규 verdict 를 관측해 감사행 1건을 남긴다(state 는 원문·계약·메타만)", async () => {
    const artifactId = await insertArtifact();
    const verdictId = await insertVerdict({
      artifactId,
      verdict: "pass",
      qualityContract: { maxEvidenceResubmissions: 1 },
    });
    const provider = scriptedProvider(() => okLowRisk);
    const service = createJudgmentService(db, { provider });

    const result = await runPlanQaShadowPass(db, { service, maxPerTick: 3, lookbackDays: 7 });

    expect(result.processed).toBe(1);
    expect(result.recorded).toBe(1);

    const [call] = await db
      .select()
      .from(judgmentCalls)
      .where(eq(judgmentCalls.correlationKey, `mission_plan_qa:${verdictId}`));
    expect(call).toBeTruthy();
    expect(call.outcome).toBe("observed");
    expect(call.contextType).toBe("mission_plan_qa");
    expect(call.contextId).toBe(verdictId);
    // state: 계획 원문 + 계약 + 미션 메타. 자기 평가 문구(verdict/diagnostics) 없음.
    const state = call.inputState as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["mission", "plan", "quality_contract"]);
    expect((state.plan as Record<string, unknown>).missionGoal).toBe("계획 목표");
    expect(state.quality_contract).toEqual({ maxEvidenceResubmissions: 1 });
    expect((state.mission as Record<string, unknown>).title).toBe("섀도 관측 미션");
    // provider 는 정의의 고정 모델을 받았다
    expect(provider.calls[0]).toMatchObject({ model: PLAN_QA_PRESCREEN_MODEL_ID });
    // 관측이 판정·이슈를 변경하지 않았다
    const [verdictRow] = await db
      .select()
      .from(missionPlanQaVerdicts)
      .where(eq(missionPlanQaVerdicts.id, verdictId));
    expect(verdictRow.verdict).toBe("pass");
    expect(verdictRow.updatedAt).toEqual(verdictRow.createdAt);
  });

  it("이미 correlationKey 가 있으면 skip 한다", async () => {
    const artifactId = await insertArtifact();
    await insertVerdict({ artifactId });
    const provider = scriptedProvider(() => okLowRisk);
    const service = createJudgmentService(db, { provider });

    const first = await runPlanQaShadowPass(db, { service });
    expect(first.processed).toBe(1);

    const second = await runPlanQaShadowPass(db, { service });
    expect(second.processed).toBe(0);
    expect(second.recorded).toBe(0);
  });

  it("artifact 가 null 인 verdict 는 skip+로그다(네트워크 호출 없음)", async () => {
    await insertVerdict({ artifactId: null });
    const provider = scriptedProvider(() => okLowRisk);

    const result = await runPlanQaShadowPass(db, {
      service: createJudgmentService(db, { provider }),
    });

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(provider.calls.length).toBe(0);
  });

  it("provider 실패 시 error 감사행을 남기고 다음 틱은 계속 진행한다", async () => {
    const artifactId = await insertArtifact();
    const failVerdictId = await insertVerdict({ artifactId });
    const nextArtifactId = await insertArtifact();
    const okVerdictId = await insertVerdict({ artifactId: nextArtifactId });

    let failOnce = true;
    const provider = scriptedProvider(() => (failOnce ? errorResult : okLowRisk));
    const service = createJudgmentService(db, { provider });

    // 틱 1: failVerdict 만 processing 순서상 먼저(생성순) — 실패해도 error 행이 남는다
    const first = await runPlanQaShadowPass(db, { service, maxPerTick: 1 });
    expect(first.processed).toBe(1);
    expect(first.recorded).toBe(1);
    const [errorCall] = await db
      .select()
      .from(judgmentCalls)
      .where(eq(judgmentCalls.correlationKey, `mission_plan_qa:${failVerdictId}`));
    expect(errorCall.outcome).toBe("error");
    expect(errorCall.error).toContain("network_error");

    // 틱 2: 실패했던 verdict 는 error 행으로 처리 완료 — 다음 verdict 로 진행
    failOnce = false;
    const second = await runPlanQaShadowPass(db, { service, maxPerTick: 1 });
    expect(second.processed).toBe(1);
    const [okCall] = await db
      .select()
      .from(judgmentCalls)
      .where(eq(judgmentCalls.correlationKey, `mission_plan_qa:${okVerdictId}`));
    expect(okCall.outcome).toBe("observed");
  });

  it("maxPerTick 을 존중한다", async () => {
    for (let i = 0; i < 3; i += 1) {
      const artifactId = await insertArtifact();
      await insertVerdict({ artifactId });
    }
    const provider = scriptedProvider(() => okLowRisk);
    const service = createJudgmentService(db, { provider });
    const callsBefore = provider.calls.length;

    const result = await runPlanQaShadowPass(db, { service, maxPerTick: 2 });

    expect(result.processed).toBe(2);
    expect(provider.calls.length - callsBefore).toBe(2);
  });

  it("정의 없는 회사는 on-demand seed 후 재시도해 관측을 완료한다", async () => {
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Shadow Co 2",
      status: "active",
      issuePrefix: "SHD2",
    });
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "Shadow Agent 2",
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
      title: "신규 회사 미션",
      status: "planning",
    });
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: otherCompanyId,
      title: "PLAN-QA 이슈 2",
      status: "todo",
    });
    const artifactId = randomUUID();
    await db.insert(missionPlanArtifacts).values({
      id: artifactId,
      companyId: otherCompanyId,
      missionId: otherMissionId,
      ownerAgentId: otherAgentId,
      missionGoal: "신규 회사 계획",
    });
    const verdictId = randomUUID();
    await db.insert(missionPlanQaVerdicts).values({
      id: verdictId,
      companyId: otherCompanyId,
      missionId: otherMissionId,
      missionPlanArtifactId: artifactId,
      planQaIssueId: otherIssueId,
      decisionHash: `hash-${randomUUID()}`,
      verdict: "request_changes",
      qualityContract: null,
      diagnostics: [],
    });

    const provider = scriptedProvider(() => okLowRisk);
    const service = createJudgmentService(db, { provider });

    const result = await runPlanQaShadowPass(db, { service, maxPerTick: 10 });

    // (이전 테스트의 잔여 pending 도 같이 처리될 수 있으므로 최솟값만 확인한다)
    expect(result.recorded).toBeGreaterThanOrEqual(1);
    const [call] = await db
      .select()
      .from(judgmentCalls)
      .where(eq(judgmentCalls.correlationKey, `mission_plan_qa:${verdictId}`));
    expect(call).toBeTruthy();
    expect(call.outcome).toBe("observed");
    expect(call.companyId).toBe(otherCompanyId);
    // on-demand seed 로 정의가 생겼다(재호당 no-op)
    const ensured = await ensurePlanQaPrescreenDefinition(db, otherCompanyId);
    expect(ensured.ensured).toBe(false);
  });

  it("루프 start 가 정의 seed 를 1회 실행하고 tick 을 돌린다", async () => {
    const runPass = vi.fn(async () => ({ scanned: 0, processed: 0, recorded: 0, skipped: 0 }));
    const loop = createPlanQaShadowLoop({ db, intervalMs: 60_000, runPass });

    await loop.observe();
    expect(runPass).toHaveBeenCalledTimes(1);
    const state = loop.getState();
    expect(state.seed).toEqual({ companies: 2, seeded: 0 }); // 두 회사 모두 이미 정의 있음
    expect(state.tickCount).toBe(1);
    expect(state.running).toBe(false); // start 전

    loop.start();
    expect(loop.getState().running).toBe(true);
    loop.stop();
    expect(loop.getState().running).toBe(false);
  });
});
