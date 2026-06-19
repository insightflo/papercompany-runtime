// server/src/services/missions/tool-step-failure.ts
//
// [파일 목적] workflow tool-step 실패 분류 로직. step/stepRun 증거에서 실패 className과
//   retry policy를 결정한다. missions.ts mega-file 회피를 위해 분리(self-contained).
// [주요 흐름] toolStepFailureEvidence(증거 수집) → classifyToolStepFailure(정규식 기반 분류).
// [외부 연결] consumer: missions.ts(ensureToolStepFailureRecoveryIssue). utils helpers + WorkflowStep + workflowStepRuns 의존.
// [수정시 주의] 새 실패 클래스/정책 추가 시 ToolStepFailureClass·ToolStepRetryPolicy union과 분기 동기화.
import { workflowStepRuns } from "@paperclipai/db";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import { asStringArray, asTrimmedString, isRecord } from "./utils.js";

export type ToolStepFailureClass =
  | "missing_file"
  | "permission_denied"
  | "auth_missing"
  | "rate_limit"
  | "timeout"
  | "parse_error"
  | "transient_or_external"
  | "input_contract"
  | "tool_bug_or_unknown"
  | "side_effect_risk";

export type ToolStepRetryPolicy =
  | "do_not_retry_until_config_fixed"
  | "do_not_retry_until_auth_configured"
  | "retry_with_bounded_backoff"
  | "manual_owner_decision_required"
  | "fix_input_contract_before_retry"
  | "inspect_tool_logs_before_retry";

export type ToolStepFailureClassification = {
  className: ToolStepFailureClass;
  retryPolicy: ToolStepRetryPolicy;
  rationale: string;
  requiredAction: string;
  evidence: string[];
};

export function getWorkflowStepToolNames(step: WorkflowStep | Record<string, unknown> | null | undefined): string[] {
  if (!step || !isRecord(step)) return [];
  const toolNames = [
    ...asStringArray(step.toolNames),
    ...asStringArray(step.tools),
  ];
  const singleToolName = asTrimmedString(step.toolName);
  if (singleToolName) toolNames.push(singleToolName);
  return Array.from(new Set(toolNames));
}

export function isIssueLessToolWorkflowStep(step: WorkflowStep | Record<string, unknown> | null | undefined, issueId: string | null): boolean {
  if (issueId) return false;
  if (!step || !isRecord(step)) return false;
  const type = asTrimmedString(step.type)?.toLowerCase();
  if (type === "tool") return true;
  return getWorkflowStepToolNames(step).length > 0 && !asTrimmedString(step.agentId);
}

export function toolStepFailureEvidence(stepRun: typeof workflowStepRuns.$inferSelect): string[] {
  const metadata = isRecord(stepRun.metadata) ? stepRun.metadata : {};
  const toolResult = isRecord(metadata.toolResult) ? metadata.toolResult : {};
  const values = [
    ["exitCode", toolResult.exitCode],
    ["error", toolResult.error],
    ["stderr", toolResult.stderr],
    ["stdout", toolResult.stdout],
    ["toolName", toolResult.toolName],
    ["lastDispatchErrorSummary", stepRun.lastDispatchErrorSummary],
  ];
  return values
    .map(([key, value]) => {
      const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
      if (!text) return null;
      return `${key}: ${text.slice(0, 2000)}`;
    })
    .filter((value): value is string => Boolean(value));
}

