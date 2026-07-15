// server/src/services/workflow/control-flow/structural-completion.ts
//
// [ purpose ] Structural gate completion helpers extracted from dag-engine.ts
//   to keep the legacy file from growing. Contains: strict callback requestId
//   guard, verdict handling logic, and verdict persistence invocation.

import type { WorkflowStep } from "../dag-engine.js";
import { and, eq, isNull } from "drizzle-orm";
import { workflowStepRuns } from "@paperclipai/db";
import { isStructuralGateStep } from "./structural-gate.js";
import {
  parseStructuralGateVerdict,
  recordStructuralGateVerdict,
  type StructuralGateVerdict,
} from "./structural-gate-ledger.js";
import type { StructuralGateProducerToken } from "./structural-gate.js";

export { isStructuralGateStep, parseStructuralGateVerdict };

export interface StructuralCompletionResult {
  structuralGateRejected: boolean;
  structuralContractFailure: boolean;
  effectiveSuccess: boolean;
}

/**
 * Strict callback guard for structural gates. Requires BOTH callback requestId
 * and stored lastDispatchRequestId to be non-null and exactly equal.
 * Returns true if the callback should be rejected.
 */
export function shouldRejectStructuralCallback(
  step: WorkflowStep | undefined,
  inputRequestId: string | undefined,
  storedRequestId: string | null,
): boolean {
  if (!isStructuralGateStep(step)) return false;
  if (!inputRequestId || !storedRequestId) return true;
  return inputRequestId !== storedRequestId;
}

/**
 * PURE structural completion plan: parses the verdict from tool result data and
 * derives effective status/flags with NO DB or ledger write. Use this to build
 * the status patch; the authoritative verdict is recorded exactly once, inside
 * the atomic transaction (atomicStructuralCompletion). Never pre-write the
 * ledger — a pre-tx write cannot be rolled back on CAS loss and leaves an orphan
 * verdict row with no matching step status update.
 *
 * Conflict resolution against an existing ledger row happens ONLY inside the
 * atomic transaction. Duplicate same-request callbacks carry identical tool
 * results, so the parsed verdict here equals the authoritative verdict recorded
 * in-tx; the patch built from this plan is therefore consistent with the
 * committed authoritative verdict.
 */
export function planStructuralCompletion(input: {
  step: WorkflowStep | undefined;
  success: boolean;
  data: unknown;
}): StructuralCompletionResult & { verdict: StructuralGateVerdict | null } {
  const { step, success, data } = input;
  const verdict = success && isStructuralGateStep(step) ? parseStructuralGateVerdict(data) : null;
  return { ...deriveStructuralCompletion(success, step, verdict), verdict };
}

function deriveStructuralCompletion(
  success: boolean,
  step: WorkflowStep | undefined,
  verdict: StructuralGateVerdict | null,
): StructuralCompletionResult {
  const structuralGateRejected = verdict === "request_changes";
  const structuralContractFailure = success && isStructuralGateStep(step) && verdict === null;
  const effectiveSuccess = success && !structuralGateRejected && !structuralContractFailure;
  return { structuralGateRejected, structuralContractFailure, effectiveSuccess };
}

export interface AtomicStructuralResult extends StructuralCompletionResult {
  /** true if this callback's CAS won and the step was updated; false if it lost the race. */
  casWon: boolean;
}

/**
 * Atomic structural gate completion: records the official verdict ledger row
 * and updates workflow_step_runs in ONE db.transaction.
 *
 * The step update CAS-locks against the exact observed callback state:
 * id, status, iterationIndex, lastDispatchRequestId (null-safe), completedAt (null-safe).
 * If it loses the CAS race, the transaction rolls back any new ledger row and
 * the newer step row is preserved untouched.
 *
 * Structural callbacks require non-empty requestId. The ledger idempotency key
 * and conflict lookup are exact to (companyId, workflowStepRunId, requestId).
 */
