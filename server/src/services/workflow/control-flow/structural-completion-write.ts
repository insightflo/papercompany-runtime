import { and, eq, isNull, type SQL } from "drizzle-orm";
import { workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { recordStructuralGateVerdict, loadStructuralGateVerdictByRequest,
  parseStructuralGateVerdict } from "./structural-gate-ledger.js";
import { isStructuralGateStep, sameStructuralGateProducerToken,
  type StructuralGateProducerToken, type StructuralGateVerdict } from "./structural-gate.js";
import { normalizeWorkflowSyncSource } from "../workflow-sync-source.js";
import type { RawWorkflowToolScope } from "../workflow-tool-lock-scope.js";
import type { AtomicStructuralCompletionInput, AtomicStructuralResult } from "./structural-completion.js";

type AtomicInput = Omit<AtomicStructuralCompletionInput, "db">;
export type StructuralWriteScope = Pick<RawWorkflowToolScope, "tx" | "mission" | "run" | "steps" | "child">;
export type StructuralCompletionWriteInput =
  | (AtomicInput & { mode: "legacy" })
  | (Omit<AtomicInput, "producerToken"> & {
      mode: "retained";
      producerToken: StructuralGateProducerToken;
      attemptWhere: SQL;
    });

export class StructuralCompletionCasLost extends Error {
  constructor(readonly result: AtomicStructuralResult) { super("STRUCTURAL_CAS_LOST"); }
}

export class StructuralCompletionAuthorityMismatch extends Error {
  constructor() { super("STRUCTURAL_COMPLETION_AUTHORITY_MISMATCH"); }
}

function completion(success: boolean, step: AtomicInput["step"], verdict: StructuralGateVerdict | null) {
  const structuralGateRejected = verdict === "request_changes";
  const structuralContractFailure = success && isStructuralGateStep(step) && verdict === null;
  return { structuralGateRejected, structuralContractFailure,
    effectiveSuccess: success && !structuralGateRejected && !structuralContractFailure };
}

function assertScopeMembership(scope: StructuralWriteScope, input: AtomicInput): void {
  const run = scope.run;
  const step = scope.steps.find((candidate) => candidate.id === input.workflowStepRunId);
  if (!run || run.id !== input.workflowRunId || run.companyId !== input.companyId ||
      !step || step.workflowRunId !== run.id) throw new StructuralCompletionAuthorityMismatch();
  if (scope.child && (scope.child.child?.id !== run.id || scope.child.child.companyId !== run.companyId)) {
    throw new StructuralCompletionAuthorityMismatch();
  }
}

/** Shared transaction-only ledger/CAS/transition body. Its caller owns the raw lock scope. */
export async function writeStructuralCompletionInTransaction(
  scope: StructuralWriteScope,
  input: StructuralCompletionWriteInput,
): Promise<AtomicStructuralResult & { casWon: true }> {
  assertScopeMembership(scope, input);
  const tx = scope.tx;
  const structuralVerdict = input.success && isStructuralGateStep(input.step) && input.producerToken
    ? parseStructuralGateVerdict(input.data) : null;

  let effectiveVerdict: StructuralGateVerdict | null = structuralVerdict;
  if (structuralVerdict !== null && input.producerToken) {
    const ledgerResult = await recordStructuralGateVerdict({
      db: tx,
      companyId: input.companyId,
      workflowRunId: input.workflowRunId,
      workflowStepRunId: input.workflowStepRunId,
      missionId: input.missionId,
      verdict: structuralVerdict,
      toolResultData: input.data,
      requestId: input.requestId,
      producerToken: input.producerToken,
    });
    effectiveVerdict = ledgerResult.authoritativeVerdict;
    if (input.mode === "retained") {
      const official = await loadStructuralGateVerdictByRequest(
        tx, input.companyId, input.workflowStepRunId, input.requestId,
      );
      if (!official || !sameStructuralGateProducerToken(official.producerToken, input.producerToken)) {
        throw new StructuralCompletionAuthorityMismatch();
      }
    }
  }

  const result = completion(input.success, input.step, effectiveVerdict);
  const casConditions = [
    eq(workflowStepRuns.id, input.workflowStepRunId),
    eq(workflowStepRuns.status, input.observedStatus),
    eq(workflowStepRuns.iterationIndex, input.observedIterationIndex ?? 0),
    ...(input.observedExecutionGeneration != null
      ? [eq(workflowStepRuns.executionGeneration, input.observedExecutionGeneration)] : []),
    input.observedRequestId
      ? eq(workflowStepRuns.lastDispatchRequestId, input.observedRequestId)
      : isNull(workflowStepRuns.lastDispatchRequestId),
    input.observedCompletedAt
      ? eq(workflowStepRuns.completedAt, input.observedCompletedAt)
      : isNull(workflowStepRuns.completedAt),
    ...(input.mode === "retained" ? [input.attemptWhere] : []),
  ];
  const [updated] = await tx.update(workflowStepRuns).set({
    status: result.effectiveSuccess ? "completed" : "failed",
    startedAt: input.patch.startedAt,
    completedAt: input.patch.completedAt,
    lastDispatchErrorAt: result.effectiveSuccess ? null : input.patch.completedAt,
    lastDispatchErrorSummary: result.effectiveSuccess ? null
      : result.structuralGateRejected ? "structural_gate_request_changes"
      : result.structuralContractFailure ? "structural_gate_contract_failure"
      : input.patch.fallbackFailureSummary,
    metadata: input.patch.metadata,
  }).where(and(...casConditions)).returning({
    id: workflowStepRuns.id,
    transitionVersion: workflowStepRuns.statusTransitionVersion,
  });
  if (!updated) throw new StructuralCompletionCasLost({ ...result, casWon: false });

  const toStatus = result.effectiveSuccess ? "completed" : "failed";
  const transitionVersion = updated.transitionVersion;
  if (input.observedStatus !== toStatus && Number.isInteger(transitionVersion) && transitionVersion >= 1) {
    const source = normalizeWorkflowSyncSource(input.source);
    await tx.insert(workflowTransitionEvents).values({
      companyId: input.companyId,
      missionId: input.missionId ?? null,
      workflowRunId: input.workflowRunId,
      workflowStepRunId: input.workflowStepRunId,
      issueId: input.issueId ?? null,
      heartbeatRunId: null,
      eventType: "workflow_step_status_transition",
      layer: "workflow_sync",
      fromStatus: input.observedStatus,
      toStatus,
      reasonCode: source,
      idempotencyKey: `wf-step-status:${input.workflowStepRunId}:${toStatus}:${transitionVersion}`,
      payload: { source, priorStatus: input.observedStatus, transitionVersion },
    }).onConflictDoNothing();
  }
  return { ...result, casWon: true };
}