export function classifyToolStepFailure(
  step: WorkflowStep | Record<string, unknown> | null | undefined,
  stepRun: typeof workflowStepRuns.$inferSelect,
): ToolStepFailureClassification {
  const evidence = toolStepFailureEvidence(stepRun);
  const runtimeText = evidence.join("\n").toLowerCase();
  const stepText = [
    step && isRecord(step) ? asTrimmedString(step.id) : null,
    step && isRecord(step) ? asTrimmedString(step.name) : null,
    step && isRecord(step) ? asTrimmedString(step.description) : null,
    ...getWorkflowStepToolNames(step),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/(enoent|no such file or directory|can't open file|cannot find module|module not found)/i.test(runtimeText)) {
    return {
      className: "missing_file",
      retryPolicy: "do_not_retry_until_config_fixed",
      rationale: "The captured runtime output shows a missing file/module/path, so repeating the same command cannot recover it.",
      requiredAction: "Fix the command, cwd, tool registration, dependency install, or source path first; then verify the tool directly before resuming the workflow.",
      evidence,
    };
  }
  if (/(permission denied|eacces|operation not permitted|not executable)/i.test(runtimeText)) {
    return {
      className: "permission_denied",
      retryPolicy: "do_not_retry_until_config_fixed",
      rationale: "The captured runtime output shows a local permission/executable problem.",
      requiredAction: "Fix file permissions, executable bits, sandbox access, or credential file access before retrying.",
      evidence,
    };
  }
  if (/(unauthorized|forbidden|authentication|auth|api key|token|credential|401|403)/i.test(runtimeText)) {
    return {
      className: "auth_missing",
      retryPolicy: "do_not_retry_until_auth_configured",
      rationale: "The captured runtime output points at missing or rejected credentials.",
      requiredAction: "Configure or refresh the required credentials/secrets, then run a narrow credential check before retrying.",
      evidence,
    };
  }
  if (/(rate limit|too many requests|http 429|\b429\b|quota exceeded)/i.test(runtimeText)) {
    return {
      className: "rate_limit",
      retryPolicy: "retry_with_bounded_backoff",
      rationale: "The captured runtime output shows provider throttling.",
      requiredAction: "Retry only with bounded backoff after confirming provider limits and avoiding duplicate side effects.",
      evidence,
    };
  }
  if (/(timed out|timeout|etimedout|deadline exceeded|socket hang up)/i.test(runtimeText)) {
    return {
      className: "timeout",
      retryPolicy: "retry_with_bounded_backoff",
      rationale: "The captured runtime output shows an execution or provider timeout.",
      requiredAction: "Check whether partial side effects occurred, then retry with bounded backoff only if the step is idempotent or safe.",
      evidence,
    };
  }
  if (/(syntaxerror|json\.parse|unexpected token|invalid json|parse error|bad control character)/i.test(runtimeText)) {
    return {
      className: "parse_error",
      retryPolicy: "fix_input_contract_before_retry",
      rationale: "The captured runtime output shows parsing or serialization failure.",
      requiredAction: "Fix the malformed input/output contract or parser expectation before retrying.",
      evidence,
    };
  }

  if (/\b(send|telegram|slack|email|publish|upload|post|deploy|write|mutat|trade|order)\b/.test(stepText)) {
    return {
      className: "side_effect_risk",
      retryPolicy: "manual_owner_decision_required",
      rationale: "The tool name or description suggests an external side effect, so retry can duplicate delivery or mutation.",
      requiredAction: "Inspect tool logs and side-effect evidence first; require an explicit owner decision before retrying.",
      evidence,
    };
  }
  if (/\b(schema|contract|input|argument|arg|payload|validation|required|missing)\b/.test(stepText)) {
    return {
      className: "input_contract",
      retryPolicy: "fix_input_contract_before_retry",
      rationale: "The step metadata points at a likely input or payload contract failure.",
      requiredAction: "Repair the upstream input contract or workflow step arguments before resuming the failed step.",
      evidence,
    };
  }
  if (/\b(fetch|collect|crawl|scrape|scan|search|api|http|network|timeout|rate|external)\b/.test(stepText)) {
    return {
      className: "transient_or_external",
      retryPolicy: "retry_with_bounded_backoff",
      rationale: "The step appears to depend on external collection or network access.",
      requiredAction: "Check provider availability/rate limits and retry only with bounded backoff when the external condition is clear.",
      evidence,
    };
  }
  return {
    className: "tool_bug_or_unknown",
    retryPolicy: "inspect_tool_logs_before_retry",
    rationale: "The failed tool step has no linked issue and no persisted error detail that proves a safe retry path.",
    requiredAction: "Inspect tool runtime logs; if the tool implementation failed, create/fix the tool bug before resuming the mission.",
    evidence,
  };
}
