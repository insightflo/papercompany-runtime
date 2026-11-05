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

const WORKFLOW_STEP_TERMINAL_STATUSES = new Set(["completed", "failed", "skipped"]);

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


function buildWorkflowDefinitionExecutionShape(context: WorkflowExecutionContext): WorkflowDefinitionExecutionShape {
  const definitionMeta = context.definition as typeof workflowDefinitions.$inferSelect & {
    executionMode?: unknown;
    dynamicPlanBootstrapOnly?: unknown;
    workflowMode?: unknown;
  };
  return {
    name: context.definition.name,
    executionMode: definitionMeta.executionMode,
    dynamicPlanBootstrapOnly: definitionMeta.dynamicPlanBootstrapOnly,
    workflowMode: definitionMeta.workflowMode,
    steps: context.steps,
  };
}

function getDynamicLaunchStepIds(context: WorkflowExecutionContext): Set<string> | undefined {
  const dynamicOwnerPlan = isDynamicOwnerPlanWorkflowDefinition(buildWorkflowDefinitionExecutionShape(context));
  if (!dynamicOwnerPlan) return undefined;
  return new Set(getWorkflowLaunchSteps(context.steps, { dynamicOwnerPlan }).map((step) => step.id));
}


/**
 * Validates that a workflow DAG is acyclic and well-formed.
 *
 * @param steps - The workflow steps to validate.
 * @returns Validation result with any errors or warnings.
 */














async function failMalformedCompletedControlNodes(
  db: Db,
  context: WorkflowExecutionContext,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  const runId = context.run.id;
  const steps = context.steps;
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const malformed = stepRuns.filter((stepRun) => {
    if (stepRun.status !== "completed") return false;
    const step = stepById.get(stepRun.stepId);
    if (!step || !isWorkflowControlNode(step)) return false;
    const parsed = workflowControlNodeResultSchema.safeParse(
      normalizeRecord(stepRun.metadata).controlNodeResult,
    );
    return !parsed.success || parsed.data.nodeType !== step.type;
  });
  if (malformed.length === 0) return stepRuns;

  const failedAt = new Date();
  for (const stepRun of malformed) {
    const metadata = normalizeRecord(stepRun.metadata);
    delete metadata.controlNodeResult;
    metadata.controlNodeError = {
      message: "Workflow control node completed without a valid result",
      failedAt: failedAt.toISOString(),
    };
    await db
      .update(workflowStepRuns)
      .set({
        status: "failed",
        completedAt: failedAt,
        lastDispatchErrorAt: failedAt,
        lastDispatchErrorSummary: "Workflow control node completed without a valid result",
        metadata,
      })
      .where(and(
        eq(workflowStepRuns.id, stepRun.id),
        eq(workflowStepRuns.workflowRunId, runId),
        eq(workflowStepRuns.status, "completed"),
      ));
  }
  // A malformed completed IF means branch selection cannot be trusted. Stop any
  // issue work already launched from that corrupt state, then let the normal skip
  // pass terminalize untouched branches and the normal finalizer fail the run.
  await cancelOutstandingWorkflowIssues(db, runId);
  const reloaded = await db.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));
  return syncStepRunsFromIssueState(db, reloaded, steps, context);
}












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

