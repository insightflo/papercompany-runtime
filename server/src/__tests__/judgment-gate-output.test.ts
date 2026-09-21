import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { JudgmentAskInput, JudgmentAskResult } from "@paperclipai/shared";
import { executeAgentJudgmentTool } from "../services/judgment/agent-judgment-tool-executor.js";
import type { JudgmentService } from "../services/judgment/judgment-service.js";

const outputDirs: string[] = [];

async function newOutputDir() {
  const dir = await mkdtemp(join(tmpdir(), "judgment-gate-output-"));
  outputDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(outputDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function service(result: JudgmentAskResult) {
  return {
    askJudgment: vi.fn(async (_input: JudgmentAskInput) => result),
  } as JudgmentService;
}

function execute(
  serviceValue: JudgmentService,
  stepContext: { stepOutputDir?: string | null } = {},
  mode: "judge" | "observe" = "judge",
) {
  return executeAgentJudgmentTool({
    db: {} as Db,
    companyId: randomUUID(),
    toolName: "judgment",
    parameters: {
      state: { input: "synthetic-voice-check" },
      questions: {
        risk: {
          type: "choice",
          instructions: "하위 검증 생략 가능 여부를 판단한다.",
          criteria: { low_risk: "검증 생략 가능", review: "검증 필요" },
        },
      },
      mode,
    },
    requestId: randomUUID(),
    workflowRunId: randomUUID(),
    stepRunId: randomUUID(),
    stepId: "judge",
    ...stepContext,
    judgmentService: serviceValue,
  });
}

describe("judgment workflow gate output", () => {
  it("writes the workflow artifact and returns its absolute path on successful judgment", async () => {
    const stepOutputDir = await newOutputDir();
    const result = await execute(service({
      status: "observed",
      answers: [{
        name: "risk",
        type: "choice",
        value: "low_risk",
        probabilities: { low_risk: 0.98, review: 0.02 },
        confidence: 0.98,
      }],
      confidence: 0.98,
      modelVersion: "test",
      usage: { inputTokens: 1, outputTokens: 1 },
      attempts: 1,
      latencyMs: 42,
    }), { stepOutputDir });

    expect(result.status).toBe(200);
    expect(result.artifactPath).toBe(join(stepOutputDir, "judgment-result.json"));
    const artifact = JSON.parse(await readFile(result.artifactPath!, "utf8")) as Record<string, unknown>;
    expect(artifact).toMatchObject({
      overall: "low_risk",
      probabilities: { low_risk: 0.98, review: 0.02 },
      answers: [{
        name: "risk",
        type: "choice",
        value: "low_risk",
        probabilities: { low_risk: 0.98, review: 0.02 },
        confidence: 0.98,
      }],
      outcome: "observed",
      latencyMs: 42,
    });
    expect(artifact.createdAt).toEqual(expect.any(String));
  });

  it("keeps observe soft success and writes no artifact when judgment is disabled", async () => {
    const stepOutputDir = await newOutputDir();
    const result = await execute(service({ status: "disabled" }), { stepOutputDir }, "observe");

    expect(result.status).toBe(200);
    expect(result.artifactPath).toBeUndefined();
    await expect(readFile(join(stepOutputDir, "judgment-result.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes no artifact without workflow step context", async () => {
    const result = await executeAgentJudgmentTool({
      db: {} as Db,
      companyId: randomUUID(),
      toolName: "judgment",
      parameters: {
        state: {},
        questions: {
          risk: {
            type: "choice",
            instructions: "하위 검증 생략 가능 여부를 판단한다.",
            criteria: { low_risk: "생략", review: "검증" },
          },
        },
      },
      requestId: randomUUID(),
      judgmentService: service({
        status: "observed",
        answers: [{ name: "risk", type: "choice", value: "low_risk", confidence: 0.9 }],
        confidence: 0.9,
        modelVersion: "test",
        usage: { inputTokens: 1, outputTokens: 1 },
        attempts: 1,
        latencyMs: 1,
      }),
    });

    expect(result.status).toBe(200);
    expect(result.artifactPath).toBeUndefined();
  });
});
