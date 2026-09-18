import type { Db } from "@paperclipai/db";
import type { JudgmentAnswer, JudgmentAskState, JudgmentQuestion } from "@paperclipai/shared";
import { judgmentQuestionSchema } from "@paperclipai/shared";
import type { CoreWorkflowToolExecutionResult } from "../workflow/core-tool-executor.js";
import { createJudgmentService, type JudgmentService } from "./judgment-service.js";

const MAX_STATE_SERIALIZED_CHARS = 120_000;

type JsonRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.every((item) => isJsonValue(item, ancestors));
    if (!isPlainRecord(value)) return false;
    return Object.values(value).every((item) => isJsonValue(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

function parseState(value: unknown): { state: JudgmentAskState } | { error: string } {
  const isSupportedShape = typeof value === "string"
    || (Array.isArray(value) && value.every((item) => typeof item === "string"))
    || isPlainRecord(value);
  if (!isSupportedShape || !isJsonValue(value)) {
    return { error: "state must be a JSON string, object, or string array" };
  }

  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") return { error: "state must be JSON serializable" };
  if (serialized.length > MAX_STATE_SERIALIZED_CHARS) {
    return { error: "state exceeds " + MAX_STATE_SERIALIZED_CHARS + " serialized characters" };
  }
  return { state: value as JudgmentAskState };
}

function parseQuestions(value: unknown): { questions: JudgmentQuestion[] } | { error: string } {
  if (!isPlainRecord(value) || Object.keys(value).length === 0) {
    return { error: "questions must be a non-empty object" };
  }
  const questions: JudgmentQuestion[] = [];
  for (const [name, raw] of Object.entries(value)) {
    if (name.length === 0 || !isPlainRecord(raw) || Object.prototype.hasOwnProperty.call(raw, "name")) {
      return { error: "question '" + name + "' has an invalid shape" };
    }
    const parsed = judgmentQuestionSchema.safeParse({ name, ...raw });
    if (!parsed.success) return { error: "question '" + name + "' has an invalid shape" };
    questions.push(parsed.data);
  }
  return { questions };
}

function parseInput(parameters: unknown):
  | { state: JudgmentAskState; questions: JudgmentQuestion[] }
  | { error: string } {
  if (!isPlainRecord(parameters)) return { error: "parameters must be an object" };
  if (Object.keys(parameters).some((key) => key !== "state" && key !== "questions")) {
    return { error: "parameters may contain only state and questions" };
  }
  const state = parseState(parameters.state);
  if ("error" in state) return state;
  const questions = parseQuestions(parameters.questions);
  if ("error" in questions) return questions;
  return { state: state.state, questions: questions.questions };
}

function invalidInput(toolName: string, error: string): CoreWorkflowToolExecutionResult {
  return {
    status: 422,
    body: { error: "Invalid judgment input: " + error, tool: toolName, source: "core" },
  };
}

function answerSummary(answers: JudgmentAnswer[]): string {
  return answers
    .map((answer) => answer.name + "=" + String(answer.value) + " (confidence=" + (answer.confidence ?? "n/a") + ")")
    .join("; ");
}

export async function executeAgentJudgmentTool(input: {
  db: Db;
  companyId: string;
  toolName: string;
  parameters: unknown;
  requestId: string;
  judgmentService?: JudgmentService;
}): Promise<CoreWorkflowToolExecutionResult> {
  const parsed = parseInput(input.parameters);
  if ("error" in parsed) return invalidInput(input.toolName, parsed.error);

  const service = input.judgmentService ?? createJudgmentService(input.db);
  const result = await service.askJudgment({
    companyId: input.companyId,
    definitionName: "agent-judgment",
    contextType: "agent_tool",
    contextId: input.requestId,
    state: parsed.state,
    questions: parsed.questions,
    mode: "observed",
  });

  if (result.status === "disabled" || result.error === "gate_disabled" || result.error === "missing_api_key") {
    return { status: 503, body: { error: "judgment layer disabled", tool: input.toolName, source: "core" } };
  }
  if (result.status === "blocked") {
    return {
      status: 422,
      body: {
        error: result.error ?? result.message ?? "judgment blocked",
        tool: input.toolName,
        source: "core",
      },
    };
  }
  if (result.status !== "observed") {
    return {
      status: 500,
      body: {
        error: result.error ?? result.message ?? "judgment failed",
        tool: input.toolName,
        source: "core",
      },
    };
  }

  const answers = result.answers ?? [];
  const confidences = Object.fromEntries(
    answers
      .filter((answer) => typeof answer.confidence === "number")
      .map((answer) => [answer.name, answer.confidence]),
  );
  return {
    status: 200,
    body: {
      content: answerSummary(answers),
      data: {
        answers,
        confidence: result.confidence ?? null,
        confidences,
        egress: result.egress
          ? { status: result.egress.status, findings: result.egress.findings }
          : { status: "checked_no_findings", findings: [] },
        auditId: result.auditId,
      },
      tool: input.toolName,
      source: "core",
    },
  };
}
