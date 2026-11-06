/**
 * DAG Engine
 *
 * Validates and executes Directed Acyclic Graph (DAG) workflows.
 * A workflow is a DAG where each step has dependencies on other steps.
 */

import { isDeepStrictEqual as same } from "node:util";
import { PgTransaction } from "drizzle-orm/pg-core";
import { readFrozenArtifactAttempt } from "./artifact-contract-runtime.js";
import { findWorkflowVerdictCorrection } from "./workflow-verdict-current.js";
import { prepareWorkflowVerdictLocks, lockWorkflowVerdictDependencies } from "./workflow-verdict-write.js";
import { lockQualityAttemptBudget } from "../quality/retry-budget.js";
import { lockUnreplacedRun } from "./run-replacement-guard.js";
import { createQaCorrectionHistorySession } from "./control-flow/qa-correction-history-session.js";
import { QaCorrectionReadError } from "./control-flow/qa-correction-authority.js";
import { observeQaCorrectionFollowup, readCurrentQaCorrectionFollowup,
  readQaCorrectionFollowupConsumption, QaCorrectionFollowupReadError } from "./control-flow/qa-correction-followup.js";
import { createWorkflowStepIssue, collectGateValidatedProducerStepIds } from "./workflow-step-issue.js";

import { isIssueLessToolStep } from "./issue-less-tool-shape.js";
import {
  ensureWorkflowStepRunRecords,
  type MaterializationOutcome,
} from "./workflow-step-materialization.js";
import {
  type ChildStartFence,
} from "./workflow-child-start-state.js";

