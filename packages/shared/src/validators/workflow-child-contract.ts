// packages/shared/src/validators/workflow-child-contract.ts
//
// [purpose] descope v1(설계 §5 "shared workflow-child v1 validation") — workflow 타입 스텝의
//   정의 단계 계약 검증 전용 헬퍼. 공유 validator(workflow.ts)가 레거시 oversized 파일이라
//   이 로직을 여기로 분리해 성장을 제한한다. 0/false 를 포함한 정책 재시도 필드 공급 자체가
//   계약 위반이며, 침묵 무시/기본값 강등은 금지된다(D2 — 검증 거부 계약).
// [usage] workflowStepDefinitionSchema 의 superRefine 에서 nodeType 이 "workflow" 일 때 호출.
import { z } from "zod";

type StepRefineInput = {
  onFailure?: unknown;
  maxRetries?: unknown;
  graphRetryDelaySeconds?: unknown;
  graphRetryBackoff?: unknown;
  graphRetryJitter?: unknown;
};

/** workflow 스텝이 공급하면 안 되는 정책 재시도 필드 목록(메시지와 1:1 대응). */
const FORBIDDEN_RETRY_FIELDS: Array<[keyof StepRefineInput, string]> = [
  ["maxRetries", "maxRetries is not allowed on workflow steps"],
  ["graphRetryDelaySeconds", "graphRetryDelaySeconds is not allowed on workflow steps"],
  ["graphRetryBackoff", "graphRetryBackoff is not allowed on workflow steps"],
  ["graphRetryJitter", "graphRetryJitter is not allowed on workflow steps"],
];

/**
 * descope v1 D2 — workflow 스텝 정책 재시도 거부. onFailure:"retry" 와 모든 graph/maxRetries
 * 재시도 필드(0/false 포함)의 공급을 typed issue 로 거부한다. agent/tool 경로는 변경 없음.
 */
export function refineWorkflowChildStepContract(
  step: StepRefineInput,
  ctx: z.RefinementCtx,
): void {
  if (step.onFailure === "retry") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["onFailure"],
      message: "retry policy is not supported on workflow steps",
    });
  }
  for (const [field, message] of FORBIDDEN_RETRY_FIELDS) {
    if (step[field] !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    }
  }
}