export async function getWorkflowExecutionResultSnapshot(
  db: Db,
  runId: string,
): Promise<WorkflowExecutionResult | null> {
  // [cycle B F8] run+step 행을 한 문장으로 읽는다 — 거부 시작(refused-start) 스냅숏과 컨텍스트가
  //   같은 일관 읽기 shape 을 공유하고, 단독 빈 step SELECT(프록시 배리어 표적)를 없앤다.
  const read = await readWorkflowRunWithStepRuns(db, runId, { requireDefinition: false });
  if (!read) return null;

  return mapWorkflowExecutionResult(read.run, read.stepRuns);
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










async function commentOnMainExecutorOversightForFailures(
  db: Db,
  context: WorkflowExecutionContext,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<void> {
  const missionId = context.run.missionId;
  if (!missionId) return;

  const failedStepRuns = stepRuns.filter((stepRun) => stepRun.status === "failed");
  if (failedStepRuns.length === 0) return;

  const oversightIssue = await db
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(
      eq(issues.missionId, missionId),
      eq(issues.originKind, "mission_main_executor_oversight"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!oversightIssue) return;

  const existingComments = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(eq(issueComments.issueId, oversightIssue.id));
  const existingBodies = existingComments.map((comment) => comment.body).join("\n");

  for (const stepRun of failedStepRuns) {
    const marker = `workflow-failure:${context.run.id}:${stepRun.stepId}`;
    if (existingBodies.includes(marker)) continue;
    const step = context.steps.find((candidate) => candidate.id === stepRun.stepId);
    await db.insert(issueComments).values({
      authorAgentId: oversightIssue.assigneeAgentId,
      body: [
        "### Workflow step failed\nA workflow step failed; the failure evidence is below. Next action: the mission owner should inspect the structured recovery options before requesting another run.",
        `<!-- ${marker} -->`,
        `- Workflow: ${context.definition.name}`,
        `- Run: ${context.run.id}`,
        `- Step: ${stepRun.stepId}${step?.name ? ` (${step.name})` : ""}`,
        `- Observed at: ${new Date().toISOString()}`,
        "",
        "Main executor action:",
        "- Review the failed step output and decide whether a retry is safe.",
        "- Retry failed steps only within the retry limit; otherwise escalate with context.",
      ].join("\n"),
      companyId: context.run.companyId,
      issueId: oversightIssue.id,
    });
  }
}



/** [cycle A §7] sync 소유 결과 — 실행 스냅숏과 별도로 전달되는 타입핑 결과. */
export type WorkflowSyncOutcome = { kind: "synced" | "not-owner" | "busy"; result: WorkflowExecutionResult };

/** 공개 시그니처 유지 — 소유 결과를 풀어 result 만 반환한다(cycle A §7). */
export async function syncWorkflowRunState(
  db: Db,
  runId: string,
  source: WorkflowSyncSource = "workflow_sync",
  options?: { childStartFence?: ChildStartFence; requireRunning?: boolean; requireMaterialized?: boolean },
): Promise<WorkflowExecutionResult> {
  return (await syncWorkflowRunStateWithOutcome(db, runId, source, options)).result;
}

// Shared issue-state snapshot for the v1 failed-predecessor wait policy.
async function loadIssueStatusesForStepRuns(
  db: Db,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(
    stepRuns
      .map((stepRun) => stepRun.issueId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  )];
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(inArray(issues.id, ids));
  return new Map(rows.map((row) => [row.id, row.status]));
}

export async function syncWorkflowRunStateWithOutcome(db: Db, runId: string, source: WorkflowSyncSource = "workflow_sync",
  options?: { childStartFence?: ChildStartFence; requireRunning?: boolean; requireMaterialized?: boolean }): Promise<WorkflowSyncOutcome> {
  return withQaCorrectionFollowupReconcile(db, runId, (rootDb, admission) =>
    withReplacementFirstDelivery(rootDb, runId, (tx) => syncWorkflowRunStateCore(tx, runId, source, options, admission, rootDb)));
}
async function syncWorkflowRunStateCore(
  db: Db,
  runId: string,
  source: WorkflowSyncSource = "workflow_sync",
  options?: { childStartFence?: ChildStartFence; requireRunning?: boolean; requireMaterialized?: boolean },
  admission?: QaRemediationAdmissionContext,
  admissionDb: Db = db,
): Promise<WorkflowSyncOutcome> {
  const normalizedSource = normalizeWorkflowSyncSource(source);
  const context = await loadWorkflowExecutionContext(db, runId);
  // [Task6b resume native entry] resume 수락 가드 — ensureStepRunRecords 를 포함한 모든 sync
  //   쓰기(step 레코드 생성/메타데이터 mutation)보다 엄격히 앞선다. own resumeRequestId 가
  //   없는 ordinary run 은 no-op 이고, resume run 은 durable 수락 계약 위반 시 conflict 로
  //   중단한다(catch-and-continue 없음; 기존 caller 에러 처리 유지). SELECT 가드일 뿐이며
  //   queue/claim/dispatch 의 공통 lock/TOCTOU 방어를 대체하지 않는다.
  await assertResumeAccepted(db, runId, context.run.dispatchAuthorityVersion);
  // [descope D3/D5] materializer 트랜잭션 진입 "전" 읽기 전용 발견 프리플라이트 — 수리는 존재하지
  //   않는다. invalid-child 는 not-owner 스냅숏으로 양보하고(fail-closed), linked/plain 은 각각
  //   임대 소유 materializer/기존 plain 경로로 진행한다(ancestor 잠금 없음).
  const syncEntry = await discoverWorkflowChildStart(db, runId);
  if (syncEntry.kind === "invalid-child") {
    const snapshot = await getWorkflowExecutionResultSnapshot(db, runId);
    if (!snapshot) throw new Error(`Workflow run ${runId} not found`);
    return { kind: "not-owner", result: snapshot };
  }
  // [cycle A §7] fence 소실(not-owner)/경합(busy)은 초기화/launch 로 진행하지 않고, 롤백 완료 "후"
  // 실제 영속 결과를 적재해 반환한다. running/빈 결과를 조작해 만들지 않는다.
  const materialization = await ensureStepRunRecords(db, runId, context.steps, options?.childStartFence, options?.requireRunning);
  if (materialization.kind !== "ready") {
    const snapshot = await getWorkflowExecutionResultSnapshot(db, runId);
    if (!snapshot) throw new Error(`Workflow run ${runId} not found`);
    return { kind: materialization.kind, result: snapshot };
  }
  let stepRuns = materialization.rows;
  const priorStatusByStepRunId = new Map(stepRuns.map((stepRun) => [stepRun.id, stepRun.status]));
  stepRuns = await syncStepRunsFromIssueState(db, stepRuns, context.steps, context);
  // [terminal-parent dispatch guard v1] 종결 부모 아래 late sync 는 늦은 선행 완료 근거만
  //   transition ledger 에 기록하고 파생 변이(reset/skip-propagation/revive/launch)를 공식
  //   재개까지 보류한다. 2026-09-23 RCA: 가드 없이는 sync 가 issue-less tool 후속을
  //   running+queued 로 materialize 한 뒤 reopen guard 가 부활만 거부해, 큐 selector
  //   (parent running)와 어긋난 좀비 큐 행이 공식 재개 전까지 claim 되지 않았다(26.2h QA 사례).
  //   실행 권위 없음(규칙 8/9) — 후속 작업 생성은 회복 경로의 소관이며, 보류 사실은 구조화
  //   활동으로 남긴다. failed 는 공식 resume/retry CAS 로 재개된다(가드는 재개를 막지 않는다).
  const reopenGuardEnabled = await isRunReopenGuardEnabled(db);
  if (reopenGuardEnabled && TERMINAL_WORKFLOW_STATUSES.has(context.run.status)) {
    await recordWorkflowStepStatusTransitions(db, {
      companyId: context.run.companyId,
      missionId: context.run.missionId,
      workflowRunId: context.run.id,
      source: normalizedSource,
      priorStatusByStepRunId,
      stepRuns,
    });
    try {
      await logActivity(db, {
        companyId: context.run.companyId,
        actorType: "system",
        actorId: "dag-engine",
        action: "workflow_run.terminal_parent_sync_deferred",
        entityType: "workflow_run",
        entityId: context.run.id,
        details: {
          runStatus: context.run.status,
          source: normalizedSource,
          lateChangedStepRunCount: stepRuns.filter((stepRun) => stepRun.status !== priorStatusByStepRunId.get(stepRun.id)).length,
        },
      });
    } catch {
      // 감사 실패가 fail-closed 결과(무변경)를 바꾸지 않는다.
    }
    const snapshot = await getWorkflowExecutionResultSnapshot(db, runId);
    if (!snapshot) throw new Error(`Workflow run ${runId} not found`);
    return { kind: "synced", result: snapshot };
  }
  const v1Enforcement = await isHeartbeatFinalizationV1Enabled(db);
  // [B2 좁은 회복 채널] v1 이 켜진 sync 에서만 이슈 상태 스냅샷을 적재한다(legacy 비용 없음).
  const issueStatusByIssueId = v1Enforcement
    ? await loadIssueStatusesForStepRuns(db, stepRuns)
    : new Map<string, string>();

  const dynamicLaunchStepIds = getDynamicLaunchStepIds(context);
  if (!dynamicLaunchStepIds && context.run.status !== "cancelled") {
    // [descope D2] 정산된 workflow S 는 이 리셋에서 명시 제외된다.
    stepRuns = await resetUnlaunchedTerminalStepRuns(db, stepRuns, workflowChildStepIds(context.steps));
  }
  if (context.run.status !== "cancelled") {
    stepRuns = await failMalformedCompletedControlNodes(db, context, stepRuns);
  }
  // [IF/loop] skip-propagation pass — 명시적 conditional false-branch 를 skipped 로 마감.
  //   hasConditionalEdges 게이트: conditional edge 가 없는 legacy 워크플로에겐 이 pass 가 no-op 이다(회귀 없음).
  //   syncStepRunsFromIssueState 이후·resetUnlaunchedTerminalStepRuns 이후에 실행한다 — QA request_changes →
  //   failed 가 반영된 후에야 when 평가가 정확하며, sentinel(controlFlowSkipped) 로 마감해 reset 의 flap(가즈아 hang)을 막는다.
  const hasConditionalEdges = workflowHasConditionalEdges(context.steps);
  // Plain legacy workflows must not pay the verdict-query cost. Load
  // authoritative validation verdicts only when conditional control flow or an
  // active issue-backed QA retry can actually consume semantic request_changes.
  const runValidationBindings = new Map<string, WorkflowValidationIssueBinding>();
  for (const stepRun of stepRuns) {
    if (!stepRun.issueId) continue;
    runValidationBindings.set(stepRun.issueId, {
      companyId: context.run.companyId,
      workflowRunId: stepRun.workflowRunId,
      workflowStepRunId: stepRun.id,
    });
  }
  const validationVerdictsByIssueId = context.run.status !== "cancelled"
    && shouldLoadValidationVerdictsForRun(context.steps, stepRuns)
    ? await loadLatestValidationVerdicts(db, runValidationBindings)
    : new Map<string, ValidationVerdictObservation>();
  // ④ revive pass — 선행이 회복(rework/재시도 completed) 되어 failure cascade 로 controlFlowSkipped 된
  //   downstream step 이 다시 runnable 이 되면 sentinel 을 풀고 pending 으로 부활시켜 이어지는 launch 가
  //   다시 잡게 한다. plain(legacy dependsOn) 워크플로도 포함한다 — deadlock-reconciler 가 남긴 stale skip 은
  //   선행 완료 후 반드시 재평가되어야 회복된 run 이 정상 종료된다(조건부-edge 전용 게이트 제거).
  //   IF false-branch / 여전히 failed 인 선행은 classifyStepActivation 이 runnable=false 를 주어 부활하지
  //   않는다(legitimate-skip/flap 회피). resetUnlaunchedTerminalStepRuns 은 controlFlowSkipped 를 제외하므로
  //   이 pass 가 유일한 정확한 부활 경로(무조건 skipped→pending flap 없음).
  let revivalProofLost = false;
  if (context.run.status !== "cancelled") {
    const reviveRunMap = buildStepRunMap(stepRuns);
    // [B2 사실망 통일] revive 도 launch 와 동일한 v1 정책 스냅샷을 소비한다 — launch 가 dispatch_ready_at
    //   대기로 미기동하는 선행을 revive 가 먼저 부활시키지 않는다(같은 평가에서 같은 사실).
    let revivePredsByStepId = buildPredFactsMap(context.steps, reviveRunMap, validationVerdictsByIssueId, v1Enforcement, issueStatusByIssueId);
    let revivedAny = false;
    for (const step of context.steps) {
      const sr = reviveRunMap.get(step.id);
      if (!sr || sr.status !== "skipped" || normalizeRecord(sr.metadata).controlFlowSkipped !== true) continue;
      if (!classifyStepActivation(step, revivePredsByStepId).runnable) continue;
      const nextMetadata = { ...buildWorkflowStepRunMetadata(step, sr.metadata), controlFlowSkipped: false };
      const result = await reviveConditionalSkip(db, {
        observedRun: context.run,
        target: sr,
        nextMetadata,
        observedPredecessors: stepRuns
          .filter((predecessor) => predecessor.id !== sr.id)
          .map(toConditionalStepObservation),
        invalidateGeneration: v1Enforcement,
      });
      if (result.kind !== "settled") {
        // The CAS proof was lost after the snapshot was taken. Reload authority and
        // stop this sync's derived passes; a later sync re-evaluates fresh state.
        revivalProofLost = true;
        stepRuns = await reloadWorkflowStepRunsForSameRun(db, stepRuns);
        // A cancelled durable row is terminal authority. Return the committed
        // snapshot instead of letting tail finalization recompute over it.
        const durable = await getWorkflowExecutionResultSnapshot(db, runId);
        if (!durable) throw new Error(`Workflow run ${runId} not found`);
        if (durable.status === "cancelled") {
          return { kind: "synced", result: durable };
        }
        break;
      }
      revivedAny = true;
      // Keep later candidates on the authoritative observation returned by the CAS
      // write; otherwise a revived predecessor still looks skipped and causes a
      // false proof loss on the next row.
      sr.status = "pending";
      sr.startedAt = null;
      sr.completedAt = null;
      sr.dispatchReadyAt = null;
      sr.evidenceReadyAt = null;
      sr.dispatchOwnerWakeupRequestId = null;
      sr.dispatchOwnerHeartbeatRunId = null;
      sr.executionGeneration = result.executionGeneration;
      sr.statusTransitionVersion = result.statusTransitionVersion;
      sr.metadata = nextMetadata;
      revivePredsByStepId = buildPredFactsMap(
        context.steps,
        reviveRunMap,
        validationVerdictsByIssueId,
        v1Enforcement,
        issueStatusByIssueId,
      );
    }
    if (revivedAny) {
      stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    }
  }
  if (!revivalProofLost) {
    const skipPropagation = await applyConditionalSkipPropagation({
      db,
      context,
      stepRuns,
      dynamicLaunchStepIds,
      validationVerdictsByIssueId,
      v1EnforcementEnabled: v1Enforcement,
      issueStatusByIssueId,
    });
    stepRuns = skipPropagation.stepRuns;
    if (skipPropagation.cancelled) {
      const durable = await getWorkflowExecutionResultSnapshot(db, runId);
      if (!durable) throw new Error(`Workflow run ${runId} not found`);
      if (durable.status === "cancelled") {
        return { kind: "synced", result: durable };
      }
      revivalProofLost = true;
    }
  }

  // [IF/loop P4] back-edge rework pass — QA request_changes 로 발화한 back-edge 의 타겟(producer) 을
  //   maxIterations cap 내에서 리셋(rework). 리셋된 producer 는 이어지는 launch while-loop 에서 재실행되고,
  //   producer 재완료 후 기존 validation-recheck(syncStepRunsFromIssueState) 가 QA issue 를 재QA 시킨다.
  //   skip-pass 이후·launch 이전에 실행: QA failed 가 반영된 뒤 리셋된 step 이 runnable 로 launch 되게.
  //   가즈아 무한 loop 방지: iteration_index 단조 증가 + maxIterations 하드 cap(loop-driver). reconciler(60min) 백업.
  if (!revivalProofLost && hasConditionalEdges && context.run.status !== "cancelled") {
    const reworkPredsByStepId = buildPredFactsMap(
      context.steps,
      buildStepRunMap(stepRuns),
      validationVerdictsByIssueId,
    );
    const reworkResult = await applyBackEdgeReworkPass({
      db,
      run: context.run,
      steps: context.steps,
      stepRuns,
      predsByStepId: reworkPredsByStepId,
      validationVerdictsByIssueId,
      refireQaStep: createQaRemediationRefire({ db, run: context.run, definition: context.definition,
        steps: context.steps, stepRuns }),
    });
    stepRuns = reworkResult.stepRuns;
  }
  if (admission?.pending.length) {
    const unresolved = await unresolvedQaRemediationAdmissionPending(admissionDb, admission, runId);
    if (unresolved.length) throw new QaRemediationAdmissionHold("unresolved_after_back_edge_rework", unresolved);
  }
  // [Hybrid QA] structural gate rework pass — when a structural (deterministic)
  //   tool gate returned request_changes, reset the producer for rework within
  //   the existing maxIterations cap. Also resets completed downstream structural
  //   gates when a producer is reworked (fresh gate re-run, no stale PASS).
  //   Runs after applyBackEdgeReworkPass so both QA and structural gate rejections
  //   are handled before the launch loop.
  if (!revivalProofLost && context.run.status !== "cancelled" && context.steps.some(isStructuralGateStep)) {
    const structuralResult = await applyStructuralGatePass({
      db,
      run: context.run,
      steps: context.steps,
      stepRuns,
    });
    stepRuns = structuralResult.stepRuns;
  }

  // [GAZ 저녁3 4f8cfacb] stale structural gate requeue — 위 rework pass 와 같은
  //   게이트 수명 주기 계열: producer 가 같은 iteration 안에서 이중완료(completedAt 재스탬프)
  //   되면, 그 전 토큰으로 PASS 한 completed 게이트는 영구히 낡은 증거가 되어 pending QA-like
  //   스텝의 createWorkflowIssue 가 매 sync 무음 null 을 반환한다(런 38fb7ef5 무발사 교착).
  //   해당 게이트를 CAS 로 pending 리셋+구조화 파인딩 기록 → 아래 launch loop 가 새 requestId/
  //   새 토큰으로 재파견해 결정적 validator 가 재검증한다. iteration 이 오르는 rework 세대는
  //   위 applyStructuralGatePass 소관이라 여기선 같은 iteration 형태만 다룬다(fail-closed).
  if (!revivalProofLost && context.run.status !== "cancelled" && context.steps.some(isStructuralGateStep)) {
    const requeueResult = await requeueStaleStructuralGatesForBlockedQa({
      db,
      run: context.run,
      steps: context.steps,
      stepRuns,
    });
    stepRuns = requeueResult.stepRuns;
  }

  // [Workflow Retry] After recovery/rework passes settle, atomically schedule
  // eligible failed steps; launch loop below dispatches immediate retries and
  // leaves delayed retries pending for the reconciler.
  if (!revivalProofLost && context.run.status !== "cancelled") {
    stepRuns = await applyWorkflowStepRetryPass({
      db,
      context,
      stepRuns,
      validationVerdictsByIssueId,
    });
  }

  const hasFailure = stepRuns.some((stepRun) => stepRun.status === "failed");
  if (!revivalProofLost && hasFailure) {
    await commentOnMainExecutorOversightForFailures(db, context, stepRuns);
  }
  // [IF/loop] short-circuit narrowing: legacy 워크플로(hasConditionalEdges=false)에선 기존과 동일하게
  //   hasFailure 시 launch 를 건너뛴다. conditional edge 가 있으면 failure/always-gated step 도 발화해야
  //   하므로 launch loop 를 항상 실행한다. [Hybrid QA 136B] structural gate failures are
  //   recoverable (request_changes triggers rework), so allow launch when structural
  //   gates exist — pending sibling gates must be able to finish.
  const hasStructuralGates = context.steps.some(isStructuralGateStep);
  if (!revivalProofLost && (!hasFailure || hasConditionalEdges || hasStructuralGates)) {
    let shouldContinue = true;
    let synchronousControlPasses = 0;
    while (shouldContinue) {
      shouldContinue = false;
      const stepRunMap = buildStepRunMap(stepRuns);
      const runnableSteps = sortWorkflowStepsByPriority(findRunnableSteps(context.steps, stepRunMap, {
        launchedStepIds: dynamicLaunchStepIds,
        validationVerdictsByIssueId,
        v1EnforcementEnabled: v1Enforcement,
        issueStatusByIssueId,
      }));
      if (runnableSteps.length === 0) break;

      let failedIssueLessToolStep = false;
      let executedControlNode = false;
      for (const step of runnableSteps) {
        const stepRun = stepRunMap.get(step.id);
        if (!stepRun) continue;

        if (isWorkflowControlNode(step)) {
          await executeWorkflowControlNode({ db, context, step, stepRun });
          executedControlNode = true;
          continue;
        }

        // [workflow child step] type:"workflow" — 같은 회사 대상 워크플로우를 자식 run 으로 실행.
        //   대기 스텝은 pending 유지 + invocation 멱등 클레임으로 재진입 안전. 마감은 completion hook 이 담당.
        //   [descope D2] retry admission/wait 힌트는 존재하지 않는다 — 세대는 항상 1이다.
        if (isWorkflowChildStep(step)) {
          const dispatched = await dispatchWorkflowChildStep({
            db,
            run: context.run,
            definition: context.definition,
            step,
            stepRun,
            now: new Date(),
          });
          failedIssueLessToolStep = failedIssueLessToolStep || !dispatched;
          continue;
        }

        if (isIssueLessToolStep(step) || await readWorkflowToolCorrection(db, context.run, stepRun, step)) {
          const started = await startIssueLessToolStepRun({
            db,
            run: context.run,
            definition: context.definition,
            step,
            steps: context.steps,
            stepRun,
            now: new Date(),
          });
          failedIssueLessToolStep = failedIssueLessToolStep || !started;
          if (started) {
            await markIssueLessRetryDispatchingFromProof({
              db,
              workflowRunId: context.run.id,
              stepRunId: stepRun.id,
              observedRetryCount: stepRun.retryCount,
              priorLastDispatchRequestId: stepRun.lastDispatchRequestId,
              metadata: stepRun.metadata,
            });
          }
          continue;
        }

        if (stepRun.issueId) {
          const retryMeta = readWorkflowRetryMetadata(normalizeRecord(stepRun.metadata).workflowRetry);
          const resumeExistingIssue = stepRunNeedsWorkflowResume(stepRun) || retryMeta !== null;
          await wakeIssueBackedRetryAndMarkDispatching({
            db,
            companyId: context.run.companyId,
            workflowRunId: context.run.id,
            definition: context.definition,
            run: context.run,
            step,
            stepRunId: stepRun.id,
            stepRunMetadata: stepRun.metadata,
            issueId: stepRun.issueId,
            observedRetryCount: stepRun.retryCount,
            resumeExistingIssue,
            wakeExistingWorkflowStepIssue,
          });
          continue;
        }

        if (context.definition.sourceKind === "quality") {
          // [T3 Quality DAG 계약] 생성+step 연결 commit 후 깨우기(native-records 코어).
          //   일반 경로도 아래에서 연결 후 깨우되, quality의 원자 생성 계약은 그대로 유지한다.
          await syncQualityStepIssueCommitBeforeWake(
            db, { run: context.run, definition: context.definition, step, stepRunId: stepRun.id }, createWorkflowStepIssue);
          continue;
        }
        let applyCreatedSideEffects: (() => Promise<void>) | undefined;
        const issueId = await createWorkflowStepIssue({
          db, run: context.run, definition: context.definition, step, steps: context.steps,
          captureDeferredSideEffects: (apply) => { applyCreatedSideEffects = apply; },
        });
        if (!issueId) continue;
        await db.update(workflowStepRuns).set({ issueId }).where(eq(workflowStepRuns.id, stepRun.id));
        // The original wake must see the durable step binding; never adopt it after claim.
        if (applyCreatedSideEffects) await applyCreatedSideEffects();
      }

      stepRuns = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runId));

      if (executedControlNode) {
        synchronousControlPasses += 1;
        if (synchronousControlPasses > context.steps.length + 1) {
          throw new Error(`Workflow control-node convergence limit exceeded for run ${runId}`);
        }
        // Only a freshly executed IF can change condition_true/condition_false
        // reachability inside this synchronous loop. Keep the legacy QA/back-edge
        // launch order untouched on iterations that did not execute a control node.
        const skipPropagation = await applyConditionalSkipPropagation({
          db,
          context,
          stepRuns,
          dynamicLaunchStepIds,
          validationVerdictsByIssueId,
          v1EnforcementEnabled: v1Enforcement,
          issueStatusByIssueId,
        });
        stepRuns = skipPropagation.stepRuns;
        if (skipPropagation.cancelled) {
          const durable = await getWorkflowExecutionResultSnapshot(db, runId);
          if (!durable) throw new Error(`Workflow run ${runId} not found`);
          if (durable.status === "cancelled") {
            return { kind: "synced", result: durable };
          }
          revivalProofLost = true;
          break;
        }
      }
      shouldContinue = failedIssueLessToolStep || executedControlNode;
    }
  }

  const hasFailureAfterLaunch = stepRuns.some((stepRun) => stepRun.status === "failed");
  if (!hasFailure && hasFailureAfterLaunch) {
    await commentOnMainExecutorOversightForFailures(db, context, stepRuns);
  }

  if (dynamicLaunchStepIds && !hasFailure) {
    const launchedStepRuns = stepRuns.filter((stepRun) => dynamicLaunchStepIds.has(stepRun.stepId));
    const launchedStepsTerminal = launchedStepRuns.length === dynamicLaunchStepIds.size
      && launchedStepRuns.every((stepRun) => WORKFLOW_STEP_TERMINAL_STATUSES.has(stepRun.status));
    const unlaunchedPendingSteps = stepRuns.filter((stepRun) =>
      !dynamicLaunchStepIds.has(stepRun.stepId) && stepRun.status === "pending" && stepRun.issueId == null
    );
    if (launchedStepsTerminal && unlaunchedPendingSteps.length > 0) {
      const now = new Date();
      for (const stepRun of unlaunchedPendingSteps) {
        // [step-status fencing v1] pending → skipped 만 허용 — 스냅샷 이후 launch 가
        //   running 으로 옮긴 행을 skipped 로 덮어쓰지 않는다.
        await setWorkflowStepRunStatus(db, {
          stepRunId: stepRun.id,
          status: "skipped",
          patch: { completedAt: now },
          expectedStatuses: ["pending"],
        });
      }
      stepRuns = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runId));
    }
  }

  // [if-stale-sync] 일반 sync 경로의 stale IF 재평가(관찰/재평가 분리) — 완료된 IF verdict 가
  //   평가 시점(controlNodeResult.evaluatedAt) 이후 갱신된 소스 work product 후보를 소비했으면
  //   pending 리셋만 수행한다. 재평가는 다음 sync 의 launch loop(executeWorkflowControlNode CAS)가
  //   수행하고, skip 부활·launch 는 그 다음 sync 패스에서 진행된다(한 패스 한 레벨 — resume 계약과
  //   동일한 수렴 속도). launch loop 안에서 재평가까지 끝내면 공식 재작업 경로(산물 재등록 → agent_api
  //   sync → 수동/공식 resume)가 모델링한 레벨 구분이 한 패스 앞당겨져 기존 계약(workflow-mirror-dag
  //   -retry-rework: resume 1회차 재평가·2회차 부활)과 충돌한다(2026-09-25, run 16dac130 레이스는
  //   resume 없이 다음 sync 들으로 자동 수렴). 터미널 run 은 terminal-parent 가드의 파생변이 보류
  //   원칙을 깨지 않는다(가드 early-return 경로와 종결 run 모두 미호출). 재사용 함수는 resume 무관하게
  //   설계되어 있다(신선도 미확시 보수 유지). finalize 전에 실행해 pending IF 를 run 종결 판정에
  //   반영시키고, transition ledger 도 completed→pending 을 기록한다.
  if (!TERMINAL_WORKFLOW_STATUSES.has(context.run.status)) {
    try {
      const staleIfResetCount = await resetStaleIfControlNodesForResume({
        db,
        companyId: context.run.companyId,
        workflowRunId: runId,
        steps: context.steps,
      });
      if (staleIfResetCount > 0) {
        stepRuns = await reloadWorkflowStepRunsForSameRun(db, stepRuns);
      }
    } catch (error) {
      logger.warn({ err: error, workflowRunId: runId }, "stale IF control-node reset failed; continuing sync");
    }
  }
  // [run-reopen-guard v1] 플래그는 sync 당 1회 읽는다(terminal-parent 가드에서 읽은 값을 재사용).
  const terminalBoundaryEnabled = await isRunTerminalBoundaryV1Enabled(db);
  const updatedRun = await finalizeWorkflowRunState(db, context, stepRuns, terminalBoundaryEnabled, reopenGuardEnabled, {
    normalizeRecord, getDynamicLaunchStepIds, buildWorkflowDefinitionExecutionShape,
  });
  // [workflow child step] 자식 run 종말 → 부모 waiting 스텝 마감 훅. 훅 실패는 sync 를 깨뜨리지 않는다
  //   (reconciler 가 회복). 훅은 자기 waiting 스텝만 마감한다(규칙 7/8).
  if (TERMINAL_WORKFLOW_STATUSES.has(updatedRun.status)) {
    try {
      // [descope D3/D5] linked 발견에 한해 종말 훅을 발화한다 — 훅은 linked 전체 신원으로만
      //   부모 스텝을 정산하고, invalid 신원은 정산을 촉발하지 않는다(회복 경로 소관).
      const hookEntry = await discoverWorkflowChildStart(db, updatedRun.id);
      if (hookEntry.kind === "linked") {
        await runWorkflowChildCompletionHook(db, {
          id: updatedRun.id,
          companyId: updatedRun.companyId,
          status: updatedRun.status,
        });
      }
    } catch {
      // swallowed: reconciler (reconcileWorkflowChildStepWaits) 가 회복한다.
    }
  }
  try {
    await closeResolvedWorkflowUnblocks({
      db,
      run: {
        id: updatedRun.id,
        status: updatedRun.status,
        companyId: updatedRun.companyId,
        missionId: updatedRun.missionId,
      },
      stepRuns,
    });
  } catch {
    // Unblock closeout must never break workflow synchronization.
  }
  // [qa source-defect card cleanup] 상황 해소(런 종결/이후 generation 통과)로 무효가 된 pending
  //   원천결함 오너 카드를 자동 cancel 한다(감사 로그 동반). 실패해도 sync 를 깨뜨리지 않는다.
  //   failed 종결은 카드가 여전히 유효한 에스컬레이션이므로 정리 대상이 아니다(모듈 내부 판정).
  try {
    await cancelResolvedQaSourceDefectOwnerCards({
      db,
      companyId: context.run.companyId,
      run: { id: updatedRun.id, status: updatedRun.status },
      steps: context.steps,
      stepRuns,
    });
  } catch {
    // swallowed: card cleanup must never break workflow sync.
  }
  await recordWorkflowStepStatusTransitions(db, {
    companyId: context.run.companyId,
    missionId: context.run.missionId,
    workflowRunId: context.run.id,
    source: normalizedSource,
    priorStatusByStepRunId,
    stepRuns,
  });

  return {
    kind: "synced",
    result: {
      runId,
      workflowId: updatedRun.workflowId,
      missionId: updatedRun.missionId,
      status: updatedRun.status as "running" | "completed" | "failed" | "cancelled",
      completedAt: updatedRun.completedAt,
      error: updatedRun.status === "failed" ? "One or more workflow steps failed" : undefined,
      stepRuns: stepRuns.map((stepRun) => ({
        id: stepRun.id,
        workflowRunId: stepRun.workflowRunId,
        stepId: stepRun.stepId,
        issueId: stepRun.issueId,
        status: stepRun.status as "pending" | "running" | "completed" | "failed" | "skipped",
        startedAt: stepRun.startedAt,
        completedAt: stepRun.completedAt,
      })),
    },
  };
}

export async function syncWorkflowRunForIssue(
  db: Db,
  issueId: string,
  source: WorkflowSyncSource = "workflow_sync",
): Promise<WorkflowExecutionResult | null> {
  const normalizedSource = normalizeWorkflowSyncSource(source);
  const issue = await db
    .select({
      originKind: issues.originKind,
      originRunId: issues.originRunId,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (issue?.originKind === "workflow_execution" && issue.originRunId) {
    return syncWorkflowRunState(db, issue.originRunId, normalizedSource);
  }

  const linkedStepRun = await db
    .select({ workflowRunId: workflowStepRuns.workflowRunId })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.issueId, issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!linkedStepRun?.workflowRunId) {
    return null;
  }

  return syncWorkflowRunState(db, linkedStepRun.workflowRunId, normalizedSource);
}

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