import { and, asc, eq, gte, inArray, is, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { withReplacementFirstDelivery } from "./replacement-first-delivery.js";
import { createQaRemediationRefire } from "./control-flow/qa-remediation.js";
import { withQaCorrectionFollowupReconcile, currentQaCorrectionSyncTime,
  queueCurrentIssuedQaCorrectionTargets } from "./control-flow/qa-correction-followup-reconcile.js";
import { QaRemediationAdmissionHold, unresolvedQaRemediationAdmissionPending,
  type QaRemediationAdmissionContext } from "./control-flow/qa-remediation-admission-root.js";
import { agents, heartbeatRuns, issueComments, issues, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { artifactAttemptMetadata, freezeCompanyArtifactAttempt } from './artifact-attempt-start.js';
import { workflowControlNodeResultSchema, type WorkflowConditionGroup, type WorkflowStepContract } from "@paperclipai/shared";
import { findCachedToolStepRun, getRunningConcurrencyCount } from "./dag-tool-step-lookups.js";
import { sortWorkflowStepsByPriority } from "./dag-step-priority.js";
import { getSingleToolStepName } from "./dag-tool-step-name.js";
import { buildStepRunMap, toConditionalStepObservation } from "./dag-step-observation.js";
import { normalizeRecord, getMetadataRecord, readMetadataString } from "./dag-metadata-helpers.js";

import { isValidationGateCandidate, buildPredFactsMap, findRunnableSteps, type ValidationVerdictObservation } from "./dag-readiness-facts.js";
import { desiredValidationCheckStepStatus, loadLatestValidationVerdicts, type WorkflowValidationIssueBinding } from "./dag-validation-verdicts.js";
import { mapWorkflowExecutionResult } from "./workflow-execution-result.js";
import type { WorkflowExecutionResult } from "./types.js";
import {
  normalizeWorkflowSyncSource,
  recordWorkflowStepStatusTransitions,
  type WorkflowSyncSource,
} from "./workflow-sync-source.js";
import { syncCancelledWorkflowRunState } from "./workflow-cancelled-state.js";
import { setWorkflowStepRunStatus } from "./step-status-fencing.js";
import { persistFailedToolDispatch } from "./tool-dispatch-failure.js";
import { settleToolQueueMetadata } from "./tool-queue-settle.js";
import {
  dispatchWorkflowChildStep,
  isWorkflowChildStep,
  runWorkflowChildCompletionHook,
} from "./workflow-child-execution.js";

import { wakeReplacementAwareIssueRetry as wakeIssueBackedRetryAndMarkDispatching } from "./replacement-agent-delivery.js";
import { syncQualityStepIssueCommitBeforeWake } from "../quality/native-records.js";
import { desiredStepRunStatusFromIssueStatus } from "./workflow-step-issue-records.js";
import { ownerPlanExecutionIntentCurrent } from "../missions/mission-owner-execution-state.js";
import { wakeExistingWorkflowStepIssue } from "./workflow-step-wake.js";
import { recheckValidationStepIssues } from "./workflow-validation-recheck.js";
import { finalizeWorkflowRunState } from "./workflow-run-finalization.js";
import { acceptWorkflowToolResult } from "./workflow-tool-result-acceptance.js";
import { deferredBeforeStartSchema, type DeferredBeforeStart } from "../runtime-execution-lifecycle.js";
import { admitClaimMetadataWithQaArtifactRequest } from "./deferred-claim-qa-delta.js";
import type { OriginalWorkflowAuthority } from "../plugin-tool-execution-receipt.js";
import { validRequest } from "../plugin-tool-receipt-envelope.js";
import { bindRetainedWorkflowTool as bindRetainedWorkflowToolPrimitive, finalizeRetainedWorkflowTool as finalizeRetainedWorkflowToolPrimitive } from "./retained-tool-completion.js";
import { releaseRetainedWorkflowToolUnsent as releaseRetainedWorkflowToolUnsentPrimitive, type RetainedWorkflowUnsentReleaseResult } from "./retained-tool-unsent-release.js";
import { captureWorkflowToolStepOriginalAuthority } from "./tool-claim-orphan-reconciliation.js";
import { reconcileOrphanedWorkflowToolStepClaims as reconcileOrphanedToolClaims, type OrphanedWorkflowToolClaim, type OrphanedWorkflowToolClaimWork } from "./tool-claim-orphan-reconciliation.js";
export { wakeExistingWorkflowStepIssue };
import { isHeartbeatFinalizationV1Enabled } from "../heartbeat-finalization/flag.js";
import { stopMissionRuntimesForMission, TERMINAL_WORKFLOW_STATUSES } from "../missions/mission-runtime-manager.js";

import { logActivity } from "../activity-log.js";
import { logger } from "../../middleware/logger.js";
import type { ConditionalEdge } from "./control-flow/types.js";
import {
  classifyStepActivation,
  findSkippableSteps,
  resolveEdges,
  workflowHasConditionalEdges,
} from "./control-flow/edge-condition.js";
import { validateDag } from "./dag-validation.js";
import { getWorkflowToolReferenceNames } from "./tool-references.js";
export { getWorkflowToolReferenceNames } from "./tool-references.js";
export { validateDag } from "./dag-validation.js";
import { applyBackEdgeReworkPass } from "./control-flow/loop-driver.js";
import { cancelResolvedQaSourceDefectOwnerCards } from "./qa-source-defect-owner-card.js";
import { closeResolvedWorkflowUnblocks } from "./resolved-unblock-closeout.js";
import { readWorkflowReworkContract } from "./control-flow/rework-contract.js";
import { isRunTerminalBoundaryV1Enabled } from "./run-terminal-boundary-flag.js";
import { isRunReopenGuardEnabled } from "./run-reopen-guard-flag.js";
import { applyStructuralGatePass, requeueStaleStructuralGatesForBlockedQa } from "./control-flow/structural-gate-rework.js";
import {
  reviveConditionalSkip,
  settleConditionalSkip,
} from "./conditional-skip-settlement.js";

import { buildQaCapAcceptanceRuntimeContract } from "./control-flow/qa-cap-runtime-contract.js";
import { stepRunNeedsWorkflowResume, isPendingReworkAwaitingCurrentIssueCompletion, matchesCurrentCapAcceptedProducer } from "./dag-rework-observation.js";
import { resolveMissionWorkProductPaths } from "../work-products/output-paths.js";

import { readExplicitValidationVerdict } from "../validation-verdict.js";
import { applyWorkProductDependencyGate, collectUniqueStepRunIssueIds, loadWorkProductDependencyGate, reloadWorkflowStepRunsForSameRun } from "./workproduct-dependency-gate.js";
import { resolveWorkflowToolStepArgs, stripShellEscapeResidue } from "./tool-step-args.js";
import { isStructuralGateStep } from "./control-flow/structural-gate.js";
import { STEP_MACHINE_CHECKS_TOOL, evaluateStepMachineChecks, renderMachineCheckFailure } from "./step-machine-checks.js";
import {
  executeWorkflowControlNode,
  isWorkflowControlNode,
  resetStaleIfControlNodesForResume,
} from "./control-flow/control-node-executor.js";
import { captureStructuralGateProducerToken } from "./control-flow/structural-semantic-readiness.js";
import {
  readWorkflowRetryMetadata,
} from "./retry-policy.js";
import {
  isRetryDelayBlockingDispatch,
  markIssueLessRetryDispatchingFromProof,
  shouldPreservePendingRetryFromIssueState,
  stripRetryTrackingOnSuccess,
} from "./retry-launch-dispatch.js";
import { markRetryDispatching } from "./retry-dispatch-state.js";
import { retryIssueLessToolWorkflowStepInternal, type ExpectedToolFailure } from "./retry-issue-less-manual.js";
import type { QaRebindRecoveryIntent } from "./qa-rebind-recovery-intent.js";
import { applyWorkflowStepRetryPass } from "./workflow-step-retry-pass.js";
import { shouldLoadValidationVerdictsForRun } from "./validation-verdict-load-gate.js";

import {
  getWorkflowLaunchSteps,
  isDynamicOwnerPlanWorkflowDefinition,
  type PersistedWorkflowStep,
  type WorkflowDefinitionExecutionShape,
} from "./execution-steps.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { projectExecutionDefinition } from "./execution-definition-view.js";
import { loadWorkflowExecutionContext } from "./workflow-execution-context.js";
import { assertResumeAccepted } from "./resume/acceptance.js";
import { withResumeSerialization, type ResumeMutationTransaction } from "./resume/serialization.js";
export {
  buildWorkflowExecutionSteps,
  getWorkflowLaunchSteps,
  isDynamicOwnerPlanWorkflowDefinition,
  normalizeWorkflowStepsForExecution,
  type WorkflowDefinitionExecutionInput,
} from "./execution-steps.js";
export { loadWorkflowExecutionContext } from "./workflow-execution-context.js";
import { readWorkflowRunWithStepRuns } from "./workflow-run-step-read.js";
import { discoverWorkflowChildStart } from "./workflow-child-discovery.js";
import {
  cancelDescendantWorkflowRunWithChildFence,
  cancelWorkflowRunWithChildFence,
  logWorkflowRunCancellationRefused,
  type CancelledRunRef,
} from "./workflow-cancel-bridge.js";
import { workflowChildStepIds, ensureStepRunRecords, buildWorkflowStepRunMetadata, resetUnlaunchedTerminalStepRuns } from "./workflow-step-run-maintenance.js";
import { syncStepRunsFromIssueState } from "./workflow-issue-state-sync.js";
import { type WorkflowToolCorrection, isQaCorrectionToolStep, readWorkflowToolCorrection, hasWorkflowToolCorrectionInvocation, withWorkflowToolCorrection } from "./workflow-tool-correction.js";
import { applyConditionalSkipPropagation } from "./workflow-conditional-skip.js";
import { cancelOutstandingWorkflowIssues } from "./workflow-cancellation.js";
export { cancelWorkflowRunWithCleanup } from "./workflow-cancellation.js";
import { workflowToolStepExecutor } from "./workflow-tool-executor-registry.js";
export { setWorkflowToolStepExecutor, setWorkflowToolStepReadinessChecker, assertWorkflowToolStepsReady } from "./workflow-tool-executor-registry.js";
import { failToolStepRunWithDispatchError, startIssueLessToolStepRun } from "./workflow-tool-start.js";
import { releaseDeferredWorkflowToolClaim, DeferredWorkflowToolClaimScopeError } from "./workflow-tool-deferred-claim.js";
import { getDynamicLaunchStepIds, getWorkflowExecutionResultSnapshot, syncWorkflowRunState, syncWorkflowRunStateWithOutcome } from "./workflow-run-sync-core.js";
export { getWorkflowExecutionResultSnapshot, syncWorkflowRunState, syncWorkflowRunStateWithOutcome, syncWorkflowRunForIssue, type WorkflowSyncOutcome } from "./workflow-run-sync-core.js";
export { markRetryDispatching };




/**
 * Workflow step definition.
 */
export interface WorkflowStep {
  id: string;
  name: string;
  title?: string;
  agentId: string;
  agentName?: string;
  assigneeAgentId?: string;
  dependencies: string[]; // step IDs this step depends on
  dependsOn?: string[];
  description?: string;
  type?: string;
  /** workflow→workflow 자식 실행(n8n "Execute Workflow"). type==="workflow" 일 때 사용. */
  targetWorkflowId?: string;
  /** [descope D1] wait:true 만 허용 — 생략은 true 로 취급된다. false 는 정의/런타임 검증에서 거부된다. */
  wait?: boolean;
  /** 자식 run 입력(토큰 렌더 대상, 최대 20키). 미해결 토큰은 fail-closed. */
  inputs?: Record<string, string>;
  qaType?: string; deliveryVerification?: 'required'; capAcceptance?: 'blocked'; deliveryRole?: 'publication-verify';
  toolName?: string;
  toolArgs?: unknown;
  tools?: string[];
  toolNames?: string[];
  sessionMode?: string;
  onFailure?: string;
  escalateTo?: string;
  maxRetries?: number;
  timeoutSeconds?: number;
  knowledgeBaseIds?: string[];
  triggerOn?: "normal" | "escalation" | string;
  /**
   * Dynamic owner-plan marker. In this mode the native workflow engine only
   * launches bootstrap/root planning steps; the owner plan creates concrete
   * mission child issues dynamically rather than the static DAG activating
   * every declared downstream step.
   */
  dynamicChildren?: boolean | string;
  ownerPlanBootstrapOnly?: boolean | string;
  bootstrapOnly?: boolean | string;
  executionMode?: "static_dag" | "dynamic_owner_plan" | string;
  workflowMode?: "static_dag" | "dynamic_owner_plan" | string;
  executionControls?: WorkflowStepExecutionControls;
  /**
   * 조건부/loop edge (control-flow). legacy `dependencies[]` 는 when:"success" 로 동작한다.
   * edge 평가는 control-flow/edge-condition, cycle 허용은 cycle-validator, loop 재발화는 loop-driver,
   * step 리셋은 step-reset 이 담당 — 여기선 데이터 모델만.
   */
  conditionalDependencies?: ConditionalEdge[];
  /**
   * Native control nodes. type:"if" 인 step 의 typed condition group(평가는 condition-evaluator),
   * type:"complete" 인 step 의 optional 사람-readable 완료 사유. 두 필드 모두 normalize spread 로 보존.
   */
  conditionGroup?: WorkflowConditionGroup;
  completionReason?: string;
  /**
   * 이 step이 파일 산출물을 생산하는지(compile-time 계약).
   * normalizeWorkflowStepsForExecution 이 명시 true/alias true만 true로 정규화한다.
   * true면 createWorkflowStepIssue 가 출력 디렉토리 + [ARTIFACT]: 등록 contract를 주입하고,
   * heartbeat missing-workProduct gate가 적용된다.
   */
  graphWorkProductRequired?: boolean;
  /**
   * 이 step이 adapter에게 tool auto-approve(예: hermes_local --yolo)를 요구하는지(compile-time 계약).
   * normalizeWorkflowStepsForExecution 이 명시 true(literal)만 true로 정규화한다(string/number/alias 거부).
   * true면 createWorkflowStepIssue 가 issue 의 assigneeAdapterOverrides.adapterConfig.autoApproveTools=true 를
   * 주입하고, heartbeat 가 이를 runtime adapter config 에 merge한다(Hermes 는 autoApproveTools→--yolo 매핑).
   */
  autoApproveTools?: boolean;
  graphRetryDelaySeconds?: number;
  graphRetryBackoff?: "fixed" | "linear" | "exponential";
  graphRetryJitter?: boolean;
  /**
   * 스텝 발주 계약 — 사전조건/사후조건/미정의동작(정의 시점 owner 작성).
   * normalizeWorkflowStepsForExecution 의 spread 로 보존되고, 발주 시 이슈 지침·실행카드·QA 루브릭에 전달된다.
   * 지침·검증 기준일 뿐 실행 통제 권위가 아니다(규칙 8).
   */
  contract?: WorkflowStepContract;
}

export type WorkflowExecutionMode = "static_dag" | "dynamic_owner_plan";

export interface WorkflowStepExecutionControls {
  concurrencyKey?: string;
  concurrencyLimit?: number;
  priority?: string;
  cacheEnabled?: boolean;
  cacheTtlSeconds?: number;
  deleteAfterUse?: boolean;
}



/** [machine-check gates] Any residual renderable workflow token ({$steps.<id>.<field>},
 * {$runMetadata.<key>}, {$runDate} …) inside a machineCheck path means the token was
 * not resolved at queue time — the check must fail, never execute on a literal token. */
const UNRESOLVED_WORKFLOW_TOKEN_RE = /\{\$(?:steps\.[^}]+|runMetadata\.[A-Za-z0-9_]+|runDate|date|workflowRunId|runMonth)\}/u;

export type WorkflowToolStepExecutionRequest = {
  companyId: string;
  workflowRunId: string;
  workflowId: string;
  stepId: string;
  stepRunId: string;
  toolName: string;
  args: unknown;
  requestId: string;
  /** Current claimed generation for exact deferred-start scope matching. */
  executionGeneration: number;
  originalAuthority?: OriginalWorkflowAuthority;
  agentId?: string;
  agentName?: string;
};

export type WorkflowToolStepExecutionResult = {
  accepted?: boolean;
  duplicate?: boolean;
  deferredBeforeStart?: DeferredBeforeStart;
  retainedUnsentRelease?: RetainedWorkflowUnsentReleaseResult;
};

function validRetainedUnsentRelease(value: unknown, request: WorkflowToolStepExecutionRequest, authority: OriginalWorkflowAuthority): value is RetainedWorkflowUnsentReleaseResult {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("kind" in value) ||
      !("receiptId" in value) || !("workflow" in value)) return false;
  const kind = value.kind;
  if (kind !== "released" && kind !== "held") return false;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== (kind === "released" ? "kind,receiptId,workflow" : "kind,reason,receiptId,workflow") ||
      (kind === "held" && (!("reason" in value) || typeof value.reason !== "string" || !value.reason.trim())) ||
      !same(request.originalAuthority, authority) || authority.workflowRunId !== request.workflowRunId ||
      authority.stepRunId !== request.stepRunId || authority.stepId !== request.stepId || authority.requestId !== request.requestId) return false;
  const probe = { kind: "paperclip.retained-tool-request", version: 1, receiptId: value.receiptId, consumer: "workflow",
    companyId: request.companyId, tool: request.toolName, parameters: request.args ?? {},
    identity: { runId: request.workflowRunId, idempotencyKey: request.requestId }, workflow: value.workflow };
  return validRequest(probe) && !!probe.workflow &&
    same(retainedWorkflowAuthorityBase(probe.workflow), retainedWorkflowAuthorityBase(authority));
}

