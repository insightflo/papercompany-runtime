// server/src/services/workflow/run-terminal-boundary-cause.ts
//
// [run-terminal-boundary v1] 종결 결정의 공개 타입과 원인 조합 검증.
// 결정/정책/발견 경로 조합은 계약으로 고정되며, 계약 밖 조합은 RangeError 로 조기 실패한다.

import { workflowRuns, type Db } from "@paperclipai/db";
import type { RecoveryChannelEvidence } from "./run-terminal-recovery-gate.js";

export type TerminalDecisionValue = "failed" | "cancelled" | "completed";
export type TerminalPolicyCause =
  | "operator_cancel"
  | "budget_hard_stop"
  | "recovery_deadline_hard"
  | "outcome_convergence";
export type TerminalDiscoveryPath =
  | "engine_recompute"
  | "engine_failure"
  | "deadlock_detection"
  | "stuck_diagnostic";
export type TerminalDecisionOrigin = "dag_engine" | "reconciler" | "deadlock_reconciler";

export interface TerminalCauseInput {
  policy: TerminalPolicyCause;
  discovery: TerminalDiscoveryPath;
  origin: TerminalDecisionOrigin;
  reason?: string;
}

/** finalize/게이트가 필요로 하는 stepRun 최소 참조(전체 행 아님). */
export interface TerminalStepRunRef {
  id: string;
  stepId: string;
  issueId: string | null;
  status: string;
  metadata: unknown;
}

export interface FinalizeRunTerminalInput {
  runId: string;
  companyId: string;
  expectedAuthorityVersion: number;
  decision: TerminalDecisionValue;
  cause: TerminalCauseInput;
  gatePolicy: "defer_on_open_recovery" | "immediate";
  now: Date;
  stepRuns: readonly TerminalStepRunRef[];
  triggerHeartbeatRunId?: string | null;
  /** true ⇒ 런타임 캡처/kill 생략(기존 dynamic owner plan 제외 규칙과 동일). */
  dynamicOwnerPlanCompleted?: boolean;
}

export type TerminalFinalizeResult =
  | {
    kind: "finalized";
    decisionId: string;
    decision: TerminalDecisionValue;
    decidedAuthorityVersion: number;
    effectIntentCount: number;
    run: typeof workflowRuns.$inferSelect;
  }
  | {
    kind: "deferred";
    gateKind: "open" | "unknown";
    evidence?: RecoveryChannelEvidence[];
    gateError?: string;
    run: typeof workflowRuns.$inferSelect;
  }
  | {
    kind: "stale_authority";
    expectedAuthorityVersion: number;
    currentAuthorityVersion: number;
    run: typeof workflowRuns.$inferSelect;
  }
  | {
    kind: "already_finalized";
    currentStatus: string;
    existingDecision: { id: string; decision: TerminalDecisionValue } | null;
    run: typeof workflowRuns.$inferSelect;
  };

type TxExecutor = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** 트랜잭션 안/밖 모두에서 평가 가능한 실행기(terminal-cleanup-fence 의 Db 합 타입과 동일 패턴). */
export type TerminalBoundaryDb = Db | TxExecutor;

export const TERMINAL_RUN_STATUSES = ["completed", "cancelled", "aborted", "failed", "timed-out"] as const;
export const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
export const ACTIVE_HEARTBEAT_STATUSES = ["queued", "running"] as const;

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

const DECISION_POLICY_CAUSES: Record<TerminalDecisionValue, readonly TerminalPolicyCause[]> = {
  cancelled: ["operator_cancel", "outcome_convergence"],
  failed: ["budget_hard_stop", "recovery_deadline_hard", "outcome_convergence"],
  completed: ["outcome_convergence"],
};

/** 결정/정책/발견 경로 조합 검증 — 계약 밖 조합은 RangeError 로 조기 실패한다. */
export function validateTerminalCause(cause: TerminalCauseInput, decision: TerminalDecisionValue): void {
  if (!DECISION_POLICY_CAUSES[decision].includes(cause.policy)) {
    throw new RangeError(`terminal decision ${decision} does not allow policy ${cause.policy}`);
  }
  if (decision === "completed" && cause.discovery !== "engine_recompute") {
    throw new RangeError(`terminal decision completed requires discovery engine_recompute, got ${cause.discovery}`);
  }
  if (cause.discovery === "deadlock_detection") {
    if (cause.origin !== "deadlock_reconciler" || cause.policy !== "recovery_deadline_hard") {
      throw new RangeError(
        "discovery deadlock_detection requires origin deadlock_reconciler and policy recovery_deadline_hard",
      );
    }
  }
  if (cause.discovery === "stuck_diagnostic") {
    if (cause.origin !== "reconciler" || cause.policy !== "recovery_deadline_hard") {
      throw new RangeError(
        "discovery stuck_diagnostic requires origin reconciler and policy recovery_deadline_hard",
      );
    }
  }
}
