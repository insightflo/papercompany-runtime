/**
 * Accepts an existing tool callback without changing receipt, fencing, write or sync order.
 * DAG functions arrive as hooks; the DAG import is type-only to avoid a runtime cycle.
 */
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { workflowDefinitions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import type { WorkflowStep } from "./dag-engine.js";
import type { WorkflowExecutionResult } from "./types.js";
import type { PersistedWorkflowStep } from "./execution-steps.js";
import { recordWorkflowStepStatusTransition, type WorkflowSyncSource } from "./workflow-sync-source.js";
import { readOwnResumeRequestId } from "./resume-scope-fence.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { isWorkflowChildStep } from "./workflow-child-execution.js";
import { applyMachineContractTruth } from "./tool-result-truth.js";
import { isStructuralGateStep, readStructuralGateProducerToken } from "./control-flow/structural-gate.js";
import { shouldRejectStructuralCallback, planStructuralCompletion, atomicStructuralCompletion } from "./control-flow/structural-completion.js";
import { verifyArtifactStepCompletion } from "./artifact-step-result.js";
import { readWorkflowToolArtifactPath } from "./tool-artifact-path.js";
import { readArtifactDigest } from "./artifact-files.js";
import { stripRetryTrackingOnSuccess } from "./retry-launch-dispatch.js";
import { lockFailureObservationScope } from "./tool-dispatch-failure.js";
import { isQaRebindConsumer, persistQaRebindCandidate } from "./qa-rebind-candidate.js";

const WORKFLOW_STEP_TERMINAL_STATUSES = new Set(["completed", "failed", "skipped"]);

export interface WorkflowToolResultInput {
    companyId: string;
    stepRunId: string;
    success: boolean;
    requestId?: string;
    workflowRunId?: string;
    stepId?: string;
    toolName?: string;
    stdout?: string;
    data?: unknown;
    artifactPath?: string; toolArtifactReceipt?: unknown;
    stderr?: string;
    exitCode?: number | null;
    error?: string;
    allowTerminalRecovery?: boolean;
}

interface WorkflowToolResultAcceptanceHooks {
  normalizeRecord(value: unknown): Record<string, unknown>;
  getMetadataRecord(value: unknown, key: string): Record<string, unknown>;
  readMetadataString(value: unknown): string | undefined;
  buildWorkflowStepRunMetadata(step: WorkflowStep, existingMetadata?: unknown): Record<string, unknown>;
  getWorkflowExecutionResultSnapshot(db: Db, runId: string): Promise<WorkflowExecutionResult | null>;
  syncWorkflowRunState(db: Db, runId: string, source: WorkflowSyncSource): Promise<WorkflowExecutionResult>;
}

export async function acceptWorkflowToolResult(
  db: Db,
  input: WorkflowToolResultInput,
  hooks: WorkflowToolResultAcceptanceHooks,
): Promise<WorkflowExecutionResult | null> {
  const { normalizeRecord, getMetadataRecord, readMetadataString, buildWorkflowStepRunMetadata,
    getWorkflowExecutionResultSnapshot, syncWorkflowRunState } = hooks;
  const row = await db
    .select({ stepRun: workflowStepRuns, run: workflowRuns, definition: workflowDefinitions })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(eq(workflowStepRuns.id, input.stepRunId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row || row.run.companyId !== input.companyId) return null;
  if (input.workflowRunId && input.workflowRunId !== row.run.id) return null;
  if (input.stepId && input.stepId !== row.stepRun.stepId) return null;
  // [Task6c-A] resume run 결과 수용은 정확한 dispatch 신원을 요구한다. requestId 가 없거나
  //   현재 dispatch 와 다르면 이 결과는 이전/미지 세대의 늦은 도착물 — zero write 로
  //   snapshot 만 돌려준다(ordinary run 은 이 가드가 없어 기존과 byte-identical). 이 가드는
  //   resetForResume 이 stamp 한 own non-null metadata.resumeRequestId 로만 판정한다.
  const resumeScopeRequestId = readOwnResumeRequestId(row.stepRun.metadata);
  if (
    resumeScopeRequestId !== null
    && (input.requestId === undefined || input.requestId !== row.stepRun.lastDispatchRequestId)
  ) {
    return getWorkflowExecutionResultSnapshot(db, row.run.id);
  }
  if (input.requestId && row.stepRun.lastDispatchRequestId && input.requestId !== row.stepRun.lastDispatchRequestId) {
    return null;
  }
  // [Hybrid QA] Structural gate callback guard and verdict handling (extracted).
  // [Task5a2a] snapshot 을 artifact/step metadata/status mutation(terminal recovery 포함) 전에
  //   검증한다(422 fail-closed). 이후 두 step lookup 이 같은 로드 배열을 쓴다(2차 raw 정규화 삭제).
  const steps = (await loadExecutionDefinition(db, row.run.id, { requireHistorical: false })).steps;
  const stepForGuard = steps.find((candidate) => candidate.id === row.stepRun.stepId);
  // [descope D5 — DAG:3447] unfenced generic 완료 경로는 workflow S 를 거부한다 — toolName/status/
  //   metadata 는 완료 권위가 아니고, 자식 정산은 settlement writers(전체 신원 형태) 전용이다.
  //   무변이 스냅숏으로 양보한다. 일반 tool 브랜치는 기존 동작을 그대로 유지한다.
  if (stepForGuard && isWorkflowChildStep(stepForGuard)) {
    return getWorkflowExecutionResultSnapshot(db, row.run.id);
  }
  // [tool truth — 2026-09-02] 기계 계약 실패(data.ok===false)는 success=true여도 실패로 기록.
  // 구조 게이트는 verdict 원장 계약상 제외. 상세: tool-result-truth.ts
  input = {
    ...input,
    ...applyMachineContractTruth({
      success: input.success,
      data: input.data,
      error: input.error,
      exitCode: input.exitCode,
      isStructuralGate: isStructuralGateStep(stepForGuard),
    }),
  };
  if (shouldRejectStructuralCallback(stepForGuard, input.requestId, row.stepRun.lastDispatchRequestId)) {
    return null;
  }
  const canRecoverTerminalFailure = input.allowTerminalRecovery === true
    && input.success
    && row.stepRun.status === "failed";
  if (WORKFLOW_STEP_TERMINAL_STATUSES.has(row.stepRun.status) && !canRecoverTerminalFailure) {
    return getWorkflowExecutionResultSnapshot(db, row.run.id);
  }

  const now = new Date();
  const existingMetadata = row.stepRun.metadata && typeof row.stepRun.metadata === "object" && !Array.isArray(row.stepRun.metadata)
    ? row.stepRun.metadata
    : {};
  const step = steps.find((candidate) => candidate.id === row.stepRun.stepId);
  const toolRequestId = input.requestId ?? row.stepRun.lastDispatchRequestId ?? null;
  const artifactCompletion = await verifyArtifactStepCompletion(row, (step as PersistedWorkflowStep | undefined)?.toolArtifactContract, input);
  const toolArtifactReceipt = artifactCompletion?.receipt ?? null;
  const artifactDataRecord = normalizeRecord(input.data);
  const relativeArtifactCandidate = [
    typeof input.artifactPath === "string" ? input.artifactPath.trim() : "",
    readMetadataString(artifactDataRecord.rawPath) ?? "",
    readMetadataString(artifactDataRecord.artifactPath) ?? "",
  ].find((candidate) => candidate.length > 0 && !path.isAbsolute(candidate));
  if (relativeArtifactCandidate) {
    throw new Error(`workflow_tool_result_rejected: artifact path is not absolute (${relativeArtifactCandidate})`);
  }
  const artifactPath = toolArtifactReceipt ? null : readWorkflowToolArtifactPath({
    artifactPath: input.artifactPath,
    data: input.data,
  });
  // [Q3 생산 시점 다이제스트 — 2026-10-04] 영수증 없이 완료되는 내구 toolResult 도 완료 시점
  //   artifactSha256 를 함께 기록한다: 이후 tool-output seed 검증(workflow-seed-tool-output.ts)이
  //   승인 시점 bytes 를 생산 시점 값과 비교해 변조를 가리고, 기록에 없으면 재사용이 fail-closed
  //   로 거절된다. additive — 영수증 분기·기존 소비자 무변경, 안전 읽기 실패 시 필드만 비운다.
  const producedArtifactSha256 = artifactPath && input.success ? await readArtifactDigest(artifactPath) : null;
  const deleteAfterUse = step?.executionControls?.deleteAfterUse === true
    || getMetadataRecord(existingMetadata, "executionControls").deleteAfterUse === true;
  const baseToolResult = {
    requestId: input.requestId ?? row.stepRun.lastDispatchRequestId ?? null,
    toolName: input.toolName ?? null,
    success: input.success,
    stdout: input.stdout ?? null,
    ...(input.data === undefined ? {} : { data: toolArtifactReceipt ? { ...artifactDataRecord, artifactPath: undefined, rawPath: undefined } : input.data }),
    ...(artifactPath ? { artifactPath, ...(producedArtifactSha256 ? { artifactSha256: producedArtifactSha256 } : {}) } : {}),
    stderr: input.stderr ?? null,
    exitCode: input.exitCode ?? null,
    error: input.error ?? null,
    completedAt: now.toISOString(),
  };
  const toolResult = input.allowTerminalRecovery === true
    ? { ...baseToolResult, recoveredBy: "owner-action" }
    : baseToolResult;
  let resultMetadata: Record<string, unknown> = deleteAfterUse
    ? {
      ...(step ? buildWorkflowStepRunMetadata(step, existingMetadata) : normalizeRecord(existingMetadata)),
      retentionDeleted: { deleteAfterUse: true, toolName: input.toolName ?? null, success: input.success, exitCode: input.exitCode ?? null, deletedAt: now.toISOString() },
    }
    : { ...existingMetadata, toolResult, ...(toolArtifactReceipt ? { toolArtifactReceipt } : {}) };
  if (deleteAfterUse) { delete resultMetadata.toolInvocation; delete resultMetadata.toolResult; delete resultMetadata.cacheHit; }
  const completionPlan = planStructuralCompletion({
    step: stepForGuard, success: input.success, data: input.data,
  });
  if (completionPlan.effectiveSuccess) {
    resultMetadata = stripRetryTrackingOnSuccess(resultMetadata) ?? resultMetadata;
  }

  // [Hybrid QA] Structural gates: atomic ledger+status transaction with CAS.
  // The status patch is derived PURELY (no DB/ledger write) via
  // planStructuralCompletion; the authoritative verdict is recorded exactly once
  // INSIDE the atomic transaction below. Never pre-write the ledger outside the
  // transaction — a pre-tx write cannot roll back on CAS loss and would orphan a
  // verdict row with no matching step status update.
  // Non-structural tool steps: unchanged non-transactional path.
  if (isStructuralGateStep(stepForGuard)) {
    const structuralGateProducerToken = readStructuralGateProducerToken(
      existingMetadata.structuralGateProducerToken,
    );
    const atomic = await atomicStructuralCompletion({
      db, step: stepForGuard, success: input.success, data: input.data,
      companyId: row.run.companyId, workflowRunId: row.run.id,
      workflowStepRunId: row.stepRun.id, missionId: row.run.missionId, issueId: row.stepRun.issueId, requestId: toolRequestId!,
      source: "workflow_tool_result",
      observedStatus: row.stepRun.status,
      observedIterationIndex: row.stepRun.iterationIndex ?? null,
      observedRequestId: row.stepRun.lastDispatchRequestId,
      observedCompletedAt: row.stepRun.completedAt,
      observedExecutionGeneration: row.stepRun.executionGeneration,
      producerToken: structuralGateProducerToken,
      patch: {
        startedAt: row.stepRun.startedAt ?? now, completedAt: now,
        metadata: resultMetadata,
        fallbackFailureSummary: input.error ?? input.stderr ?? null,
      },
    });
    if (!atomic.casWon) return getWorkflowExecutionResultSnapshot(db, row.run.id);
    return syncWorkflowRunState(db, row.run.id, "workflow_tool_result");
  }

  // Non-structural path: reuse the pure completion plan.
  // When finalization v1 is enabled, tool steps must also set dispatch_ready_at
  // so that v1Enforcement-enabled edge-condition evaluation admits downstream steps.
  // Heartbeat-backed steps get this via settlement.ts; tool steps bypass heartbeat
  // entirely, so we set it here on successful completion (only if not already set).
  const { structuralGateRejected, structuralContractFailure, effectiveSuccess } = completionPlan;
  const nextStatus = effectiveSuccess ? "completed" : "failed";
  // [Task6c-A] 완료 UPDATE 는 세대 CAS 로 강화된다: load 시점과 update 시점 사이
  //   resetForResume 이 executionGeneration/statusTransitionVersion 을 정확히 함께 +1 하고 새
  //   resumeRequestId 로 stamp 을 교체하므로, (generation, transitionVersion) 이 여전히 일치하는
  //   resume 행은 필연히 같은 resumeRequestId 를 가진다(metadata 동등성은 이 CAS 가 보장 — 별도
  //   where 불필요). ordinary run 도 generation 만으로 낡은 종결/복구 결과를 차단한다. 0 row 이면
  //   stale 결과 — 전이 기록/동기화 없이 snapshot 만 돌려준다.
  const completionCasCondition = and(
    eq(workflowStepRuns.executionGeneration, row.stepRun.executionGeneration),
    ...(artifactCompletion ? [eq(workflowStepRuns.lastDispatchRequestId, artifactCompletion.requestId), eq(workflowStepRuns.status, "running")] : []),
    ...(resumeScopeRequestId !== null
      ? [eq(workflowStepRuns.statusTransitionVersion, row.stepRun.statusTransitionVersion)]
      : []),
  );
  // [descope D5 — DAG:3447] unfenced generic 완료 경로는 workflow S 를 절대 마감하지 않는다 —
  //   자식 정산 권위는 workflow-child-settlement-writers 의 전체 신원 형태뿐이다(위에서 거부됨).
  const observeFailure = nextStatus === "failed" && isQaRebindConsumer(row.stepRun.issueId, stepForGuard, existingMetadata);
  const writeCompletion = async (writer: Db) => {
    const [updated] = await writer.update(workflowStepRuns).set({
      status: nextStatus,
      startedAt: row.stepRun.startedAt ?? now, completedAt: now,
      dispatchReadyAt: effectiveSuccess && !row.stepRun.dispatchReadyAt ? now : undefined,
      lastDispatchErrorAt: effectiveSuccess ? null : now,
      lastDispatchErrorSummary: effectiveSuccess ? null
        : structuralGateRejected ? "structural_gate_request_changes"
        : structuralContractFailure ? "structural_gate_contract_failure"
        : (input.error ?? input.stderr ?? null),
      metadata: resultMetadata,
    }).where(and(eq(workflowStepRuns.id, row.stepRun.id), completionCasCondition)).returning({
      id: workflowStepRuns.id,
      transitionVersion: workflowStepRuns.statusTransitionVersion,
    });
    if (updated && observeFailure) {
      await persistQaRebindCandidate(writer, { companyId: row.run.companyId,
        workflowRunId: row.run.id, consumerStepRunId: updated.id });
    }
    return updated;
  };
  // Lock order mission → run → step (see lockFailureObservationScope).
  const updatedStepRun = observeFailure
    ? await db.transaction(async tx => {
      await lockFailureObservationScope(tx as unknown as Db, row.run);
      return writeCompletion(tx as unknown as Db);
    }) : await writeCompletion(db);
  if (!updatedStepRun) {
    // [Task6c-A] stale resume 결과: 한 건도 쓰지 않고 현재 상태 snapshot 으로 수렴.
    return getWorkflowExecutionResultSnapshot(db, row.run.id);
  }
  {
    await recordWorkflowStepStatusTransition(db, {
      companyId: row.run.companyId,
      missionId: row.run.missionId,
      workflowRunId: row.run.id,
      workflowStepRunId: row.stepRun.id,
      issueId: row.stepRun.issueId,
      fromStatus: row.stepRun.status,
      toStatus: nextStatus,
      source: "workflow_tool_result",
      transitionVersion: updatedStepRun.transitionVersion > row.stepRun.statusTransitionVersion
        ? updatedStepRun.transitionVersion
        : null,
    });
  }

  return syncWorkflowRunState(db, row.run.id, "workflow_tool_result");
}