function retainedWorkflowAuthorityBase(value: OriginalWorkflowAuthority) {
  const base = { ...value };
  delete base.specialized;
  return base;
}
export type WorkflowToolStepExecutor = (
  request: WorkflowToolStepExecutionRequest,
) => Promise<WorkflowToolStepExecutionResult | void>;

export type WorkflowToolStepReadiness = {
  available: boolean;
  reason?: string;
};

export type WorkflowToolStepReadinessChecker = (input: {
  companyId: string;
  toolNames: string[];
}) => Promise<WorkflowToolStepReadiness>;

export type WorkflowToolStepQueueDispatchResult = {
  claimedCount: number;
  executedCount: number;
  failedCount: number;
  skippedCount: number;
};












export type WorkflowExecutionContext = {
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  steps: WorkflowStep[];
  stepRuns: (typeof workflowStepRuns.$inferSelect)[];
};







/**
 * Validates that a workflow DAG is acyclic and well-formed.
 *
 * @param steps - The workflow steps to validate.
 * @returns Validation result with any errors or warnings.
 */



























/** Narrow discovery only; a matching event still needs issuance, currentness and byte proof. */
function workflowToolQueueCandidate() {
  return or(isNull(workflowStepRuns.issueId), sql`exists (
    select 1 from ${workflowTransitionEvents}
    where ${workflowTransitionEvents.companyId} = ${workflowRuns.companyId}
      and ${workflowTransitionEvents.workflowRunId} = ${workflowRuns.id}
      and ${workflowTransitionEvents.workflowStepRunId} = ${workflowStepRuns.id}
      and ${workflowTransitionEvents.issueId} = ${workflowStepRuns.issueId}
      and ${workflowTransitionEvents.eventType} = 'qa_correction_followup_requested'
  )`);
}













