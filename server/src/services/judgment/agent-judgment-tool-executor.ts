import { readFile } from "node:fs/promises";
import type { Db } from "@paperclipai/db";
import type { JudgmentAnswer, JudgmentAskState, JudgmentQuestion } from "@paperclipai/shared";
import { judgmentQuestionSchema } from "@paperclipai/shared";
import type { CoreWorkflowToolExecutionResult } from "../workflow/core-tool-executor.js";
import { createJudgmentService, type JudgmentService } from "./judgment-service.js";

const MAX_STATE_SERIALIZED_CHARS = 120_000;

// [판단 로더 강화] 엄격(fatal) utf8 디코더 — 유효하지 않은 바이트 시퀀스에서 즉시 예외.
//   대표 산출물이 바이너리(예: PNG)로 바뀌었을 때 mojibake 문자열로 직렬화되어 모델 호출
//   까지 진행되는 사고(런 56eb185e)를 직렬화 전에 차단한다.
const strictUtf8TextDecoder = new TextDecoder("utf-8", { fatal: true });

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

function parseInput(parameters: unknown, options: { allowWorkProductPath: boolean }):
  | { state: JudgmentAskState; questions: JudgmentQuestion[]; mode: "judge" | "observe"; stateWorkProductPath?: string }
  | { error: string } {
  if (!isPlainRecord(parameters)) return { error: "parameters must be an object" };
  const allowedKeys = new Set(["state", "questions", "mode"]);
  if (options.allowWorkProductPath) allowedKeys.add("stateWorkProductPath");
  const rejectedKeys = Object.keys(parameters).filter((key) => !allowedKeys.has(key));
  if (rejectedKeys.length > 0) {
    return {
      error: "parameters may contain only " + [...allowedKeys].sort().join(", ")
        + " (rejected: " + rejectedKeys.sort().join(", ") + ")"
        + (options.allowWorkProductPath ? "" : "; stateWorkProductPath requires workflow step context"),
    };
  }
  const workProductPath = parameters.stateWorkProductPath;
  if (workProductPath !== undefined
      && (typeof workProductPath !== "string" || workProductPath.trim().length === 0)) {
    return { error: "stateWorkProductPath must be a non-empty string" };
  }
  if (parameters.state === undefined && workProductPath === undefined) {
    return { error: "state is required" };
  }
  const mode = parameters.mode === undefined ? "judge" : parameters.mode;
  if (mode !== "judge" && mode !== "observe") {
    return { error: "mode must be 'judge' or 'observe'" };
  }
  if (parameters.state !== undefined) {
    const state = parseState(parameters.state);
    if ("error" in state) return state;
    const questions = parseQuestions(parameters.questions);
    if ("error" in questions) return questions;
    return {
      state: state.state,
      questions: questions.questions,
      mode,
      ...(typeof workProductPath === "string" ? { stateWorkProductPath: workProductPath } : {}),
    };
  }
  const questions = parseQuestions(parameters.questions);
  if ("error" in questions) return questions;
  return {
    state: {},
    questions: questions.questions,
    mode,
    ...(typeof workProductPath === "string" ? { stateWorkProductPath: workProductPath } : {}),
  };
}

/**
 * [보안] stateWorkProductPath 는 워크플로우 도구 스텝 문맥에서만 허용한다. 경로는 서버측
 * resolveWorkflowToolStepArgs 가 조상 스텝의 workProduct 로 해석한 값이며, 에이전트가
 * 임의 경로를 넘겨 파일을 읽는 우회를 막는다(스텝 문맥 없이 path 가 오면 parseInput 단계
 * 에서 거부). 읽은 내용은 C0 반출 통제(마스킹·집행점)를 그대로 통과한다.
 *
 * [판단 로더 강화] 파일은 Buffer 로 읽어 엄격(fatal) utf8 검증을 통과한 텍스트만 사용한다.
 *   유효하지 않은 바이트 시퀀스/NUL 제어바이트 → artifact_type_mismatch 로 직렬화 전 즉시
 *   실패. 크기 예산(120k 자) 검사는 직렬화 전에 수행하며 초과분은 artifact_state_too_large
 *   로 실패한다(상한 인상·자동 절단 없음). 식별 가능한 코드로 감독 루프가 원인(대표 오등록
 *   등의 입력 계약 위반 vs 예산 초과)을 구분할 수 있다.
 */
