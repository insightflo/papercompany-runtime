import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { JudgmentAskInput, JudgmentAskResult } from "@paperclipai/shared";
import { executeAgentJudgmentTool } from "../services/judgment/agent-judgment-tool-executor.js";
import type { JudgmentService } from "../services/judgment/judgment-service.js";

const okResult: JudgmentAskResult = {
  status: "observed",
  answers: [],
  modelVersion: "test",
  usage: { inputTokens: 1, outputTokens: 1 },
  attempts: 1,
  latencyMs: 1,
};

function mockService(): JudgmentService & { askJudgment: ReturnType<typeof vi.fn> } {
  return {
    askJudgment: vi.fn(async (_input: JudgmentAskInput) => okResult),
  } as JudgmentService & { askJudgment: ReturnType<typeof vi.fn> };
}

function parameters(type: "choice" | "score" | "noul", criteria: unknown) {
  return {
    state: { plan: "작업 계획" },
    questions: {
      decision: { type, instructions: "판단한다.", criteria },
    },
  };
}

async function execute(parametersValue: unknown, service: JudgmentService) {
  return executeAgentJudgmentTool({
    db: {} as Db,
    companyId: randomUUID(),
    toolName: "judgment",
    parameters: parametersValue,
    requestId: randomUUID(),
    judgmentService: service,
  });
}

describe("judgment criteria type validation", () => {
  it("choice 배열 criteria 를 provider 호출 전에 거부한다", async () => {
    const service = mockService();
    const result = await execute(parameters("choice", ["PASS", "REQUEST_CHANGES"]), service);

    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).toContain("decision");
    expect(JSON.stringify(result.body)).toContain("got array");
    expect(JSON.stringify(result.body)).toContain("{label: description}");
    expect(service.askJudgment).toHaveBeenCalledTimes(0);
  });

  it("choice 객체 criteria 는 정상 실행한다", async () => {
    const service = mockService();
    const result = await execute(parameters("choice", { proceed: "진행" }), service);

    expect(result.status).toBe(200);
    expect(service.askJudgment).toHaveBeenCalledTimes(1);
  });

  it("score 배열 루브릭은 정상 실행한다", async () => {
    const service = mockService();
    const result = await execute(parameters("score", ["1점: 부족", "5점: 충분"]), service);

    expect(result.status).toBe(200);
    expect(service.askJudgment).toHaveBeenCalledTimes(1);
  });

  it("noul 배열 criteria 도 조기 거부한다(공식 계약은 {true,false} 객체)", async () => {
    const service = mockService();
    const result = await execute(parameters("noul", ["루브릭 아님"]), service);

    expect(result.status).toBe(422);
    expect(service.askJudgment).toHaveBeenCalledTimes(0);
  });

  it("score 객체 criteria 는 조기 거부한다(공식 계약은 루브릭 배열)", async () => {
    const service = mockService();
    const result = await execute(parameters("score", { high: "설명" }), service);

    expect(result.status).toBe(422);
    expect(service.askJudgment).toHaveBeenCalledTimes(0);
  });

  it("choice 문자열(레거시) criteria 도 조기 거부한다", async () => {
    const service = mockService();
    const result = await execute(parameters("choice", "통과 기준 설명"), service);

    expect(result.status).toBe(422);
    expect(service.askJudgment).toHaveBeenCalledTimes(0);
  });
});

  it("score 루브릭이 2개 미만이면 조기 거부한다", async () => {
    const service = mockService();
    const one = await execute(parameters("score", ["루브릭 1개"]), service);
    expect(one.status).toBe(422);
    expect(service.askJudgment).toHaveBeenCalledTimes(0);
  });