// Reap orphaned running claims after timeout + grace through the existing failure/sync path.
// Process-local executors/timers disappear on restart; queued, unclaimed rows are not orphans.
const DEFAULT_ORPHANED_TOOL_CLAIM_TIMEOUT_MS = 10 * 60_000;
const ORPHANED_TOOL_CLAIM_GRACE_MS = 5 * 60_000;
const ORPHANED_TOOL_CLAIM_MIN_AGE_MS = 15 * 60_000;

async function resolveWorkflowToolStepClaimTimeoutMs(
  db: Db,
  companyId: string,
  toolName: string,
): Promise<number> {
  let rows = await db
    .select({ adapterConfig: toolDefinitions.adapterConfig })
    .from(toolDefinitions)
    .where(and(
      eq(toolDefinitions.companyId, companyId),
      eq(toolDefinitions.name, toolName),
    ))
    .limit(1);
  if (rows.length === 0) {
    rows = await db
      .select({ adapterConfig: toolDefinitions.adapterConfig })
      .from(toolDefinitions)
      .where(eq(toolDefinitions.name, toolName))
      .limit(1);
  }
  const timeoutMs = rows[0]?.adapterConfig?.timeoutMs;
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_ORPHANED_TOOL_CLAIM_TIMEOUT_MS;
}