async function readWorkProductState(
  filePath: string,
  base: JudgmentAskState,
): Promise<{ state: JudgmentAskState } | { error: string }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    return { error: "stateWorkProductPath is not readable" };
  }
  let content: string;
  try {
    content = strictUtf8TextDecoder.decode(bytes);
  } catch {
    return { error: `artifact_type_mismatch: ${filePath} is not decodable as UTF-8 text` };
  }
  // 유효 utf8 로 디코딩되더라도 NUL 바이트는 텍스트 state 문서에 정상적으로 나타나지 않는다.
  if (bytes.includes(0)) {
    return { error: `artifact_type_mismatch: ${filePath} is not decodable as UTF-8 text` };
  }
  if (content.length > MAX_STATE_SERIALIZED_CHARS) {
    return {
      error: `artifact_state_too_large: stateWorkProductPath content exceeds ${MAX_STATE_SERIALIZED_CHARS} characters`,
    };
  }
  const merged: Record<string, unknown> = {
    ...(isPlainRecord(base) ? base : { state: base }),
    source: "workflow_work_product",
    document: content,
  };
  const serialized = JSON.stringify(merged);
  if (typeof serialized !== "string") return { error: "state must be JSON serializable" };
  if (serialized.length > MAX_STATE_SERIALIZED_CHARS) {
    return { error: `artifact_state_too_large: state exceeds ${MAX_STATE_SERIALIZED_CHARS} serialized characters` };
  }
  return { state: merged as JudgmentAskState };
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
  workflowRunId?: string | null;
  stepRunId?: string | null;
  stepId?: string | null;
  judgmentService?: JudgmentService;
}): Promise<CoreWorkflowToolExecutionResult> {
  const workflowRunId = input.workflowRunId?.trim() || null;
  const stepRunId = input.stepRunId?.trim() || null;
  const stepId = input.stepId?.trim() || null;
  const isWorkflowStepContext = Boolean(workflowRunId && stepId);
  const parsed = parseInput(input.parameters, { allowWorkProductPath: isWorkflowStepContext });
  if ("error" in parsed) return invalidInput(input.toolName, parsed.error);

  const service = input.judgmentService ?? createJudgmentService(input.db);
  const contextType = isWorkflowStepContext ? "workflow_step" : "agent_tool";
  const contextId = isWorkflowStepContext
    ? `wfr:${workflowRunId}:step:${stepRunId ?? stepId}`
    : input.requestId;
  // 같은 스텝의 재시도는 judgment_calls에 각각 한 행을 남긴다. 같은 correlationKey를
  // 공유하지만 correlationKey는 비유니크 인덱스이므로 여러 행을 허용한다.
  let state = parsed.state;
  if (parsed.stateWorkProductPath !== undefined) {
    const read = await readWorkProductState(parsed.stateWorkProductPath, parsed.state);
    if ("error" in read) return invalidInput(input.toolName, read.error);
    state = read.state;
  }
  const result = await service.askJudgment({
    companyId: input.companyId,
    definitionName: "agent-judgment",
    contextType,
    contextId,
    state,
    questions: parsed.questions,
    mode: "observed",
  });

  // [B-4.2] observe 모드(워크플로우 관측 스텝 전용 소프트 성공): judgment 호출이 실패해도
  //   스텝은 성공으로 마감해 운영 워크플로우 런을 보호한다. 오류·차단·비활성은
  //   judgment_calls 감사행과 body.data.outcome 에 기록된다(스텝 실패 아님).
  //   observe 는 스텝 문맥에서만 의도된 용도라도 에이전트가 쓸 수는 있다 — 이때도
  //   판단은 여전히 권고일 뿐이므로 안전하다(mode 파라미터는 판단에 영향 없음).
  const observeFailure = (outcome: string, detail: string): CoreWorkflowToolExecutionResult => ({
    status: 200,
    body: {
      content: "judgment observation " + outcome + ": " + detail,
      data: { outcome, detail },
      tool: input.toolName,
      source: "core",
    },
  });
  if (parsed.mode === "observe") {
    if (result.status === "disabled" || result.error === "gate_disabled" || result.error === "missing_api_key") {
      return observeFailure("disabled", "judgment layer disabled");
    }
    if (result.status === "blocked") {
      return observeFailure("blocked", result.error ?? result.message ?? "judgment blocked");
    }
    if (result.status !== "observed") {
      return observeFailure("error", result.error ?? result.message ?? "judgment failed");
    }
  } else {
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
        outcome: "observed",
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
