import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentToolGrants,
  agents,
  companies,
  createDb,
  judgmentCalls,
  judgmentDefinitions,
  toolDefinitions,
} from "@paperclipai/db";
import type { JudgmentAskInput, JudgmentAskResult } from "@paperclipai/shared";
import { createTypesafeProvider, type JudgmentProvider } from "../services/judgment/provider.js";
import { createJudgmentService, type JudgmentService } from "../services/judgment/judgment-service.js";
import { seedAgentJudgmentTool } from "../services/judgment/agent-judgment-tool.js";
import { grantWorkflowToolToAgent } from "../services/workflow/tool-catalog.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport().catch((error: unknown) => ({
  supported: false,
  reason: error instanceof Error ? error.message : String(error),
}));
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn("Skipping agent judgment tool tests: " + (support.reason ?? "unsupported"));

const okResult: JudgmentAskResult = {
  status: "ok",
  answers: [{
    name: "decision",
    type: "choice",
    value: "proceed",
    probabilities: { proceed: 0.9, skip: 0.1 },
    confidence: 0.9,
  }],
  modelVersion: "jev-1.13.0",
  usage: { inputTokens: 10, outputTokens: 5 },
  attempts: 1,
  latencyMs: 12,
};

function fakeProvider(result: JudgmentAskResult): JudgmentProvider & { calls: number; lastInput: JudgmentAskInput | null } {
  let calls = 0;
  let lastInput: JudgmentAskInput | null = null;
  return {
    id: "typesafe",
    async ask(input) {
      calls += 1;
      lastInput = input;
      return result;
    },
    get calls() { return calls; },
    get lastInput() { return lastInput; },
  };
}

function parameters(state: unknown = {
  plan: "작업 계획",
  contact: { email: "owner@example.com", phone: "010-1234-5678" },
}) {
  return {
    state,
    questions: {
      decision: {
        type: "choice",
        instructions: "이 작업을 진행할 가치가 있는지 판단한다.",
        criteria: { proceed: "진행", skip: "건너뜀" },
      },
    },
  };
}