export async function reconcileOrphanedWorkflowToolStepClaims(
  db: Db,
  options: { limit?: number; now?: Date } = {},
): Promise<{ orphanedCount: number; skippedCount: number }> {
  return reconcileOrphanedToolClaims(db, options, {
    prepare: async (candidate: OrphanedWorkflowToolClaim): Promise<OrphanedWorkflowToolClaimWork | null> => {
      const steps = (await loadExecutionDefinition(db, candidate.run.id, { requireHistorical: false })).steps;
      const step = steps.find((entry) => entry.id === candidate.stepRun.stepId);
      if (!step || (!isIssueLessToolStep(step)
        && !(candidate.stepRun.issueId && isQaCorrectionToolStep(step)))) return null;
      const correction = candidate.stepRun.issueId
        ? await readWorkflowToolCorrection(db, candidate.run, candidate.stepRun, step) : null;
      if (candidate.stepRun.issueId && (!correction
        || !hasWorkflowToolCorrectionInvocation(candidate.stepRun, correction))) return null;
      const invocation = getMetadataRecord(candidate.stepRun.metadata, "toolInvocation");
      const requestId = readMetadataString(invocation.requestId)
        ?? readMetadataString(candidate.stepRun.lastDispatchRequestId);
      const toolName = readMetadataString(invocation.toolName) ?? getSingleToolStepName(step);
      if (!requestId || requestId !== candidate.stepRun.lastDispatchRequestId || !toolName) return null;
      const timeoutMs = await resolveWorkflowToolStepClaimTimeoutMs(db, candidate.run.companyId, toolName);
      return {
        step, requestId, toolName, timeoutMs,
        args: Object.prototype.hasOwnProperty.call(invocation, "args") ? invocation.args : null,
        ...(correction ? { correction } : {}),
      };
    },
    fail: async ({ db: writer, run, stepRun, work, now, error }) => {
      await failToolStepRunWithDispatchError({ db: writer, step: work.step, stepRun, now,
        requestId: work.requestId, toolName: work.toolName, args: work.args, error,
        provenance: { run, source: "workflow_tool_queue" } });
    },
    sync: async (runId) => { await syncWorkflowRunState(db, runId, "workflow_tool_queue"); },
    withCorrectionAuthority: async (candidate, work, write) => {
      if (!work.correction) return null;
      return await withWorkflowToolCorrection({ db, run: candidate.run, stepRun: candidate.stepRun,
        step: work.step, correction: work.correction as WorkflowToolCorrection }, async (writer) => {
        const [currentRun] = await writer.select().from(workflowRuns).where(eq(workflowRuns.id, candidate.run.id)).for("update");
        if (!currentRun) return false;
        const [stepRun] = await writer.select().from(workflowStepRuns).where(and(
          eq(workflowStepRuns.id, candidate.stepRun.id),
          eq(workflowStepRuns.workflowRunId, currentRun.id),
        )).for("update");
        return write(writer, currentRun, stepRun);
      });
    },
  });
}





