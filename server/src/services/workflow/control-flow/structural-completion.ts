// server/src/services/workflow/control-flow/structural-completion.ts
//
// [ purpose ] Structural gate completion helpers extracted from dag-engine.ts
//   to keep the legacy file from growing. Contains: strict callback requestId
//   guard, verdict handling logic, and verdict persistence invocation.

import type { WorkflowStep } from "../dag-engine.js";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../../../errors.js";
import { isStructuralGateStep } from "./structural-gate.js";
import {
  parseStructuralGateVerdict,
  type StructuralGateVerdict,
} from "./structural-gate-ledger.js";
import type { StructuralGateProducerToken } from "./structural-gate.js";
import type { WorkflowSyncSource } from "../workflow-sync-source.js";
import { discoverLegacyStructuralScope, withWorkflowToolLockScope,
  type ExpectedWorkflowToolScope, type RawWorkflowToolScope } from "../workflow-tool-lock-scope.js";
import { loadExecutionDefinition } from "../execution-definition.js";
import { isWorkflowChildStep } from "../workflow-child-guards.js";
import { StructuralCompletionCasLost, writeStructuralCompletionInTransaction } from "./structural-completion-write.js";

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
export type AtomicStructuralCompletionInput = {
  db: Db;
  step: WorkflowStep | undefined;
  success: boolean;
  data: unknown;
  companyId: string;
  workflowRunId: string;
  workflowStepRunId: string;
  missionId?: string | null;
  issueId?: string | null;
  source?: WorkflowSyncSource;
  requestId: string;
  observedStatus: string;
  observedIterationIndex: number | null;
  observedRequestId: string | null;
  observedCompletedAt: Date | null;
  observedExecutionGeneration?: number | null;
  producerToken: StructuralGateProducerToken | null;
  patch: {
    startedAt: Date;
    completedAt: Date;
    metadata: Record<string, unknown>;
    fallbackFailureSummary: string | null;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function sameIdentity(left: ExpectedWorkflowToolScope, right: ExpectedWorkflowToolScope): boolean {
  if (left.kind !== right.kind || left.companyId !== right.companyId ||
      left.workflowRunId !== right.workflowRunId || left.missionId !== right.missionId) return false;
  if (left.kind !== "linked" || right.kind !== "linked") return left.kind === right.kind;
  return left.parentMissionId === right.parentMissionId && left.targetWorkflowId === right.targetWorkflowId &&
    left.identity.companyId === right.identity.companyId && left.identity.parentRunId === right.identity.parentRunId &&
    left.identity.parentStepRunId === right.identity.parentStepRunId && left.identity.stepId === right.identity.stepId &&
    left.identity.invocationId === right.identity.invocationId && left.identity.generation === right.identity.generation &&
    left.identity.childRunId === right.identity.childRunId;
}

/** Recheck captured legacy links under the common locks; no retained running/current policy belongs here. */
async function legacyScopeMatches(
  scope: RawWorkflowToolScope,
  expected: ExpectedWorkflowToolScope,
  input: AtomicStructuralCompletionInput,
): Promise<boolean> {
  const run = scope.run;
  const step = scope.steps.find((candidate) => candidate.id === input.workflowStepRunId &&
    candidate.workflowRunId === input.workflowRunId);
  if (scope.scopeIssue !== null || !sameIdentity(scope.expected, expected) || !run || !step ||
      run.id !== input.workflowRunId || run.companyId !== input.companyId) return false;
  const invocationMetadata = record(record(step.metadata)?.toolInvocation);
  if (invocationMetadata && Object.prototype.hasOwnProperty.call(invocationMetadata, "retainedCompletion")) return false;

  if (expected.kind === "plain") {
    return scope.child === null && run.missionId === expected.missionId &&
      (scope.mission?.id ?? null) === expected.missionId &&
      (!scope.mission || scope.mission.companyId === input.companyId) &&
      run.parentRunId === null && run.parentStepRunId === null && run.triggeredBy !== "workflow-step";
  }

  const child = scope.child;
  const parent = child?.parent, invocation = child?.invocation, parentStep = child?.parentStep;
  if (!child || !parent || !invocation || !parentStep || !child.child || run.missionId !== null ||
      (scope.mission?.id ?? null) !== expected.parentMissionId ||
      (parent.missionId ?? null) !== expected.parentMissionId ||
      (scope.mission && scope.mission.companyId !== input.companyId) ||
      parent.id !== expected.identity.parentRunId || parent.companyId !== input.companyId ||
      parentStep.id !== expected.identity.parentStepRunId || parentStep.workflowRunId !== parent.id ||
      parentStep.stepId !== expected.identity.stepId ||
      invocation.id !== expected.identity.invocationId || invocation.companyId !== input.companyId ||
      invocation.parentStepRunId !== parentStep.id || invocation.childRunId !== run.id ||
      invocation.state !== "linked" || invocation.generation !== expected.identity.generation ||
      invocation.targetWorkflowId !== expected.targetWorkflowId || child.child.id !== run.id ||
      child.child.companyId !== input.companyId || child.child.workflowId !== expected.targetWorkflowId ||
      child.child.parentRunId !== parent.id || child.child.parentStepRunId !== parentStep.id ||
      child.child.triggeredBy !== "workflow-step") return false;

  try {
    const definition = await loadExecutionDefinition(scope.tx, parent.id, { requireHistorical: true });
    const parentStepDefinition = definition.steps.find((candidate) => candidate.id === expected.identity.stepId);
    return !!parentStepDefinition && isWorkflowChildStep(parentStepDefinition) &&
      (parentStepDefinition as { targetWorkflowId?: unknown }).targetWorkflowId === expected.targetWorkflowId;
  } catch (error) {
    if (error instanceof HttpError) return false;
    throw error;
  }
}

function casLossResult(input: AtomicStructuralCompletionInput): AtomicStructuralResult {
  const verdict = input.success && isStructuralGateStep(input.step) && input.producerToken
    ? parseStructuralGateVerdict(input.data) : null;
  return { ...deriveStructuralCompletion(input.success, input.step, verdict), casWon: false };
}

/** Legacy structural entry: discover, lock the shared prefix, recheck, then use the shared transaction body. */
export async function atomicStructuralCompletion(
  input: AtomicStructuralCompletionInput,
): Promise<AtomicStructuralResult> {
  const discovered = await discoverLegacyStructuralScope(input.db, {
    companyId: input.companyId,
    workflowRunId: input.workflowRunId,
  });
  if (discovered.kind !== "ready") return casLossResult(input);

  try {
    return await withWorkflowToolLockScope(input.db, discovered.expected, async (scope) => {
      if (!(await legacyScopeMatches(scope, discovered.expected, input))) return casLossResult(input);
      const { db: _rootDb, ...writeInput } = input;
      return writeStructuralCompletionInTransaction(scope, { ...writeInput, mode: "legacy" });
    });
  } catch (error) {
    if (error instanceof StructuralCompletionCasLost) return error.result;
    throw error;
  }
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