describeEP("agent-facing judgment builtin tool", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const agentId = randomUUID();
  let toolId!: string;
  let firstSeed!: Awaited<ReturnType<typeof seedAgentJudgmentTool>>;
  let secondSeed!: Awaited<ReturnType<typeof seedAgentJudgmentTool>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("judgment-agent-tool-");
    db = createDb(tempDb!.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Agent Judgment Co", status: "active", issuePrefix: "AJT1" },
      { id: otherCompanyId, name: "Other Agent Judgment Co", status: "active", issuePrefix: "AJT2" },
    ]);
    firstSeed = await seedAgentJudgmentTool(db);
    secondSeed = await seedAgentJudgmentTool(db);
    const [tool] = await db.select({ id: toolDefinitions.id }).from(toolDefinitions)
      .where(and(eq(toolDefinitions.companyId, companyId), eq(toolDefinitions.name, "judgment")));
    toolId = tool.id;
    await db.insert(agents).values({ id: agentId, companyId, name: "judgment-agent", status: "idle" });
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  async function grant(): Promise<void> {
    await grantWorkflowToolToAgent(db, { companyId, agentId, toolName: "judgment", grantedBy: "test-board" });
  }

  async function execute(
    input: unknown,
    service?: JudgmentService,
    requestId = randomUUID(),
    context: { agentId?: string | null; workflowRunId?: string | null; stepRunId?: string | null; stepId?: string | null } = {},
  ) {
    return executeCoreWorkflowTool({
      db,
      companyId,
      agentId: context.agentId === undefined ? agentId : context.agentId,
      toolName: "judgment",
      parameters: input,
      requestId,
      workflowRunId: context.workflowRunId,
      stepRunId: context.stepRunId,
      stepId: context.stepId,
      ...(service ? { judgmentService: service } : {}),
    });
  }

  it("모든 회사에 도구와 정의를 만들고 두 번 호출해도 각 1행이며 grant는 만들지 않는다", async () => {
    expect(firstSeed).toMatchObject({ companies: 2, toolsSeeded: 2, definitionsSeeded: 2 });
    expect(secondSeed).toMatchObject({ companies: 2, toolsSeeded: 0, definitionsSeeded: 0 });
    expect(await db.select().from(toolDefinitions)).toHaveLength(2);
    expect(await db.select().from(judgmentDefinitions)).toHaveLength(2);
    expect(await db.select().from(agentToolGrants)).toHaveLength(0);
    const [tool] = await db.select().from(toolDefinitions).where(eq(toolDefinitions.id, toolId));
    expect(tool).toMatchObject({ adapterType: "builtin", adapterConfig: { kind: "judgment" }, enabled: true });
    expect(tool.description).toContain("LLM 대신 이 도구를 먼저 호출");
    expect(tool.inputSchema.required).toEqual(["state", "questions"]);
  });

  it("grant가 없으면 403이고 judgment provider를 호출하지 않는다", async () => {
    const provider = fakeProvider(okResult);
    const result = await execute(parameters(), createJudgmentService(db, { provider }));
    expect(result.status).toBe(403);
    expect(result.body.error).toContain("not granted");
    expect(provider.calls).toBe(0);
  });

  it("에이전트와 스텝 문맥이 모두 없으면 403을 유지한다", async () => {
    const provider = fakeProvider(okResult);
    const result = await execute(parameters(), createJudgmentService(db, { provider }), randomUUID(), { agentId: null });
    expect(result.status).toBe(403);
    expect(result.body.error).toContain("Agent identity is required");
    expect(provider.calls).toBe(0);
  });

  it("에이전트 없는 workflow tool step은 judgment를 실행하고 스텝 감사 문맥과 C0 검사본을 사용한다", async () => {
    const provider = fakeProvider(okResult);
    const service = createJudgmentService(db, { provider });
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    const stepId = "judge-branch";
    const result = await execute(parameters(), service, randomUUID(), {
      agentId: null,
      workflowRunId,
      stepRunId,
      stepId,
    });

    expect(result.status).toBe(200);
    expect(provider.calls).toBe(1);
    expect(JSON.stringify(provider.lastInput?.state)).not.toContain("owner@example.com");
    expect(JSON.stringify(provider.lastInput?.state)).not.toContain("010-1234-5678");

    const data = result.body.data as Record<string, unknown>;
    const [audit] = await db.select().from(judgmentCalls).where(eq(judgmentCalls.id, data.auditId as string));
    expect(audit).toMatchObject({
      companyId,
      contextType: "workflow_step",
      contextId: `wfr:${workflowRunId}:step:${stepRunId}`,
      correlationKey: `workflow_step:wfr:${workflowRunId}:step:${stepRunId}`,
      outcome: "observed",
      egressStatus: "checked_redacted",
    });
    expect(JSON.stringify(audit.inputState)).not.toContain("owner@example.com");
    expect(JSON.stringify(audit.inputState)).not.toContain("010-1234-5678");
  });

  it("grant 후 builtin judgment를 호출하고 C0 검사본과 agent_tool 감사행을 반환한다", async () => {
    await grant();
    const provider = fakeProvider(okResult);
    const service = createJudgmentService(db, { provider });
    const requestId = "agent-tool-request-1";
    const result = await execute(parameters(), service, requestId);

    expect(result.status).toBe(200);
    expect(result.body.content).toContain("decision=proceed");
    expect(result.body.content).toContain("confidence=0.9");
    const data = result.body.data as Record<string, unknown>;
    expect(data.answers).toEqual(okResult.answers);
    expect(data.confidence).toBe(0.9);
    expect(data.confidences).toEqual({ decision: 0.9 });
    expect(data.egress).toMatchObject({ status: "checked_redacted", findings: expect.any(Array) });
    expect(data.auditId).toBeTruthy();
    expect(provider.calls).toBe(1);
    expect(provider.lastInput?.questions).toEqual([{
      name: "decision",
      ...parameters().questions.decision,
    }]);
    expect(JSON.stringify(provider.lastInput?.state)).not.toContain("owner@example.com");
    expect(JSON.stringify(provider.lastInput?.state)).not.toContain("010-1234-5678");

    const [audit] = await db.select().from(judgmentCalls).where(eq(judgmentCalls.id, data.auditId as string));
    expect(audit).toMatchObject({ companyId, contextType: "agent_tool", contextId: requestId, outcome: "observed" });
    expect(JSON.stringify(audit.inputState)).not.toContain("owner@example.com");
    expect(audit.egressStatus).toBe("checked_redacted");
  });

  it("게이트가 꺼졌거나 키가 없으면 503과 고정 오류를 반환한다", async () => {
    await grant();
    const disabled = await execute(parameters(), createJudgmentService(db, {
      provider: createTypesafeProvider({ env: {} }),
    }));
    expect(disabled).toMatchObject({ status: 503, body: { error: "judgment layer disabled" } });

    const missingKey = await execute(parameters(), createJudgmentService(db, {
      provider: createTypesafeProvider({ env: { PAPERCLIP_JUDGMENT_ENABLED: "1" } }),
    }));
    expect(missingKey).toMatchObject({ status: 503, body: { error: "judgment layer disabled" } });
  });

  it("state/questions 형식 오류와 state 120,000자 초과는 provider 전에 422다", async () => {
    await grant();
    const shouldNotCall: JudgmentService = { askJudgment: async () => { throw new Error("must not call"); } };
    const tooLarge = await execute(parameters("x".repeat(120_001)), shouldNotCall);
    expect(tooLarge).toMatchObject({ status: 422 });
    expect(tooLarge.body.error).toContain("120000");

    const invalidState = await execute({ ...parameters(), state: 42 }, shouldNotCall);
    expect(invalidState).toMatchObject({ status: 422 });
    const invalidQuestions = await execute({ ...parameters(), questions: { decision: { type: "choice" } } }, shouldNotCall);
    expect(invalidQuestions).toMatchObject({ status: 422 });
  });

  it("C0 차단 결과는 422이고 provider를 호출하지 않으며 감사행에 남는다", async () => {
    await grant();
    const provider = fakeProvider(okResult);
    const result = await execute(parameters({ originPolicy: "secret", value: "비밀" }), createJudgmentService(db, { provider }));
    expect(result.status).toBe(422);
    expect(result.body.error).toContain("blocked");
    expect(provider.calls).toBe(0);
    const rows = await db.select().from(judgmentCalls).where(eq(judgmentCalls.contextType, "agent_tool"));
    expect(rows.some((row) => row.outcome === "blocked")).toBe(true);
  });