export async function processQueuedWorkflowToolStepRuns(
  db: Db,
  options: { limit?: number; now?: Date } = {},
): Promise<WorkflowToolStepQueueDispatchResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  // A nested sync cannot observe correction files or take a late quality prefix. Admit issued
  // targets here on the existing root queue tick, including a prior failed/completed QA attempt.
  if (!is(db, PgTransaction)) {
    const correctionRows = await db
      .select({ stepRun: workflowStepRuns, run: workflowRuns, definition: workflowDefinitions })
      .from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
      .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
      .where(and(eq(workflowRuns.status, "running"), isNotNull(workflowStepRuns.issueId),
        inArray(workflowStepRuns.status, ["pending", "running", "failed", "completed"]), workflowToolQueueCandidate()))
      .orderBy(asc(workflowStepRuns.startedAt), asc(workflowStepRuns.id))
      .limit(limit);
    for (const row of correctionRows) {
      const context = await loadWorkflowExecutionContext(db, row.run.id);
      const step = context.steps.find(s => s.id === row.stepRun.stepId);
      if (!step || step.triggerOn === "escalation"
        || isRetryDelayBlockingDispatch(row.stepRun.metadata, options.now ?? new Date())) continue;
      const launched = getDynamicLaunchStepIds(context);
      if (launched && !launched.has(step.id)) continue;
      const correction = await readWorkflowToolCorrection(db, row.run, row.stepRun, step);
      if (!correction || hasWorkflowToolCorrectionInvocation(row.stepRun, correction)) continue;
      await startIssueLessToolStepRun({ db, run: row.run, definition: context.definition,
        step, steps: context.steps, stepRun: row.stepRun, now: options.now ?? new Date() });
    }
  }
  const orphanReconcile = await reconcileOrphanedWorkflowToolStepClaims(db, { ...options, limit });
  const queuedRows = await db
    .select({ stepRun: workflowStepRuns, run: workflowRuns, definition: workflowDefinitions })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(
      eq(workflowRuns.status, "running"),
      eq(workflowStepRuns.status, "running"),
      workflowToolQueueCandidate(),
      isNull(workflowStepRuns.lastDispatchAcceptedAt),
      isNull(workflowStepRuns.lastDispatchErrorAt),
      sql`${workflowStepRuns.lastDispatchRequestId} is not null`,
    ))
    .orderBy(asc(workflowStepRuns.startedAt), asc(workflowStepRuns.id))
    .limit(limit);

  const result: WorkflowToolStepQueueDispatchResult = {
    claimedCount: 0,
    executedCount: 0,
    failedCount: orphanReconcile.orphanedCount,
    skippedCount: orphanReconcile.skippedCount,
  };

  for (const row of queuedRows) {
    const now = options.now ?? new Date();
    // [Task5a2a] 활성화/claim/tool call 전에 각 선택 행의 캡처 실행정의를 로드하고 delegation 기본
    //   title 은 캡처 name(projected definition)에서 만든다. persisted toolInvocation 권위 유지.
    const execution = await loadExecutionDefinition(db, row.run.id, { requireHistorical: false });
    const steps = execution.steps;
    const step = steps.find((candidate) => candidate.id === row.stepRun.stepId);
    if (!step || (!isIssueLessToolStep(step) && !(row.stepRun.issueId && isQaCorrectionToolStep(step)))) {
      result.skippedCount += 1;
      continue;
    }
    // [when:always / edge gate] A queued issue-less tool row can outlive a non-terminal predecessor, so
    //   re-check classifyStepActivation against current step-run states and skip (not fail) to re-dispatch.
    const activationPreds = buildPredFactsMap(steps, buildStepRunMap(
      await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, row.run.id)),
    ));
    if (!classifyStepActivation(step, activationPreds).runnable) {
      result.skippedCount += 1;
      continue;
    }
    // [owner plan admission] 오래된 owner 계획 intent 소유 run 의 실제 실행 admission 은 연기한다(스텝은 queued 유지).
    if (!(await ownerPlanExecutionIntentCurrent(db, row.run.companyId, { runMetadata: row.run.metadata, stepMetadata: row.stepRun.metadata }))) { result.skippedCount += 1; continue; }

    const correction = row.stepRun.issueId
      ? await readWorkflowToolCorrection(db, row.run, row.stepRun, step) : null;
    const invocation = getMetadataRecord(row.stepRun.metadata, "toolInvocation");
    const requestId = readMetadataString(invocation.requestId) ?? readMetadataString(row.stepRun.lastDispatchRequestId);
    const toolName = readMetadataString(invocation.toolName) ?? getSingleToolStepName(step);
    if (row.stepRun.issueId) {
      if (!correction || !hasWorkflowToolCorrectionInvocation(row.stepRun, correction)
        || invocation.requestId !== requestId || toolName !== getSingleToolStepName(step)
        || !Object.prototype.hasOwnProperty.call(invocation, "args")) {
        result.skippedCount += 1;
        continue;
      }
      readFrozenArtifactAttempt(row.stepRun.metadata.artifactExecution,
        { executionGeneration: row.stepRun.executionGeneration, requestId: requestId! });
    }
    // [arg hygiene] 저장된 인자 재사용 시에도 셸 이스케이프 잔여($/, $')를 정화한다 —
    // 렌더 직후 값과 동일한 위생 보장(2026-09-02 enqueue 오염 사고).
    const hasPersistedArgs = Object.prototype.hasOwnProperty.call(invocation, "args");
    const queuedArtifactExecution = !hasPersistedArgs && requestId && row.stepRun.metadata.artifactExecution
      ? readFrozenArtifactAttempt(row.stepRun.metadata.artifactExecution,
        { executionGeneration: row.stepRun.executionGeneration, requestId })
      : null;
    const args = hasPersistedArgs
      ? stripShellEscapeResidue(invocation.args)
      : await resolveWorkflowToolStepArgs({
        db,
        run: row.run,
        step: step as PersistedWorkflowStep,
        workflowSteps: steps,
        consumerStepRunId: row.stepRun.id,
        consumerArtifactContract: queuedArtifactExecution?.contract,
      });
    if (!requestId) {
      await failToolStepRunWithDispatchError({
        db,
        step,
        stepRun: row.stepRun,
        now,
        requestId: `${row.run.id}:${step.id}:${Date.now()}`,
        toolName,
        args,
        error: "Workflow tool step queue entry is missing a dispatch request id.",
        provenance: { run: row.run, source: "workflow_tool_queue" },
      });
      await syncWorkflowRunState(db, row.run.id, "workflow_tool_queue");
      result.failedCount += 1;
      continue;
    }

    const metadata = normalizeRecord(row.stepRun.metadata);
    const claimedMetadata: Record<string, unknown> = {
      ...metadata,
      toolQueue: {
        ...getMetadataRecord(metadata, "toolQueue"),
        status: "claimed",
        claimedAt: now.toISOString(),
      },
      toolInvocation: {
        ...invocation,
        requestId,
        toolName,
        args,
        dispatchedAt: now.toISOString(),
      },
    };

    // [Task6b-2 bounded queue-claim lock] 기존 conditional claim UPDATE 를 apply 와 같은
    //   mission→run→steps FOR UPDATE 순서의 짧은 tx 안에서 실행한다(serialization 헬퍼 재사용,
    //   SQL 중복 없음). claim 결과 판정(0 rows skip) 이후 위임/executor dispatch, complete/fail 은
    //   잠금 밖 기존 경로 그대로다. mission 미연결 ordinary run 은 잠글 mission 이 없으므로
    //   기존 direct claim 을 유지한다(serialization 실패 시 스킵, 다음 틱 재시도).
    const claimStepRun = (executor: Pick<ResumeMutationTransaction, "update">) => executor
      .update(workflowStepRuns)
      .set({
        lastDispatchAcceptedAt: now,
        metadata: claimedMetadata,
      })
      .where(and(
        eq(workflowStepRuns.id, row.stepRun.id),
        eq(workflowStepRuns.status, "running"),
        isNull(workflowStepRuns.lastDispatchAcceptedAt),
        isNull(workflowStepRuns.lastDispatchErrorAt),
        eq(workflowStepRuns.lastDispatchRequestId, requestId),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    const claimedStepRun = correction
      ? await withWorkflowToolCorrection({ db, run: row.run, stepRun: row.stepRun, step, correction }, claimStepRun)
      : row.run.missionId === null
      ? await claimStepRun(db)
      : await withResumeSerialization(db, {
        companyId: row.run.companyId,
        missionId: row.run.missionId,
        runId: row.run.id,
      }, (lock) => claimStepRun(lock.tx)).catch(() => null);

    if (!claimedStepRun) {
      result.skippedCount += 1;
      continue;
    }
    result.claimedCount += 1;

    try {
      if (toolName === "delegate_to_company") {
        const { startDelegatedWorkflowStep } = await import("../workflow-delegations.js");
        const delegated = await startDelegatedWorkflowStep({
          db,
          run: row.run,
          definition: projectExecutionDefinition(row.definition, execution),
          step,
          stepRun: claimedStepRun,
          args,
          now,
        });
        if (!delegated) {
          await failToolStepRunWithDispatchError({
            db,
            step,
            stepRun: claimedStepRun,
            now,
            requestId,
            toolName,
            args,
            error: "Workflow delegation tool step could not be started.",
            provenance: { run: row.run, source: "workflow_tool_queue" },
          });
          await syncWorkflowRunState(db, row.run.id, "workflow_tool_queue");
          result.failedCount += 1;
        } else {
          result.executedCount += 1;
        }
        continue;
      }

      // [machine-check gates] Reserved in-process verifier: no registry row, no
      // plugin dispatch, no tool executor. Deterministic code-level predicates
      // run here; the verdict flows through the standard structural completion
      // path (ledger row on pass, failed step + existing retry on failure).
      if (toolName === STEP_MACHINE_CHECKS_TOOL) {
        const gateArgs = args && typeof args === "object" && !Array.isArray(args)
          ? args as Record<string, unknown>
          : {};
        const machinePaths = await resolveMissionWorkProductPaths(db, {
          companyId: row.run.companyId,
          missionId: row.run.missionId,
          workflowRunId: row.run.id,
          stepId: step.id,
        });
        const evaluation = await evaluateStepMachineChecks({
          checks: gateArgs.machineChecks,
          resolvePath: (tokened) => UNRESOLVED_WORKFLOW_TOKEN_RE.test(tokened) ? null : tokened,
          workspaceCwd: machinePaths?.workProductRoot ?? process.cwd(),
        });
        const failure = evaluation.ok ? null : renderMachineCheckFailure(evaluation.results);
        await completeWorkflowToolStepFromResult(db, {
          companyId: row.run.companyId,
          stepRunId: claimedStepRun.id,
          requestId,
          workflowRunId: row.run.id,
          stepId: step.id,
          toolName,
          success: evaluation.ok,
          stdout: JSON.stringify(evaluation),
          ...(evaluation.ok ? {
            data: {
              ok: true,
              verdict: "pass",
              results: evaluation.results,
              producerStepId: typeof gateArgs.producerStepId === "string" ? gateArgs.producerStepId : null,
            },
          } : {}),
          stderr: failure ?? "",
          exitCode: evaluation.ok ? 0 : 1,
          ...(failure ? { error: failure } : {}),
        });
        if (evaluation.ok) result.executedCount += 1;
        else result.failedCount += 1;
        continue;
      }

      if (!workflowToolStepExecutor) {
        await failToolStepRunWithDispatchError({
          db,
          step,
          stepRun: claimedStepRun,
          now,
          requestId,
          toolName,
          args,
          error: "Workflow tool step executor is not configured.",
          provenance: { run: row.run, source: "workflow_tool_queue" },
        });
        await syncWorkflowRunState(db, row.run.id, "workflow_tool_queue");
        result.failedCount += 1;
        continue;
      }

      const persistedStep = step as PersistedWorkflowStep;
      const agentName = typeof persistedStep.agentName === "string" ? persistedStep.agentName.trim() : undefined;
      const originalAuthority = captureWorkflowToolStepOriginalAuthority({
        run: row.run, stepRun: claimedStepRun, requestId,
      });
      const executionRequest: WorkflowToolStepExecutionRequest = {
        companyId: row.run.companyId,
        workflowRunId: row.run.id,
        workflowId: row.definition.id,
        stepId: step.id,
        stepRunId: claimedStepRun.id,
        toolName,
        args,
        requestId,
        executionGeneration: claimedStepRun.executionGeneration,
        originalAuthority: structuredClone(originalAuthority),
        agentId: (typeof step.agentId === "string" && step.agentId.trim())
          ? step.agentId.trim()
          : (typeof step.assigneeAgentId === "string" ? step.assigneeAgentId.trim() : undefined),
        agentName,
      };
      const expectedRequest = structuredClone(executionRequest);
      const dispatchResult = await workflowToolStepExecutor(executionRequest);
      if (dispatchResult && Object.prototype.hasOwnProperty.call(dispatchResult, "retainedUnsentRelease")) {
        const contradictory = dispatchResult.accepted !== true || dispatchResult.duplicate === true ||
          Object.prototype.hasOwnProperty.call(dispatchResult, "deferredBeforeStart");
        if (contradictory || !validRetainedUnsentRelease(dispatchResult.retainedUnsentRelease,
          expectedRequest, originalAuthority)) {
          logger.warn({ workflowRunId: row.run.id, stepRunId: claimedStepRun.id, requestId },
            "Retained workflow tool release result was invalid; leaving the claim held");
        }
        result.skippedCount += 1;
        continue;
      }
      if (dispatchResult?.deferredBeforeStart) {
        try {
          await releaseDeferredWorkflowToolClaim({
            db, run: row.run, step, claimedStepRun, requestId,
            deferred: dispatchResult.deferredBeforeStart, correction,
          });
        } catch (error) {
          if (error instanceof DeferredWorkflowToolClaimScopeError) throw error;
          logger.warn({ error, workflowRunId: row.run.id, stepRunId: claimedStepRun.id, requestId },
            "Deferred workflow tool claim could not be restored; leaving the claim for existing recovery");
        }
        result.skippedCount += 1;
        continue;
      }
      if (dispatchResult?.accepted === false) {
        await failToolStepRunWithDispatchError({
          db,
          step,
          stepRun: claimedStepRun,
          now,
          requestId,
          toolName,
          args,
          error: "Workflow tool step executor rejected the queued request.",
          provenance: { run: row.run, source: "workflow_tool_queue" },
        });
        await syncWorkflowRunState(db, row.run.id, "workflow_tool_queue");
        result.failedCount += 1;
        continue;
      }
      result.executedCount += 1;
    } catch (error) {
      await failToolStepRunWithDispatchError({
        db,
        step,
        stepRun: claimedStepRun,
        now,
        requestId,
        toolName,
        args,
        error: error instanceof Error ? error.message : String(error),
        provenance: { run: row.run, source: "workflow_tool_queue" },
      });
      await syncWorkflowRunState(db, row.run.id, "workflow_tool_queue");
      result.failedCount += 1;
    }
  }

  return result;
}



