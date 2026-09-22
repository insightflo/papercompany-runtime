import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, judgmentCalls, judgmentDefinitions } from "@paperclipai/db";
import type { JudgmentAnswer, JudgmentAskResult, JudgmentDefinitionSnapshot, JudgmentQuestion } from "@paperclipai/shared";
import { createJudgmentService } from "../services/judgment/judgment-service.js";
import type { JudgmentProvider } from "../services/judgment/provider.js";
import { AGENT_JUDGMENT_DEFINITION_NAME, buildAgentJudgmentDefinition } from "../services/judgment/agent-judgment-tool.js";
import {
  AGENT_JUDGMENT_SHADOW_DEFINITION_NAME,
  AGENT_JUDGMENT_SHADOW_MODEL_ID,
  AGENT_JUDGMENT_SHADOW_PURPOSE,
  buildAgentJudgmentShadowDefinition,
  buildShadowJudgmentQuestions,
  ensureAgentJudgmentShadowDefinition,
  resolveAgentShadowConfig,
  runAgentJudgmentShadowPass,
  seedAgentJudgmentShadowDefinitions,
  type AgentShadowPassResult,
} from "../services/judgment/agent-judgment-shadow.js";
import { createAgentJudgmentShadowLoop, resolveAgentShadowOwnership } from "../services/judgment/agent-judgment-shadow-loop.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping agent-judgment shadow tests: ${support.reason ?? "unsupported"}`);
}

const stubSnapshot: JudgmentDefinitionSnapshot = {
  description: "테스트용 최소 스냅샷",
  stateAssembly: { kind: "inline-ref", notes: "stub" },
  questions: [],
  policy: { notes: "stub", thresholds: {} },
};

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

const okShadowAnswers: JudgmentAskResult = {
  status: "ok",
  answers: [
    // v2 noul 답변의 value 는 boolean 이다 — 공유 타입 JudgmentAnswerValue 는 boolean 슬롯이
    // 없으므로(외부 JSON 계약) 테스트에서만 캐스트해 심는다. verdict 계산은 unknown 으로 검증한다.
    { name: "complete_html", type: "noul", value: 0.9 },
    { name: "claims_grounded", type: "noul", value: 0.85 },
  ],
  modelVersion: AGENT_JUDGMENT_SHADOW_MODEL_ID,
  usage: { inputTokens: 100, outputTokens: 10 },
  attempts: 1,
  latencyMs: 5,
};

describe("agent-judgment-shadow — 게이트/설정/정의(단위)", () => {
  it("PAPERCLIP_JUDGMENT_ENABLED 게이트: 1/true 만 활성화", () => {
    expect(resolveAgentShadowOwnership({}).enabled).toBe(false);
    expect(resolveAgentShadowOwnership({ PAPERCLIP_JUDGMENT_ENABLED: "0" }).enabled).toBe(false);
    expect(resolveAgentShadowOwnership({ PAPERCLIP_JUDGMENT_ENABLED: "1" }).enabled).toBe(true);
    expect(resolveAgentShadowOwnership({ PAPERCLIP_JUDGMENT_ENABLED: "TRUE" }).enabled).toBe(true);
  });

  it("resolveAgentShadowConfig — 기본 3/7, 오버라이드, 비정상 폴백", () => {
    expect(resolveAgentShadowConfig({})).toEqual({ maxPerTick: 3, lookbackDays: 7 });
    expect(
      resolveAgentShadowConfig({
        PAPERCLIP_JUDGMENT_AGENT_SHADOW_MAX_PER_TICK: "5",
        PAPERCLIP_JUDGMENT_AGENT_SHADOW_LOOKBACK_DAYS: "14",
      }),
    ).toEqual({ maxPerTick: 5, lookbackDays: 14 });
    expect(
      resolveAgentShadowConfig({
        PAPERCLIP_JUDGMENT_AGENT_SHADOW_MAX_PER_TICK: "-1",
        PAPERCLIP_JUDGMENT_AGENT_SHADOW_LOOKBACK_DAYS: "abc",
      }),
    ).toEqual({ maxPerTick: 3, lookbackDays: 7 });
  });

  it("v2 질문 — noul 2개뿐, overall choice 없음, criteria true/false 명시", () => {
    const questions = buildShadowJudgmentQuestions();
    expect(questions.map((q) => q.name).sort()).toEqual(["claims_grounded", "complete_html"]);
    for (const question of questions) {
      expect(question.type).toBe("noul");
      const criteria = question.criteria as Record<string, unknown>;
      expect(criteria).toHaveProperty("true");
      expect(criteria).toHaveProperty("false");
    }
  });

  it("정의 스냅샷 — purpose/thresholds 메모/축약 조립 notes", () => {
    const definition = buildAgentJudgmentShadowDefinition();
    expect(definition.purpose).toBe(AGENT_JUDGMENT_SHADOW_PURPOSE);
    expect(definition.policy.thresholds).toEqual({ noul_yes_min: 0.6 });
    expect(definition.stateAssembly.notes).toContain("document_text");
    expect(definition.stateAssembly.notes).toContain("structure_stats");
    expect(definition.originClass ?? "internal").not.toBe("secret");
    expect(definition.questions).toHaveLength(2);
    expect(definition.questions.every((q) => q.type === "noul")).toBe(true);
  });
});

