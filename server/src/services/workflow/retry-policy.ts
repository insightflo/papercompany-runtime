// server/src/services/workflow/retry-policy.ts
//
// Pure, database-free workflow step retry policy and classifier.
// The DAG engine and terminal classifier share these helpers so retry
// arithmetic lives in exactly one place.

const MAX_RETRY_DELAY_SECONDS = 86_400; // 24 hours

export type WorkflowRetryBackoff = "fixed" | "linear" | "exponential";

export interface WorkflowRetryPolicy {
  enabled: boolean;
  maxRetries: number;
  delaySeconds: number;
  backoff: WorkflowRetryBackoff;
  jitter: boolean;
}

export type WorkflowStepRetryDecision =
  | { eligible: true; retryNumber: number; maxRetries: number; delaySeconds: number }
  | {
      eligible: false;
      reason:
        | "disabled"
        | "exhausted"
        | "unsupported_step"
        | "control_node"
        | "qa_rework"
        | "recovery_active"
        | "malformed_state";
    };

export interface WorkflowRetryPolicySource {
  onFailure?: string;
  maxRetries?: number;
  graphRetryDelaySeconds?: number;
  graphRetryBackoff?: string;
  graphRetryJitter?: boolean;
}

/**
 * Normalize a step definition's retry fields into a fully resolved policy.
 * - onFailure "retry" is the only setting that enables generic retries.
 * - maxRetries omitted → 2; explicit 0 → disabled.
 * - delay omitted → 0; backoff omitted → fixed; jitter omitted → false.
 */
export function normalizeWorkflowRetryPolicy(source: WorkflowRetryPolicySource): WorkflowRetryPolicy {
  const onFailure = typeof source.onFailure === "string" ? source.onFailure.trim() : "";
  const enabled = onFailure === "retry";

  const rawMax = typeof source.maxRetries === "number" && Number.isFinite(source.maxRetries)
    ? Math.floor(source.maxRetries)
    : undefined;
  const maxRetries = rawMax !== undefined && rawMax >= 0 ? rawMax : 2;

  const rawDelay = typeof source.graphRetryDelaySeconds === "number" && Number.isFinite(source.graphRetryDelaySeconds)
    ? Math.floor(source.graphRetryDelaySeconds)
    : 0;
  const delaySeconds = rawDelay >= 0 ? rawDelay : 0;

  const rawBackoff = typeof source.graphRetryBackoff === "string" ? source.graphRetryBackoff.trim().toLowerCase() : "";
  const backoff: WorkflowRetryBackoff =
    rawBackoff === "linear" || rawBackoff === "exponential" ? rawBackoff : "fixed";

  const jitter = source.graphRetryJitter === true;

  return {
    enabled: enabled && maxRetries > 0,
    maxRetries,
    delaySeconds,
    backoff,
    jitter,
  };
}

/**
 * Calculate the delay in seconds for retry number `n` (starting at 1).
 * - fixed:      base
 * - linear:     base * n
 * - exponential: base * 2^(n-1)
 * Jitter applies a factor in [0.8, 1.2] before the 24-hour cap.
 * A base delay of 0 always produces 0, including when jitter is enabled.
 */
export function calculateWorkflowRetryDelaySeconds(
  policy: Pick<WorkflowRetryPolicy, "delaySeconds" | "backoff" | "jitter">,
  retryNumber: number,
  random: () => number = Math.random,
): number {
  const n = retryNumber >= 1 ? retryNumber : 1;
  const base = policy.delaySeconds;

  if (base === 0) return 0;

  let raw: number;
  switch (policy.backoff) {
    case "linear":
      raw = base * n;
      break;
    case "exponential":
      raw = base * 2 ** (n - 1);
      break;
    default:
      raw = base;
      break;
  }

  if (policy.jitter) {
    const factor = 0.8 + random() * 0.4; // [0.8, 1.2]
    raw = raw * factor;
  }

  return Math.min(Math.floor(raw), MAX_RETRY_DELAY_SECONDS);
}

export interface WorkflowStepRetryClassificationInput {
  policy: WorkflowRetryPolicy;
  stepRunStatus: string;
  retryCount: number;
  isControlNode: boolean;
  /** True only for ordinary issue-backed agent/legacy steps and issue-less
   *  tool steps. Unknown node types are unsupported and fail closed. */
  stepTypeSupported: boolean;
  isQaStep: boolean;
  qaRequestChanges: boolean;
  recoveryActive: boolean;
}
/**
 * Pure decision: should a failed step be retried via generic workflow retry?
 * Returns eligible + the computed retry number and delay, or an explicit
 * exclusion reason. Fail-closed: ambiguous recovery state → recovery_active;
 * unknown step kinds → unsupported_step/control_node.
 */
export function classifyWorkflowStepRetry(
  input: WorkflowStepRetryClassificationInput,
  random: () => number = Math.random,
): WorkflowStepRetryDecision {
  if (input.isControlNode) {
    return { eligible: false, reason: "control_node" };
  }
  // Unknown/unsupported node types (anything that is not an ordinary
  // agent/legacy or tool step) must never be generically retried.
  if (!input.stepTypeSupported) {
    return { eligible: false, reason: "unsupported_step" };
  }
  if (!input.policy.enabled) {
    return { eligible: false, reason: "disabled" };
  }
  if (input.stepRunStatus !== "failed") {
    return { eligible: false, reason: "malformed_state" };
  }
  if (input.isQaStep && input.qaRequestChanges) {
    return { eligible: false, reason: "qa_rework" };
  }

  if (input.recoveryActive) {
    return { eligible: false, reason: "recovery_active" };
  }
  const nextRetryNumber = input.retryCount + 1;
  if (nextRetryNumber > input.policy.maxRetries) {
    return { eligible: false, reason: "exhausted" };
  }

  const delaySeconds = calculateWorkflowRetryDelaySeconds(input.policy, nextRetryNumber, random);

  return {
    eligible: true,
    retryNumber: nextRetryNumber,
    maxRetries: input.policy.maxRetries,
    delaySeconds,
  };
}

// ── Retry metadata compatibility exports ───────────────────────────

export {
  appendRetryAttempt,
  buildWorkflowRetryMetadata,
  hasMalformedWorkflowRetry,
  isStepRunAwaitingRetry,
  isWorkflowRetryDue,
  readWorkflowRetryMetadata,
  sanitizeErrorSummary,
} from "./retry-metadata.js";
export type {
  WorkflowRetryAttemptSummary,
  WorkflowRetryMetadata,
  WorkflowRetryMetadataState,
} from "./retry-metadata.js";