export async function atomicStructuralCompletion(input: {
  db: import("@paperclipai/db").Db;
  step: WorkflowStep | undefined;
  success: boolean;
  data: unknown;
  companyId: string;
  workflowRunId: string;
  workflowStepRunId: string;
  missionId?: string | null;
  requestId: string; // required non-empty for structural gates
  /** Observed step run state for CAS */
  observedStatus: string;
  observedIterationIndex: number | null;
  observedRequestId: string | null;
  observedCompletedAt: Date | null;
  /** Captured at dispatch; binds this verdict to the producer generation. */
  producerToken: StructuralGateProducerToken | null;
  /** Immutable callback details. The status/error portion is derived inside
   * the transaction from the authoritative (possibly conflict-resolved)
   * ledger verdict, never from an untrusted duplicate callback. */
  patch: {
    startedAt: Date;
    completedAt: Date;
    metadata: Record<string, unknown>;
    fallbackFailureSummary: string | null;
  };
}): Promise<AtomicStructuralResult> {
  const {
    db, step, success, data, companyId, workflowRunId,
    workflowStepRunId, missionId, requestId,
    observedStatus, observedIterationIndex, observedRequestId, observedCompletedAt, producerToken,
    patch,
  } = input;

  const structuralVerdict = success && isStructuralGateStep(step) && producerToken
    ? parseStructuralGateVerdict(data)
    : null;

  let effectiveVerdict: StructuralGateVerdict | null = structuralVerdict;
  let casWon = true;

  await db.transaction(async (tx) => {
    // 1. Record verdict ledger row (onConflictDoNothing within tx)
    if (structuralVerdict !== null && producerToken) {
      const ledgerResult = await recordStructuralGateVerdict({
        db: tx,
        companyId,
        workflowRunId,
        workflowStepRunId,
        missionId,
        verdict: structuralVerdict,
        toolResultData: data,
        requestId,
        producerToken,
      });
      effectiveVerdict = ledgerResult.authoritativeVerdict;
    }

    const completion = deriveStructuralCompletion(success, step, effectiveVerdict);

    // 2. CAS update step run — exact observed state match. This runs after
    // exact request-scoped conflict resolution, so status always follows the
    // official ledger row rather than an incoming duplicate callback body.
    const casConditions = [
      eq(workflowStepRuns.id, workflowStepRunId),
      eq(workflowStepRuns.status, observedStatus),
      eq(workflowStepRuns.iterationIndex, observedIterationIndex ?? 0),
    ];
    if (observedRequestId) {
      casConditions.push(eq(workflowStepRuns.lastDispatchRequestId, observedRequestId));
    } else {
      casConditions.push(isNull(workflowStepRuns.lastDispatchRequestId));
    }
    if (observedCompletedAt) {
      casConditions.push(eq(workflowStepRuns.completedAt, observedCompletedAt));
    } else {
      casConditions.push(isNull(workflowStepRuns.completedAt));
    }

    const casResult = await tx.update(workflowStepRuns).set({
      status: completion.effectiveSuccess ? "completed" : "failed",
      startedAt: patch.startedAt,
      completedAt: patch.completedAt,
      lastDispatchErrorAt: completion.effectiveSuccess ? null : patch.completedAt,
      lastDispatchErrorSummary: completion.effectiveSuccess ? null
        : completion.structuralGateRejected ? "structural_gate_request_changes"
        : completion.structuralContractFailure ? "structural_gate_contract_failure"
        : patch.fallbackFailureSummary,
      metadata: patch.metadata,
    }).where(and(...casConditions)).returning({ id: workflowStepRuns.id });

    if (casResult.length === 0) {
      // CAS lost — a newer row exists. Throwing rolls back the ledger insert
      // (if this callback inserted a new row) and leaves the newer step untouched.
      casWon = false;
      throw new Error("STRUCTURAL_CAS_LOST");
    }
  }).catch((err) => {
    // Only swallow the expected CAS-lost signal
    if (err instanceof Error && err.message === "STRUCTURAL_CAS_LOST") return;
    throw err;
  });

  return { ...deriveStructuralCompletion(success, step, effectiveVerdict), casWon };
}


export interface DependencyFreshnessResult {
  allFound: boolean;
  allDone: boolean;
  maxCompletedAt: number;
}

/**
 * Checks dependency freshness for validation recheck, tolerating issue-less
 * structural tool step dependencies. For deps with issueId, checks issue
 * status === "done". For deps without issueId (issue-less tool steps),
 * checks stepRun status === "completed".
 */
export function checkDependencyFreshness(
  dependencies: readonly string[],
  stepRunByStepId: ReadonlyMap<string, { issueId: string | null; status: string; completedAt?: Date | null }>,
  issueById: ReadonlyMap<string, { status: string; completedAt?: Date | null }>,
): DependencyFreshnessResult {
  let allFound = true;
  let allDone = true;
  let maxCompletedAt = 0;

  for (const depId of dependencies) {
    const depRun = stepRunByStepId.get(depId);
    if (!depRun) { allFound = false; continue; }
    if (depRun.issueId) {
      const depIssue = issueById.get(depRun.issueId);
      if (!depIssue) { allFound = false; allDone = false; continue; }
      if (depIssue.status !== "done") allDone = false;
      const t = depIssue.completedAt?.getTime() ?? 0;
      if (t > 0) maxCompletedAt = Math.max(maxCompletedAt, t);
    } else {
      if (depRun.status !== "completed") allDone = false;
      const t = depRun.completedAt?.getTime() ?? 0;
      if (t > 0) maxCompletedAt = Math.max(maxCompletedAt, t);
    }
  }

  return { allFound, allDone, maxCompletedAt };
}