export async function completeWorkflowToolStepFromResult(
  db: Db,
  input: {
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
  },
): Promise<WorkflowExecutionResult | null> {
  return acceptWorkflowToolResult(db, input, {
    normalizeRecord,
    getMetadataRecord,
    readMetadataString,
    buildWorkflowStepRunMetadata,
    getWorkflowExecutionResultSnapshot,
    syncWorkflowRunState,
  });
}
export function bindRetainedWorkflowTool(
  db: Db,
  scope: Parameters<typeof bindRetainedWorkflowToolPrimitive>[1],
): ReturnType<typeof bindRetainedWorkflowToolPrimitive> {
  return bindRetainedWorkflowToolPrimitive(db, scope);
}

export function finalizeRetainedWorkflowTool(
  db: Db,
  owner: Parameters<typeof finalizeRetainedWorkflowToolPrimitive>[1],
  actual: Parameters<typeof finalizeRetainedWorkflowToolPrimitive>[2],
): ReturnType<typeof finalizeRetainedWorkflowToolPrimitive> {
  return finalizeRetainedWorkflowToolPrimitive(db, owner, actual, {
    normalizeRecord,
    getMetadataRecord,
    readMetadataString,
    buildWorkflowStepRunMetadata,
    syncWorkflowRunStateWithOutcome,
  });
}