function questions() {
  return parameters().questions;
}

describe("judgment stateWorkProductPath (workflow step context only)", () => {
  it("스텝 문맥에서 stateWorkProductPath 파일을 읽어 state.document로 판단하고 C0 마스킹을 통과한다", async () => {
    const { writeFile, mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "judgment-wp-"));
    const wp = join(dir, "draft.md");
    await writeFile(wp, "# 초안\n초보자용 개념 설명. 문의: owner@example.com\n", "utf8");

    const provider = fakeProvider(okResult);
    const service = createJudgmentService(db, { provider });
    const result = await execute(
      { stateWorkProductPath: wp, questions: questions() },
      service,
      randomUUID(),
      { agentId: null, workflowRunId: randomUUID(), stepRunId: randomUUID(), stepId: "judge-draft" },
    );

    expect(result.status).toBe(200);
    expect(provider.calls).toBe(1);
    const sentState = provider.lastInput?.state as Record<string, unknown>;
    expect(sentState.source).toBe("workflow_work_product");
    expect(String(sentState.document)).toContain("초보자용 개념 설명");
    expect(JSON.stringify(sentState)).not.toContain("owner@example.com");

    const data = result.body.data as Record<string, unknown>;
    const [audit] = await db.select().from(judgmentCalls).where(eq(judgmentCalls.id, data.auditId as string));
    expect(audit?.contextType).toBe("workflow_step");
    expect(audit?.inputState).toMatchObject({ source: "workflow_work_product" });
  });

  it("스텝 문맥이 아니면(에이전트 문맥) stateWorkProductPath 키 자체가 거부된다(파일 읽기 우회 방지)", async () => {
    await grant();
    const provider = fakeProvider(okResult);
    const result = await execute(
      { stateWorkProductPath: "/etc/hosts", questions: questions() },
      createJudgmentService(db, { provider }),
    );
    expect(result.status).toBe(422);
    expect(result.body.error).toContain("stateWorkProductPath");
    expect(provider.calls).toBe(0);
  });

  it("에이전트·스텝 문맥이 모두 없으면 신원 가드(403)가 파라미터 검사보다 먼저 발동한다", async () => {
    const provider = fakeProvider(okResult);
    const result = await execute(
      { stateWorkProductPath: "/etc/hosts", questions: questions() },
      createJudgmentService(db, { provider }),
      randomUUID(),
      { agentId: null },
    );
    expect(result.status).toBe(403);
    expect(provider.calls).toBe(0);
  });

  it("읽을 수 없는 경로는 422로 실패한다", async () => {
    const provider = fakeProvider(okResult);
    const result = await execute(
      { stateWorkProductPath: "/nonexistent/path/wp.md", questions: questions() },
      createJudgmentService(db, { provider }),
      randomUUID(),
      { agentId: null, workflowRunId: randomUUID(), stepRunId: randomUUID(), stepId: "s" },
    );
    expect(result.status).toBe(422);
    expect(result.body.error).toContain("not readable");
    expect(provider.calls).toBe(0);
  });

  it("state 없이 stateWorkProductPath만으로 판단할 수 있다", async () => {
    const { writeFile, mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "judgment-wp2-"));
    const wp = join(dir, "doc.txt");
    await writeFile(wp, "검토 대상 문서", "utf8");

    const provider = fakeProvider(okResult);
    const result = await execute(
      { stateWorkProductPath: wp, questions: questions() },
      createJudgmentService(db, { provider }),
      randomUUID(),
      { agentId: null, workflowRunId: randomUUID(), stepRunId: randomUUID(), stepId: "s2" },
    );
    expect(result.status).toBe(200);
    const sentState = provider.lastInput?.state as Record<string, unknown>;
    expect(sentState.document).toBe("검토 대상 문서");
  });
});

  it("mode:'observe'는 judgment 실패/차단/비활성도 200으로 마감해 워크플로우 런을 보호한다", async () => {
    const stepCtx = { agentId: null as string | null, workflowRunId: randomUUID(), stepRunId: randomUUID(), stepId: "observe-step" };
    // 게이트 off 시뮬레이션: provider가 disabled를 반환
    const disabledProvider = fakeProvider({ ...okResult, status: "disabled" });
    const r1 = await execute({ ...parameters(), mode: "observe" }, createJudgmentService(db, { provider: disabledProvider }), randomUUID(), stepCtx);
    expect(r1.status).toBe(200);
    expect((r1.body.data as Record<string, unknown>).outcome).toBe("disabled");

    // blocked 시뮬레이션
    const blockedProvider = fakeProvider({ ...okResult, status: "blocked", error: "blocked:test" });
    const r2 = await execute({ ...parameters(), mode: "observe" }, createJudgmentService(db, { provider: blockedProvider }), randomUUID(), stepCtx);
    expect(r2.status).toBe(200);
    expect((r2.body.data as Record<string, unknown>).outcome).toBe("blocked");

    // 정상 관측은 outcome=observed
    const okProvider = fakeProvider(okResult);
    const r3 = await execute({ ...parameters(), mode: "observe" }, createJudgmentService(db, { provider: okProvider }), randomUUID(), stepCtx);
    expect(r3.status).toBe(200);
    expect((r3.body.data as Record<string, unknown>).outcome).toBe("observed");

    // judge 모드(기본)는 기존 하드 실패 유지 — disabled → 503
    const r4 = await execute({ ...parameters(), mode: "judge" }, createJudgmentService(db, { provider: disabledProvider }), randomUUID(), stepCtx);
    expect(r4.status).toBe(503);
  });

  it("mode 값이 잘못되면 422", async () => {
    const provider = fakeProvider(okResult);
    const result = await execute({ ...parameters(), mode: "force" }, createJudgmentService(db, { provider }), randomUUID(), { agentId: null, workflowRunId: randomUUID(), stepId: "s" });
    expect(result.status).toBe(422);
    expect(result.body.error).toContain("mode");
  });
});