describeEP("agent-judgment shadow pass (embedded DB)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";

  async function definitionId(company: string, name: string, snapshot: JudgmentDefinitionSnapshot): Promise<string> {
    const [existing] = await db.select({ id: judgmentDefinitions.id }).from(judgmentDefinitions)
      .where(and(eq(judgmentDefinitions.companyId, company), eq(judgmentDefinitions.name, name))).limit(1);
    if (existing) return existing.id;
    const [row] = await db.insert(judgmentDefinitions).values({
      companyId: company, name, version: 1, isActive: true, providerId: "typesafe",
      modelId: AGENT_JUDGMENT_SHADOW_MODEL_ID, definition: snapshot,
    }).returning({ id: judgmentDefinitions.id });
    return row.id;
  }

  async function insertV1Call(company: string, contextId: string, inputState: Record<string, unknown>): Promise<void> {
    await db.insert(judgmentCalls).values({
      companyId: company,
      definitionId: await definitionId(company, AGENT_JUDGMENT_DEFINITION_NAME, buildAgentJudgmentDefinition()),
      definitionVersion: 1, contextType: "workflow_step", contextId,
      correlationKey: `workflow_step:${contextId}`, inputState, questions: [], answers: [],
      outcome: "observed", attempts: 1,
    });
  }

  async function shadowRows(contextId: string, company: string) {
    return db.select({ call: judgmentCalls }).from(judgmentCalls)
      .innerJoin(judgmentDefinitions, eq(judgmentCalls.definitionId, judgmentDefinitions.id))
      .where(and(
        eq(judgmentCalls.companyId, company),
        eq(judgmentCalls.contextId, contextId),
        eq(judgmentDefinitions.name, AGENT_JUDGMENT_SHADOW_DEFINITION_NAME),
      ));
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-shadow-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Agent Shadow Co", status: "active", issuePrefix: "AGS1" });
    await definitionId(companyId, AGENT_JUDGMENT_DEFINITION_NAME, buildAgentJudgmentDefinition());
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("시더가 섀도 정의를 만들고 멱등적으로 재실행된다", async () => {
    expect(await seedAgentJudgmentShadowDefinitions(db, { companyId })).toEqual({ companies: 1, seeded: 1 });
    expect(await seedAgentJudgmentShadowDefinitions(db, { companyId })).toEqual({ companies: 1, seeded: 0 });
    const [definition] = await db.select().from(judgmentDefinitions)
      .where(and(eq(judgmentDefinitions.companyId, companyId), eq(judgmentDefinitions.name, AGENT_JUDGMENT_SHADOW_DEFINITION_NAME)));
    expect(definition.version).toBe(1);
    expect(definition.isActive).toBe(true);
    expect(definition.modelId).toBe(AGENT_JUDGMENT_SHADOW_MODEL_ID);
    expect(definition.definition.purpose).toBe(AGENT_JUDGMENT_SHADOW_PURPOSE);
  });

  it("(a) 신규 v1 행 1건 → processed/recorded 1 + 축약 state·원문 미전송 검증", async () => {
    const html = '<html><body><h1>기술 스카우트 리포트</h1><script>var leak = "RAWSOURCE";</script><p>모든 주장이 근거와 연결됨</p></body></html>';
    const contextId = `wfr:${randomUUID()}:step:${randomUUID()}`;
    await insertV1Call(companyId, contextId, { subject: "기술 스카우트 리포트", document: html });
    const provider = scriptedProvider(() => okShadowAnswers);
    const result = await runAgentJudgmentShadowPass(db, {
      service: createJudgmentService(db, { provider }),
      maxPerTick: 3,
      lookbackDays: 7,
    });
    expect(result).toEqual({ scanned: 1, processed: 1, recorded: 1, skipped: 0 });
    const ask = provider.calls[0] as { state: Record<string, unknown>; model: string; questions: JudgmentQuestion[] };
    expect(ask.model).toBe(AGENT_JUDGMENT_SHADOW_MODEL_ID);
    expect(ask.questions.map((q) => q.name).sort()).toEqual(["claims_grounded", "complete_html"]);
    expect(ask.questions.every((q) => q.type === "noul")).toBe(true);
    expect(ask.state.subject).toBe("기술 스카우트 리포트");
    expect(typeof ask.state.document_text).toBe("string");
    expect(ask.state.document_text as string).toContain("모든 주장이 근거와 연결됨");
    expect(ask.state.structure_stats).toMatchObject({ docChars: html.length });
    expect(JSON.stringify(ask.state)).not.toContain("RAWSOURCE");
    expect(JSON.stringify(ask.state)).not.toContain("<script>");
    const rows = await shadowRows(contextId, companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].call.contextType).toBe("workflow_step");
    expect(rows[0].call.contextId).toBe(contextId);
    expect(rows[0].call.outcome).toBe("observed");
    expect(JSON.stringify(rows[0].call.inputState)).not.toContain("RAWSOURCE");
  });

  it("(b) 같은 correlationKey 의 섀도 행이 이미 있으면 skip 한다", async () => {
    const contextId = `wfr:${randomUUID()}:step:${randomUUID()}`;
    await insertV1Call(companyId, contextId, { document: "<html><body><p>이미 관측됨</p></body></html>" });
    const shadowDefId = await definitionId(companyId, AGENT_JUDGMENT_SHADOW_DEFINITION_NAME, stubSnapshot);
    await db.insert(judgmentCalls).values({
      companyId, definitionId: shadowDefId, definitionVersion: 1,
      contextType: "workflow_step", contextId, correlationKey: `workflow_step:${contextId}`,
      inputState: {}, questions: [], answers: [], outcome: "observed", attempts: 1,
    });
    const provider = scriptedProvider(() => okShadowAnswers);
    const result = await runAgentJudgmentShadowPass(db, {
      service: createJudgmentService(db, { provider }),
      lookbackDays: 7,
    });
    expect(result.processed).toBe(0);
    expect(result.recorded).toBe(0);
    expect(provider.calls.length).toBe(0);
  });

  it("(c) inputState.document 없는 행은 skipped(네트워크 호출 없음)", async () => {
    await insertV1Call(companyId, `wfr:${randomUUID()}:step:${randomUUID()}`, { subject: "문서 없음" });
    const provider = scriptedProvider(() => okShadowAnswers);
    const result = await runAgentJudgmentShadowPass(db, {
      service: createJudgmentService(db, { provider }),
      lookbackDays: 7,
    });
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(provider.calls.length).toBe(0);
  });

  it("(d) maxPerTick=0 이면 0건 처리한다", async () => {
    await insertV1Call(companyId, `wfr:${randomUUID()}:step:${randomUUID()}`, {
      document: "<html><body><p>대기 행</p></body></html>",
    });
    const provider = scriptedProvider(() => okShadowAnswers);
    const result = await runAgentJudgmentShadowPass(db, {
      service: createJudgmentService(db, { provider }),
      maxPerTick: 0,
      lookbackDays: 7,
    });
    expect(result.processed).toBe(0);
    expect(result.recorded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(provider.calls.length).toBe(0);
  });

  it("(e) 정의 없는 회사는 on-demand seed 후 재시도해 관측을 완료한다", async () => {
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Agent Shadow Co 2",
      status: "active",
      issuePrefix: "AGS2",
    });
    const contextId = `wfr:${randomUUID()}:step:${randomUUID()}`;
    await insertV1Call(otherCompanyId, contextId, { document: "<html><body><p>신규 회사 문서</p></body></html>" });
    const provider = scriptedProvider(() => okShadowAnswers);
    const result = await runAgentJudgmentShadowPass(db, {
      service: createJudgmentService(db, { provider }),
      maxPerTick: 10,
      lookbackDays: 7,
    });
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(result.recorded).toBeGreaterThanOrEqual(1);
    const rows = await shadowRows(contextId, otherCompanyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].call.outcome).toBe("observed");
    expect(await ensureAgentJudgmentShadowDefinition(db, otherCompanyId)).toEqual({ ensured: false });
  });

  it("루프 — 시작 시 seed 1회 + 즉시 1틱, start/stop 상태", async () => {
    const runPass = vi.fn(
      async (_db: unknown, _options?: unknown): Promise<AgentShadowPassResult> => ({
        scanned: 0,
        processed: 0,
        recorded: 0,
        skipped: 0,
      }),
    );
    const loop = createAgentJudgmentShadowLoop({ db, intervalMs: 60_000, runPass });
    await loop.observe();
    expect(runPass).toHaveBeenCalledTimes(1);
    const state = loop.getState();
    expect(state.seed).toEqual({ companies: 2, seeded: 0 });
    expect(state.tickCount).toBe(1);
    expect(state.running).toBe(false);
    loop.start();
    expect(loop.getState().running).toBe(true);
    loop.stop();
    expect(loop.getState().running).toBe(false);
  });
});