export function releaseRetainedWorkflowToolUnsent(db: Db, owner: Parameters<typeof releaseRetainedWorkflowToolUnsentPrimitive>[1],
  proof: Parameters<typeof releaseRetainedWorkflowToolUnsentPrimitive>[2]): ReturnType<typeof releaseRetainedWorkflowToolUnsentPrimitive> {
  return releaseRetainedWorkflowToolUnsentPrimitive(db, owner, proof);
}

export async function retryIssueLessToolWorkflowStep(
  db: Db,
  input: { companyId: string; runId: string; stepId: string; recoveryRequestReference?: string | null; expectedFailure?: ExpectedToolFailure; validateIntent?: (tx: Db) => Promise<boolean>; qaRebind?: QaRebindRecoveryIntent },
): Promise<{ stepRunId: string; result: WorkflowExecutionResult } | null> {
  // [descope D2] workflow-type S 는 수동 issue-less retry 를 명시적으로 거부한다 — schedule/
  //   reset/retry-count 증가 같은 어떤 변이도 일어나기 "전"이다(스케줄러 리셋 제외 포함).
  const preflight = await loadWorkflowExecutionContext(db, input.runId);
  if (preflight.run.companyId === input.companyId) {
    const targetStep = preflight.steps.find((candidate) => candidate.id === input.stepId);
    if (targetStep && isWorkflowChildStep(targetStep)) return null;
  }
  return retryIssueLessToolWorkflowStepInternal({
    db,
    ...input,
    loadWorkflowExecutionContext,
    isIssueLessToolStep,
    // [descope D2] 리셋 경로에서도 정산된 workflow S 는 재오픈되지 않는다.
    resetUnlaunchedTerminalStepRuns: (resetDb, rows) =>
      resetUnlaunchedTerminalStepRuns(resetDb, rows, workflowChildStepIds(preflight.steps)),
    syncWorkflowRunState: (syncDb, runId) => syncWorkflowRunState(syncDb, runId, "workflow_retry"),
  });
}




const WORKFLOW_RUN_TERMINAL_STATUSES_SQL = sql`('completed', 'cancelled', 'aborted', 'failed', 'timed-out')`;




























// [cycle A §7] 실행 진입 래퍼/타입은 줄 수 예산을 위해 workflow-run-execution.ts 로 이관했다.
// 공개 표면(dag-engine 재노출)은 그대로 유지된다.
export {
  executeWorkflowRun,
  executeWorkflowRunWithStartOutcome,
  type WorkflowRunExecutionOutcome,
} from "./workflow-run-execution.js";

// NOTE: stuck-run 정리(reconcile)는 services/workflow/reconciler.ts 의
// createNativeWorkflowReconciler + reconcileWorkflow 로 이관했다. 과거 이 파일에
// 있던 reconcileWorkflowRuns(및 engine.ts 의 reconcile() 래퍼)는 호출부가 없는
// dead code 였고, 그 빈약 구현(run 상태만 failed 로 바꾸고 pending step / orphan
// step 은 처리하지 않음) 대신 reconciler.ts 의 더 완전한 구현을 주기 구동한다.
