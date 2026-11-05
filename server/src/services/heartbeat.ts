import fs from "node:fs/promises";
import { prioritizeProjectWorkspaceCandidatesForRun } from "./heartbeat-workspace-priority.js";
import { hasWorkflowQaReworkContract, shouldResetTaskSessionForWake } from "./heartbeat-session-reset.js";
export { shouldResetTaskSessionForWake } from "./heartbeat-session-reset.js";
import { detectCodexAuthFailureForAutoBlock, type CodexAuthAutoBlockInfo } from "./heartbeat-codex-auth-classification.js";
export { detectCodexAuthFailureForAutoBlock } from "./heartbeat-codex-auth-classification.js";
export type { CodexAuthAutoBlockInfo } from "./heartbeat-codex-auth-classification.js";
import { resolveRuntimeSessionParamsForWorkspace, type ResolvedWorkspaceForRun } from "./heartbeat-workspace-session.js";
export { resolveRuntimeSessionParamsForWorkspace } from "./heartbeat-workspace-session.js";
export type { ResolvedWorkspaceForRun } from "./heartbeat-workspace-session.js";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, is, isNotNull, isNull, lt, lte, not, or, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { withTxTimeout } from "@paperclipai/db";
import type { BillingType, HeartbeatRunStatus } from "@paperclipai/shared";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  companies,
  heartbeatRunEvents,
  heartbeatRuns,
  workflowRuns,
  workflowTransitionEvents,
  documents,
  issueComments,
  issueDocuments,
  issueExecutionCards,
  issueWorkProducts,
  issues,
  missionSessions,
  missions,
  operatorDecisions,
  projects,
  projectWorkspaces,
  workflowStepRuns,
} from "@paperclipai/db";
import { HttpError, conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { loadConfig } from "../config.js";
import { publishLiveEvent } from "./live-events.js";
import { getRunLogStore } from "./run-log-store.js";
import { createHeartbeatRunLog } from "./heartbeat-run-log.js";
import { getServerAdapter, runningProcesses } from "../adapters/index.js";
import { createHeartbeatAgentCancellation, publishHeartbeatRunStatus } from "./heartbeat-agent-cancellation.js";
import type { AdapterExecutionResult, AdapterInvocationMeta, AdapterSessionCodec, AdapterSessionUpdate } from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { assertHeartbeatAdapterMayStart, createHeartbeatAdapterScope, isHeartbeatUnstartedDeferral, runWithinHeartbeatAdapterScope } from "./heartbeat-adapter-scope.js";
import { runtimeExecutionLifecycle, type RuntimeExecutionScope } from "./runtime-execution-lifecycle.js";
import { parseObject, asBoolean, asNumber } from "../adapters/utils.js";
import { resolveAdapterFallbackThinking, resolveAdapterFallbackConfig, applyAdapterFallbackRuntimeConfig, type AdapterFallbackConfig } from "./heartbeat-adapter-fallback.js";
import { withAgentStartLock } from "./heartbeat-start-lock.js";
import { deriveRepoNameFromRepoUrl } from "./heartbeat-workspace-repo-name.js";
import { normalizePaperclipApiUrl, resolveHostForPaperclipApiUrl } from "./heartbeat-api-address.js";
import { normalizeMaxConcurrentRuns } from "./heartbeat-concurrency-limit.js";
import { isProcessAlive, terminateRecordedProcess } from "./heartbeat-process-liveness.js";
import { hasSatisfiedWorkProductRegistration } from "./heartbeat-artifact-registration.js";
export { hasSatisfiedWorkProductRegistration, workProductReferencesClaimedArtifact } from "./heartbeat-artifact-registration.js";
import { resolveHeartbeatFailureCode, isTerminalHeartbeatRunStatus } from "./heartbeat-run-status.js";
import { recordHeartbeatQueueTransitionEvent, recordHeartbeatRunTerminalTransitionEvent, requeueCoalescedWakeupsForFinishedRun, setHeartbeatRunStatus } from "./heartbeat-queue-lifecycle.js";
export { recordHeartbeatQueueTransitionEvent, recordHeartbeatRunTerminalTransitionEvent, requeueCoalescedWakeupsForFinishedRun, setHeartbeatRunStatus } from "./heartbeat-queue-lifecycle.js";
import { isWorkflowStepResumeWake } from "./heartbeat-workflow-resume-wake.js";
import { costService } from "./costs.js";
import { mergeAgentConfig } from "./agents.js";
import {
  executeFencedEffect,
  HEARTBEAT_ADAPTER_EXECUTE_EFFECT_KIND,
} from "./effect-envelope.js";
import { readExplicitValidationVerdict } from "./validation-verdict.js";
import { hasWorkflowValidationCompletionLedger } from "./workflow/validation-verdict-ledger.js";
import { companySkillService } from "./company-skills.js";
import { budgetService, type BudgetEnforcementScope } from "./budgets.js";
import { secretService } from "./secrets.js";
import { resolveWorkflowStepToolContext } from "./heartbeat-workflow-tool-context.js";
import { resolveWorkflowStepKnowledgeContext } from "./heartbeat-workflow-knowledge-context.js";
import { resolveMaintenanceGuidanceContext } from "./heartbeat-maintenance-guidance.js";
import { classifyHeartbeatRunFailure, heartbeatRunFailureText, type HeartbeatFailureClassification } from "./heartbeat-failure-classification.js";
import { normalizeUsageTotals, readRawUsageTotals, deriveNormalizedUsageDelta, formatCount, type UsageTotals } from "./heartbeat-usage-totals.js";
import { MISSION_CHILD_RUN_OUTPUT_COMMENT_MAX_CHARS, runText, buildMissionChildRunOutputComment, buildSuccessfulIssueRunAutoCompletedComment, buildNoProgressAutoBlockedComment, buildMissionWorkerNoProgressOversightComment, buildFailedIssueRunAutoBlockedComment, buildMissionWorkerFailureOversightComment, buildMissionOversightRunFailureComment, buildMissionOversightRunSucceededReleaseComment } from "./heartbeat-run-presentation.js";
import { buildRequestChangesValidationGateComment, buildMissingWorkflowValidationVerdictGateComment, buildInsufficientEvidenceWorkflowVerdictGateComment, buildRequestChangesOwnerActionDescription, type RequestChangesVerdict } from "./heartbeat-validation-presentation.js";
export { classifyHeartbeatRunFailure, type HeartbeatFailureClassification } from "./heartbeat-failure-classification.js";
import { finalizeHermesChatRun } from "./hermes-chat.js";
import { missionSessionStore } from "./sessions/mission-session-store.js";
import { resolveDefaultAgentWorkspaceDir, resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { capHeartbeatRunResultJsonForStorage, summarizeHeartbeatRunResultJson } from "./heartbeat-run-summary.js";
import {
  attentionHeartbeatRuns,
  clampRunListLimit,
  countHeartbeatRuns,
  listHeartbeatRunSummaryPage,
  statsHeartbeatRuns,
} from "./heartbeat-bounded-reads.js";
import { extractCodexTaskCompleteMessages } from "./workflow/codex-task-output.js";
import { createWorktreeHarness, WorktreeViolation } from "./worktree/harness.js";
import {
  buildWorkspaceReadyComment,
  cleanupExecutionWorkspaceArtifacts,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  sanitizeRuntimeServiceBaseEnv,
} from "./workspace-runtime.js";
import { issueService } from "./issues.js";
import { writeQualityFinding } from "./quality-finding-writer.js";
import {
  buildQualityWakeAcceptancePatch,
  findExistingQualityWakeRow,
  mergeableWakeupKeyCondition,
  queuePausedAgentWakeupRequest,
} from "./quality/heartbeat-admission.js";
import { isBoundedExecutionWakeKey } from "./quality/native-wake.js";
import { agentWikiService, formatWikiLessons, type RecordFailureInput } from "./agent-wiki.js";
import {
  formatKnowledgePatternCards,
  injectionGroupFor,
  selectCardsForInjection,
} from "./knowledge-pattern-injection.js";
import {
  buildHeartbeatFailureWikiLesson,
  classifyWorkProductFailure,
} from "./heartbeat-failure-wiki.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import { evaluateContextBudgetPreflight } from "./context-budget-preflight.js";
import {
  confirmInstructionInjectionDelivery,
  forceFullInstructionInjection,
  invalidateInstructionInjectionSession,
  prepareInstructionInjection,
} from "./instruction-injection-ledger.js";

import { refreshStepInputManifest } from "./wake-context-hygiene.js";
import {
  advanceOperatorInstructionCursor,
  assembleIssueCommentContext,
} from "./operator-instruction-cursor.js";
import {
  resolveAdapterFailedTransientRetryMaxSec,
  resolveNoProgressAdvisoryThreshold,
  resolveNoProgressAutoBlockThreshold,
  resolveQaStepActiveExecutionTimeoutMs,
  resolveStepAwareActiveExecutionTimeoutMs,
} from "./heartbeat-stability.js";
import { computeConsecutiveNoProgress, type NoProgressAssessment } from "./heartbeat-no-progress.js";
export { computeConsecutiveNoProgress, type NoProgressAssessment } from "./heartbeat-no-progress.js";
import { evaluateStepInputManifestGuard } from "./step-input-manifest-guard.js";
import { completeLinkedWorkflowStepRunsForIssue } from "./workflow/issue-step-closeout.js";
import {
  configureInstantWorkflowAdvanceDb,
  requestInstantWorkflowAdvance,
} from "./workflow/instant-advance.js";
import { buildSessionHandoffArtifact, type SessionHandoffArtifact } from "./session-handoff-artifact.js";
import { buildContextSafeFileViews } from "./context-safe-file-views.js";
import {
  FILE_VIEW_STALENESS_ROTATION_REASON,
  evaluateSessionFileStaleness,
  parseFileViewStalenessRotationPolicy,
} from "./file-view-session-staleness.js";
import { buildRuntimeSearchPathPermissions } from "./runtime-search-path-permissions.js";
import { isPathInsideOrEqual, resolveMissionWorkProductPaths } from "./work-products/output-paths.js";
import {
  extractClaimedArtifactPathsFromText,
  extractExplicitArtifactPaths,
  extractExplicitArtifactUrls,
  isActionableClaimedArtifactPath,
  resolveCommentArtifactPathCandidates,
} from "./work-products/artifact-claim-paths.js";
import { buildMaintenanceDecisionContext } from "./maintenance/decision-context.js";
import { logMaintenanceDecisionEvaluated } from "./maintenance/decision-audit.js";
import { missionPlanArtifactService } from "./mission-plan-artifacts.js";
import { missionService } from "./missions.js";
import { type PlanQaWakeupHandler, type PlanningIssueWakeupHandler } from "./mission-owner-plan-decisions.js";
import { blockMissionPlanQaCompletionWithoutLedger, hasMissionPlanQaCompletionLedger } from "./missions/mission-plan-qa-completion-gate.js";
import { buildMissionOwnerPlanningContext } from "./missions/mission-owner-planning-context.js";
import { createPlanQaWakeupHandler, createPlanningIssueWakeupHandler } from "./missions/plan-qa-wakeup.js";
import { buildMissionExecutionDigest } from "./missions/mission-execution-digest.js";
import { buildMissingWorkProductRegistrationGateComment } from "./work-products/artifact-registration-instructions.js";
import { handleDelegatedArtifactHandback } from "./delegated-artifact-handback.js";
import {
  MISSION_OWNER_DECISION_OPTIONS,
  parseMissionOwnerActionMarker,
  type ExtractedMissionOwnerDecision,
} from "./missions/mission-owner-recovery-events.js";
import { loadLatestMissionOwnerDecision } from "./missions/mission-owner-recovery-ledger.js";
import { isMissionExecutionLiaisonAgent } from "./missions/agent-role-boundaries.js";
import { syncSrbSourceIssueStatus } from "./srb/source-status-sync.js";
import {
  assertMissionRuntimeAcceptsWork,
  buildMissionIssueHandoffMarkdown,
  completeMissionAgentRuntimeRun,
  markMissionRuntimeBootstrapInjected,
  persistMissionIssueHandoff,
  reapStaleBusyMissionRuntimes as reapStaleBusyMissionRuntimesCore,
  resolveMissionDecisionLogPointer,
  updateMissionRollingStateFromHandoff,
} from "./missions/mission-runtime-manager.js";
import { compileMissionRunContext } from "./missions/mission-context-compiler.js";
import { buildAssignedIssuePromptSection } from "./missions/mission-issue-envelope.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  gateProjectExecutionWorkspacePolicy,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../log-redaction.js";
import { isHeartbeatFinalizationV1Enabled } from "./heartbeat-finalization/flag.js";
import {
  acknowledgeHeartbeatRunBeforeAdapter,
  recordHeartbeatTerminalOutcomeShadow,
} from "./heartbeat-finalization/shadow-writes.js";
import { deriveTaskKey, normalizeAgentNameKey, readNonEmptyString, resolveAdapterFallbackAttempt, runTaskKey, isSameTaskScope } from "./heartbeat-run-context.js";
import { enqueueAdapterFallbackRun, enqueueProcessLossRetry, type HeartbeatRetryEnqueueDeps } from "./heartbeat-retry-enqueue.js";
import { resolveWorkflowExecutionLink } from "./heartbeat-finalization/workflow-link.js";
import { insertWorkflowWakeRequest } from "./heartbeat-workflow-wake.js";
import { preserveWorkflowAttemptProof, withoutWorkflowAttemptProof } from "./heartbeat-finalization/workflow-attempt-proof.js";
import { assertHeartbeatRecoveryAdmission, claimQueuedRunWithRecoveryGuard, claimAvailableHeartbeatRuns,
  executeHeartbeatWithRecoveryGuard, startHeartbeatWithC5ExecutionGuard } from "./heartbeat-recovery-guard.js";
import { maybeRecordTerminalFinalization } from "./heartbeat-finalization/shadow-terminal-hook.js";
import {
  SHUTDOWN_INTERRUPTED_ERROR_CODE,
  buildShutdownCheckpoint,
  emptyFlushSummary,
  remainingMs,
  type ShutdownFlushSummary,
} from "./shutdown-flush.js";
import { operatorApprovalWaitService } from "./operator-approval-wait.js";
import { settleHeartbeatAfterExecution } from "./heartbeat-finalization/post-execution.js";
import { attemptFullSettlement } from "./heartbeat-finalization/settlement.js";
import { createPauseExecutionObservation, finishPauseExecution } from "./heartbeat-pause-quiescence.js";
import { observeQuiescenceResources } from "./heartbeat-finalization/quiescence-probe.js";
import { createHeartbeatActualObservation, freezeHeartbeatActualDrainIdentity, isProvenNonC5WorkflowExecution,
  writeHeartbeatActualDrain, type HeartbeatActualDrainIdentity } from "./heartbeat-actual-drain.js";
import { readWorkflowAttemptProof } from "./heartbeat-finalization/workflow-attempt-proof.js";
import {
  acknowledgeTerminalReleaseObligation,
  createTerminalReleaseManifest,
  readReadyTerminalReleaseContinuation,
  readTerminalReleaseAcknowledgment,
  readTerminalReleaseManifest,
  readTerminalReleaseManifestForSource,
  terminalReleaseMatchesRun,
  TERMINAL_RELEASE_EVENT_TYPE,
  writeTerminalReleaseManifest,
  type TerminalFollowup,
} from "./heartbeat-terminal-release-continuation.js";
import { readTerminalContinuationSource, settleTerminalContinuationFromQaSuccessor } from "./heartbeat-terminal-successor-settlement.js";
import {
  assertIssueResumeScopeIdentity,
  recordResumeStaleResultRejected,
  resolveHeartbeatResumeScopeFence,
} from "./workflow/resume-scope-fence.js";
import { trackHeartbeatExecution } from "./heartbeat-execution-tracker.js";
import { failWakeupForFailedHeartbeat } from "./heartbeat-wakeup-failure.js";

type ActiveHeartbeatExecutionFrame = {
  readonly run: typeof heartbeatRuns.$inferSelect;
  readonly finalizationVersion: number | null;
  adapterInvocationAttempted: boolean;
  actualCaptured: boolean;
  identityObserved: boolean;
  actualDrainIdentity: HeartbeatActualDrainIdentity | null;
  noActualInvocationConfirmed: boolean;
  c5ExecutionOptedIn: boolean;
  c5NotInvoked: { proof: C5NotInvokedProof; identity: QaCorrectionExecutionIdentity } | null;
  c5TerminalWriterSnapshot: typeof heartbeatRuns.$inferSelect | null;
  ownerReleaseBlocked: boolean;
  conflicted: boolean;
};

type HeartbeatServiceOptions = {
  qaCorrectionExecution?: { ownerRuntime: QaFileOwnerRuntime };
};

// A root Db keeps its explicitly supplied owner runtime across bare service recreation.
// The WeakMap keys by the exact Db object and does not share execution contexts or roots.
import { sameHeartbeatExecutionAttempt, heartbeatActualIdentityMatchesRun, producedExecutionScopeKind, sameC5ExecutionIdentityBeforeOwnerRelease } from "./heartbeat-attempt-identity.js";

const heartbeatC5OwnerRuntimeByDb = new WeakMap<Db, QaFileOwnerRuntime>();

function bindHeartbeatC5OwnerRuntime(db: Db, explicit: QaFileOwnerRuntime | undefined) {
  const bound = heartbeatC5OwnerRuntimeByDb.get(db);
  if (explicit) {
    if (bound && bound !== explicit) throw new Error("heartbeat_c5_owner_runtime_binding_conflict");
    if (!bound) heartbeatC5OwnerRuntimeByDb.set(db, explicit);
    return explicit;
  }
  if (bound) return bound;
  const ownerRuntime = createQaFileOwnerRuntime(loadConfig());
  heartbeatC5OwnerRuntimeByDb.set(db, ownerRuntime);
  return ownerRuntime;
}

function createHeartbeatC5SharedAdmission(ownerRuntime: QaFileOwnerRuntime): QaRemediationSharedAdmissionRuntime {
  const outerNotifications = createReplacementRootNotifications();
  const resolutionMap = new Map<string, unknown>();
  const rootResolutionMaps = new WeakMap<ReplacementRootNotifications, Map<string, unknown>>();
  return {
    ownerRuntime,
    outerNotifications,
    resolutionMap,
    bindResolutionMap: (notifications, map) => rootResolutionMaps.set(notifications, map),
    driftBudget: { corrections: 0 },
  };
}

function mergeHeartbeatRootNotifications(target: ReplacementRootNotifications, source: ReplacementRootNotifications) {
  for (const agentId of source.agentIds) target.agentIds.add(agentId);
  for (const wakeupRequestId of source.correctionWakeupRequestIds) target.correctionWakeupRequestIds.add(wakeupRequestId);
}

class C5NotInvokedExecutionError extends Error {
  readonly code = "c5_held_not_invoked";
  constructor(readonly proof: C5NotInvokedProof) {
    super("heartbeat adapter start held by pending QA remediation preparation");
  }
}

// heartbeatService(db) is created by several control-plane callers. Share only live frames
// for that exact Db object so cancellation can consult the active actual without persistence.
const activeHeartbeatExecutionFramesByDb = new WeakMap<Db, Map<string, ActiveHeartbeatExecutionFrame>>();

function activeHeartbeatExecutionFrames(db: Db) {
  let frames = activeHeartbeatExecutionFramesByDb.get(db);
  if (!frames) {
    frames = new Map();
    activeHeartbeatExecutionFramesByDb.set(db, frames);
  }
  return frames;
}



const NONWORKFLOW_EXECUTION_SCOPES = new Set([
  "issue_nonworkflow", "mission_nonworkflow", "timer", "manual_on_demand", "automation_nonworkflow",
]);


import { createSkippedWakeWriter, promoteQueuedWakeupRequestsForAgent, selectQueuedAgentIds, selectDeferredWakeupRequest, failFollowupWake, type HeartbeatFollowupQueueDeps } from "./heartbeat-followup-queue.js";
import { isStoredOperatorDecisionWake, promoteStoredDeferredWakes } from "./heartbeat-stored-recovery-admission.js";
import { promoteQueuedWakeupRequest, promoteDeferredWakeupRequest, insertInitialWakeupRun, insertQueuedHeartbeat, type HeartbeatFollowupPromotionDeps } from "./heartbeat-followup-promotion.js";
import { readQaCorrectionWakeRef } from "./work-products/qa-correction-producer-attempt.js";
import { withCorrectionDeliveryRoot, type CorrectionDeliveryInput, type CorrectionDeliveryResult } from "./workflow/control-flow/qa-correction-delivery-root.js";
import { assertDeliveryInput, requireDelivery } from "./workflow/control-flow/qa-correction-delivery-receipt.js";
import { createReplacementRootNotifications, currentReplacementRootNotifications, isQaCorrectionRootOwnerRequired,
  validateAndRegisterQaCorrectionRootDrain, withReplacementRootNotificationDb,
  type ReplacementRootNotifications } from "./issue-assignment-wakeup.js";
import {
  captureQaCorrectionExecutionIdentity,
  QaCorrectionClaimRejected,
  withQaCorrectionClaimRoot,
} from "./workflow/control-flow/qa-correction-claim-root.js";
import { isC5PreInvocationRollback, QaRemediationAdmissionHold, readC5NotInvokedProof, type C5NotInvokedProof, type QaCorrectionExecutionIdentity,
  type QaRemediationSharedAdmissionRuntime }
  from "./workflow/control-flow/qa-remediation-admission-root.js";
import { createQaFileOwnerRuntime, type QaFileOwnerRuntime } from "./workflow/control-flow/qa-remediation-runtime.js";
import { lifecycleActiveClause, lifecycleInFlightClause } from "./heartbeat-finalization/lifecycle-active.js";
import { missionDedupExemptOversightReviewClause } from "./heartbeat-mission-dedup.js";
import { createHeartbeatQueuedStaleRecovery } from "./heartbeat-queued-stale-recovery.js";
import {
  countSessionFileMessages,
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
  RUN_TOOL_CONTRACT_CONTEXT_KEY,
  type SessionCompactionPolicy,
} from "@paperclipai/adapter-utils";

export {
  extractClaimedArtifactPathsFromText,
  extractExplicitArtifactPaths,
  isActionableClaimedArtifactPath,
  resolveCommentArtifactPathCandidates,
};

type IssueCreateInput = Parameters<ReturnType<typeof issueService>["create"]>[1];


const TERMINAL_MISSION_STATUSES = new Set(["completed", "cancelled"]);
export const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
// [목적] queued wakeup promote 시 "이 issue 는 이미 끝났으니 재실행 거절" 판정할 terminal 상태.
//   done/completed/cancelled(canceled)/closed 는 재시도 무의미 → request failed 로 종료.
const PROMOTED_REJECT_ISSUE_STATUSES = new Set(["done", "completed", "cancelled", "canceled", "closed", "wontfix"]);
const DETACHED_PROCESS_ERROR_CODE = "process_detached";
// orphaned-but-alive child 강제 회수 시한. handle 상실 후에도 child pid 가 살아 reaper 가 process_detached
// 로 매 tick defer 만 하던 무한 대기(CMPA-5519 ~72분 hang)를 상한으로 끊고 process_lost+retry 로 회수.
const DETACHED_REAP_AFTER_MS = 30 * 60 * 1000;
const DETACHED_GRACE_SEC = 5;
// [paperclip-stuck 2026-08-06, A2] detached 유예 창 동안 agents.status 가 `running`에 갇히는
// (phantom running) 것을 끊는다. reapOrphanedRuns 는 detached child 를 DETACHED_REAP_AFTER_MS 까지
// 유예하지만, 그 동안 finalizeAgentStatus 가 호출되지 않아 agent 가 최장 30분간 running 으로 보임.
// agent.updatedAt 기준으로 이 임계를 넘기면 agent 를 `error` 로 강등해 보드/QA 가 실상을 반영하게 한다.
// (run 자체는 longevity cap 에 따라 별도 회수 — 여기서는 agent 가시성만 교정.)
const HEARTBEAT_AGENT_DETACHED_DEMOTE_MS = 10 * 60 * 1000;
export const CODEX_REAUTH_REQUIRED_PAUSE_REASON = "reauth_required";

function workflowStepIdFromIssueDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  return description.match(/(?:^|\n)-?\s*stepId:\s*([a-z0-9_-]+)/i)?.[1] ?? null;
}

function firstDependencyIssueFromDescription(description: string | null | undefined): {
  targetStepId: string;
  targetIssueIdentifier: string;
  targetIssueTitle: string;
} | null {
  if (!description) return null;
  const match = description.match(/\n-\s*([a-z0-9_-]+):\s*([A-Z][A-Z0-9]{1,9}-\d+)\s*\([^)]*\)\s*—\s*([^\n]+)/i);
  if (!match) return null;
  return {
    targetStepId: match[1],
    targetIssueIdentifier: match[2],
    targetIssueTitle: match[3].trim(),
  };
}
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
const MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const execFile = promisify(execFileCallback);
const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "commandcode_local",
]);




/**
 * [스테이지 A + 봇 bug·high 조사 결과 기록] 이 헬퍼의 3개 호출부 함수
 * (autoRegisterWorkProductFromIssueDocument / FromClaimedFile /
 *  applyMissionOwnerUnblockArtifactUrlToSource)는 현재 트리에서 호출부가 없다 —
 * 과거 리팩터에서 유실(이 PR 이전 상태, 활동 로그 액션명은 유입됨). savepoint 복구는
 * 호출부 복원 시 그대로 유효하다. 복원 여부는 별도 제품 결정으로 보고됨.
 *
 * [스테이지 A + 봇 bug·medium 교정] heartbeat 자동 등록의 삽입. 대표 부분 유니크 인덱스
 * 도입 후 동시 첫 대표 등록은 23505 하드 실패가 된다(종전엔 조용한 이중 대표 드리프트).
 * savepoint 로 위반을 끊어낸 뒤 (동일 산출물이면 기존 행 재사용, 아니면) 비대표로
 * 재시기한다 — 자동 등록은 늘 성공해야 한다.
 * [주의] tx 는 트랜잭션 객체(input.tx)여야 한다 — 최상위 db 를 넘기면 savepoint 가
 * 아니라 독립 트랜잭션이 시작된다(호출부 계약).
 */
async function insertAutoWorkProduct(
  tx: Pick<Db, "insert" | "select"> & { transaction?: Db["transaction"] },
  values: typeof issueWorkProducts.$inferInsert,
): Promise<typeof issueWorkProducts.$inferSelect | null> {
  if (typeof tx.transaction !== "function") {
    // 테스트 더블(부분 mock) — 성공 경로만 시뮬레이션한다.
    return await tx
      .insert(issueWorkProducts)
      .values(values)
      .returning()
      .then((rows) => rows[0] ?? null);
  }
  try {
    return await tx.transaction(async (nested) =>
      nested
        .insert(issueWorkProducts)
        .values(values)
        .returning()
        .then((rows) => rows[0] ?? null));
  } catch (error) {
    // [봇 bug·high 교정] drizzle 은 원본 PG 오류를 cause 체인에 둔다 — 공용 판별 사용.
    if (!isPgUniqueViolation(error)) throw error;
    // [봇 bug·medium 교정] 동시 등록이 같은 산출물이었으면 이중 행이 된다 — 동일
    //   (provider, externalId/url, issue) 행이 이미 있으면 그것을 재사용한다.
    const externalId = typeof values.externalId === "string" ? values.externalId : null;
    const url = typeof values.url === "string" ? values.url : null;
    const provider = typeof values.provider === "string" ? values.provider : null;
    // [봇 bug·medium 교정] 재사용 술부는 실제 충돌 키(company, issue, type — 부분 유니크)
    //   와 일치해야 한다. provider/externalId/url 까지 같아야 "동일 산출물"이다.
    const existing = await tx
      .select()
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, values.companyId),
        eq(issueWorkProducts.issueId, values.issueId),
        ...(typeof values.type === "string" ? [eq(issueWorkProducts.type, values.type)] : []),
    // [봇 bug·medium 교정] null 식별자는 eq(col, null) — SQL 에서 항상 거짓 — 이 아니라
    //   isNull 으로 명시해야 "식별자 없는 산출물끼리"만 재사용된다(모든 값 일치 방지).
        ...(provider
          ? [eq(issueWorkProducts.provider, provider)]
          : [isNull(issueWorkProducts.provider)]),
        ...(externalId
          ? [eq(issueWorkProducts.externalId, externalId)]
          : [isNull(issueWorkProducts.externalId)]),
        ...(url
          ? [eq(issueWorkProducts.url, url)]
          : [isNull(issueWorkProducts.url)]),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;
    return await tx
      .insert(issueWorkProducts)
      .values({ ...values, isPrimary: false })
      .returning()
      .then((rows) => rows[0] ?? null);
  }
}

async function ensureManagedProjectWorkspace(input: {
  companyId: string;
  agentId: string;
  projectId: string;
  repoUrl: string | null;
  worktreeCheck?: (opts: { tool: string; args: Record<string, unknown>; cwd?: string; filePath?: string; command?: string }) => Promise<void>;
}): Promise<{ cwd: string; warning: string | null }> {
  const cwd = resolveManagedProjectWorkspaceDir({
    companyId: input.companyId,
    projectId: input.projectId,
    repoName: deriveRepoNameFromRepoUrl(input.repoUrl),
  });
  await fs.mkdir(path.dirname(cwd), { recursive: true });
  const stats = await fs.stat(cwd).catch(() => null);

  if (!input.repoUrl) {
    if (!stats) {
      await fs.mkdir(cwd, { recursive: true });
    }
    return { cwd, warning: null };
  }

  const gitDirExists = await fs
    .stat(path.resolve(cwd, ".git"))
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (gitDirExists) {
    return { cwd, warning: null };
  }

  if (stats) {
    const entries = await fs.readdir(cwd).catch(() => []);
    if (entries.length > 0) {
      return {
        cwd,
        warning: `Managed workspace path "${cwd}" already exists but is not a git checkout. Using it as-is.`,
      };
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }

  try {
    // worktree: check command-execute before git clone
    if (input.worktreeCheck) {
      await input.worktreeCheck({
        tool: "command-execute",
        args: { command: "git clone", repoUrl: input.repoUrl ?? "" },
        cwd,
        command: `git clone ${input.repoUrl} ${cwd}`,
      });
    }
    await execFile("git", ["clone", input.repoUrl, cwd], {
      env: sanitizeRuntimeServiceBaseEnv(process.env),
      timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS,
    });
    return { cwd, warning: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare managed checkout for "${input.repoUrl}" at "${cwd}": ${reason}`);
  }
}

const heartbeatRunListColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  status: heartbeatRuns.status,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  error: heartbeatRuns.error,
  wakeupRequestId: heartbeatRuns.wakeupRequestId,
  exitCode: heartbeatRuns.exitCode,
  signal: heartbeatRuns.signal,
  usageJson: heartbeatRuns.usageJson,
  resultJson: heartbeatRuns.resultJson,
  sessionIdBefore: heartbeatRuns.sessionIdBefore,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  logStore: heartbeatRuns.logStore,
  logRef: heartbeatRuns.logRef,
  logBytes: heartbeatRuns.logBytes,
  logSha256: heartbeatRuns.logSha256,
  logCompressed: heartbeatRuns.logCompressed,
  stdoutExcerpt: sql<string | null>`NULL`.as("stdoutExcerpt"),
  stderrExcerpt: sql<string | null>`NULL`.as("stderrExcerpt"),
  errorCode: heartbeatRuns.errorCode,
  externalRunId: heartbeatRuns.externalRunId,
  processPid: heartbeatRuns.processPid,
  processStartedAt: heartbeatRuns.processStartedAt,
  retryOfRunId: heartbeatRuns.retryOfRunId,
  processLossRetryCount: heartbeatRuns.processLossRetryCount,
  contextSnapshot: heartbeatRuns.contextSnapshot,
  createdAt: heartbeatRuns.createdAt,
  updatedAt: heartbeatRuns.updatedAt,
} as const;


const ISSUE_RUN_START_STATUSES = ["backlog", "todo", "blocked", "in_review", "in_progress"];


function hasResumableSessionForRun(
  runtime: {
    sessionId: string | null;
    sessionParams: Record<string, unknown> | null;
  },
  cwd: string,
) {
  return (
    typeof runtime.sessionId === "string" &&
    runtime.sessionId.length > 0 &&
    (() => {
      const runtimeSessionCwd = readNonEmptyString(parseObject(runtime.sessionParams).cwd) ?? "";
      return runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd);
    })()
  );
}

interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation" | "scheduler";
  triggerDetail?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}


type SessionCompactionDecision = {
  rotate: boolean;
  reason: string | null;
  handoffMarkdown: string | null;
  handoffArtifact: SessionHandoffArtifact | null;
  previousRunId: string | null;
};

interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}



export { prioritizeProjectWorkspaceCandidatesForRun };

/**
 * [instant-advance v1.2] 종말 확정된 런이 워크플로우 런에 속하면(contextSnapshot.workflowRunId)
 *   즉시 진행을 요청한다 — fire-and-forget(fireWikiRecord 와 동일 non-blocking 패턴). 훅 실패가
 *   런 완료 경로에 영향을 주지 않도록 전체를 try/catch 로 감싼다. 게이트 off 면 모듈 내부에서
 *   no-op 다(PAPERCLIP_WORKFLOW_INSTANT_ADVANCE).
 * [수정시 영향] 호출부는 런 종결 확정 지점 3곳(정상 outcome / inner catch / outer catch).
 */
function fireInstantWorkflowAdvanceForTerminalRun(run: { id: string; contextSnapshot: unknown }): void {
  try {
    const workflowRunId = readNonEmptyString(
      parseObject(run.contextSnapshot)["workflowRunId"],
    );
    if (!workflowRunId) return;
    requestInstantWorkflowAdvance(workflowRunId);
  } catch (err) {
    logger.warn(
      { err, runId: run.id, tag: "instant-advance" },
      "failed to request instant workflow advance for terminal run",
    );
  }
}





function resolveCurrentPaperclipApiUrl(): string {
  const explicit = normalizePaperclipApiUrl(process.env.PAPERCLIP_API_URL);
  if (explicit) return explicit;
  const host = resolveHostForPaperclipApiUrl(process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST);
  const port = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3200";
  return `http://${host}:${port}`;
}

function applyPaperclipApiContext(context: Record<string, unknown>): void {
  const apiUrl = resolveCurrentPaperclipApiUrl();
  context.paperclipApiUrl = apiUrl;
  context.paperclipApiBaseUrl = `${apiUrl.replace(/\/+$/, "")}/api`;
}

function isHermesOperationsLiaisonAgent(agent: Pick<typeof agents.$inferSelect, "name" | "adapterType" | "runtimeConfig" | "metadata">) {
  return isMissionExecutionLiaisonAgent(agent);
}

function isMissionOwnerControlIssue(issue: Pick<typeof issues.$inferSelect, "originKind" | "description">) {
  return isMissionOwnerTaskIssue(issue);
}

function truncateContextText(value: string | null | undefined, max = 220) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed;
}

function isMissionOwnerTaskIssue(issue: {
  originKind: string | null;
  description: string | null;
}) {
  return (
    issue.originKind === "mission_main_executor_oversight" ||
    issue.originKind === "mission_main_executor_unblock" ||
    parseMissionOwnerActionMarker(issue.description) !== null
  );
}

function canApplyRequestChangesValidationGate(issue: {
  originKind: string | null;
  title?: string | null;
}) {
  if (issue.originKind === "mission_main_executor_plan") return false;
  if (issue.originKind === "mission_main_executor_oversight") return false;
  if (issue.originKind === "mission_main_executor_unblock") return false;

  const title = issue.title?.trim() ?? "";
  return (
    /^\s*\[QA\]/iu.test(title) ||
    /\b(QA|audit|auditor|validator|validation|validate|verify|review|check)\b/iu.test(title) ||
    title.includes("검증")
  );
}

function canApplyMissingWorkProductRegistrationGate(issue: {
  originKind: string | null;
  title?: string | null;
  description?: string | null;
}, stepRunRequiresWorkProduct?: boolean) {
  if (issue.originKind === "mission_main_executor_plan") return false;
  if (issue.originKind === "mission_main_executor_oversight") return false;
  if (issue.originKind === "mission_main_executor_unblock") return false;

  // workflow step의 명시 graphWorkProductRequired 플래그(workflow_step_runs.metadata에 stamp)가
  // 권위 source. present면 title/contract 휴리스틱을 무시한다.
  if (stepRunRequiresWorkProduct === true) return true;
  if (stepRunRequiresWorkProduct === false) return false;

  // Legacy fallback: 플래그 미스탬프 step-run(pre-deploy / 미동기화)용 종래 휴리스틱.
  const title = issue.title?.trim() ?? "";
  if (/\b(lead|approval|approve|audit|auditor|validator|validation|validate|verify|QA|review|check)\b/iu.test(title)) return false;
  if (hasDeliverableOutputContract(issue.description)) return true;
  return (
    /\b(synthesi[sz]e|synthesis|generate|produce|create|draft|artifact|document|note|infographic|export|deliver|html|pdf|report)\b/iu.test(title) ||
    /(작성|생성|제작|산출물|문서|자료|보고서|리포트|HTML|PDF)/u.test(title)
  );
}

function hasDeliverableOutputContract(description: string | null | undefined) {
  const text = description?.trim() ?? "";
  return text.includes("Deliverable output (use exactly this directory)") && /`?\[?ARTIFACT\]?`?\s*:/iu.test(text);
}

/**
 * workflow_step_runs.metadata 에서 graphWorkProductRequired 플래그를 3상으로 판정.
 * - true  → 명시 산출물 step (gate 발동)
 * - false → 명시 비산출물 step (gate 스킵, 휴리스틱도 무시)
 * - undefined → 필드 미스탬프(legacy row / metadata={} / non-boolean) → 종래 휴리스틱 fallback
 * buildWorkflowStepRunMetadata 가 항상 boolean 으로 stamp 하므로 non-boolean은 undefined 취급(legacy 호환).
 */
export function resolveStepRunRequiresWorkProduct(metadata: unknown): boolean | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).graphWorkProductRequired;
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}




async function autoRegisterWorkProductFromIssueDocument(input: {
  tx: Pick<Db, "select" | "insert">;
  issue: {
    id: string;
    companyId: string;
    projectId?: string | null;
  };
  run: typeof heartbeatRuns.$inferSelect;
  claimedArtifactPaths: string[];
  allowedArtifactRoot?: string | null;
}) {
  // [Task6c-C-ii] resume-linked issue 의 workProduct 자동등록은 같은 세대 정체 검증을 공유한다.
  if (!(await assertIssueResumeScopeIdentity(input.tx as unknown as Parameters<typeof assertIssueResumeScopeIdentity>[0], { companyId: input.issue.companyId, issueId: input.issue.id }))) {
    return null;
  }
  const issueDocs = await input.tx
    .select({
      id: documents.id,
      key: issueDocuments.key,
      title: documents.title,
      latestBody: documents.latestBody,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(eq(issueDocuments.issueId, input.issue.id))
    .limit(25);

  const matchingDocument = issueDocs.find((doc) => {
    if (doc.key !== "work-product" && doc.key !== "workproduct") return false;
    const haystack = [doc.title, doc.latestBody].filter(Boolean).join("\n");
    return input.claimedArtifactPaths
      .filter((artifactPath) => !input.allowedArtifactRoot || isPathInsideOrEqual(artifactPath, input.allowedArtifactRoot))
      .some((artifactPath) => haystack.includes(artifactPath));
  });
  if (!matchingDocument) return null;

  const artifactPath = input.claimedArtifactPaths.find((candidate) => {
    if (input.allowedArtifactRoot && !isPathInsideOrEqual(candidate, input.allowedArtifactRoot)) return false;
    const haystack = [matchingDocument.title, matchingDocument.latestBody].filter(Boolean).join("\n");
    return haystack.includes(candidate);
  });
  if (!artifactPath) return null;

  const isPrimary = !(await input.tx
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(eq(issueWorkProducts.issueId, input.issue.id))
    .limit(1)
    .then((rows) => rows[0] ?? null));

  const created = await insertAutoWorkProduct(input.tx, {
      companyId: input.issue.companyId,
      projectId: input.issue.projectId ?? null,
      issueId: input.issue.id,
      type: "document",
      provider: "local",
      externalId: artifactPath,
      title: matchingDocument.title ?? path.basename(artifactPath),
      status: "active",
      reviewState: "none",
      isPrimary,
      healthStatus: "unknown",
      summary: "Auto-registered from issue document key `work-product` after a successful run reported this artifact path.",
      metadata: {
        path: artifactPath,
        autoRegisteredFrom: "issue_document_work_product",
        issueDocumentId: matchingDocument.id,
        issueDocumentKey: matchingDocument.key,
        claimedArtifactPaths: input.claimedArtifactPaths,
      },
      createdByRunId: input.run.id,
    });

  await input.tx.insert(activityLog).values({
    companyId: input.issue.companyId,
    actorType: "system",
    actorId: "heartbeat",
    action: "issue.work_product_auto_registered_from_document",
    entityType: "issue",
    entityId: input.issue.id,
    agentId: input.run.agentId,
    runId: input.run.id,
    details: {
      workProductId: created?.id ?? null,
      issueDocumentId: matchingDocument.id,
      issueDocumentKey: matchingDocument.key,
      path: artifactPath,
    },
  });

  return created ?? null;
}

async function autoRegisterWorkProductFromClaimedFile(input: {
  tx: Pick<Db, "select" | "insert">;
  issue: {
    id: string;
    companyId: string;
    projectId?: string | null;
  };
  run: typeof heartbeatRuns.$inferSelect;
  claimedArtifactPaths: string[];
  allowedArtifactRoot?: string | null;
  preferClaimedArtifactPath?: boolean;
  registrationSource?: {
    type: "issue_comment_artifact_marker" | "issue_comment_claimed_file";
    commentClaimedArtifactPaths: string[];
    sourceCommentIds: string[];
  };
  requireExistingLocalFile?: boolean;
}) {
  // [Task6c-C-ii] resume-linked issue 의 workProduct 자동등록은 같은 세대 정체 검증을 공유한다.
  if (!(await assertIssueResumeScopeIdentity(input.tx as unknown as Parameters<typeof assertIssueResumeScopeIdentity>[0], { companyId: input.issue.companyId, issueId: input.issue.id }))) {
    return null;
  }
  // [목적] producer 가 산출물 파일은 만들고 경로까지 출력(claimed)했으나 POST /work-products 등록 절차를
  //   안 지킨 케이스의 회복. 문서 기반 자동등록(autoRegisterWorkProductFromIssueDocument)이 "work-product"
  //   문서가 없어 못 잡을 때, claimed 절대경로가 실제 파일이면 그 파일을 workProduct 로 등록한다.
  // [주의] 절대경로 + fs.isFile() 확인으로만 등록(오등록/과등록 위험 최소화). CMPAA-163(existing WP 를
  //   missing 으로 오탐하는 false-positive)과는 다른 경로 — 여기는 진짜 등록 안 된 실제 파일을 보강 등록.
  // [수정시 영향] 모든 producer(workflow/수동)에 적용. 조건 완화 시 오등록 위험.
  // producer 가 명시한 claimed 경로(artifact-path regex 추출)를 권위로 그대로 등록한다. 파일 존재 검사/
  //   workspace resolve 는 의도적으로 생략 — (a) producer 가 project-relative("/tech-scout/...") 등 다양한
  //   형태로 경로를 보고해 단일 resolve base 를 정하기 어렵고, (b) downstream validator 가 같은 workspace
  //   맥락에서 같은 경로를 resolve 하므로 producer 가 쓴 형태를 보존하는 쪽이 일관된다. 파일이 진짜 없으면
  //   downstream REQUEST_CHANGES 로 자교정(현재 gate block 보다 낫다). CMPAA-163(existing WP missing 오탐)
  //   과는 다른, 진짜 미등록 claimed 산출물의 보강 등록 경로.
  // producer 가 여러 경로를 claimed 할 때 deliverable-like(report/draft/.md/.html/.pdf 등) 경로를 선호하고
  //   misc(favicon/.svg/.ico/.json 등)는 배제. 잘못된 artifact 를 등록해 downstream 가 엉뚱한 파일을 쓰는 것을
  //   막는다(이전 run: synthesize 가 favicon.svg 를 대신 등록해 build 가 report.md 를 못 찾음).
  const DELIVERABLE_NAME_RE = /(report|draft|outline|article|document|deliverable|artifact|manual|guide|summary|brief|synthesi[sz]e)/i;
  const DELIVERABLE_EXT_RE = /\.(md|html?|pdf|txt)$/i;
  const MISC_ARTIFACT_RE = /(favicon|\.svg$|\.ico$|\.json$|\.lock$|\.log$|\.map$|node_modules|package\.json|\/config\.)/i;
  const runDateStr = input.run.startedAt instanceof Date
    ? input.run.startedAt.toISOString().slice(0, 10).replace(/-/g, "")
    : "";
  const eligibleClaimedArtifactPaths = input.claimedArtifactPaths
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0 && !c.includes("{"))
    .filter((p) => !input.allowedArtifactRoot || isPathInsideOrEqual(p, input.allowedArtifactRoot));
  // explicit `[ARTIFACT]: <abs path>` 마커로 선언된 경로를 권위로 우선한다. generic scraping noise
  // (raw-tech-scout.json, /design.md 등)가 eligible 을 여러 개로 만들어도, explicit 선언 1개면
  // 그것을 등록(.json 이라도). extractExplicitArtifactPaths 가 Set dedup + backslash strip 하므로
  // `evidence.json\`(command escaping)과 `evidence.json`(final line)은 하나로 정규화된다.
  const explicitRunText = [stringifyRunResultJson(input.run.resultJson), input.run.stdoutExcerpt, input.run.stderrExcerpt]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  const explicitEligiblePaths = extractExplicitArtifactPaths(explicitRunText)
    .filter((p) => isActionableClaimedArtifactPath(p))
    .filter((p) => !input.allowedArtifactRoot || isPathInsideOrEqual(p, input.allowedArtifactRoot));
  const commentRegistrationSource = input.registrationSource ?? null;
  const commentRegistrationSourceKind = commentRegistrationSource?.type ?? null;
  const explicitCommentEligiblePaths = commentRegistrationSource?.commentClaimedArtifactPaths
    .filter((p) => isActionableClaimedArtifactPath(p))
    .filter((p) => !input.allowedArtifactRoot || isPathInsideOrEqual(p, input.allowedArtifactRoot)) ?? [];
  const declaredArtifactPath = explicitCommentEligiblePaths.length === 1
    ? explicitCommentEligiblePaths[0]
    : input.preferClaimedArtifactPath && explicitEligiblePaths.length >= 1
    ? explicitEligiblePaths[0]
    : null;
  const scored = eligibleClaimedArtifactPaths
    .map((p) => {
      let score = (DELIVERABLE_NAME_RE.test(p) ? 2 : 0) + (DELIVERABLE_EXT_RE.test(p) ? 2 : 0) - (MISC_ARTIFACT_RE.test(p) ? 3 : 0);
      // run-date awareness: current-run 날짜 경로 선호(+5), stale 날짜 패널티(-5)
      if (runDateStr && p.includes(runDateStr)) score += 5;
      else if (/\d{8}/.test(p)) score -= 5;
      return { p, score };
    })
    .sort((a, b) => b.score - a.score);
  // deliverable-like(점수>0)인 것만 등록. 전부 misc 면 등록 안 함(gate block — 잘못된 artifact 등록 방지).
  const resolvedArtifactPath = declaredArtifactPath ?? (scored.length > 0 && scored[0].score > 0 ? scored[0].p : null);
  if (!resolvedArtifactPath) return null;
  if (input.requireExistingLocalFile === true && !(await isExistingLocalFile(resolvedArtifactPath))) return null;

  const isPrimary = !(await input.tx
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(eq(issueWorkProducts.issueId, input.issue.id))
    .limit(1)
    .then((rows) => rows[0] ?? null));

  const created = await insertAutoWorkProduct(input.tx, {
      companyId: input.issue.companyId,
      projectId: input.issue.projectId ?? null,
      issueId: input.issue.id,
      type: "file",
      provider: "local",
      externalId: resolvedArtifactPath,
      title: path.basename(resolvedArtifactPath),
      status: "active",
      reviewState: "none",
      isPrimary,
      healthStatus: "unknown",
      summary: commentRegistrationSource
        ? "Auto-registered from one same-run issue comment artifact path."
        : "Auto-registered from a claimed artifact path that resolves to a real file (producer reported the path but did not register a workProduct).",
      metadata: commentRegistrationSource
        ? {
            path: resolvedArtifactPath,
            autoRegisteredFrom: commentRegistrationSourceKind,
            commentClaimedArtifactPaths: commentRegistrationSource.commentClaimedArtifactPaths,
            sourceCommentIds: commentRegistrationSource.sourceCommentIds,
          }
        : {
            path: resolvedArtifactPath,
            autoRegisteredFrom: "claimed_artifact_file",
            claimedArtifactPaths: input.claimedArtifactPaths,
          },
      createdByRunId: input.run.id,
    });

  await input.tx.insert(activityLog).values({
    companyId: input.issue.companyId,
    actorType: "system",
    actorId: "heartbeat",
    action: commentRegistrationSource
      ? "issue.work_product_auto_registered_from_comment"
      : "issue.work_product_auto_registered_from_file",
    entityType: "issue",
    entityId: input.issue.id,
    agentId: input.run.agentId,
    runId: input.run.id,
    details: commentRegistrationSource
      ? {
          workProductId: created?.id ?? null,
          path: resolvedArtifactPath,
          autoRegisteredFrom: commentRegistrationSourceKind,
          commentClaimedArtifactPaths: commentRegistrationSource.commentClaimedArtifactPaths,
          sourceCommentIds: commentRegistrationSource.sourceCommentIds,
        }
      : {
          workProductId: created?.id ?? null,
          path: resolvedArtifactPath,
          autoRegisteredFrom: "claimed_artifact_file",
          claimedArtifactPaths: input.claimedArtifactPaths,
        },
  });

  return created ?? null;
}

async function isExistingLocalFile(artifactPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(artifactPath);
    return stats.isFile();
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function extractMissionOwnerUnblockArtifactUrl(run: Pick<typeof heartbeatRuns.$inferSelect, "resultJson" | "stdoutExcerpt" | "stderrExcerpt">): string | null {
  const text = [stringifyRunResultJson(run.resultJson), run.stdoutExcerpt, run.stderrExcerpt]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  return extractExplicitArtifactUrls(text)[0] ?? null;
}

async function applyMissionOwnerUnblockArtifactUrlToSource(input: {
  tx: Pick<Db, "select" | "insert" | "update" | "transaction">;
  ownerActionIssue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "missionId" | "identifier" | "originKind" | "originId">;
  run: typeof heartbeatRuns.$inferSelect;
  artifactUrl: string;
  now: Date;
}): Promise<{ sourceIssueId: string; workProductId: string | null } | null> {
  const ownerActionIssue = input.ownerActionIssue;
  if (
    ownerActionIssue.originKind !== "mission_main_executor_unblock" ||
    !ownerActionIssue.originId ||
    !ownerActionIssue.missionId
  ) {
    return null;
  }

  const sourceIssue = await input.tx
    .select({
      id: issues.id,
      companyId: issues.companyId,
      projectId: issues.projectId,
      missionId: issues.missionId,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      hiddenAt: issues.hiddenAt,
      completedAt: issues.completedAt,
    })
    .from(issues)
    .where(and(eq(issues.id, ownerActionIssue.originId), eq(issues.companyId, ownerActionIssue.companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!sourceIssue || sourceIssue.hiddenAt || sourceIssue.missionId !== ownerActionIssue.missionId) return null;
  if (sourceIssue.status === "cancelled") return null;

  // [Task6c-C-ii] resume-linked source issue 의 owner-unblock artifact 자동등록도 같은 세대
  //   정체 검증을 공유한다 — 어긋나면 등록/완료 mutation 전에 무음 스킵한다.
  if (!(await assertIssueResumeScopeIdentity(input.tx as unknown as Parameters<typeof assertIssueResumeScopeIdentity>[0], { companyId: sourceIssue.companyId, issueId: sourceIssue.id }))) {
    return null;
  }

  const existingWorkProduct = await input.tx
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, sourceIssue.companyId),
      eq(issueWorkProducts.issueId, sourceIssue.id),
      or(
        eq(issueWorkProducts.url, input.artifactUrl),
        eq(issueWorkProducts.externalId, input.artifactUrl),
      ),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  let workProductId: string | null = existingWorkProduct?.id ?? null;
  if (!workProductId) {
    const hasExistingWorkProduct = await input.tx
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, sourceIssue.id))
      .limit(1)
      .then((rows) => Boolean(rows[0]));

    const created = await insertAutoWorkProduct(input.tx, {
        companyId: sourceIssue.companyId,
        projectId: sourceIssue.projectId ?? null,
        issueId: sourceIssue.id,
        type: "preview_url",
        provider: "mission_owner_unblock",
        externalId: input.artifactUrl,
        title: sourceIssue.title,
        url: input.artifactUrl,
        status: "active",
        reviewState: "none",
        isPrimary: !hasExistingWorkProduct,
        healthStatus: "unknown",
        summary: "Auto-registered from a successful mission-owner unblock run that emitted an [ARTIFACT] URL.",
        metadata: {
          autoRegisteredFrom: "mission_owner_unblock_artifact_url",
          ownerActionIssueId: ownerActionIssue.id,
          ownerActionIssueIdentifier: ownerActionIssue.identifier,
          ownerActionRunId: input.run.id,
        },
        createdByRunId: input.run.id,
      });
    workProductId = created?.id ?? null;

    await input.tx.insert(activityLog).values({
      companyId: sourceIssue.companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "issue.work_product_auto_registered_from_owner_unblock_url",
      entityType: "issue",
      entityId: sourceIssue.id,
      agentId: input.run.agentId,
      runId: input.run.id,
      details: {
        workProductId,
        artifactUrl: input.artifactUrl,
        ownerActionIssueId: ownerActionIssue.id,
      },
    });
  }

  if (sourceIssue.status !== "done") {
    await input.tx
      .update(issues)
      .set({
        status: "done",
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        completedAt: input.now,
        updatedAt: input.now,
      })
      .where(and(eq(issues.id, sourceIssue.id), eq(issues.companyId, sourceIssue.companyId)));
  }
  const completedStepRunIds = await completeLinkedWorkflowStepRunsForIssue({
    db: input.tx,
    issueId: sourceIssue.id,
    completedAt: sourceIssue.completedAt ?? input.now,
    source: "heartbeat_promotion",
    heartbeatRunId: input.run.id,
  });

  await input.tx.insert(issueComments).values({
    companyId: sourceIssue.companyId,
    issueId: sourceIssue.id,
    authorAgentId: input.run.agentId,
    body: [
      "### Mission owner unblock result applied",
      `Owner-action issue: ${ownerActionIssue.identifier ?? ownerActionIssue.id} (${ownerActionIssue.id})`,
      `Owner-action run: ${input.run.id}`,
      "Action: successful owner-unblock run emitted an [ARTIFACT] URL, so the source issue was reconciled to done.",
      workProductId ? `WorkProduct: ${workProductId}` : "WorkProduct: already registered",
      `[ARTIFACT]: ${input.artifactUrl}`,
    ].join("\n"),
  });

  await input.tx.insert(activityLog).values({
    companyId: sourceIssue.companyId,
    actorType: "system",
    actorId: "heartbeat",
    action: "mission.owner_unblock_source_completed_from_artifact_url",
    entityType: "issue",
    entityId: sourceIssue.id,
    agentId: input.run.agentId,
    runId: input.run.id,
    details: {
      previousStatus: sourceIssue.status,
      nextStatus: "done",
      ownerActionIssueId: ownerActionIssue.id,
      workflowStepRunIds: completedStepRunIds,
      artifactUrl: input.artifactUrl,
      workProductId,
    },
  });

  return { sourceIssueId: sourceIssue.id, workProductId };
}

function canCreateMissionOwnerUnblockForRequestChanges(issue: {
  originKind: string | null;
  title?: string | null;
}) {
  return canApplyRequestChangesValidationGate(issue);
}

export type MissionOwnerTaskContext = {
  available: true;
  gating: "originKind" | "mission-owner-action-marker";
  mission: {
    id: string;
    title: string;
    status: string;
  };
  ownerTaskIssue: {
    id: string;
    identifier: string | null;
    title: string;
    originKind: string | null;
    status: string;
  };
  sourceIssue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    assigneeAgentId: string | null;
  } | null;
  latestOwnerActionDecision: ExtractedMissionOwnerDecision | null;
  governanceEvidence: string;
  allowedDecisionOptions: string[];
  requiredDecisionFormat: string[];
};

async function resolveMissionOwnerTaskContext(input: {
  db: Db;
  companyId: string;
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    description: string | null;
    status: string;
    missionId: string | null;
    originKind: string | null;
    originId: string | null;
  } | null;
}): Promise<MissionOwnerTaskContext | null> {
  const { db, companyId, issue } = input;
  if (!issue || !isMissionOwnerTaskIssue(issue)) return null;

  const marker = parseMissionOwnerActionMarker(issue.description);
  const missionId = issue.missionId ?? marker?.missionId ?? null;
  if (!missionId) return null;

  const mission = await db
    .select({ id: missions.id, title: missions.title, status: missions.status })
    .from(missions)
    .where(and(eq(missions.id, missionId), eq(missions.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!mission) return null;

  const sourceIssueId = issue.originKind === "mission_main_executor_unblock"
    ? issue.originId
    : marker?.sourceIssueId ?? null;
  const sourceIssue = sourceIssueId
    ? await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null)
    : null;

  // Structured recovery ledger only — comment/description decision prose is display-only.
  const structuredDecision = await loadLatestMissionOwnerDecision({
    db,
    companyId,
    ownerActionIssueId: issue.id,
  });
  const latestOwnerActionDecision = structuredDecision?.decision ?? null;

  return {
    available: true,
    gating: issue.originKind === "mission_main_executor_oversight" || issue.originKind === "mission_main_executor_unblock"
      ? "originKind"
      : "mission-owner-action-marker",
    mission: {
      id: mission.id,
      title: truncateContextText(mission.title, 160) ?? "Untitled mission",
      status: mission.status,
    },
    ownerTaskIssue: {
      id: issue.id,
      identifier: issue.identifier,
      title: truncateContextText(issue.title, 160) ?? "Untitled issue",
      originKind: issue.originKind,
      status: issue.status,
    },
    sourceIssue: sourceIssue
      ? {
          id: sourceIssue.id,
          identifier: sourceIssue.identifier,
          title: truncateContextText(sourceIssue.title, 160) ?? "Untitled source issue",
          status: sourceIssue.status,
          assigneeAgentId: sourceIssue.assigneeAgentId,
        }
      : null,
    latestOwnerActionDecision,
    governanceEvidence: "Governance evidence: unavailable in this context builder",
    allowedDecisionOptions: [...MISSION_OWNER_DECISION_OPTIONS],
    requiredDecisionFormat: [
      "Submit structured Mission owner decision via the dedicated recovery API / ledger (owner_recovery_api).",
      "Comments and Markdown decision blocks are display-only and are not control-plane authority.",
      "Decision options:",
      ...MISSION_OWNER_DECISION_OPTIONS.map((option) => `- ${option}`),
    ],
  };
}

function normalizeLedgerBillingType(value: unknown): BillingType {
  const raw = readNonEmptyString(value);
  switch (raw) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

function resolveLedgerBiller(result: AdapterExecutionResult): string {
  return readNonEmptyString(result.biller) ?? readNonEmptyString(result.provider) ?? "unknown";
}

function normalizeBilledCostCents(costUsd: number | null | undefined, billingType: BillingType): number {
  if (billingType === "subscription_included") return 0;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(costUsd * 100));
}
function missionRuntimeCostCents(costUsd: number | null | undefined): number | null {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return null;
  return Math.round(costUsd * 100);
}

async function resolveLedgerScopeForRun(
  db: Db,
  companyId: string,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const context = parseObject(run.contextSnapshot);
  const contextIssueId = run.issueId ?? readNonEmptyString(context.issueId);
  const contextProjectId = readNonEmptyString(context.projectId);

  if (!contextIssueId) {
    return {
      issueId: null,
      projectId: contextProjectId,
    };
  }

  const issue = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(and(eq(issues.id, contextIssueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  return {
    issueId: issue?.id ?? null,
    projectId: issue?.projectId ?? contextProjectId,
  };
}


export function parseSessionCompactionPolicy(agent: typeof agents.$inferSelect): SessionCompactionPolicy {
  return resolveSessionCompactionPolicy(agent.adapterType, agent.runtimeConfig).policy;
}



function parseIssueAssigneeAdapterOverrides(
  raw: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.adapterConfig);
  const adapterConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean"
      ? parsed.useProjectWorkspace
      : null;
  if (!adapterConfig && useProjectWorkspace === null) return null;
  return {
    adapterConfig,
    useProjectWorkspace,
  };
}



export function formatRuntimeWorkspaceWarningLog(warning: string) {
  return {
    stream: "stdout" as const,
    chunk: `[paperclip] ${warning}\n`,
  };
}



export function buildCodexAuthAutoBlockedComment(input: CodexAuthAutoBlockInfo & { runId: string }): string {
  const detected = input.authErrorCode
    ? `codex_local 실행 중 401 Unauthorized (auth error code: \`${input.authErrorCode}\`)`
    : "codex_local 실행 중 401 Unauthorized";
  return [
    "## 자동 차단: codex_local 인증 오류",
    `- 원인코드: \`${input.reasonCode}\``,
    `- 감지: ${detected}`,
    `- 실행 runId: \`${input.runId}\``,
    "- 조치 1: `codex login`으로 Codex CLI를 재인증",
    "- 조치 2: Hermes `openai-codex`도 같은 계정 세션을 쓰면 `hermes auth`로 별도 재인증 상태 확인",
    "- 조치 3: OPENAI API 키 사용 모드면 `OPENAI_API_KEY` 유효성 재확인",
    "- 재개: 인증 복구 후 에이전트 일시정지를 해제하고 heartbeat 재실행",
  ].join("\n");
}

function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return "forceFreshSession was requested";
  if (hasWorkflowQaReworkContract(contextSnapshot)) return "workflow QA rework requires a fresh session";

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";
  if (wakeReason === "mission_unblock_action_created") return "wake reason is mission_unblock_action_created";
  if (wakeReason === "mission_unblock_action_stalled") return "wake reason is mission_unblock_action_stalled";
  return null;
}

function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  payload: Record<string, unknown> | null;
}) {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const issueIdFromPayload = readNonEmptyString(payload?.["issueId"]);
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const missionIdFromPayload = readNonEmptyString(payload?.["missionId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentId = deriveCommentId(contextSnapshot, payload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueIdFromPayload) {
    contextSnapshot.issueId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["missionId"]) && missionIdFromPayload) {
    contextSnapshot.missionId = missionIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskId"]) && issueIdFromPayload) {
    contextSnapshot.taskId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["commentId"]) && commentIdFromPayload) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["wakeCommentId"]) && wakeCommentId) {
    contextSnapshot.wakeCommentId = wakeCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (!readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) && triggerDetail) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }

  return {
    contextSnapshot,
    issueIdFromPayload,
    commentIdFromPayload,
    taskKey,
    wakeCommentId,
  };
}

function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
) {
  const existing = parseObject(existingRaw);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const commentId = deriveCommentId(incoming, null);
  if (commentId) {
    merged.commentId = commentId;
    merged.wakeCommentId = commentId;
  }
  return merged;
}


function isTrackedLocalChildProcessAdapter(adapterType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}




function isTerminalAdapterFallbackConfigurationFailure(run: typeof heartbeatRuns.$inferSelect) {
  const text = [
    heartbeatRunFailureText({
      errorCode: run.errorCode,
      errorMessage: run.error,
      stdoutExcerpt: run.stdoutExcerpt,
      stderrExcerpt: run.stderrExcerpt,
    }),
    stringifyRunResultJson(run.resultJson),
    stringifyRunResultJson(run.usageJson),
  ].join("\n").toLowerCase();

  return (
    /api error:\s*400\b[\s\S]*param incorrect/.test(text) ||
    /\bparam incorrect\b/.test(text) ||
    /\bnot supported model\b/.test(text) ||
    /\bunsupported model\b/.test(text) ||
    /\binvalid model\b/.test(text) ||
    /\bunknown model\b/.test(text) ||
    /\bmodel\b[\s\S]{0,80}\bnot (?:found|supported)\b/.test(text)
  );
}

function shouldQueueRunFailureAdapterFallback(input: {
  run: typeof heartbeatRuns.$inferSelect;
  fallback: Pick<AdapterFallbackConfig, "command" | "provider" | "model" | "maxAttempts">;
}) {
  const context = parseObject(input.run.contextSnapshot);
  const fallbackAttempt = resolveAdapterFallbackAttempt(context);
  if (fallbackAttempt >= input.fallback.maxAttempts) return false;

  const activeFallbackCommand = readNonEmptyString(context.fallbackCommand);
  const activeFallbackProvider = readNonEmptyString(context.fallbackProvider);
  const activeFallbackModel = readNonEmptyString(context.fallbackModel);
  const fallbackProvider = input.fallback.provider ?? null;
  const fallbackModel = input.fallback.model ?? null;
  const isSameFallbackCommand = activeFallbackCommand === input.fallback.command;
  const isSameFallbackRoute =
    isSameFallbackCommand &&
    activeFallbackProvider === fallbackProvider &&
    activeFallbackModel === fallbackModel;
  const isFallbackRun = readNonEmptyString(context.wakeReason) === "adapter_fallback";
  if (isFallbackRun && isSameFallbackRoute && isTerminalAdapterFallbackConfigurationFailure(input.run)) {
    return false;
  }

  return true;
}


function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

function getAdapterSessionCodec(adapterType: string) {
  const adapter = getServerAdapter(adapterType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

function buildMissionSessionSecretName(input: {
  missionId: string;
  agentId: string;
  adapterType: string;
}) {
  return `mission-session:${input.missionId}:${input.agentId}:${input.adapterType}`;
}

function isRecoverableMissionSessionSecretReadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof HttpError) {
    return error.status === 400 && message.includes("Invalid local_encrypted secret material");
  }
  return (
    message.includes("Unsupported state or unable to authenticate data") ||
    message.includes("Invalid initialization vector") ||
    message.includes("Invalid authentication tag length")
  );
}

function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

export type MissionSessionAuthorityDecision = {
  missionKnown: boolean;
  defaultAuthority: "mission_session" | "task_session" | "runtime_state" | "none";
  compatibilitySeedSessionId: string | null;
  preferredSessionId: string | null;
};

export function resolveMissionSessionAuthorityDecision(input: {
  missionId?: string | null;
  missionSessionId?: string | null;
  taskSessionDisplayId?: string | null;
  taskSessionLegacySessionId?: string | null;
  runtimeSessionId?: string | null;
  resetTaskSession?: boolean;
}): MissionSessionAuthorityDecision {
  const missionId = readNonEmptyString(input.missionId);
  const resetTaskSession = input.resetTaskSession === true;
  const taskSessionDisplayId = truncateDisplayId(readNonEmptyString(input.taskSessionDisplayId));
  const taskSessionLegacySessionId = readNonEmptyString(input.taskSessionLegacySessionId);
  const runtimeSessionId = readNonEmptyString(input.runtimeSessionId);

  if (missionId) {
    return {
      missionKnown: true,
      defaultAuthority: "mission_session",
      compatibilitySeedSessionId:
        resetTaskSession ? null : (taskSessionDisplayId ?? taskSessionLegacySessionId ?? null),
      preferredSessionId: readNonEmptyString(input.missionSessionId),
    };
  }

  if (resetTaskSession) {
    return {
      missionKnown: false,
      defaultAuthority: "none",
      compatibilitySeedSessionId: null,
      preferredSessionId: null,
    };
  }

  const taskSessionId = taskSessionDisplayId ?? taskSessionLegacySessionId ?? null;
  if (taskSessionId) {
    return {
      missionKnown: false,
      defaultAuthority: "task_session",
      compatibilitySeedSessionId: null,
      preferredSessionId: taskSessionId,
    };
  }

  if (runtimeSessionId) {
    return {
      missionKnown: false,
      defaultAuthority: "runtime_state",
      compatibilitySeedSessionId: null,
      preferredSessionId: runtimeSessionId,
    };
  }

  return {
    missionKnown: false,
    defaultAuthority: "none",
    compatibilitySeedSessionId: null,
    preferredSessionId: null,
  };
}

function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams =
    hasExplicitParams
      ? explicitParams
      : hasExplicitSessionId
        ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
        : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

export function isSucceededHeartbeatRunStatus(status: string | null | undefined): status is "succeeded" {
  return status === "succeeded";
}
function containsToolLimitLifecycleFailure(run: typeof heartbeatRuns.$inferSelect) {
  const text = [run.stdoutExcerpt, run.stderrExcerpt, run.error].filter(Boolean).join("\n");
  return /reached maximum iterations|tool[-\s]?call limit|tool capacity|could not post|couldn't post|not able to post|before i could post|could not .*mark|couldn't .*mark/iu.test(text);
}




function stringifyRunResultJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractRequestChangesVerdict(run: typeof heartbeatRuns.$inferSelect): RequestChangesVerdict | null {
  const result = parseObject(run.resultJson);
  const candidates = [
    readNonEmptyString(result.verdict),
    readNonEmptyString(result.decision),
    readNonEmptyString(result.outcome),
    readNonEmptyString(result.status),
    readNonEmptyString(result.result),
    ...extractCodexTaskCompleteMessages(readNonEmptyString(result.stdout)),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  let requestChangesCandidate: string | null = null;
  for (const candidate of candidates) {
    const verdict = readExplicitValidationVerdict(candidate, { allowLeadingVerdict: true });
    if (verdict === "pass") return null;
    if (verdict === "request_changes") {
      requestChangesCandidate = candidate;
      break;
    }
  }

  if (!requestChangesCandidate) return null;

  return {
    excerpt:
      requestChangesCandidate.length > MISSION_CHILD_RUN_OUTPUT_COMMENT_MAX_CHARS
        ? requestChangesCandidate.slice(requestChangesCandidate.length - MISSION_CHILD_RUN_OUTPUT_COMMENT_MAX_CHARS)
        : requestChangesCandidate,
  };
}


export function extractClaimedArtifactPaths(run: Pick<typeof heartbeatRuns.$inferSelect, "resultJson" | "stdoutExcerpt" | "stderrExcerpt">): string[] {
  const text = [stringifyRunResultJson(run.resultJson), run.stdoutExcerpt, run.stderrExcerpt]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  return extractClaimedArtifactPathsFromText(text);
}



/**
 * [목적] fireWikiRecord — agent 자가학습 wiki에 실패 패턴을 기록한다. fire-and-forget(non-blocking):
 *   recordFailure를 await하지 않고 .catch로 에러를 삼켜, wiki 로깅이 절대 main flow를
 *   깨뜨리지 않도록 한다(activity-log.ts의 plugin event fanout .catch 선례와 동일 패턴).
 * [입력] wiki: agentWikiService(db) 인스턴스. input: RecordFailureInput. runIdForLog: 로깅용 run id.
 * [수정시 영향] 호출부는 모두 heartbeatService 클로저 내부. 에러는 logger.warn으로만 남는다.
 */
function fireWikiRecord(
  wiki: ReturnType<typeof agentWikiService>,
  input: RecordFailureInput,
  runIdForLog?: string,
): void {
  void wiki
    .recordFailure(input)
    .catch((err: unknown) =>
      logger.warn(
        { err, runId: runIdForLog, pattern: input.pattern },
        "agent-wiki.recordFailure non-blocking failure",
      ),
    );
}

export function heartbeatService(db: Db, options: HeartbeatServiceOptions = {}) {
  const c5OwnerRuntime = bindHeartbeatC5OwnerRuntime(db, options.qaCorrectionExecution?.ownerRuntime);
  // [instant-advance v1.2] fire-and-forget 진행 모듈에 db 주입(미주입 요청은 no-op).
  configureInstantWorkflowAdvanceDb(db);
  const instanceSettings = instanceSettingsService(db);
  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  const runLogStore = getRunLogStore();
  const secretsSvc = secretService(db);
  const companySkills = companySkillService(db);
  const issuesSvc = issueService(db);
  const wikiSvc = agentWikiService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const enqueuePlanQaWakeup = createPlanQaWakeupHandler(
    { wakeup: (agentId, opts) => enqueueWakeup(agentId, opts) },
    { requestedByActorId: "heartbeat-plan-qa", contextSource: "heartbeat_plan_qa" },
  );
  const enqueuePlanningIssueWakeup = createPlanningIssueWakeupHandler(
    { wakeup: (agentId, opts) => enqueueWakeup(agentId, opts) },
    { requestedByActorId: "heartbeat-plan-rework", contextSource: "heartbeat_plan_rework" },
  );
  const activeRunExecutions = new Set<string>();
  const terminalContinuationInflight = new Set<string>();
  let terminalContinuationScanCursor: { createdAt: string; id: string } | null = null;
  const budgetHooks = {
    cancelWorkForScope: cancelBudgetScopeWork,
  };
  const budgets = budgetService(db, budgetHooks);
  const worktreeHarness = createWorktreeHarness(db);

  /**
   * worktreeCheck — call worktreeHarness.checkAction, re-throwing MUST violations.
   * SHOULD violations are logged by the harness internally; MAY violations are audit-logged.
   */
  async function worktreeCheck(opts: {
    agent: { id: string; companyId: string };
    tool: string;
    args: Record<string, unknown>;
    cwd?: string;
    filePath?: string;
    command?: string;
  }): Promise<void> {
    try {
      await worktreeHarness.checkAction({
        companyId: opts.agent.companyId,
        agentId: opts.agent.id,
        tool: opts.tool,
        args: opts.args,
        cwd: opts.cwd,
        filePath: opts.filePath,
        command: opts.command,
      });
    } catch (err) {
      // WorktreeViolation bubbles up as MUST violation → fail the operation
      if (err instanceof WorktreeViolation) {
        throw err;
      }
      // Unexpected error — re-throw
      throw err;
    }
  }

  function isMissionOwnerActionParentPlacementRejected(error: unknown) {
    return error instanceof HttpError &&
      error.status === 422 &&
      (
        error.message.includes("Mission downstream issue creation is not allowed") ||
        error.message.includes("Mission nested child issue creation is not allowed") ||
        error.message.includes("Mission child issue burst limit exceeded")
      );
  }

  async function createMissionOwnerActionIssue(companyId: string, data: IssueCreateInput) {
    if (!data.parentId) return issuesSvc.create(companyId, data);
    try {
      return await issuesSvc.create(companyId, data);
    } catch (error) {
      if (!isMissionOwnerActionParentPlacementRejected(error)) throw error;
      const { parentId: _parentId, ...flatData } = data;
      logger.warn({
        err: error,
        companyId,
        missionId: data.missionId,
        originKind: data.originKind,
        originId: data.originId,
        rejectedParentId: data.parentId,
      }, "mission owner action parent placement rejected; creating flat owner action with origin link");
      return issuesSvc.create(companyId, flatData);
    }
  }

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function positivelyClassifiesNonworkflowV1(
    supplied: typeof heartbeatRuns.$inferSelect,
    current: typeof heartbeatRuns.$inferSelect | null,
    frame?: ActiveHeartbeatExecutionFrame,
  ) {
    if (!current || !sameHeartbeatExecutionAttempt(supplied, current)
      || supplied.invocationSource !== current.invocationSource
      || supplied.wakeupRequestId !== current.wakeupRequestId) return false;
    if (frame && !frame.conflicted && !frame.ownerReleaseBlocked && !frame.actualDrainIdentity
      && frame.finalizationVersion === 1 && sameHeartbeatExecutionAttempt(frame.run, current)
      && (!frame.adapterInvocationAttempted || frame.actualCaptured)
      && await isProvenNonC5WorkflowExecution(db, current)) return true;
    const scope = supplied.executionScopeKind;
    if (!NONWORKFLOW_EXECUTION_SCOPES.has(scope ?? "")
      || supplied.finalizationVersion !== 1 || current.finalizationVersion !== 1
      || supplied.workflowStepRunId !== null || supplied.workflowExecutionGeneration !== null
      || current.workflowStepRunId !== null || current.workflowExecutionGeneration !== null) return false;
    const attempts = frame ? [supplied, current, frame.run] : [supplied, current];
    if (attempts.some(attempt => attempt.executionScopeKind !== scope || attempt.finalizationVersion !== 1
      || attempt.workflowStepRunId !== null || attempt.workflowExecutionGeneration !== null
      || attempt.invocationSource !== supplied.invocationSource || attempt.wakeupRequestId !== supplied.wakeupRequestId)) return false;
    if (frame && (frame.conflicted || frame.ownerReleaseBlocked || frame.finalizationVersion !== 1
      || !sameHeartbeatExecutionAttempt(frame.run, current) || frame.actualDrainIdentity
      || (frame.adapterInvocationAttempted && !frame.actualCaptured))) return false;

    let wake: typeof agentWakeupRequests.$inferSelect | null = null;
    if (supplied.wakeupRequestId) {
      [wake] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.id, supplied.wakeupRequestId),
        eq(agentWakeupRequests.companyId, supplied.companyId),
      )).limit(1);
      if (!wake || wake.id !== supplied.wakeupRequestId || wake.companyId !== supplied.companyId
        || wake.agentId !== supplied.agentId || wake.issueId !== supplied.issueId || wake.runId !== supplied.id
        || wake.status === "coalesced" || wake.workflowRunId !== null || wake.workflowStepRunId !== null
        || wake.workflowExecutionGeneration !== null) return false;
    }
    return producedExecutionScopeKind(supplied, wake) === scope;
  }

  async function ensureMissionOwnerActionForRequestChanges(input: {
    sourceIssue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "missionId" | "identifier" | "title" | "originKind" | "status" | "assigneeAgentId" | "parentId">;
    run: typeof heartbeatRuns.$inferSelect;
    verdict: RequestChangesVerdict;
  }) {
    if (!input.sourceIssue.missionId) return null;
    if (!canCreateMissionOwnerUnblockForRequestChanges(input.sourceIssue)) return null;
    const mission = await db
      .select()
      .from(missions)
      .where(and(eq(missions.id, input.sourceIssue.missionId), eq(missions.companyId, input.sourceIssue.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!mission?.ownerAgentId) return null;
    let missionExecutionDigest: string[] = [];
    try {
      missionExecutionDigest = await buildMissionExecutionDigest(db, {
        mission,
        blockedIssue: input.sourceIssue,
      });
    } catch (err) {
      logger.warn(
        { err, missionId: input.sourceIssue.missionId, issueId: input.sourceIssue.id },
        "failed to build mission execution digest for REQUEST_CHANGES owner action",
      );
      missionExecutionDigest = ["Mission execution digest could not be built; inspect workflow runs, step runs, work products, and source issue comments manually."];
    }

    const existing = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, input.sourceIssue.companyId),
        eq(issues.missionId, input.sourceIssue.missionId),
        eq(issues.originKind, "mission_main_executor_unblock"),
        eq(issues.originId, input.sourceIssue.id),
        sql`${issues.hiddenAt} is null`,
        not(inArray(issues.status, ["done", "cancelled"])),
      ))
      .orderBy(asc(issues.createdAt), asc(issues.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const sourceLabel = input.sourceIssue.identifier ?? input.sourceIssue.id;
    const nextDescription = buildRequestChangesOwnerActionDescription({
      ...input,
      mission,
      missionExecutionDigest,
    });
    if (existing && !(existing.description ?? "").includes("Mission execution digest:")) {
      await db
        .update(issues)
        .set({ description: nextDescription, updatedAt: new Date() })
        .where(eq(issues.id, existing.id));
      existing.description = nextDescription;
    }
    const ownerActionParentId = input.sourceIssue.parentId ? undefined : input.sourceIssue.id;
    const ownerAction = existing ?? await createMissionOwnerActionIssue(input.sourceIssue.companyId, {
      assigneeAgentId: mission.ownerAgentId,
      description: nextDescription,
      missionId: input.sourceIssue.missionId,
      originKind: "mission_main_executor_unblock",
      originId: input.sourceIssue.id,
      parentId: ownerActionParentId,
      priority: "high",
      status: "todo",
      title: `[Unblock] ${sourceLabel}: ${input.sourceIssue.title}`,
    });

    try {
      await enqueueWakeup(mission.ownerAgentId, {
        source: "automation",
        triggerDetail: "mission_validation_request_changes",
        reason: "mission_validation_request_changes",
        idempotencyKey: `mission-validation-request-changes:${input.run.id}:${ownerAction.id}`,
        requestedByActorType: "system",
        requestedByActorId: "heartbeat",
        payload: {
          issueId: ownerAction.id,
          sourceIssueId: input.sourceIssue.id,
          sourceRunId: input.run.id,
          verdict: "REQUEST_CHANGES",
        },
        contextSnapshot: {
          taskKey: `issue:${ownerAction.id}`,
          issueId: ownerAction.id,
          missionId: input.sourceIssue.missionId,
          sourceIssueId: input.sourceIssue.id,
          sourceRunId: input.run.id,
          wakeReason: "mission_validation_request_changes",
        },
      });
    } catch (err) {
      logger.warn(
        { err, missionId: input.sourceIssue.missionId, issueId: ownerAction.id, sourceIssueId: input.sourceIssue.id },
        "failed to wake mission owner after REQUEST_CHANGES validation gate",
      );
    }

    return ownerAction;
  }

  async function deferOperationsMissionIssueToMainExecutor(input: {
    agent: typeof agents.$inferSelect;
    issueId: string;
    missionId: string;
  }) {
    if (!isHermesOperationsLiaisonAgent(input.agent)) return null;

    const issue = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.id, input.issueId),
        eq(issues.companyId, input.agent.companyId),
        eq(issues.missionId, input.missionId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!issue) return null;

    const mission = await db
      .select()
      .from(missions)
      .where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.agent.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!mission?.ownerAgentId) return null;

    const now = new Date();
    const sourceLabel = issue.identifier ?? issue.id;
    const roleEvidence = [
      `Hermes Ops boundary: ${input.agent.name} is chief_of_staff_liaison; it may monitor and report, but must not directly execute mission issue ${sourceLabel}.`,
      "Required routing: signal the mission main executor. The main executor decides recovery, re-dispatch, replan, escalation, or no action.",
    ];

    let ownerAction = issue;
    if (isMissionOwnerControlIssue(issue)) {
      if (issue.assigneeAgentId !== mission.ownerAgentId) {
        ownerAction = await db
          .update(issues)
          .set({
            assigneeAgentId: mission.ownerAgentId,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id))
          .returning()
          .then((rows) => rows[0] ?? issue);
      }
    } else {
      ownerAction = await missionService(db).ensureMainExecutorUnblockIssue(mission, issue, {
        renewAfterNoActionWaiting: true,
        governanceEvidence: roleEvidence,
      });
    }

    await db.insert(activityLog).values({
      companyId: input.agent.companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "mission.ops_issue_deferred_to_main_executor",
      entityType: "issue",
      entityId: issue.id,
      agentId: input.agent.id,
      details: {
        missionId: mission.id,
        sourceIssueId: issue.id,
        sourceIssueIdentifier: sourceLabel,
        ownerAgentId: mission.ownerAgentId,
        ownerActionIssueId: ownerAction.id,
        operationsAgentRole: "chief_of_staff_liaison",
      },
    });

    return { mission, issue, ownerAction };
  }

  async function getRuntimeState(agentId: string) {
    return db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getTaskSession(
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) {
    return db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          eq(agentTaskSessions.agentId, agentId),
          eq(agentTaskSessions.adapterType, adapterType),
          eq(agentTaskSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function ensureMissionSessionBinding(input: {
    agent: typeof agents.$inferSelect;
    missionId: string;
    adapterType: string;
    seedSessionId?: string | null;
  }) {
    const seedSessionId = readNonEmptyString(input.seedSessionId);
    const secretName = buildMissionSessionSecretName({
      missionId: input.missionId,
      agentId: input.agent.id,
      adapterType: input.adapterType,
    });
    let secret = await secretsSvc.getByName(input.agent.companyId, secretName);

    if (!secret) {
      secret = await secretsSvc.create(
        input.agent.companyId,
        {
          name: secretName,
          provider: "local_encrypted",
          value: seedSessionId ?? "",
          description: `Mission session binding for mission ${input.missionId}`,
        },
        { agentId: input.agent.id },
      );
    }

    const store = missionSessionStore(db);
    const { session } = await store.getOrCreate({
      missionId: input.missionId,
      agentId: input.agent.id,
      companyId: input.agent.companyId,
      sessionSecretId: secret.id,
      adapterType: input.adapterType,
    });

    let sessionId: string | null;
    try {
      sessionId = readNonEmptyString(
        await secretsSvc.resolveSecretValue(input.agent.companyId, session.sessionSecretId, "latest"),
      );
    } catch (err) {
      if (!isRecoverableMissionSessionSecretReadError(err)) throw err;
      const resetValue = seedSessionId ?? "";
      logger.warn(
        { err, missionId: input.missionId, agentId: input.agent.id, sessionSecretId: session.sessionSecretId },
        "mission session secret could not be read; resetting session binding",
      );
      await secretsSvc.rotate(
        session.sessionSecretId,
        { value: resetValue },
        { agentId: input.agent.id },
      );
      sessionId = readNonEmptyString(resetValue);
    }

    if (!sessionId && seedSessionId) {
      await secretsSvc.rotate(
        session.sessionSecretId,
        { value: seedSessionId },
        { agentId: input.agent.id },
      );
      sessionId = seedSessionId;
    }

    return { session, sessionId };
  }

  async function resolveMissionSessionAuthority(input: {
    agent: typeof agents.$inferSelect;
    missionId: string | null;
    adapterType: string;
    taskSessionDisplayId?: string | null;
    taskSessionLegacySessionId?: string | null;
    runtimeSessionId?: string | null;
    resetTaskSession?: boolean;
  }): Promise<{
    decision: MissionSessionAuthorityDecision;
    missionSessionBinding: Awaited<ReturnType<typeof ensureMissionSessionBinding>> | null;
  }> {
    const baseDecision = resolveMissionSessionAuthorityDecision({
      missionId: input.missionId,
      taskSessionDisplayId: input.taskSessionDisplayId,
      taskSessionLegacySessionId: input.taskSessionLegacySessionId,
      runtimeSessionId: input.runtimeSessionId,
      resetTaskSession: input.resetTaskSession,
    });

    if (!baseDecision.missionKnown || !input.missionId) {
      return {
        decision: baseDecision,
        missionSessionBinding: null,
      };
    }

    const missionSessionBinding = await ensureMissionSessionBinding({
      agent: input.agent,
      missionId: input.missionId,
      adapterType: input.adapterType,
      seedSessionId: baseDecision.compatibilitySeedSessionId,
    });

    return {
      decision: {
        ...baseDecision,
        preferredSessionId: missionSessionBinding.sessionId,
      },
      missionSessionBinding,
    };
  }

  async function persistMissionSessionBinding(input: {
    agent: typeof agents.$inferSelect;
    sessionSecretId: string;
    sessionId: string | null;
  }) {
    const nextValue = input.sessionId ?? "";
    let currentValue: string | null;
    try {
      currentValue = await secretsSvc.resolveSecretValue(
        input.agent.companyId,
        input.sessionSecretId,
        "latest",
      );
    } catch (err) {
      if (!isRecoverableMissionSessionSecretReadError(err)) throw err;
      logger.warn(
        { err, agentId: input.agent.id, sessionSecretId: input.sessionSecretId },
        "mission session secret could not be read before persist; rotating replacement value",
      );
      currentValue = null;
    }
    if (currentValue === nextValue) return;
    await secretsSvc.rotate(
      input.sessionSecretId,
      { value: nextValue },
      { agentId: input.agent.id },
    );
  }

  async function getLatestRunForSession(
    agentId: string,
    sessionId: string,
    opts?: { excludeRunId?: string | null },
  ) {
    const conditions = [
      eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.sessionIdAfter, sessionId),
    ];
    if (opts?.excludeRunId) {
      conditions.push(sql`${heartbeatRuns.id} <> ${opts.excludeRunId}`);
    }
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  type IssueScopedRawSessionResumeDecision =
    | { readonly rotate: false }
    | {
        readonly rotate: true;
        readonly previousSessionId: string;
        readonly reason: string;
      };

  async function evaluateIssueScopedRawSessionResume(input: {
    readonly agentId: string;
    readonly currentIssueId: string | null;
    readonly currentMissionId: string | null;
    readonly currentRunId: string;
    readonly sessionId: string | null;
  }): Promise<IssueScopedRawSessionResumeDecision> {
    const currentIssueId = readNonEmptyString(input.currentIssueId);
    const currentMissionId = readNonEmptyString(input.currentMissionId);
    const sessionId = readNonEmptyString(input.sessionId);
    if (!sessionId) return { rotate: false };
    if (!currentIssueId && !currentMissionId) return { rotate: false };

    const previousRun = await getLatestRunForSession(input.agentId, sessionId, {
      excludeRunId: input.currentRunId,
    });
    const previousContext = parseObject(previousRun?.contextSnapshot);
    // [session hygiene] 미션 간 세션 재개 금지 — 같은 세션을 다른 미션 컨텍스트에서
    //   재개하면 이전 미션의 대화 히스토리가 새 미션에 흘러든다. 미션이 다르면 회전.
    const previousMissionId = readNonEmptyString(previousContext.missionId);
    if (currentMissionId && previousMissionId && previousMissionId !== currentMissionId) {
      return {
        rotate: true,
        previousSessionId: sessionId,
        reason: `mission changed from ${previousMissionId} to ${currentMissionId}`,
      };
    }
    const previousIssueId =
      readNonEmptyString(previousRun?.issueId) ?? readNonEmptyString(previousContext.issueId);
    if (!currentIssueId || !previousIssueId || previousIssueId === currentIssueId) return { rotate: false };

    return {
      rotate: true,
      previousSessionId: sessionId,
      reason: `workflow step issue changed from ${previousIssueId} to ${currentIssueId}`,
    };
  }

  async function getOldestRunForSession(agentId: string, sessionId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestRawUsageForSession(
    companyId: string,
    agentId: string,
    sessionId: string,
    opts?: { excludeRunId?: string | null },
  ) {
    const conditions = [
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.sessionIdAfter, sessionId),
      sql`${heartbeatRuns.usageJson} is not null`,
    ];
    if (opts?.excludeRunId) {
      conditions.push(sql`${heartbeatRuns.id} <> ${opts.excludeRunId}`);
    }
    const pageSize = 50;
    for (let offset = 0; ; offset += pageSize) {
      const rows = await db
        .select({ usageJson: heartbeatRuns.usageJson })
        .from(heartbeatRuns)
        .where(and(...conditions))
        .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
        .limit(pageSize)
        .offset(offset);
      for (const row of rows) {
        const usage = readRawUsageTotals(row.usageJson);
        if (usage) return usage;
      }
      if (rows.length < pageSize) return null;
    }
  }

  async function resolveNormalizedUsageForSession(input: {
    companyId: string;
    agentId: string;
    runId: string;
    sessionId: string | null;
    rawUsage: UsageTotals | null;
  }) {
    const { companyId, agentId, runId, sessionId, rawUsage } = input;
    if (!sessionId || !rawUsage) {
      return {
        normalizedUsage: rawUsage,
        previousRawUsage: null as UsageTotals | null,
        derivedFromSessionTotals: false,
      };
    }

    const previousRawUsage = await getLatestRawUsageForSession(companyId, agentId, sessionId, {
      excludeRunId: runId,
    });
    return {
      normalizedUsage: deriveNormalizedUsageDelta(rawUsage, previousRawUsage),
      previousRawUsage,
      derivedFromSessionTotals: previousRawUsage !== null,
    };
  }

  async function evaluateSessionCompaction(input: {
    agent: typeof agents.$inferSelect;
    sessionId: string | null;
    issueId: string | null;
    missionId?: string | null;
  }): Promise<SessionCompactionDecision> {
    const { agent, sessionId, issueId } = input;
    if (!sessionId) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        handoffArtifact: null,
        previousRunId: null,
      };
    }

    const policy = parseSessionCompactionPolicy(agent);
    if (!policy.enabled || !hasSessionCompactionThresholds(policy)) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        handoffArtifact: null,
        previousRunId: null,
      };
    }

    const fetchLimit = Math.max(policy.maxSessionRuns > 0 ? policy.maxSessionRuns + 1 : 0, 4);
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
        usageJson: heartbeatRuns.usageJson,
        resultJson: heartbeatRuns.resultJson,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(fetchLimit);

    if (runs.length === 0) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        handoffArtifact: null,
        previousRunId: null,
      };
    }

    const latestRun = runs[0] ?? null;
    const oldestRun =
      policy.maxSessionAgeHours > 0
        ? await getOldestRunForSession(agent.id, sessionId)
        : runs[runs.length - 1] ?? latestRun;
    const latestRawUsage = policy.maxRawInputTokens > 0
      ? runs
        .map((run) => readRawUsageTotals(run.usageJson))
        .find((usage): usage is UsageTotals => usage !== null)
        ?? await getLatestRawUsageForSession(agent.companyId, agent.id, sessionId)
      : null;
    const sessionAgeHours =
      latestRun && oldestRun
        ? Math.max(
            0,
            (new Date(latestRun.createdAt).getTime() - new Date(oldestRun.createdAt).getTime()) / (1000 * 60 * 60),
          )
        : 0;

    let reason: string | null = null;
    if (policy.maxSessionMessages > 0) {
      // [session hygiene] 재개 히스토리 상한 — usageJson이 비어 토큰 트리거가 동작하지
      //   않아도 세션 파일의 메시지 수로 무한 증식(hermes-era 136+ 메시지 사례)을 막는다.
      const sessionMessageCount = await countSessionFileMessages(sessionId, {
        stopAfter: policy.maxSessionMessages,
      });
      if (sessionMessageCount !== null && sessionMessageCount > policy.maxSessionMessages) {
        reason = `session exceeded ${policy.maxSessionMessages} messages`;
      }
    }
    if (!reason && policy.maxSessionRuns > 0 && runs.length > policy.maxSessionRuns) {
      reason = `session exceeded ${policy.maxSessionRuns} runs`;
    } else if (
      policy.maxRawInputTokens > 0 &&
      latestRawUsage &&
      latestRawUsage.inputTokens >= policy.maxRawInputTokens
    ) {
      reason =
        `session raw input reached ${formatCount(latestRawUsage.inputTokens)} tokens ` +
        `(threshold ${formatCount(policy.maxRawInputTokens)})`;
    } else if (policy.maxSessionAgeHours > 0 && sessionAgeHours >= policy.maxSessionAgeHours) {
      reason = `session age reached ${Math.floor(sessionAgeHours)} hours`;
    }

    if (!reason || !latestRun) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        handoffArtifact: null,
        previousRunId: latestRun?.id ?? null,
      };
    }

    const latestSummary = summarizeHeartbeatRunResultJson(latestRun.resultJson);
    const latestTextSummary =
      readNonEmptyString(latestSummary?.summary) ??
      readNonEmptyString(latestSummary?.result) ??
      readNonEmptyString(latestSummary?.message) ??
      readNonEmptyString(latestRun.error);

    // [A안] 세션 회전 시 결정원장 포인터(미션+판번호)를 실어 다음 세션이
    // 권위 있는 구조 레코드(mission_rolling_state)를 찾게 한다. 표시용 맥락일 뿐.
    const decisionLogPointer = input.missionId
      ? await resolveMissionDecisionLogPointer(db, input.missionId)
      : null;

    const handoffMarkdown = [
      "Paperclip session handoff:",
      `- Previous session: ${sessionId}`,
      issueId ? `- Issue: ${issueId}` : "",
      `- Rotation reason: ${reason}`,
      latestTextSummary ? `- Last run summary: ${latestTextSummary}` : "",
      decisionLogPointer
        ? `- Mission decision log: mission ${decisionLogPointer.missionId} rolling state revision ${decisionLogPointer.revision} (authoritative decision statuses: confirmed/under_review/retired)`
        : "",
      "Continue from the current task state. Rebuild only the minimum context you need.",
    ]
      .filter(Boolean)
      .join("\n");
    const handoffArtifact = buildSessionHandoffArtifact({
      previousSessionId: sessionId,
      previousRunId: latestRun.id,
      issueId,
      rotationReason: reason,
      lastRunSummaryText: latestTextSummary ?? null,
      // 원장이 실제로 존재할 때만 필드가 실린다(없으면 기존 형태 유지).
      missionDecisionLogPointer: decisionLogPointer ?? undefined,
    });

    return {
      rotate: true,
      reason,
      handoffMarkdown,
      handoffArtifact,
      previousRunId: latestRun.id,
    };
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
    opts?: { missionId?: string | null },
  ) {
    const codec = getAdapterSessionCodec(agent.adapterType);
    if (taskKey) {
      const existingTaskSession = await getTaskSession(
        agent.companyId,
        agent.id,
        agent.adapterType,
        taskKey,
      );
      const parsedParams = normalizeSessionParams(
        codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
      );
      const taskSessionId = truncateDisplayId(
        existingTaskSession?.sessionDisplayId ??
          (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
          readNonEmptyString(parsedParams?.sessionId),
      );

      if (opts?.missionId) {
        const authority = await resolveMissionSessionAuthority({
          agent,
          missionId: opts.missionId,
          adapterType: agent.adapterType,
          taskSessionDisplayId: taskSessionId,
          taskSessionLegacySessionId: readNonEmptyString(parsedParams?.sessionId),
        });
        return truncateDisplayId(authority.decision.preferredSessionId);
      }

      return taskSessionId;
    }

    if (opts?.missionId) {
      const authority = await resolveMissionSessionAuthority({
        agent,
        missionId: opts.missionId,
        adapterType: agent.adapterType,
      });
      return truncateDisplayId(authority.decision.preferredSessionId);
    }

    const runtimeForRun = await getRuntimeState(agent.id);
    return runtimeForRun?.sessionId ?? null;
  }

  async function resolveWorkspaceForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: { useProjectWorkspace?: boolean | null },
  ): Promise<ResolvedWorkspaceForRun> {
    const issueId = readNonEmptyString(context.issueId);
    const contextProjectId = readNonEmptyString(context.projectId);
    const contextProjectWorkspaceId = readNonEmptyString(context.projectWorkspaceId);
    const issueProjectRef = issueId
      ? await db
          .select({
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
            missionId: issues.missionId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueProjectId = issueProjectRef?.projectId ?? null;
    const preferredProjectWorkspaceId =
      issueProjectRef?.projectWorkspaceId ?? contextProjectWorkspaceId ?? null;
    // [목적] issue/context 어디에도 project가 없으면, issue가 속한 mission의 projectId로 폴백.
    //   mission에 project를 물리면 그 project의 primary workspace에서 run이 돌아간다
    //   -> source='project_primary' + workspaceId -> broadScan 허용 + durable cwd.
    //   RES-1363 류(Step Input Manifest 의 find. 광역스캔 차단)와 outputs/ 소실을 함께 방지.
    // [주의] mission.projectId가 없거나 mission 자체가 없으면 null 로 둬 기존 fallback 경로 유지.
    let resolvedProjectId = issueProjectId ?? contextProjectId;
    if (!resolvedProjectId && issueProjectRef?.missionId) {
      const [missionProjectRow] = await db
        .select({ projectId: missions.projectId })
        .from(missions)
        .where(and(eq(missions.id, issueProjectRef.missionId), eq(missions.companyId, agent.companyId)))
        .limit(1);
      resolvedProjectId = missionProjectRow?.projectId ?? null;
    }
    const useProjectWorkspace = opts?.useProjectWorkspace !== false;
    const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;

    const unorderedProjectWorkspaceRows = workspaceProjectId
      ? await db
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, agent.companyId),
              eq(projectWorkspaces.projectId, workspaceProjectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      : [];
    const projectWorkspaceRows = prioritizeProjectWorkspaceCandidatesForRun(
      unorderedProjectWorkspaceRows,
      preferredProjectWorkspaceId,
    );

    const workspaceHints = projectWorkspaceRows.map((workspace) => ({
      workspaceId: workspace.id,
      cwd: readNonEmptyString(workspace.cwd),
      repoUrl: readNonEmptyString(workspace.repoUrl),
      repoRef: readNonEmptyString(workspace.repoRef),
    }));

    if (projectWorkspaceRows.length > 0) {
      const preferredWorkspace = preferredProjectWorkspaceId
        ? projectWorkspaceRows.find((workspace) => workspace.id === preferredProjectWorkspaceId) ?? null
        : null;
      const missingProjectCwds: string[] = [];
      let hasConfiguredProjectCwd = false;
      let preferredWorkspaceWarning: string | null = null;
      if (preferredProjectWorkspaceId && !preferredWorkspace) {
        preferredWorkspaceWarning =
          `Selected project workspace "${preferredProjectWorkspaceId}" is not available on this project.`;
      }
      for (const workspace of projectWorkspaceRows) {
        let projectCwd = readNonEmptyString(workspace.cwd);
        let managedWorkspaceWarning: string | null = null;
        if (!projectCwd || projectCwd === REPO_ONLY_CWD_SENTINEL) {
          try {
            // worktree: check file-write before managed workspace operations
            await worktreeCheck({
              agent,
              tool: "file-write",
              args: { operation: "managed_workspace_setup" },
            });
            const managedWorkspace = await ensureManagedProjectWorkspace({
              companyId: agent.companyId,
              agentId: agent.id,
              projectId: workspaceProjectId ?? resolvedProjectId ?? workspace.projectId,
              repoUrl: readNonEmptyString(workspace.repoUrl),
              worktreeCheck: async (opts) =>
                worktreeCheck({ agent, tool: opts.tool, args: opts.args, cwd: opts.cwd, filePath: opts.filePath, command: opts.command }),
            });
            projectCwd = managedWorkspace.cwd;
            managedWorkspaceWarning = managedWorkspace.warning;
          } catch (error) {
            if (preferredWorkspace?.id === workspace.id) {
              preferredWorkspaceWarning = error instanceof Error ? error.message : String(error);
            }
            continue;
          }
        }
        hasConfiguredProjectCwd = true;
        const projectCwdExists = await fs
          .stat(projectCwd)
          .then((stats) => stats.isDirectory())
          .catch(() => false);
        if (projectCwdExists) {
          return {
            cwd: projectCwd,
            source: "project_primary" as const,
            projectId: resolvedProjectId,
            workspaceId: workspace.id,
            repoUrl: workspace.repoUrl,
            repoRef: workspace.repoRef,
            workspaceHints,
            warnings: [preferredWorkspaceWarning, managedWorkspaceWarning].filter(
              (value): value is string => Boolean(value),
            ),
          };
        }
        if (preferredWorkspace?.id === workspace.id) {
          preferredWorkspaceWarning =
            `Selected project workspace path "${projectCwd}" is not available yet.`;
        }
        missingProjectCwds.push(projectCwd);
      }

      const fallbackCwd = resolveDefaultAgentWorkspaceDir(agent.id);
      // worktree: check file-write before fallback workspace mkdir
      await worktreeCheck({
        agent,
        tool: "file-write",
        args: { operation: "fallback_workspace_mkdir" },
        cwd: fallbackCwd,
        filePath: fallbackCwd,
      });
      await fs.mkdir(fallbackCwd, { recursive: true });
      const warnings: string[] = [];
      if (preferredWorkspaceWarning) {
        warnings.push(preferredWorkspaceWarning);
      }
      if (missingProjectCwds.length > 0) {
        const firstMissing = missingProjectCwds[0];
        const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
        warnings.push(
          extraMissingCount > 0
            ? `Project workspace path "${firstMissing}" and ${extraMissingCount} other configured path(s) are not available yet. Using fallback workspace "${fallbackCwd}" for this run.`
            : `Project workspace path "${firstMissing}" is not available yet. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      } else if (!hasConfiguredProjectCwd) {
        warnings.push(
          `Project workspace has no local cwd configured. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      }
      return {
        cwd: fallbackCwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: projectWorkspaceRows[0]?.id ?? null,
        repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
        repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
        workspaceHints,
        warnings,
      };
    }

    if (workspaceProjectId) {
      // worktree: check file-write before managed workspace operations
      await worktreeCheck({
        agent,
        tool: "file-write",
        args: { operation: "managed_workspace_setup" },
      });
      const managedWorkspace = await ensureManagedProjectWorkspace({
        companyId: agent.companyId,
        agentId: agent.id,
        projectId: workspaceProjectId,
        repoUrl: null,
        worktreeCheck: async (opts) =>
          worktreeCheck({ agent, tool: opts.tool, args: opts.args, cwd: opts.cwd, filePath: opts.filePath, command: opts.command }),
      });
      return {
        cwd: managedWorkspace.cwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        workspaceHints,
        warnings: managedWorkspace.warning ? [managedWorkspace.warning] : [],
      };
    }

    const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
    if (sessionCwd) {
      const sessionCwdExists = await fs
        .stat(sessionCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (sessionCwdExists) {
        return {
          cwd: sessionCwd,
          source: "task_session" as const,
          projectId: resolvedProjectId,
          workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
          repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
          repoRef: readNonEmptyString(previousSessionParams?.repoRef),
          workspaceHints,
          warnings: [],
        };
      }
    }

    const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
    // worktree: check file-write before default workspace mkdir
    await worktreeCheck({
      agent,
      tool: "file-write",
      args: { operation: "default_workspace_mkdir" },
      cwd,
      filePath: cwd,
    });
    await fs.mkdir(cwd, { recursive: true });
    const warnings: string[] = [];
    if (sessionCwd) {
      warnings.push(
        `Saved session workspace "${sessionCwd}" is not available. Using fallback workspace "${cwd}" for this run.`,
      );
    } else if (resolvedProjectId) {
      warnings.push(
        `No project workspace directory is currently available for this issue. Using fallback workspace "${cwd}" for this run.`,
      );
    } else {
      warnings.push(
        `No project or prior session workspace was available. Using fallback workspace "${cwd}" for this run.`,
      );
    }
    return {
      cwd,
      source: "agent_home" as const,
      projectId: resolvedProjectId,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints,
      warnings,
    };
  }

  async function upsertTaskSession(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string | null;
    lastError: string | null;
  }) {
    const existing = await getTaskSession(
      input.companyId,
      input.agentId,
      input.adapterType,
      input.taskKey,
    );
    if (existing) {
      return db
        .update(agentTaskSessions)
        .set({
          sessionParamsJson: input.sessionParamsJson,
          sessionDisplayId: input.sessionDisplayId,
          lastRunId: input.lastRunId,
          lastError: input.lastError,
          updatedAt: new Date(),
        })
        .where(eq(agentTaskSessions.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    return db
      .insert(agentTaskSessions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        adapterType: input.adapterType,
        taskKey: input.taskKey,
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastRunId: input.lastRunId,
        lastError: input.lastError,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearTaskSessions(
    companyId: string,
    agentId: string,
    opts?: { taskKey?: string | null; adapterType?: string | null },
  ) {
    const conditions = [
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId),
    ];
    if (opts?.taskKey) {
      conditions.push(eq(agentTaskSessions.taskKey, opts.taskKey));
    }
    if (opts?.adapterType) {
      conditions.push(eq(agentTaskSessions.adapterType, opts.adapterType));
    }

    return db
      .delete(agentTaskSessions)
      .where(and(...conditions))
      .returning()
      .then((rows) => rows.length);
  }

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await getRuntimeState(agent.id);
    if (existing) return existing;

    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
    opts?: { expectedStatuses?: string[]; expectedRun?: typeof heartbeatRuns.$inferSelect },
  ) {
    return setHeartbeatRunStatus(db, runId, status, patch, opts);
  }

  // Evidence-only backfill for runs that were terminalized externally
  // (finalizeLinkedRunsForIssueStatus / cancel / reap) while their adapter was
  // still executing. Writes only evidence columns; never touches status,
  // finishedAt, error, or errorCode, and emits no terminal events (the
  // external finalizer already recorded those). See the completion path in
  // runHeartbeat where this is used.
  async function backfillTerminalRunEvidence(
    runId: string,
    evidence: Partial<Pick<
      typeof heartbeatRuns.$inferInsert,
      | "exitCode" | "signal" | "usageJson" | "resultJson" | "sessionIdAfter"
      | "stdoutExcerpt" | "stderrExcerpt" | "logBytes" | "logSha256" | "logCompressed"
    >>,
  ) {
    return db
      .update(heartbeatRuns)
      .set({ ...evidence, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  /** Fill only missing actual-result evidence on the same exact owner/attempt. */
  async function preserveActualRunEvidence(run: typeof heartbeatRuns.$inferSelect,
    evidence: Partial<Pick<typeof heartbeatRuns.$inferInsert,
      | "exitCode" | "signal" | "usageJson" | "resultJson" | "sessionIdAfter"
      | "stdoutExcerpt" | "stderrExcerpt" | "logBytes" | "logSha256" | "logCompressed">>): Promise<boolean> {
    return db.transaction(async tx => {
      const [current] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId))).for("no key update");
      if (!current || current.agentId !== run.agentId || current.issueId !== run.issueId
        || current.wakeupRequestId !== run.wakeupRequestId || current.workflowStepRunId !== run.workflowStepRunId
        || current.workflowExecutionGeneration !== run.workflowExecutionGeneration
        || current.executionScopeKind !== run.executionScopeKind || current.executionEpoch !== run.executionEpoch
        || current.executionToken !== run.executionToken || current.executorOwnerId !== run.executorOwnerId
        || current.executorOwnerLeaseEpoch !== run.executorOwnerLeaseEpoch
        || current.executorOwnerLeaseToken !== run.executorOwnerLeaseToken || current.retryOfRunId !== run.retryOfRunId
        || current.processLossRetryCount !== run.processLossRetryCount) return false;
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(evidence)) {
        if (value === undefined) continue;
        const existing = current[key as keyof typeof current];
        if (existing === null || existing === undefined) {
          if (value !== null) patch[key] = value;
        } else if (!isDeepStrictEqual(existing, value)) return false;
      }
      if (Object.keys(patch).length === 0) return true;
      const rows = await tx.update(heartbeatRuns).set({ ...patch, updatedAt: new Date() })
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId))).returning({ id: heartbeatRuns.id });
      return rows.length === 1;
    });
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    if (!wakeupRequestId) return;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(and(eq(agentWakeupRequests.id, wakeupRequestId), status === "cancelled"
        ? undefined : not(eq(agentWakeupRequests.status, "cancelled"))));
  }

  // [Task 6C] queue/run 상태전이를 workflow_transition_events 에 mirror (append-only).
  // 기존 경로 제거/교체 없이 event 만 추가. unique index (company_id, idempotency_key) 로 중복 방지.
  async function recordQueueTransitionEvent(input: {
    companyId: string;
    missionId?: string | null;
    issueId?: string | null;
    wakeupRequestId?: string | null;
    heartbeatRunId?: string | null;
    workflowRunId?: string | null;
    workflowStepRunId?: string | null;
    eventType: string;
    layer: string;
    decision?: string | null;
    reason?: string | null;
    reasonCode?: string | null;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
  }) {
    await recordHeartbeatQueueTransitionEvent(db, input);
  }

  async function appendRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const sanitizedMessage = event.message
      ? redactCurrentUserText(event.message, currentUserRedactionOptions)
      : event.message;
    const sanitizedPayload = event.payload
      ? redactCurrentUserValue(event.payload, currentUserRedactionOptions)
      : event.payload;

    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: sanitizedMessage,
      payload: sanitizedPayload,
    });

    publishLiveEvent({
      companyId: run.companyId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: sanitizedMessage ?? null,
        payload: sanitizedPayload ?? null,
      },
    });
  }

  /**
   * Audit a broad-scan block or hook intercept as a redacted run event.
   * Preflight/runtime blocks throw; runtime_hook intercepts are audit-only
   * (the run continues — the synthetic output is for operator visibility,
   * not the agent LLM). F6: runtime_hook uses a distinct eventType so
   * "blocked" vs "intercepted" is observable. Payload is sanitized by
   * appendRunEvent. Non-fatal: a DB failure here must not mask the caller.
   */
  async function appendBroadScanBlockEvent(
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    details: {
      reason: string;
      errorCode: string;
      phase: "preflight" | "runtime" | "runtime_flush" | "runtime_hook";
      stream?: "stdout" | "stderr";
      matchedCommand?: string | null;
      matchedPhrase?: string | null;
      line?: string;
    },
  ): Promise<void> {
    const eventType =
      details.phase === "runtime_hook"
        ? "guard.broad_scan_intercepted"
        : "guard.broad_scan_blocked";
    try {
      await appendRunEvent(run, seq, {
        eventType,
        stream: details.stream ?? "system",
        level: "warn",
        message: details.reason,
        payload: {
          errorCode: details.errorCode,
          phase: details.phase,
          matchedCommand: details.matchedCommand ?? null,
          matchedPhrase: details.matchedPhrase ?? null,
          line: details.line ?? null,
        },
      });
    } catch {
      // Non-fatal: the original broad-scan guard error must still surface.
    }
  }

  async function nextRunEventSeq(runId: string) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return Number(row?.maxSeq ?? 0) + 1;
  }

  async function persistRunProcessMetadata(
    runId: string,
    meta: { pid: number; startedAt: string },
  ) {
    const startedAt = new Date(meta.startedAt);
    return db
      .update(heartbeatRuns)
      .set({
        processPid: meta.pid,
        processStartedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearDetachedRunWarning(runId: string) {
    const updated = await db
      .update(heartbeatRuns)
      .set({
        error: null,
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.errorCode, DETACHED_PROCESS_ERROR_CODE)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;

    await appendRunEvent(updated, await nextRunEventSeq(updated.id), {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "Detached child process reported activity; cleared detached warning",
    });
    return updated;
  }

  // [B-7 재시도 함수군 추출] enqueueProcessLossRetry/enqueueAdapterFallbackRun 은
  //   heartbeat-retry-enqueue.ts 로 기계적 이동했다(동작 무변경). deps 는 이 팩토리 클로저를 그대로 주입.
  const retryEnqueueDeps: HeartbeatRetryEnqueueDeps = { db, resolveSessionBeforeForWakeup, appendRunEvent };

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    return {
      enabled: asBoolean(heartbeat.enabled, true),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
      maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
    };
  }

  async function countRunningRunsForAgent(agentId: string) {
    const activeClause = await lifecycleActiveClause(db);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), activeClause));
    return Number(count ?? 0);
  }

  async function claimQueuedRun(run: typeof heartbeatRuns.$inferSelect,
    notificationSink?: ReplacementRootNotifications) {
    const ownerRuntime = c5OwnerRuntime;
    if (is(db, PgTransaction) && !ownerRuntime) {
      // Validate correction ancestry before registering; a savepoint cannot own execution.
      try {
        await withQaCorrectionClaimRoot(db, run,
          tx => assertHeartbeatRecoveryAdmission(tx, run), async () => {
            currentReplacementRootNotifications(db)?.agentIds.add(run.agentId);
          });
      } catch (error) {
        // Preserve the ordinary claim refusal contract while correction errors still abort.
        if (isQaCorrectionRootOwnerRequired(error) || error instanceof QaCorrectionClaimRejected) throw error;
        await cancelRunInternal(run.id, error instanceof Error ? error.message : "Heartbeat claim refused", false);
        return { kind: "not_claimed" as const };
      }
      // Keep the durable row queued for the owning root drain or scheduler after commit.
      return { kind: "root_deferred" as const };
    }
    const sharedAdmission = ownerRuntime ? createHeartbeatC5SharedAdmission(ownerRuntime) : undefined;
    const result = await claimQueuedRunWithRecoveryGuard({
      db, sharedAdmission, cancelRun: cancelRunInternal, recordQueueTransitionEvent, publishLiveEvent, setWakeupStatus,
    }, run);
    if (sharedAdmission && notificationSink) mergeHeartbeatRootNotifications(notificationSink, sharedAdmission.outerNotifications);
    return result;
  }

  async function pauseAgentForReauthRequired(
    agentId: string,
    authInfo: CodexAuthAutoBlockInfo,
  ) {
    const paused = await db
      .update(agents)
      .set({
        status: "paused",
        pauseReason: CODEX_REAUTH_REQUIRED_PAUSE_REASON,
        pausedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agentId), not(inArray(agents.status, ["paused", "terminated", "pending_approval"]))))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (paused) {
      publishLiveEvent({
        companyId: paused.companyId,
        type: "agent.status",
        payload: {
          agentId: paused.id,
          status: paused.status,
          pauseReason: paused.pauseReason,
          pausedAt: paused.pausedAt ? new Date(paused.pausedAt).toISOString() : null,
          outcome: "reauth_required",
          reasonCode: authInfo.reasonCode,
        },
      });
    }

    return paused;
  }

  async function finalizeAgentStatus(
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;

    if (existing.status === "paused" || existing.status === "terminated") {
      return;
    }

    const runningCount = await countRunningRunsForAgent(agentId);
    const nextStatus =
      runningCount > 0
        ? "running"
        : outcome === "succeeded" || outcome === "cancelled"
          ? "idle"
          : "error";

    const updated = await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt
            ? new Date(updated.lastHeartbeatAt).toISOString()
            : null,
          outcome,
        },
      });
    }
  }

  // [A2] detached child 유예 창 동안 agents.status 가 `running`에 갇힌(phantom running) 상태를
  // 직접 교정한다. finalizeAgentStatus 경로를 타지 않는 detached defer 분기에서 호출되며, agent 가
  // HEARTBEAT_AGENT_DETACHED_DEMOTE_MS 이상 stale 하고 해당 agent 의 running run 이 모두 detached 상태일
  // 때만 `error` 로 강등한다. 진행 중인(non-detached) sibling run 이 하나라도 있으면 절대 강등하지 않는다.
  async function demoteAgentStuckDetached(run: typeof heartbeatRuns.$inferSelect, now: Date) {
    const [agent] = await db
      .select({ id: agents.id, status: agents.status, updatedAt: agents.updatedAt, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, run.agentId))
      .limit(1);
    if (!agent || agent.status !== "running") return;

    const agentStaleMs = agent.updatedAt ? now.getTime() - new Date(agent.updatedAt).getTime() : Number.POSITIVE_INFINITY;
    if (agentStaleMs < HEARTBEAT_AGENT_DETACHED_DEMOTE_MS) return;

    // sibling 이라도 진짜로 실행 중인(non-detached) run 이 있으면 agent 는 여전히 running 이어야 한다.
    const nonDetachedRunning = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, run.agentId),
          eq(heartbeatRuns.status, "running"),
          // IS DISTINCT FROM treats NULL as non-detached (a run that never entered the
          // detached state is genuinely progressing). Plain `!=` would drop NULL rows.
          sql`${heartbeatRuns.errorCode} is distinct from ${DETACHED_PROCESS_ERROR_CODE}`,
        ),
      )
      .limit(1);
    if (nonDetachedRunning.length > 0) return;

    const updated = await db
      .update(agents)
      .set({ status: "error", lastHeartbeatAt: now, updatedAt: now })
      .where(and(eq(agents.id, run.agentId), eq(agents.status, "running")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt ? new Date(updated.lastHeartbeatAt).toISOString() : null,
          outcome: "failed",
          reasonCode: "detached_agent_demoted",
        },
      });
      logger.warn(
        { agentId: run.agentId, runId: run.id, agentStaleMs },
        "demoted phantom-running agent to error while detached child deferred",
      );
      fireWikiRecord(wikiSvc, {
        companyId: run.companyId,
        agentId: run.agentId,
        missionId: null,
        pattern: "phantom running (detached 유예 창)",
        cause: "in-memory handle 은 상실했지만 child pid 가 살아있어 reapOrphanedRuns 가 detached 로 유예하는 동안 agents.status 가 running 에 갇힘. 서버 재시작/handle 상실 후 finalizeAgentStatus 가 호출되지 않아 발생.",
        solution: "detached 유예 창에서도 agent.updatedAt staleness 를 별도 검사해 error 로 강등. run 자체는 DETACHED_REAP_AFTER_MS cap 으로 회수되므로 가시성만 교정.",
        errorCode: "detached_agent_demoted",
      }, run.id);
    }
  }

  async function resolveRunActiveExecutionTimeoutMs(
    run: typeof heartbeatRuns.$inferSelect,
    baseMs: number,
  ): Promise<number> {
    if (baseMs <= 0) return 0;
    const issueId = run.issueId ?? readNonEmptyString(parseObject(run.contextSnapshot).issueId);
    if (!issueId) return baseMs;
    try {
      const { workflowService } = await import("./workflow/engine.js");
      const contract = await workflowService.getStepExecutionContractForIssue(db, issueId);
      return resolveStepAwareActiveExecutionTimeoutMs({
        baseMs,
        contract,
        qaStepActiveExecutionTimeoutMs: resolveQaStepActiveExecutionTimeoutMs(),
      });
    } catch {
      return baseMs;
    }
  }

  // [checkpoint+graceful shutdown] SIGTERM/SIGINT 종료 플러시 — 이 프로세스가 추적 중이던 running 런을
  // 내구 마킹(failed + shutdown_interrupted)하고 process_lost 와 동일 정합의 회수(정확히 1회 재시도,
  // 소진 시 fallback/릴리즈)를 대기열에 넣는다. 마킹은 #277 CAS 경로(expectedStatuses=["running"]) —
  // 늙은 프로세스의 flush 가 새 런타임 상태를 덮어쓰지 않는다(split-brain 방지). 체크포인트 참조
  // 레코드(zod v1 strict)는 마킹과 같은 CAS 쓰기에 원자 첨부된다. 미마킹 런(데드라인 초과/오류)은
  // running 유지 → 기존 reaper 가 회수(안전 장전). 마킹 후 재시도 등록 전 죽는 창은 reaper 백스톱이 회수.
  async function markRunsShutdownInterrupted(
    runIds: string[],
    opts: { signal: "SIGINT" | "SIGTERM"; deadlineMs: number },
  ): Promise<ShutdownFlushSummary> {
    const summary = emptyFlushSummary();
    const deadlineAt = Date.now() + Math.max(0, opts.deadlineMs);
    for (const runId of runIds) {
      summary.considered += 1;
      if (remainingMs(deadlineAt) <= 0) {
        summary.skippedDeadline += 1;
        continue;
      }
      try {
        const run = await getRun(runId);
        if (!run || run.status !== "running") {
          // 이미 종단 상태면 덮어쓰지 않는다(CAS 와 동일한 펜스 의미 — 사전 검사).
          summary.fenced += 1;
          continue;
        }
        const agent = await getAgent(run.agentId);
        const retryPlanned = Boolean(agent) && (run.processLossRetryCount ?? 0) < 1;
        const interruptedAt = new Date();
        const lastPid = runningProcesses.get(runId)?.child.pid ?? run.processPid ?? null;
        const checkpoint = await buildShutdownCheckpoint({
          db,
          run,
          signal: opts.signal,
          lastPid,
          retryPlanned,
          interruptedAt,
        });
        if (!checkpoint.ok) {
          logger.warn(
            { runId, issues: checkpoint.issues },
            "shutdown flush: checkpoint record rejected by schema; marking without checkpoint attachment",
          );
        }
        const shutdownMessage = `Graceful ${opts.signal} shutdown interrupted run; last pid ${lastPid ?? "unknown"}`;
        const finalizedRun = await setRunStatus(
          run.id,
          "failed",
          {
            error: shutdownMessage,
            errorCode: SHUTDOWN_INTERRUPTED_ERROR_CODE,
            finishedAt: interruptedAt,
            ...(checkpoint.ok
              ? {
                  contextSnapshot: {
                    ...parseObject(run.contextSnapshot),
                    shutdownCheckpoint: checkpoint.checkpoint,
                  },
                }
              : {}),
          },
          { expectedStatuses: ["running"] },
        );
        await setWakeupStatus(run.wakeupRequestId, "failed", {
          finishedAt: interruptedAt,
          error: shutdownMessage,
        });
        if (!finalizedRun) {
          summary.fenced += 1;
          continue;
        }
        summary.marked += 1;

        // process_lost 후처리 미터 — 재시도 의미론 동일 정합(정확히 1회, retryCount 소진 규칙 동일).
        // 종료 중이므로 finalizeAgentStatus/startNextQueuedRunForAgent(새 실행 촉발)은 하지 않는다.
        let retriedRun: typeof heartbeatRuns.$inferSelect | null = null;
        let fallbackRun: typeof heartbeatRuns.$inferSelect | null = null;
        if (retryPlanned && agent) {
          retriedRun = await enqueueProcessLossRetry(retryEnqueueDeps, finalizedRun, agent, interruptedAt);
          if (retriedRun) summary.retried += 1;
        } else {
          const fallback = agent ? resolveAdapterFallbackConfig(agent.adapterConfig) : null;
          const fallbackAttempt = resolveAdapterFallbackAttempt(run.contextSnapshot);
          if (agent && fallback && fallbackAttempt < fallback.maxAttempts) {
            fallbackRun = await enqueueAdapterFallbackRun(retryEnqueueDeps, finalizedRun, agent, interruptedAt, {
              fallbackCommand: fallback.command,
              fallbackProvider: fallback.provider,
              fallbackModel: fallback.model,
              fallbackThinking: resolveAdapterFallbackThinking(fallback, fallbackAttempt + 1),
              fallbackReason: SHUTDOWN_INTERRUPTED_ERROR_CODE,
            });
            if (fallbackRun) summary.fallbackQueued += 1;
          }
        }
        if (!retriedRun && !fallbackRun) {
          try {
            await releaseIssueExecutionAndPromote(finalizedRun, { skipLocked: true });
            summary.released += 1;
          } catch (err) {
            logger.warn(
              { err, runId: run.id },
              "shutdown flush: failed to release+promote run; issue lock reaper will recover",
            );
          }
        }
        await appendRunEvent(finalizedRun, await nextRunEventSeq(finalizedRun.id), {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: retriedRun
            ? `${shutdownMessage}; queued retry ${retriedRun.id}`
            : fallbackRun
              ? `${shutdownMessage}; queued adapter fallback ${fallbackRun.id}`
              : shutdownMessage,
          payload: {
            ...(lastPid !== null ? { lastPid } : {}),
            ...(retriedRun ? { retryRunId: retriedRun.id } : {}),
            ...(fallbackRun ? { fallbackRunId: fallbackRun.id } : {}),
          },
        });
      } catch (err) {
        summary.errors += 1;
        logger.warn(
          { err, runId },
          "shutdown flush: failed to mark run; leaving run for reaper recovery",
        );
      }
    }
    summary.deadlineExceeded = summary.skippedDeadline > 0;
    if (summary.deadlineExceeded || summary.errors > 0) {
      logger.warn(
        { summary },
        "shutdown flush incomplete: unmarked runs stay running and will be recovered by the reaper",
      );
    }
    return summary;
  }

  async function reapOrphanedRuns(opts?: {
    staleThresholdMs?: number;
    activeExecutionTimeoutMs?: number;
    queuedStaleThresholdMs?: number;
  }) {
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const activeExecutionTimeoutMs = opts?.activeExecutionTimeoutMs ?? 0;
    const queuedStaleThresholdMs = opts?.queuedStaleThresholdMs ?? 0;
    const now = new Date();

    // Find all runs stuck in "running" state. Queued runs are handled below only
    // when they have exceeded an explicit queued staleness threshold.
    const activeRuns = await db
      .select({
        run: heartbeatRuns,
        adapterType: agents.adapterType,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.status, "running"));

    const reaped: string[] = [];

    // [approval-waiting marker] running 런의 이슈에 pending 운영자 결정/승인이 있으면
    // '멈춤(stuck)'이 아니라 '사람 대기'다 — 배치 판정 후 타임아웃 회수에서 면제한다(스캔 N+1 금지).
    const approvalWaitByIssueId = await operatorApprovalWaitService(db).markersForIssueIds(
      activeRuns.map((row) => row.run.issueId).filter((issueId): issueId is string => Boolean(issueId)),
    );

    for (const { run, adapterType } of activeRuns) {
      const trackedProcess = runningProcesses.get(run.id) ?? null;
      const hasActiveExecution = activeRunExecutions.has(run.id);
      if (trackedProcess || hasActiveExecution) {
        // [issue done → 자식 즉시 kill] 에이전트가 issue 를 done/cancelled 처리했는데도
        // 어댑터 자식(opencode 등)이 exit 안 하고 살아있으면 maxConcurrentRuns 블록이
        // execution_stale(15min)까지 지속된다. issue 상태가 done/cancelled 면 자식을
        // 즉시 종료해 블록을 푼다.
        if (trackedProcess && run.issueId) {
          const [issueRow] = await db.select({ status: issues.status }).from(issues)
            .where(eq(issues.id, run.issueId)).limit(1);
          if (issueRow && (issueRow.status === "done" || issueRow.status === "cancelled")) {
            trackedProcess.child.kill("SIGTERM");
            setTimeout(() => {
              if (!trackedProcess.child.killed) {
                trackedProcess.child.kill("SIGKILL");
              }
            }, Math.max(1, trackedProcess.graceSec) * 1000);
            runningProcesses.delete(run.id);
            await setRunStatus(run.id, issueRow.status === "done" ? "succeeded" : "cancelled", {
              error: `Issue ${issueRow.status} but adapter child did not exit; terminated`,
              errorCode: "issue_done_child_not_exited",
              finishedAt: now,
            }, { expectedStatuses: ["running"] });
            // Agent self-learning wiki (Phase 1): adapter 자식 미종료 패턴 기록 (non-blocking).
            fireWikiRecord(wikiSvc, {
              companyId: run.companyId,
              agentId: run.agentId,
              missionId: null,
              pattern: "adapter 자식 미종료 (issue done/cancelled)",
              cause: "이슈가 done/cancelled로 종료됐는데도 어댑터 자식(opencode 등)이 exit하지 않아 maxConcurrentRuns 블록이 execution_stale까지 지속됨.",
              solution: "이슈 done/cancelled 처리 후 어댑터 자식이 확실히 exit하도록 종료 시그널/플래그 점검. 작업 완료 시 프로세스를 즉시 종료할 것.",
              errorCode: "issue_done_child_not_exited",
            }, run.id);
            continue;
          }
        }
        if (activeExecutionTimeoutMs <= 0) continue;
        // [run stability] step 등급 타임아웃 — QA/검수 step이거나 명시적 step timeout이 있으면
        //   기본 부실 역치(900s) 대신 그 등급의 역치로 판정한다(낮추지 않는다).
        const stepAwareTimeoutMs = await resolveRunActiveExecutionTimeoutMs(run, activeExecutionTimeoutMs);
        if (stepAwareTimeoutMs <= 0) continue;
        const refTime = new Date(run.updatedAt).getTime();
        if (now.getTime() - refTime < stepAwareTimeoutMs) continue;

        // [approval-waiting marker] 실행이 pending 운영자 결정/승인 대기 중이면 stuck 이 아니다.
        // 프로세스는 살아있고 사람 결정에 막혀 있으므로 타임아웃/kill 을 보류한다(자동취소 금지).
        const approvalWait = run.issueId ? approvalWaitByIssueId.get(run.issueId) : undefined;
        if (approvalWait?.waiting) {
          logger.info(
            {
              runId: run.id,
              issueId: run.issueId,
              operatorDecisionIds: approvalWait.operatorDecisionIds,
              approvalIds: approvalWait.approvalIds,
              activeExecutionTimeoutMs,
            },
            "run is waiting on a pending operator decision/approval; skipping stale execution timeout",
          );
          continue;
        }

        if (trackedProcess) {
          trackedProcess.child.kill("SIGTERM");
          setTimeout(() => {
            if (!trackedProcess.child.killed) {
              trackedProcess.child.kill("SIGKILL");
            }
          }, Math.max(1, trackedProcess.graceSec) * 1000);
          runningProcesses.delete(run.id);
        }

        const timeoutMessage = `Heartbeat execution exceeded ${Math.round(stepAwareTimeoutMs / 1000)}s without reaching a terminal state`;
        const timedOutRun = await setRunStatus(run.id, "timed_out", {
          error: timeoutMessage,
          errorCode: "execution_stale_timeout",
          finishedAt: now,
        }, { expectedStatuses: ["running"] });
        await setWakeupStatus(run.wakeupRequestId, "timed_out", {
          finishedAt: now,
          error: timeoutMessage,
        });
        if (timedOutRun) {
          await appendRunEvent(timedOutRun, await nextRunEventSeq(timedOutRun.id), {
            eventType: "lifecycle",
            stream: "system",
            level: "error",
            message: timeoutMessage,
            payload: {
              activeExecution: hasActiveExecution,
              trackedProcess: Boolean(trackedProcess),
              activeExecutionTimeoutMs,
            },
          });
          // [recovery liveness hardening] per-run isolation: 이 run 의 terminal 처리(release,
          // finalize, startNext) 중 어느 단계가 실패/정지해도 전체 sweep 과 recovery lane 을
          // 중단시키지 않고 다음 run 으로 진행한다.
          try {
            await releaseIssueExecutionAndPromote(timedOutRun, { skipLocked: true });
            const terminalRun = await getRun(timedOutRun.id);
            if (terminalRun && isTerminalHeartbeatRunStatus(terminalRun.status)) {
              await settleHeartbeatAfterExecution(db, terminalRun, now);
            }
            await finalizeAgentStatus(run.agentId, "timed_out");
            await startNextQueuedRunForAgent(run.agentId);
            reaped.push(run.id);
          } catch (err) {
            logger.warn({ err, runId: run.id }, "failed to finalize timed-out run; continuing sweep");
          }
        }
        // Agent self-learning wiki (Phase 1): execution stale(hang) 패턴 기록 (non-blocking).
        fireWikiRecord(wikiSvc, {
          companyId: run.companyId,
          agentId: run.agentId,
          missionId: null,
          pattern: "execution stale (hang)",
          cause: "어댑터 실행이 타임아웃(activeExecutionTimeout) 전에 종단 상태에 도달하지 못해 hang으로 판정됨.",
          solution: "API_TIMEOUT(10분)과 idle 점검. 장기 실행 명령은 타임아웃/백그라운드 분리. 자식이 stdout을 닫지 않고 누수하는지 확인.",
          errorCode: "execution_stale_timeout",
        }, run.id);
        continue;
      }

      // Apply staleness threshold to avoid false positives
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      const tracksLocalChild = isTrackedLocalChildProcessAdapter(adapterType);
      if (tracksLocalChild && run.processPid && isProcessAlive(run.processPid)) {
        if (run.errorCode !== DETACHED_PROCESS_ERROR_CODE) {
          const detachedMessage = `Lost in-memory process handle, but child pid ${run.processPid} is still alive`;
          const detachedRun = await setRunStatus(run.id, "running", {
            error: detachedMessage,
            errorCode: DETACHED_PROCESS_ERROR_CODE,
          }, { expectedStatuses: ["running"] });
          if (detachedRun) {
            await appendRunEvent(detachedRun, await nextRunEventSeq(detachedRun.id), {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: detachedMessage,
              payload: {
                processPid: run.processPid,
              },
            });
          }
        }
        // FIX 2b: orphaned-but-alive child longevity cap. child 가 DETACHED_REAP_AFTER_MS 초과 실행 중이면
        // 강제 kill 후 아래 기존 process_lost/retry 경로로 fall-through(무한 defer 방지 — CMPA-5519 대응).
        const detachedChildStartedMs = run.processStartedAt
          ? new Date(run.processStartedAt).getTime()
          : run.startedAt
            ? new Date(run.startedAt).getTime()
            : 0;
        if (
          DETACHED_REAP_AFTER_MS > 0 &&
          detachedChildStartedMs > 0 &&
          now.getTime() - detachedChildStartedMs > DETACHED_REAP_AFTER_MS
        ) {
          terminateRecordedProcess(run.processPid, "SIGTERM");
          setTimeout(
            () => terminateRecordedProcess(run.processPid, "SIGKILL"),
            Math.max(1, DETACHED_GRACE_SEC) * 1000,
          );
          // fall through to process_lost/retry below (의도적 continue 생략).
        } else {
          // [A2] run 은 longevity cap 까지 detached 로 유예하지만, 그동안 agent 가 phantom running
          // 에 갇히지 않도록 agent 가시성을 직접 교정한 뒤 유예한다.
          await demoteAgentStuckDetached(run, now);
          continue;
        }
      }

      const shouldRetry = tracksLocalChild && !!run.processPid && (run.processLossRetryCount ?? 0) < 1;
      const baseMessage = run.processPid
        ? `Process lost -- child pid ${run.processPid} is no longer running`
        : "Process lost -- server may have restarted";

      let finalizedRun = await setRunStatus(run.id, "failed", {
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
        errorCode: "process_lost",
        finishedAt: now,
      }, { expectedStatuses: ["running"] });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
      });
      if (!finalizedRun) finalizedRun = await getRun(run.id);
      if (!finalizedRun) continue;

      // Agent wiki hook (process_lost): adapter 자식 프로세스 상실 교훈 축적 (non-blocking).
      // detached 30min cap fall-through 도 이 process_lost 경로를 타므로 이 hook 하나로 커버.
      fireWikiRecord(wikiSvc, {
        companyId: run.companyId,
        agentId: run.agentId,
        pattern: "process_lost (adapter 자식 프로세스 상실)",
        cause: "어댑터 자식 프로세스가 예기치 않게 종료/상실돼 run 실패. in-memory handle 상실(→orphan), 서버 재시작, 자식 crash 등. CMPA-5519 hang의 주요 원인.",
        solution: "detached 30min cap + graceful shutdown 자식 회수로 handle-loss 회수 지연을 보강. 반복 시 adapter command·리소스·안정성 점검.",
        errorCode: "process_lost",
      }, run.id);

      let retriedRun: typeof heartbeatRuns.$inferSelect | null = null;
      let fallbackRun: typeof heartbeatRuns.$inferSelect | null = null;
      if (shouldRetry) {
        const agent = await getAgent(run.agentId);
        if (agent) {
          retriedRun = await enqueueProcessLossRetry(retryEnqueueDeps, finalizedRun, agent, now);
        }
      } else {
        const agent = await getAgent(run.agentId);
        const fallback = agent ? resolveAdapterFallbackConfig(agent.adapterConfig) : null;
        const fallbackAttempt = resolveAdapterFallbackAttempt(run.contextSnapshot);
        const shouldFallback =
          Boolean(agent) &&
          Boolean(fallback) &&
          fallbackAttempt < fallback!.maxAttempts;
        if (agent && fallback && shouldFallback) {
          fallbackRun = await enqueueAdapterFallbackRun(retryEnqueueDeps, finalizedRun, agent, now, {
            fallbackCommand: fallback.command,
            fallbackProvider: fallback.provider,
            fallbackModel: fallback.model,
            fallbackThinking: resolveAdapterFallbackThinking(
              fallback,
              resolveAdapterFallbackAttempt(finalizedRun.contextSnapshot) + 1,
            ),
            fallbackReason: "process_lost",
          });
        } else {
          // [recovery liveness hardening] per-run isolation: fallback 없는 run 의 release+promote
          // 실패가 전체 sweep 을 중단시키지 않게 격리.
          try {
            await releaseIssueExecutionAndPromote(finalizedRun, { skipLocked: true });
          } catch (err) {
            logger.warn({ err, runId: run.id }, "failed to release+promote finalized run; continuing sweep");
          }
        }
      }

      await appendRunEvent(finalizedRun, await nextRunEventSeq(finalizedRun.id), {
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message: shouldRetry
          ? `${baseMessage}; queued retry ${retriedRun?.id ?? ""}`.trim()
          : fallbackRun
            ? `${baseMessage}; queued adapter fallback ${fallbackRun.id}`
          : baseMessage,
        payload: {
          ...(run.processPid ? { processPid: run.processPid } : {}),
          ...(retriedRun ? { retryRunId: retriedRun.id } : {}),
          ...(fallbackRun ? { fallbackRunId: fallbackRun.id } : {}),
        },
      });

      // [recovery liveness hardening] terminal 체인 후속(finalize/startNext) 도 격리 — 이 run 의
      // 실패가 전체 sweep 을 중단시키지 않는다.
      try {
        await finalizeAgentStatus(run.agentId, "failed");
        await startNextQueuedRunForAgent(run.agentId);
        runningProcesses.delete(run.id);
        reaped.push(run.id);
      } catch (err) {
        logger.warn({ err, runId: run.id }, "failed to finalize process-lost run; continuing sweep");
      }
    }

    // [checkpoint+graceful shutdown 백스톱] 종료 플러시가 마킹(failed+shutdown_interrupted)까지는
    // 커밋했으나 재시도 등록 직전에 프로세스가 죽거나 데드라인에 걸린 런의 회수 사각지대 방어.
    // 이 스캔이 없으면 마킹된 런은 위 running 스캔 대상에서 빠져 아무도 회수하지 못한다(요구사항:
    // 종료 시 마킹된 런은 기존 회수 경로에 반드시 진입해야 한다). 조건 — processLossRetryCount<1
    // (재시도 자격, 소진 규칙 동일) + 후계 런(retryOfRunId, retry/fallback 공통) 부재 → 정확히 1회.
    // retryCount 소진 마킹 런의 fallback 누락은 여기서 보충하지 않는다(이슈 락은
    // reapStalledIssueExecutionLocks 가 회수 — 데드라인 스킵 시 의도된 우아한 강등).
    try {
      const interruptedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.status, "failed"),
            eq(heartbeatRuns.errorCode, SHUTDOWN_INTERRUPTED_ERROR_CODE),
            sql`${heartbeatRuns.processLossRetryCount} < 1`,
          ),
        )
        .limit(50);
      for (const run of interruptedRuns) {
        try {
          if (runningProcesses.has(run.id) || activeRunExecutions.has(run.id)) continue;
          const successors = await db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.retryOfRunId, run.id))
            .limit(1);
          if (successors.length > 0) continue;
          const agent = await getAgent(run.agentId);
          if (!agent) continue;
          const retriedRun = await enqueueProcessLossRetry(retryEnqueueDeps, run, agent, now);
          if (retriedRun) {
            await setWakeupStatus(run.wakeupRequestId, "failed", {
              finishedAt: now,
              error: run.error ?? "shutdown_interrupted recovered by backstop",
            });
            await appendRunEvent(run, await nextRunEventSeq(run.id), {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: `Recovered shutdown-interrupted run; queued retry ${retriedRun.id}`,
              payload: { retryRunId: retriedRun.id },
            });
            reaped.push(run.id);
          }
        } catch (err) {
          logger.warn({ err, runId: run.id }, "failed to recover shutdown-interrupted run; continuing sweep");
        }
      }
    } catch (err) {
      logger.warn({ err }, "shutdown-interrupted backstop scan failed; continuing sweep");
    }

    if (queuedStaleThresholdMs > 0) {
      const recoverQueuedStaleWork = createHeartbeatQueuedStaleRecovery({
        db,
        activeExecutionTimeoutMs,
        withAgentStartLock,
        startNextQueuedRunForAgent,
        countActiveRunsForAgent: countRunningRunsForAgent,
        maxConcurrentRuns: agent => parseHeartbeatPolicy(agent).maxConcurrentRuns,
        hasActiveExecution: runId => activeRunExecutions.has(runId),
        hasLiveTrackedChild: runId => {
          const child = runningProcesses.get(runId)?.child;
          return Boolean(child && child.exitCode === null && child.signalCode === null && isProcessAlive(child.pid));
        },
        resolveActiveExecutionTimeoutMs: resolveRunActiveExecutionTimeoutMs,
        setRunStatus: setHeartbeatRunStatus,
        publishRunStatus: run => publishHeartbeatRunStatus(publishLiveEvent, run),
        nextRunEventSeq,
        appendRunEvent,
        releaseIssueExecutionAndPromote,
        getRun,
        settleHeartbeatAfterExecution,
        finalizeAgentStatus,
        recordQueueTransitionEvent,
      });
      const queuedRecovery = await recoverQueuedStaleWork(queuedStaleThresholdMs);
      reaped.push(...queuedRecovery.reapedRunIds);
    }

    const continuationCursor = terminalContinuationScanCursor;
    const continuationPredicate = continuationCursor
      ? and(eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_EVENT_TYPE), or(
          gt(workflowTransitionEvents.createdAt, sql`${continuationCursor.createdAt}::timestamptz`),
          and(eq(workflowTransitionEvents.createdAt, sql`${continuationCursor.createdAt}::timestamptz`),
            gt(workflowTransitionEvents.id, continuationCursor.id)),
        ))
      : eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_EVENT_TYPE);
    const continuationRows = await db.select({ id: workflowTransitionEvents.id, createdAt: sql<string>`${workflowTransitionEvents.createdAt}::text` })
      .from(workflowTransitionEvents).where(continuationPredicate)
      .orderBy(asc(workflowTransitionEvents.createdAt), asc(workflowTransitionEvents.id)).limit(50);
    if (continuationRows.length === 0) {
      terminalContinuationScanCursor = null;
    } else {
      const last = continuationRows[continuationRows.length - 1]!;
      terminalContinuationScanCursor = { createdAt: last.createdAt, id: last.id };
      for (const row of continuationRows) {
        if (terminalContinuationInflight.has(row.id)) continue;
        const manifest = await readTerminalReleaseManifest(db, row.id);
        if (manifest.kind !== "found") {
          logger.warn({ continuationEventId: row.id, reason: manifest.reason },
            "terminal release reaper left malformed continuation held");
          continue;
        }
        const execution = runTerminalReleaseContinuation(row.id).then(result => {
          if (result.kind === "held") logger.warn({ continuationEventId: row.id, reason: result.reason },
            "terminal release reaper left continuation pending");
        }).catch(error => {
          logger.warn({ err: error, continuationEventId: row.id },
            "terminal release reaper continuation failed; durable obligation remains pending");
        });
        trackHeartbeatExecution(db, execution);
      }
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  async function finalizeLinkedRunsForIssueStatus(input: {
    issueId: string;
    companyId: string;
    status: string;
    linkedRunIds?: Array<string | null | undefined>;
  }) {
    // [run honesty] issue→blocked 로 진행 중 런이 잘리는 것은 통제판 결정이지 에이전트/어댑트 결함이
    //   아니다(2026-08-19 GAZ 실측: 오너 종결 진행 중이던 리뷰 런이 failed+issue_status_blocked 로
    //   기록되어 모니터링을 오염했고, finalizeAgentStatus("failed") 가 에이전트를 error 로 마킹해
    //   오너의 재할당 판단까지 흔들었다). cancelled + errorCode 유지로 사유는 구분 가능하게 둔다.
    const issueTerminalStatus = input.status === "done"
      ? "succeeded"
      : input.status === "cancelled"
        ? "cancelled"
        : input.status === "blocked"
          ? "cancelled"
          : null;
    if (!issueTerminalStatus) {
      return { finalized: 0, runIds: [] as string[] };
    }

    const explicitRunIds = [
      ...(input.linkedRunIds ?? []),
    ].filter((runId): runId is string => typeof runId === "string" && runId.length > 0);
    const linkedRunCondition = explicitRunIds.length > 0
      ? or(eq(heartbeatRuns.issueId, input.issueId), inArray(heartbeatRuns.id, [...new Set(explicitRunIds)]))
      : eq(heartbeatRuns.issueId, input.issueId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        linkedRunCondition,
      ));

    const finalizedRunIds: string[] = [];
    const now = new Date();
    for (const run of runs) {
      const trackedProcess = runningProcesses.get(run.id) ?? null;
      if (trackedProcess) {
        trackedProcess.child.kill("SIGTERM");
        setTimeout(() => {
          if (!trackedProcess.child.killed) {
            trackedProcess.child.kill("SIGKILL");
          }
        }, Math.max(1, trackedProcess.graceSec) * 1000);
        runningProcesses.delete(run.id);
      } else if (terminateRecordedProcess(run.processPid, "SIGTERM")) {
        setTimeout(() => {
          terminateRecordedProcess(run.processPid, "SIGKILL");
        }, 5_000);
      }

      const errorCode = input.status === "done"
        ? null
        : input.status === "cancelled"
          ? "cancelled"
          : "issue_status_blocked";
      const error = input.status === "done"
        ? null
        : input.status === "cancelled"
          ? "Issue cancelled while linked run was active; terminalized by control plane"
          : "Issue blocked while linked run was active; terminalized by control plane";

      const updated = await db
        .update(heartbeatRuns)
        .set({
          status: issueTerminalStatus,
          error,
          errorCode,
          finishedAt: now,
          updatedAt: new Date(),
        })
        .where(and(eq(heartbeatRuns.id, run.id), inArray(heartbeatRuns.status, ["queued", "running"])))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) continue;
      await recordHeartbeatTerminalOutcomeShadow(db, updated);

      publishLiveEvent({
        companyId: updated.companyId,
        type: "heartbeat.run.status",
        payload: {
          runId: updated.id,
          agentId: updated.agentId,
          status: updated.status,
          invocationSource: updated.invocationSource,
          triggerDetail: updated.triggerDetail,
          error: updated.error ?? null,
          errorCode: updated.errorCode ?? null,
          startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
          finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
        },
      });
      await recordHeartbeatRunTerminalTransitionEvent(db, updated);
      await maybeRecordTerminalFinalization(db, updated, now);
      await setWakeupStatus(updated.wakeupRequestId, issueTerminalStatus === "succeeded" ? "completed" : issueTerminalStatus, {
        finishedAt: now,
        error,
      });
      await releaseRuntimeServicesForRun(updated.id).catch(() => undefined);
      activeRunExecutions.delete(updated.id);
      await finalizeAgentStatus(updated.agentId, issueTerminalStatus);
      await startNextQueuedRunForAgent(updated.agentId);
      finalizedRunIds.push(updated.id);
    }

    if (finalizedRunIds.length > 0) {
      logger.info(
        { issueId: input.issueId, status: input.status, runIds: finalizedRunIds },
        "terminalized active heartbeat runs after issue status transition",
      );
    }

    return { finalized: finalizedRunIds.length, runIds: finalizedRunIds };
  }
  // [mission-runtime busy 고착 회수기 wrapper] 코어 스윕은 mission-runtime-manager 참조.
  // 여기서는 (a) 회수된 이슈 웨이크업 재요청, (b) 위키 패턴 기록(비차단), (c) 로그만 담당한다.
  async function reapStaleBusyMissionRuntimes(opts?: {
    graceMs?: number;
    now?: Date;
  }): Promise<{ reaped: number; skippedActiveRun: number; skippedTerminalMission: number; casLost: number }> {
    const summary = await reapStaleBusyMissionRuntimesCore(db, {
      ...(opts?.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
      ...(opts?.now ? { now: opts.now } : {}),
      onReaped: async (reaped) => {
        try {
          await enqueueWakeup(reaped.agentId, {
            source: "automation",
            contextSnapshot: { issueId: reaped.issueId ?? undefined },
            reason: "retry_stale_busy_runtime",
          });
        } catch (err) {
          logger.warn({ err, agentId: reaped.agentId, issueId: reaped.issueId }, "busy reaper: wakeup re-request failed");
        }
        fireWikiRecord(wikiSvc, {
          companyId: reaped.companyId,
          agentId: reaped.agentId,
          missionId: reaped.missionId,
          pattern: "mission 런타임 busy 고착 (백킹 런 없음)",
          cause: "beginMissionAgentRuntimeRun이 busy로 표시한 뒤 completeMissionAgentRuntimeRun 완료 처리가 누락되어(서버 크래시 타이밍 등) 런타임이 새 이슈를 받지 못함.",
          solution: "recovery lane 회수기가 busy→idle 전환(CAS)하고 끊긴 이슈 웨이크업을 재요청했다. 재발 시 완료 처리 누락 경로(런 종료 처리 예외)를 추적할 것.",
          errorCode: "stale_busy_runtime_reaped",
        }, reaped.runtimeId);
      },
    });
    if (summary.reaped.length > 0) {
      logger.warn(
        { reaped: summary.reaped.map((entry) => ({ runtimeId: entry.runtimeId, agentId: entry.agentId, issueId: entry.issueId })),
          skippedActiveRun: summary.skippedActiveRun, casLost: summary.casLost },
        "mission runtime stale-busy reaper recovered runtimes",
      );
    }
    return {
      reaped: summary.reaped.length,
      skippedActiveRun: summary.skippedActiveRun,
      skippedTerminalMission: summary.skippedTerminalMission,
      casLost: summary.casLost,
    };
  }
  // [issue 실행잠금 고착 회수기] terminal 실패 run 을 여전히 execution lock(checkout/execution
  // run)으로 가리키는 in_progress 이슈를 표준 실패 경로로 회수한다. 부실 assignment wakeup
  // (이슈 미연결)으로 발사된 run 안에서 이슈가 checkout 되고 process_lost 재시도 chain 이
  // linkage 없이 죽으면, 기존 release 경로는 "내 run id 와 연결된 이슈"만 찾으므로 이슈도
  // 스텝도 아무도 종결하지 못한다(tts 스톨 사고 2026-09-03, 미션 ac97255c). 살아있는 후계
  // 런(retry/fallback/issue-linked)이 없을 때만 발동하고, 실제 상태 전환은 기존
  // releaseIssueExecutionAndPromote 표준 경로(이슈 blocked + 실패 comment + 감사로그 +
  // 워크플로 스텝 failed 전파)가 담당한다.
  async function reapStalledIssueExecutionLocks(opts?: {
    limit?: number;
  }): Promise<{
    reaped: number;
    skippedLiveLock: number;
    skippedLiveSuccessor: number;
    skippedLiveIssueRun: number;
    skipped: number;
  }> {
    const limit = opts?.limit ?? 100;
    const terminalFailureStatuses = ["failed", "timed_out", "cancelled"];
    const liveStatuses = ["queued", "running"];
    let reaped = 0;
    let skippedLiveLock = 0;
    let skippedLiveSuccessor = 0;
    let skippedLiveIssueRun = 0;
    let skipped = 0;

    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.status, "in_progress"),
          or(isNotNull(issues.executionRunId), isNotNull(issues.checkoutRunId)),
        ),
      )
      .limit(limit);

    for (const issue of candidates) {
      try {
        const lockRunIds = Array.from(
          new Set([issue.executionRunId, issue.checkoutRunId].filter(
            (runId): runId is string => Boolean(runId),
          )),
        );
        if (lockRunIds.length === 0) continue;
        const lockRuns = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, lockRunIds));
        if (lockRuns.length !== lockRunIds.length) {
          // dangling lock(참조 run 없음)은 다른 계열 — 여기서 건드리지 않는다.
          skipped++;
          continue;
        }
        const lockRunById = new Map(lockRuns.map((run) => [run.id, run]));
        // guard 1: 모든 lock 참조가 terminal 실패 상태여야 한다(하나라도 live/succeeded 면 skip).
        if (lockRuns.some((run) => !terminalFailureStatuses.includes(run.status))) {
          skippedLiveLock++;
          continue;
        }
        // guard 2: 후계 retry/fallback 런이 살아있으면 skip(재시도 chain 이 작업을 이어받는 중).
        const liveSuccessors = await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              inArray(heartbeatRuns.retryOfRunId, lockRunIds),
              inArray(heartbeatRuns.status, liveStatuses),
            ),
          )
          .limit(1);
        if (liveSuccessors.length > 0) {
          skippedLiveSuccessor++;
          continue;
        }
        // guard 3: 이슈에 연결된 살아있는 run 이 있으면 skip(엔진이 인지한 실행 채택 중).
        const liveIssueRuns = await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.issueId, issue.id),
              inArray(heartbeatRuns.status, liveStatuses),
            ),
          )
          .limit(1);
        if (liveIssueRuns.length > 0) {
          skippedLiveIssueRun++;
          continue;
        }
        const holderRun = lockRunById.get(issue.executionRunId ?? "") ?? lockRunById.get(issue.checkoutRunId ?? "");
        if (!holderRun) {
          skipped++;
          continue;
        }
        // 표준 차단 분기(terminal_run_failure)는 assignee 일치를 요구한다.
        if (issue.assigneeAgentId !== holderRun.agentId) {
          skipped++;
          continue;
        }
        await releaseIssueExecutionAndPromote(holderRun, { skipLocked: true });
        const [after] = await db
          .select({
            status: issues.status,
            checkoutRunId: issues.checkoutRunId,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .where(eq(issues.id, issue.id))
          .limit(1);
        const transitioned = after !== undefined && (
          after.status !== "in_progress" ||
          after.checkoutRunId !== issue.checkoutRunId ||
          after.executionRunId !== issue.executionRunId
        );
        if (transitioned) {
          reaped++;
          // [스텝 전파] 이슈가 blocked 로 전환됐으면 연결 워크플로 스텝도 즉시 failed 로
          // 전파한다(표준 post-tx 동기화와 동일 호출). 실패해도 회수 자체는 유지한다.
          try {
            const { workflowService } = await import("./workflow/engine.js");
            await workflowService.syncRunStatusForIssue(db, issue.id, "heartbeat_promotion");
          } catch (err) {
            logger.warn({ err, issueId: issue.id }, "issue execution lock reaper: workflow sync after recovery failed");
          }
          logger.warn(
            {
              issueId: issue.id,
              holderRunId: holderRun.id,
              holderStatus: holderRun.status,
              holderErrorCode: holderRun.errorCode,
              nextStatus: after?.status,
            },
            "issue execution lock reaper recovered stalled issue via standard failure path",
          );
        } else {
          skipped++;
        }
      } catch (err) {
        // per-issue isolation: 한 이슈 회수 실패가 스윕 전체를 멈추지 않게 한다.
        logger.warn({ err, issueId: issue.id }, "issue execution lock reaper: per-issue failure; continuing sweep");
        skipped++;
      }
    }

    return { reaped, skippedLiveLock, skippedLiveSuccessor, skippedLiveIssueRun, skipped };
  }
  async function resumeQueuedRuns(agentId?: string) {
    for (const targetAgentId of agentId ? [agentId] : await selectQueuedAgentIds(db)) {
      await startNextQueuedRunForAgent(targetAgentId);
    }
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
    normalizedUsage?: UsageTotals | null,
  ) {
    await ensureRuntimeState(agent);
    const usage = normalizedUsage ?? normalizeUsageTotals(result.usage);
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const billingType = normalizeLedgerBillingType(result.billingType);
    const additionalCostCents = normalizeBilledCostCents(result.costUsd, billingType);
    const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
    const provider = result.provider ?? "unknown";
    const biller = resolveLedgerBiller(result);
    const ledgerScope = await resolveLedgerScopeForRun(db, agent.companyId, run);

    await db
      .update(agentRuntimeState)
      .set({
        adapterType: agent.adapterType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError: result.errorMessage ?? null,
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
        totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
        totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeState.agentId, agent.id));

    if (additionalCostCents > 0 || hasTokenUsage) {
      const costs = costService(db, budgetHooks);
      await costs.createEvent(agent.companyId, {
        heartbeatRunId: run.id,
        agentId: agent.id,
        issueId: ledgerScope.issueId,
        projectId: ledgerScope.projectId,
        provider,
        biller,
        billingType,
        model: result.model ?? "unknown",
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costCents: additionalCostCents,
        occurredAt: new Date(),
      });
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    const c5QueueOptIn = Boolean(c5OwnerRuntime);
    const c5Notifications = c5QueueOptIn ? createReplacementRootNotifications() : null;
    const claimedRuns = await withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
        return [];
      }
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
      if (availableSlots <= 0) return [];

      const queuedSnapshot = c5QueueOptIn
        ? await db.select().from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
          .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
        : null;
      const claimedRuns = await claimAvailableHeartbeatRuns({
        c5QueueOptIn,
        select: (slots, attempted) => queuedSnapshot
          ? Promise.resolve(queuedSnapshot.filter(run => !attempted.includes(run.id)).slice(0, slots))
          : db.select().from(heartbeatRuns)
            .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued"),
              attempted.length ? not(inArray(heartbeatRuns.id, attempted)) : undefined))
            .orderBy(asc(heartbeatRuns.createdAt)).limit(slots),
        claim: run => claimQueuedRun(run, c5Notifications ?? undefined),
        promote: slots => promoteQueuedWakeupRequestsForAgent(followupQueueDeps, agent, slots),
        publish: publishQueuedRun,
      }, availableSlots);

      for (const claimedRun of claimedRuns) {
        const execution = executeRun(claimedRun.id).catch((err) => {
          logger.error({ err, runId: claimedRun.id }, "queued heartbeat execution failed");
        });
        trackHeartbeatExecution(db, execution);
      }
      return claimedRuns;
    });
    if (c5Notifications) await drainC5RootNotifications(c5Notifications);
    return claimedRuns;
  }

  const followupPromotionDeps: HeartbeatFollowupPromotionDeps = {
    deferredWakeContextKey: DEFERRED_WAKE_CONTEXT_KEY,
    issueRunStartStatuses: ISSUE_RUN_START_STATUSES,
    enrichWakeContextSnapshot,
    resolveSessionBeforeForWakeup,
  };
  const followupQueueDeps: HeartbeatFollowupQueueDeps = {
    db,
    deferredWakeContextKey: DEFERRED_WAKE_CONTEXT_KEY,
    promotedRejectIssueStatuses: PROMOTED_REJECT_ISSUE_STATUSES,
    enrichWakeContextSnapshot,
    isWorkflowStepResumeWake,
    getInvocationBlock: budgets.getInvocationBlock,
    promote: (tx, input) => promoteQueuedWakeupRequest(followupPromotionDeps, tx, input),
    promoteDeferredOwner: (agent, limit) => promoteStoredDeferredWakes(db, followupPromotionDeps, agent, limit, isWorkflowStepResumeWake),
    deliverCorrection: connectCorrectionDelivery,
  };

  // Stored requests carry a server proof and reserved context; neither is caller payload.
  async function connectCorrectionDelivery(candidate: CorrectionDeliveryInput | { wakeupRequestId: string },
    transactionProfile: "public_callback" | "recovery_skip_locked"):
    Promise<{ kind: CorrectionDeliveryResult["kind"] | "nested_pending"; run: typeof heartbeatRuns.$inferSelect | null }> {
    let input: CorrectionDeliveryInput;
    if ("wakeupRequestId" in candidate) {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, candidate.wakeupRequestId));
      requireDelivery(wake, "candidate");
      const ref = readQaCorrectionWakeRef(wake);
      const clean = withoutWorkflowAttemptProof(wake.payload) ?? {};
      const saved = clean[DEFERRED_WAKE_CONTEXT_KEY];
      requireDelivery(ref && saved && typeof saved === "object" && !Array.isArray(saved), "context");
      delete clean[DEFERRED_WAKE_CONTEXT_KEY];
      const contextSnapshot = saved as Record<string, unknown>;
      const deferredReason = (wake.status === "deferred_issue_execution" && wake.runId === null
        && wake.reason === "issue_execution_deferred") || (wake.runId !== null && wake.reason === "issue_execution_promoted");
      requireDelivery(wake.issueId && wake.missionId && wake.workflowRunId && wake.workflowStepRunId
        && wake.workflowExecutionGeneration !== null, "scope");
      input = { mode: wake.status === "deferred_issue_execution" ? "deferred" : "queued", ref,
        companyId: wake.companyId, agentId: wake.agentId, issueId: wake.issueId, missionId: wake.missionId,
        workflowRunId: wake.workflowRunId, workflowStepRunId: wake.workflowStepRunId,
        workflowExecutionGeneration: wake.workflowExecutionGeneration, candidateWakeupRequestId: wake.id,
        request: { idempotencyKey: wake.idempotencyKey!, source: wake.source, triggerDetail: wake.triggerDetail,
          reason: deferredReason ? contextSnapshot.wakeReason as string | null : wake.reason,
          requestKind: wake.requestKind, requestedByActorType: wake.requestedByActorType,
          requestedByActorId: wake.requestedByActorId, payload: clean, contextSnapshot } };
    } else input = candidate;
    assertDeliveryInput(input);
    if (is(db, PgTransaction)) {
      await validateAndRegisterQaCorrectionRootDrain(db, input);
      return { kind: "nested_pending", run: null };
    }
    const r = input.request, contextSnapshot = r.contextSnapshot, taskKey = deriveTaskKey(contextSnapshot, r.payload);
    const mention = r.reason === "issue_comment_mentioned" || contextSnapshot.wakeReason === "issue_comment_mentioned";
    const result = await withCorrectionDeliveryRoot(db, input, async (tx, wake) => {
      const [currentAgent] = await tx.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
      requireDelivery(currentAgent && issue, "scope");
      if (input.mode === "deferred") return promoteDeferredWakeupRequest(followupPromotionDeps, tx, { deferred: wake, deferredAgent: currentAgent, issue });
      const isWorkflowStepResume = isWorkflowStepResumeWake({ ...r, contextSnapshot });
      if (input.mode === "initial") {
        const sessionBefore = await resolveSessionBeforeForWakeup(
          currentAgent, mention ? `mission:${input.missionId}` : taskKey, { missionId: input.missionId },
        );
        return insertInitialWakeupRun(followupPromotionDeps, tx, {
          agent: currentAgent, request: wake, contextSnapshot, taskKey, sessionBefore,
          issue: mention ? null : issue, isWorkflowStepResume,
        });
      }
      return promoteQueuedWakeupRequest(followupPromotionDeps, tx, {
        agent: currentAgent, request: wake, promotedContextSnapshot: contextSnapshot,
        promotedSource: wake.source as WakeupOptions["source"], promotedTriggerDetail: wake.triggerDetail,
        promotedIssueId: issue.id, promotedTaskKey: taskKey, missionIdForWake: input.missionId, promotedIssue: issue,
        isWorkflowStepResume, isPlanReworkPromotion: r.reason === "mission_owner_plan_rework_requested" && issue.originKind === "mission_main_executor_plan",
      });
    }, { transactionProfile });
    if (result.kind === "waiting") return { kind: result.kind, run: null };
    const run = await getRun(result.heartbeatRunId);
    requireDelivery(run && run.wakeupRequestId === result.wakeupRequestId && run.companyId === input.companyId
      && run.agentId === input.agentId && (result.kind !== "new_delivery" || result.startRunId === run.id), "writer_link");
    return { kind: result.kind, run };
  }

  async function isCorrectionRun(execDb: Db, run: typeof heartbeatRuns.$inferSelect) {
    if (!run.wakeupRequestId) return false;
    const [wake] = await execDb.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId));
    return !!wake && !!readQaCorrectionWakeRef(wake);
  }

  async function deliverStoredQaCorrectionWake(wakeupRequestId: string,
    transactionProfile: "public_callback" | "recovery_skip_locked", resumeQueue: boolean) {
    const result = await connectCorrectionDelivery({ wakeupRequestId }, transactionProfile);
    if (result.kind !== "new_delivery" || !result.run) return;
    publishQueuedRun(result.run);
    if (resumeQueue) await startNextQueuedRunForAgent(result.run.agentId);
  }

  async function drainC5RootNotifications(notifications: ReplacementRootNotifications) {
    for (const wakeupRequestId of [...notifications.correctionWakeupRequestIds].sort()) {
      try { await deliverStoredQaCorrectionWake(wakeupRequestId, "public_callback", true); }
      catch (error) {
        logger.warn({ err: error, wakeupRequestId }, "committed C5 correction wake notification remains undrained");
      }
    }
    for (const agentId of [...notifications.agentIds].sort()) {
      try { await resumeQueuedRuns(agentId); }
      catch (error) { logger.warn({ err: error, agentId }, "committed C5 queue notification remains undrained"); }
    }
  }

  function publishQueuedRun(run: typeof heartbeatRuns.$inferSelect) {
    publishLiveEvent({
      companyId: run.companyId, type: "heartbeat.run.queued",
      payload: { runId: run.id, agentId: run.agentId, invocationSource: run.invocationSource,
        triggerDetail: run.triggerDetail, wakeupRequestId: run.wakeupRequestId },
    });
  }

  async function executeRun(runId: string) {
    let run = await getRun(runId);
    if (!run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    if (run.status === "queued") {
      const claimNotifications = c5OwnerRuntime ? createReplacementRootNotifications() : null;
      const outcome = await claimQueuedRun(run, claimNotifications ?? undefined);
      if (outcome.kind !== "claimed") return;
      run = outcome.run;
      // executeRun's queued path is outside the agent-start lock; the claim root has
      // returned only after its native owner closed, so reentry cannot await itself.
      if (claimNotifications) await drainC5RootNotifications(claimNotifications);
    }

    activeRunExecutions.add(run.id);
    const executionFrames = activeHeartbeatExecutionFrames(db);
    const previousExecutionFrame = executionFrames.get(run.id);
    const executionFrame: ActiveHeartbeatExecutionFrame = {
      run,
      finalizationVersion: run.finalizationVersion ?? null,
      adapterInvocationAttempted: false,
      actualCaptured: false,
      identityObserved: false,
      actualDrainIdentity: null,
      noActualInvocationConfirmed: false,
      c5ExecutionOptedIn: c5OwnerRuntime !== undefined,
      c5NotInvoked: null,
      c5TerminalWriterSnapshot: null,
      ownerReleaseBlocked: false,
      conflicted: Boolean(previousExecutionFrame),
    };
    if (previousExecutionFrame) previousExecutionFrame.conflicted = true;
    executionFrames.set(run.id, executionFrame);
    const removeExecutionFrame = () => {
      if (executionFrames.get(run.id) === executionFrame) executionFrames.delete(run.id);
      if (executionFrames.size === 0) activeHeartbeatExecutionFramesByDb.delete(db);
    };
    const pauseExecution = createPauseExecutionObservation();
    const actualObservation = createHeartbeatActualObservation<AdapterExecutionResult>();
    let adapterStartIdentity: Parameters<typeof createHeartbeatAdapterScope>[1] | null = null;
    let adapterStartScope: RuntimeExecutionScope | null = null;
    let unstartedShutdownDeferral = false;
    let c5RootNotifications: ReplacementRootNotifications | null = null;
    let c5RootSettlementConfirmed = false;
    let c5AdmissionEntered = false;
    let c5RefusalConfirmed = false;
    const cleanupObservation = { releaseCalled: false, releaseSucceeded: false,
      settlementCalled: false, settlementSucceeded: false };
    let actualDrainIdentity: HeartbeatActualDrainIdentity | null = null;
    let actualEvidencePreserved = true;
    let terminalReleaseOptedIn = false;
    let terminalContinuationEventId: string | null = null;
    let unresolvedTerminalReleaseHoldReason: string | null = null;
    const holdOwnerRelease = (reason: string) => {
      executionFrame.ownerReleaseBlocked = true;
      unresolvedTerminalReleaseHoldReason = reason;
      return { kind: "held" as const, reason };
    };
    const deferOwnerRelease = (reason: string) => {
      executionFrame.ownerReleaseBlocked = true;
      return { kind: "deferred" as const, reason };
    };
    const releaseC5HeldIssueOwner = async (finished: typeof heartbeatRuns.$inferSelect) => {
      const held = executionFrame.c5NotInvoked;
      const writerSnapshot = executionFrame.c5TerminalWriterSnapshot;
      if (!held || !writerSnapshot || finished !== writerSnapshot) return false;
      return db.transaction(async tx => {
        const [current] = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, finished.id), eq(heartbeatRuns.companyId, finished.companyId),
        )).for("no key update");
        if (!current || !sameHeartbeatExecutionAttempt(executionFrame.run, current)
          || current.status !== "failed" || current.errorCode !== "c5_held_not_invoked"
          || !executionFrame.c5ExecutionOptedIn || executionFrame.conflicted
          || executionFrame.adapterInvocationAttempted || executionFrame.actualCaptured
          || actualObservation.wasInvoked() || executionFrame.c5NotInvoked?.proof !== held.proof
          || executionFrame.run.status !== "running" || writerSnapshot.status !== "failed"
          || writerSnapshot.errorCode !== "c5_held_not_invoked"
          || writerSnapshot.finalizationVersion !== executionFrame.finalizationVersion
          || !sameHeartbeatExecutionAttempt(executionFrame.run, writerSnapshot)) return false;

        let proofBinding: ReturnType<typeof readC5NotInvokedProof>;
        let writerIdentity: QaCorrectionExecutionIdentity;
        let currentIdentity: QaCorrectionExecutionIdentity;
        try {
          proofBinding = readC5NotInvokedProof(held.proof, db, held.identity, "adapter_start");
          writerIdentity = captureQaCorrectionExecutionIdentity(writerSnapshot);
          currentIdentity = captureQaCorrectionExecutionIdentity(current);
        } catch {
          return false;
        }
        if (!isDeepStrictEqual(proofBinding.identity, held.identity)
          || !isDeepStrictEqual(held.identity, writerIdentity)) return false;

        if (current.finalizationVersion === 1) {
          const source = "heartbeat_status:failed:c5_held_not_invoked";
          if (executionFrame.finalizationVersion !== 1 || writerSnapshot.finalizationVersion !== 1
            || held.identity.executorOwnerReleasedAt !== null || writerSnapshot.executorOwnerReleasedAt !== null
            || !sameC5ExecutionIdentityBeforeOwnerRelease(held.identity, currentIdentity)
            || current.terminalOutcome !== "failed" || current.terminalDecisionSource !== source
            || !(current.terminalDecidedAt instanceof Date) || !Number.isFinite(current.terminalDecidedAt.getTime())) {
            return false;
          }
          const terminalEvents = await tx.select().from(workflowTransitionEvents).where(and(
            eq(workflowTransitionEvents.companyId, current.companyId),
            eq(workflowTransitionEvents.idempotencyKey, "terminal-outcome:" + current.id),
          ));
          if (terminalEvents.length !== 1) return false;
          const [event] = terminalEvents;
          if (!event || event.workflowRunId !== null || event.companyId !== current.companyId
            || event.workflowStepRunId !== current.workflowStepRunId || event.issueId !== current.issueId
            || event.wakeupRequestId !== current.wakeupRequestId || event.heartbeatRunId !== current.id
            || event.executionGeneration !== current.workflowExecutionGeneration
            || event.executorOwnerId !== current.executorOwnerId
            || event.eventType !== "workflow_authority_transition" || event.layer !== "workflow_authority"
            || event.decision !== "shadow_write" || event.reason !== "terminal_outcome_decided"
            || event.reasonCode !== "terminal_outcome_decided"
            || event.idempotencyKey !== "terminal-outcome:" + current.id
            || !isDeepStrictEqual(event.payload, {
              version: 1,
              transition: "terminal_outcome_decided",
              executionEpoch: current.executionEpoch,
              executionToken: current.executionToken,
              ownerLeaseEpoch: current.executorOwnerLeaseEpoch,
              ownerLeaseToken: current.executorOwnerLeaseToken,
              outcome: "failed",
              source,
            })) return false;
        } else if (current.finalizationVersion !== executionFrame.finalizationVersion
          || writerSnapshot.finalizationVersion !== executionFrame.finalizationVersion
          || !isDeepStrictEqual(held.identity, currentIdentity)) {
          return false;
        }
        if (!current.issueId) return true;
        const [issue] = await tx.select().from(issues).where(and(
          eq(issues.id, current.issueId), eq(issues.companyId, current.companyId),
        )).for("update");
        if (!issue || issue.assigneeAgentId !== current.agentId
          || (issue.executionRunId !== current.id && issue.checkoutRunId !== current.id)
          || (issue.executionRunId !== null && issue.executionRunId !== current.id)
          || (issue.checkoutRunId !== null && issue.checkoutRunId !== current.id)) return false;
        const ownerConditions = [
          eq(issues.id, issue.id), eq(issues.companyId, issue.companyId), eq(issues.assigneeAgentId, current.agentId),
          issue.executionRunId === null ? isNull(issues.executionRunId) : eq(issues.executionRunId, current.id),
          issue.checkoutRunId === null ? isNull(issues.checkoutRunId) : eq(issues.checkoutRunId, current.id),
        ];
        const released = await tx.update(issues).set({
          executionRunId: null, checkoutRunId: null, executionAgentNameKey: null,
          executionLockedAt: null, updatedAt: new Date(),
        }).where(and(...ownerConditions)).returning({ id: issues.id });
        return released.length === 1;
      });
    };
    const releaseFinishedRun = async (finished: typeof heartbeatRuns.$inferSelect): Promise<
      { kind: "legacy" | "terminal" | "deferred" | "held"; reason?: string }
    > => {
      const actual = await actualObservation.awaitSettled();
      let current: typeof heartbeatRuns.$inferSelect | null = null;
      try {
        current = await getRun(finished.id);
      } catch (error) {
        logger.warn({ err: error, runId: finished.id }, "finished heartbeat identity could not be reread");
      }
      const expectsV1 = executionFrame.finalizationVersion === 1 || finished.finalizationVersion === 1
        || current?.finalizationVersion === 1;
      const hasCapturedTerminalWriter = Boolean(actual && actualDrainIdentity);
      if (!current && (expectsV1 || hasCapturedTerminalWriter)) {
        return holdOwnerRelease("durable_attempt_unreadable");
      }
      if (current && !sameHeartbeatExecutionAttempt(finished, current)
        && (expectsV1 || actualDrainIdentity || hasCapturedTerminalWriter)) {
        return holdOwnerRelease("durable_attempt_mismatch");
      }
      if ((expectsV1 || actualDrainIdentity || hasCapturedTerminalWriter) && executionFrame.conflicted) {
        return holdOwnerRelease("active_execution_frame_conflicted");
      }
      if (executionFrame.c5NotInvoked) {
        const held = executionFrame.c5NotInvoked;
        const writerSnapshot = executionFrame.c5TerminalWriterSnapshot;
        let writerIdentityMatches = false;
        try {
          writerIdentityMatches = !!writerSnapshot
            && isDeepStrictEqual(held.identity, captureQaCorrectionExecutionIdentity(writerSnapshot));
        } catch {
          writerIdentityMatches = false;
        }
        if (!executionFrame.c5ExecutionOptedIn || executionFrame.conflicted || actual
          || executionFrame.adapterInvocationAttempted || executionFrame.actualCaptured
          || actualObservation.wasInvoked() || !writerSnapshot || finished !== writerSnapshot
          || executionFrame.run.status !== "running" || writerSnapshot.status !== "failed"
          || writerSnapshot.errorCode !== "c5_held_not_invoked"
          || writerSnapshot.finalizationVersion !== executionFrame.finalizationVersion
          || !sameHeartbeatExecutionAttempt(executionFrame.run, writerSnapshot)
          || !writerIdentityMatches || !current || !sameHeartbeatExecutionAttempt(executionFrame.run, current)) {
          return holdOwnerRelease("c5_not_invoked_closure_unproven");
        }
        if (!await releaseC5HeldIssueOwner(finished)) return holdOwnerRelease("c5_issue_owner_release_unproven");
        executionFrame.noActualInvocationConfirmed = true;
        return { kind: "legacy" };
      }
      if (executionFrame.c5ExecutionOptedIn && !c5RefusalConfirmed && !actual && !executionFrame.adapterInvocationAttempted) {
        return holdOwnerRelease("adapter_start_outcome_unproven");
      }
      const positivelyNonworkflow = expectsV1 && current
        ? await positivelyClassifiesNonworkflowV1(finished, current, executionFrame).catch(() => false)
        : false;
      if (actual && actualDrainIdentity) {
        if (!sameHeartbeatExecutionAttempt(executionFrame.run, finished)
          || !heartbeatActualIdentityMatchesRun(actualDrainIdentity, finished)) {
          return holdOwnerRelease("frozen_actual_run_mismatch");
        }
        executionFrame.actualCaptured = true;
        executionFrame.actualDrainIdentity = actualDrainIdentity;
        terminalReleaseOptedIn = true;
        try {
          const release = await releaseIssueExecutionAndPromote(finished, { terminalSource: actualDrainIdentity });
          if (release?.kind === "release_committed_followup_pending") {
            terminalContinuationEventId = release.continuationEventId;
            unresolvedTerminalReleaseHoldReason = null;
          } else {
            const reason = release?.reason ?? "release_result_missing";
            logger.warn({ runId: finished.id, reason },
              "terminal heartbeat issue release remains unproven; actual drain receipt is withheld");
            return holdOwnerRelease(reason);
          }
        } catch (error) {
          logger.warn({ err: error, runId: finished.id },
            "terminal heartbeat issue release remains unproven; actual drain receipt is withheld");
          return holdOwnerRelease("terminal_issue_release_failed");
        }
        return { kind: "terminal" };
      }
      if (expectsV1 && executionFrame.adapterInvocationAttempted && !positivelyNonworkflow) {
        return holdOwnerRelease("terminal_actual_or_workflow_identity_unobserved");
      }
      if (!actual && !executionFrame.adapterInvocationAttempted) {
        if (expectsV1 && !positivelyNonworkflow
          && (!executionFrame.identityObserved || !actualDrainIdentity)) {
          return holdOwnerRelease("terminal_identity_missing_before_actual");
        }
        if (expectsV1 && !positivelyNonworkflow && actualDrainIdentity
          && !heartbeatActualIdentityMatchesRun(actualDrainIdentity, finished)) {
          return holdOwnerRelease("terminal_identity_attempt_mismatch_before_actual");
        }
        executionFrame.noActualInvocationConfirmed = true;
      }
      if (!actualDrainIdentity || !actual) {
        const release = await releaseIssueExecutionAndPromote(finished);
        if (release && "kind" in release) {
          if (release.kind === "release_deferred") return deferOwnerRelease(release.reason);
          if (release.kind === "release_held" || release.kind === "release_unproven") {
            return holdOwnerRelease(release.reason);
          }
        }
      }
      if (!actual && executionFrame.noActualInvocationConfirmed) executionFrame.ownerReleaseBlocked = false;
      return { kind: "legacy" };
    };

    try {
    const agent = await getAgent(run.agentId);
    if (!agent) {
      await setRunStatus(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      }, { expectedStatuses: ["running"] });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: "Agent not found",
      });
      const failedRun = await getRun(runId);
      if (failedRun) await releaseFinishedRun(failedRun);
      return;
    }

    const runtime = await ensureRuntimeState(agent);
    const context = parseObject(run.contextSnapshot);
    const companyRuntimeContext = await db
      .select({
        defaultLanguage: companies.defaultLanguage,
        companyKind: companies.companyKind,
      })
      .from(companies)
      .where(eq(companies.id, agent.companyId))
      .then((rows) => rows[0] ?? null);
    context.paperclipUserFacingLanguage = companyRuntimeContext?.defaultLanguage ?? "en";
    applyPaperclipApiContext(context);
    const taskKey = deriveTaskKey(context, null);
    // Mission session branch: when missionId is present, session is keyed by
    // "mission:{missionId}" to ensure reuse across runs within the same mission.
    const missionId = readNonEmptyString(context.missionId);
    const effectiveTaskKey = missionId ? `mission:${missionId}` : taskKey;
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const issueId = readNonEmptyString(context.issueId);
    const issueContext = issueId
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
            status: issues.status,
            priority: issues.priority,
            parentId: issues.parentId,
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
            executionWorkspaceId: issues.executionWorkspaceId,
            executionWorkspacePreference: issues.executionWorkspacePreference,
            missionId: issues.missionId,
            originKind: issues.originKind,
            originId: issues.originId,
            requestDepth: issues.requestDepth,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
            executionWorkspaceSettings: issues.executionWorkspaceSettings,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueAssigneeOverrides =
      issueContext && issueContext.assigneeAgentId === agent.id
        ? parseIssueAssigneeAdapterOverrides(
            issueContext.assigneeAdapterOverrides,
          )
        : null;
    const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
    const issueExecutionWorkspaceSettings = isolatedWorkspacesEnabled
      ? parseIssueExecutionWorkspaceSettings(issueContext?.executionWorkspaceSettings)
      : null;
    const contextProjectId = readNonEmptyString(context.projectId);
    const executionProjectId = issueContext?.projectId ?? contextProjectId;
    const projectExecutionWorkspacePolicy = executionProjectId
      ? await db
          .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
          .from(projects)
          .where(and(eq(projects.id, executionProjectId), eq(projects.companyId, agent.companyId)))
          .then((rows) =>
            gateProjectExecutionWorkspacePolicy(
              parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy),
              isolatedWorkspacesEnabled,
            ))
      : null;
    const taskSession = effectiveTaskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, effectiveTaskKey)
      : null;
    const resetTaskSession = shouldResetTaskSessionForWake(context);
    const sessionResetReason = describeSessionResetReason(context);
    const taskSessionForRun = resetTaskSession ? null : taskSession;
    const previousSessionParams = normalizeSessionParams(
      sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null),
    );
    const missionSessionAuthority = missionId
      ? await resolveMissionSessionAuthority({
          agent,
          missionId,
          adapterType: agent.adapterType,
          taskSessionDisplayId: taskSessionForRun?.sessionDisplayId ?? null,
          taskSessionLegacySessionId: readNonEmptyString(previousSessionParams?.sessionId),
          runtimeSessionId: runtime.sessionId,
          resetTaskSession,
        })
      : null;
    const missionSessionBinding = missionSessionAuthority?.missionSessionBinding ?? null;
    const missionSessionId = missionSessionAuthority?.decision.preferredSessionId ?? null;
    const config = mergeAgentConfig(agent);
    const executionWorkspaceMode = resolveExecutionWorkspaceMode({
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const resolvedWorkspace = await resolveWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      { useProjectWorkspace: executionWorkspaceMode !== "agent_default" },
    );
    const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig({
      agentConfig: config,
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      mode: executionWorkspaceMode,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const mergedConfig = issueAssigneeOverrides?.adapterConfig
      ? { ...workspaceManagedConfig, ...issueAssigneeOverrides.adapterConfig }
      : workspaceManagedConfig;
    const { config: resolvedConfig, secretKeys } = await secretsSvc.resolveAdapterConfigForRuntime(
      agent.companyId,
      mergedConfig,
    );
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agent.companyId);
    const {
      missionAgentRuntimeForRun,
      missionIssueEnvelopePolicy,
      paperclipMissionRuntime,
      paperclipMissionWorkingNote,
    } = await compileMissionRunContext(db, {
      companyId: agent.companyId,
      missionId,
      agentId: agent.id,
      adapterType: agent.adapterType,
      resolvedConfig,
      workspaceId: resolvedWorkspace.workspaceId ?? null,
      workspaceKey: resolvedWorkspace.workspaceId ?? resolvedWorkspace.cwd ?? "default",
      currentIssueId: issueContext?.id ?? issueId ?? null,
      runId: run.id,
      missionSessionId,
    });
    if (paperclipMissionRuntime) {
      context.paperclipMissionRuntime = paperclipMissionRuntime;
    } else {
      delete context.paperclipMissionRuntime;
    }
    if (paperclipMissionWorkingNote) {
      context.paperclipMissionWorkingNote = paperclipMissionWorkingNote;
    } else {
      delete context.paperclipMissionWorkingNote;
    }
    const assignedTaskPromptSection = buildAssignedIssuePromptSection(issueContext);
    const resolvedPromptTemplate = readNonEmptyString(resolvedConfig.promptTemplate);
    const promptTemplateWithIssueTask =
      issueContext
        ? resolvedPromptTemplate
          ? !resolvedPromptTemplate.includes("{{taskBody}}") && !resolvedPromptTemplate.includes("{{#taskId}}")
            ? `${resolvedPromptTemplate}${assignedTaskPromptSection}`
            : resolvedPromptTemplate
          : assignedTaskPromptSection.trim()
        : resolvedPromptTemplate;
    const issueTaskAdapterConfig = issueContext
      ? {
          taskId: issueContext.id,
          taskTitle: issueContext.title,
          taskBody: issueContext.description ?? issueContext.title,
          ...(promptTemplateWithIssueTask ? { promptTemplate: promptTemplateWithIssueTask } : {}),
        }
      : {};
    let runtimeConfig: Record<string, unknown> = {
      ...resolvedConfig,
      ...issueTaskAdapterConfig,
      ...(missionIssueEnvelopePolicy.fullContextInjection ? { paperclipRuntimeSkills: runtimeSkillEntries } : {}),
    };
    runtimeConfig = applyAdapterFallbackRuntimeConfig({ run, context, config: runtimeConfig });

    // Agent self-learning wiki (Phase 2): 해당 agent의 가장 빈번한 과거 실패 교훈을
    // adapter prompt에 주입해 같은 실수가 반복되지 않도록 한다. non-blocking (실패 시 skip).
    try {
      const wikiEntries = await wikiSvc.searchRelevant({
        companyId: agent.companyId,
        agentId: agent.id,
        limit: 3,
      });
      const wikiSection = formatWikiLessons(wikiEntries);
      if (wikiSection) {
        const basePrompt = readNonEmptyString(runtimeConfig.promptTemplate);
        runtimeConfig.promptTemplate = basePrompt ? `${basePrompt}\n\n${wikiSection}` : wikiSection;
      }
    } catch (err) {
      logger.warn({ err, runId: run.id }, "agent-wiki.searchRelevant non-blocking failure");
    }

    const issueRef = issueContext
      ? {
          id: issueContext.id,
          identifier: issueContext.identifier,
          title: issueContext.title,
          projectId: issueContext.projectId,
          projectWorkspaceId: issueContext.projectWorkspaceId,
          executionWorkspaceId: issueContext.executionWorkspaceId,
          executionWorkspacePreference: issueContext.executionWorkspacePreference,
        }
      : null;
    const workflowStepToolContext = await resolveWorkflowStepToolContext({
      db,
      companyId: agent.companyId,
      issueId: issueRef?.id ?? null,
    });
    const workflowStepKnowledgeContext = await resolveWorkflowStepKnowledgeContext({
      db,
      companyId: agent.companyId,
      agentId: agent.id,
      issueId: issueRef?.id ?? null,
      taskKey,
      issueTitle: issueContext?.title ?? null,
      issueDescription: issueContext?.description ?? null,
      note: readNonEmptyString(context.note),
    });
    if (workflowStepToolContext) {
      context.paperclipWorkflowStepToolContract = workflowStepToolContext;
    } else {
      delete context.paperclipWorkflowStepToolContract;
    }
    if (workflowStepToolContext && issueRef) {
      context[RUN_TOOL_CONTRACT_CONTEXT_KEY] = {
        version: 1,
        sourceKind: "workflow_step",
        issueId: issueRef.id,
        workflowRunId: workflowStepToolContext.workflowRunId,
        workflowId: workflowStepToolContext.workflowId,
        stepId: workflowStepToolContext.stepId,
        stepName: workflowStepToolContext.stepName,
        toolNames: workflowStepToolContext.toolNames,
        toolArgs: workflowStepToolContext.toolArgs,
        tools: workflowStepToolContext.tools,
      };
    } else {
      delete context[RUN_TOOL_CONTRACT_CONTEXT_KEY];
    }
    if (workflowStepKnowledgeContext) {
      context.paperclipWorkflowStepKnowledgeContext = workflowStepKnowledgeContext;
    } else {
      delete context.paperclipWorkflowStepKnowledgeContext;
    }

    // [P2 — 사람 큐레이션 패턴 카드 관련도 주입, 측정 롤아웃] 실험 플래그(on) + 결정론적
    //   50/50 군 배정의 injection 군일 때만 active+audience='agent'+신선 카드 상위 2건을
    //   프롬프트에 소량 주입한다. 군+카드 id는 스텝런 메타데이터에 1회 기록(측정 원장 —
    //   주입군/비주입군 성공률 비교). 기계 카운터 위키 주입과 혼용되지 않는 별도 섹션이다.
    //   non-blocking(실패 시 skip) + 플래그 기본 off(fail-closed).
    try {
      const experimentalFlags = await instanceSettings.getExperimental();
      const workflowStepContract = experimentalFlags.enableKnowledgePatternInjection && issueRef
        ? await (await import("./workflow/engine.js")).workflowService.getStepExecutionContractForIssue(db, issueRef.id)
        : null;
      if (workflowStepContract) {
        const injectionGroup = injectionGroupFor(`${agent.companyId}:${workflowStepContract.workflowRunId}:${workflowStepContract.stepId}`);
        const injectableCards = injectionGroup === "injection"
          ? await selectCardsForInjection(db, {
              companyId: agent.companyId,
              contextTexts: [
                issueContext?.title ?? "",
                issueContext?.description ?? "",
                workflowStepToolContext?.stepName ?? "",
                readNonEmptyString(context.note) ?? "",
              ],
            })
          : [];
        const cardSection = injectionGroup === "injection" ? formatKnowledgePatternCards(injectableCards) : null;
        if (cardSection) {
          const basePrompt = readNonEmptyString(runtimeConfig.promptTemplate);
          runtimeConfig.promptTemplate = basePrompt ? `${basePrompt}\n\n${cardSection}` : cardSection;
        }
        const [stepRunMeta] = await db
          .select({ metadata: workflowStepRuns.metadata })
          .from(workflowStepRuns)
          .where(eq(workflowStepRuns.id, workflowStepContract.stepRunId))
          .limit(1);
        const existingMeta = (stepRunMeta?.metadata ?? {}) as Record<string, unknown>;
        if (stepRunMeta && !existingMeta.knowledgePatternInjection) {
          await db
            .update(workflowStepRuns)
            .set({
              metadata: {
                ...existingMeta,
                knowledgePatternInjection: {
                  group: injectionGroup,
                  cardIds: injectableCards.map((card) => card.id),
                  decidedAt: new Date().toISOString(),
                },
              },
            })
            .where(eq(workflowStepRuns.id, workflowStepContract.stepRunId));
        }
      }
    } catch (err) {
      logger.warn({ err, runId: run.id }, "knowledge-pattern injection non-blocking failure");
    }
    // Maintenance intake rules are only meaningful for an explicitly
    // maintenance-scoped company. Do not leak them into product, GitHub PR,
    // research, or other business work merely because the company has rules
    // or accessible knowledge bases.
    const maintenanceGuidanceContext = companyRuntimeContext?.companyKind === "maintenance"
      ? await resolveMaintenanceGuidanceContext({
          db,
          companyId: agent.companyId,
          agentId: agent.id,
          workflowStepKnowledgeContext,
          issueTitle: issueContext?.title ?? null,
          issueDescription: issueContext?.description ?? null,
          note: readNonEmptyString(context.note),
          taskKey,
        })
      : null;
    if (maintenanceGuidanceContext) {
      context.paperclipMaintenanceGuidance = maintenanceGuidanceContext;
    } else {
      delete context.paperclipMaintenanceGuidance;
    }
    const maintenanceDecisionContext = companyRuntimeContext?.companyKind !== "maintenance" ||
      (issueContext?.missionId && !maintenanceGuidanceContext)
      ? null
      : buildMaintenanceDecisionContext({
          issue: issueContext
            ? {
                id: issueContext.id,
                identifier: issueContext.identifier,
                title: issueContext.title,
                description: issueContext.description,
                status: issueContext.status,
                priority: issueContext.priority,
              }
            : null,
          requestedStatus: readNonEmptyString(context.requestedStatus),
          guidance: maintenanceGuidanceContext,
        });
    if (maintenanceDecisionContext) {
      context.paperclipMaintenanceDecision = maintenanceDecisionContext;
      if (issueContext?.id) {
        await logMaintenanceDecisionEvaluated({
          db,
          companyId: agent.companyId,
          agentId: agent.id,
          runId: run.id,
          issue: {
            id: issueContext.id,
            identifier: issueContext.identifier,
            projectId: issueContext.projectId,
          },
          workflow: workflowStepToolContext
            ? {
                workflowRunId: workflowStepToolContext.workflowRunId,
                workflowId: workflowStepToolContext.workflowId,
                stepId: workflowStepToolContext.stepId,
                stepName: workflowStepToolContext.stepName,
              }
            : workflowStepKnowledgeContext
              ? {
                  workflowRunId: workflowStepKnowledgeContext.workflowRunId,
                  workflowId: workflowStepKnowledgeContext.workflowId,
                  stepId: workflowStepKnowledgeContext.stepId,
                  stepName: workflowStepKnowledgeContext.stepName,
                }
              : null,
          decision: maintenanceDecisionContext,
        });
      }
    } else {
      delete context.paperclipMaintenanceDecision;
    }
    const effectiveMissionIdForPlan = issueContext?.missionId ?? missionId;
    if (effectiveMissionIdForPlan) {
      const activePlan = await missionPlanArtifactService(db).getActiveMissionPlan({
        companyId: agent.companyId,
        missionId: effectiveMissionIdForPlan,
      });
      context.paperclipMissionPlan = missionPlanArtifactService(db).summarizeMissionPlanForRuntime(activePlan);
    } else {
      delete context.paperclipMissionPlan;
    }
    const missionOwnerTaskContext = await resolveMissionOwnerTaskContext({
      db,
      companyId: agent.companyId,
      issue: issueContext,
    });
    if (missionOwnerTaskContext) {
      context.paperclipMissionOwnerTaskContext = missionOwnerTaskContext;
    } else {
      delete context.paperclipMissionOwnerTaskContext;
    }
    const missionOwnerPlanningMissionId = issueContext?.originKind === "mission_main_executor_plan"
      ? issueContext.missionId ?? missionId
      : null;
    if (missionOwnerPlanningMissionId) {
      context.paperclipMissionOwnerPlanningContext = await buildMissionOwnerPlanningContext(db, {
        companyId: agent.companyId,
        missionId: missionOwnerPlanningMissionId,
      });
    } else {
      delete context.paperclipMissionOwnerPlanningContext;
    }
    const existingExecutionWorkspace =
      issueRef?.executionWorkspaceId ? await executionWorkspacesSvc.getById(issueRef.executionWorkspaceId) : null;
    const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
      companyId: agent.companyId,
      heartbeatRunId: run.id,
      executionWorkspaceId: existingExecutionWorkspace?.id ?? null,
    });
    const executionWorkspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: resolvedWorkspace.cwd,
        source: resolvedWorkspace.source,
        projectId: resolvedWorkspace.projectId,
        workspaceId: resolvedWorkspace.workspaceId,
        repoUrl: resolvedWorkspace.repoUrl,
        repoRef: resolvedWorkspace.repoRef,
      },
      config: runtimeConfig,
      issue: issueRef,
      agent: {
        id: agent.id,
        name: agent.name,
        companyId: agent.companyId,
      },
      recorder: workspaceOperationRecorder,
    });
    const resolvedProjectId = executionWorkspace.projectId ?? issueRef?.projectId ?? executionProjectId ?? null;
    const resolvedProjectWorkspaceId = issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
    const shouldReuseExisting =
      issueRef?.executionWorkspacePreference === "reuse_existing" &&
      existingExecutionWorkspace &&
      existingExecutionWorkspace.status !== "archived";
    let persistedExecutionWorkspace = null;
    try {
      persistedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
        ? await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
            cwd: executionWorkspace.cwd,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            branchName: executionWorkspace.branchName,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            status: "active",
            lastUsedAt: new Date(),
            metadata: {
              ...(existingExecutionWorkspace.metadata ?? {}),
              source: executionWorkspace.source,
              createdByRuntime: executionWorkspace.created,
            },
          })
        : resolvedProjectId
          ? await executionWorkspacesSvc.create({
              companyId: agent.companyId,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              mode:
                executionWorkspaceMode === "isolated_workspace"
                  ? "isolated_workspace"
                  : executionWorkspaceMode === "operator_branch"
                    ? "operator_branch"
                    : executionWorkspaceMode === "agent_default"
                      ? "adapter_managed"
                      : "shared_workspace",
              strategyType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "project_primary",
              name: executionWorkspace.branchName ?? issueRef?.identifier ?? `workspace-${agent.id.slice(0, 8)}`,
              status: "active",
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: executionWorkspace.branchName,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              lastUsedAt: new Date(),
              openedAt: new Date(),
              metadata: {
                source: executionWorkspace.source,
                createdByRuntime: executionWorkspace.created,
              },
            })
          : null;
    } catch (error) {
      if (executionWorkspace.created) {
        try {
          await cleanupExecutionWorkspaceArtifacts({
            workspace: {
              id: existingExecutionWorkspace?.id ?? `transient-${run.id}`,
              cwd: executionWorkspace.cwd,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              branchName: executionWorkspace.branchName,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              metadata: {
                createdByRuntime: true,
                source: executionWorkspace.source,
              },
            },
            projectWorkspace: {
              cwd: resolvedWorkspace.cwd,
              cleanupCommand: null,
            },
            teardownCommand: projectExecutionWorkspacePolicy?.workspaceStrategy?.teardownCommand ?? null,
            recorder: workspaceOperationRecorder,
          });
        } catch (cleanupError) {
          logger.warn(
            {
              runId: run.id,
              issueId,
              executionWorkspaceCwd: executionWorkspace.cwd,
              cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            },
            "Failed to cleanup realized execution workspace after persistence failure",
          );
        }
      }
      throw error;
    }
    await workspaceOperationRecorder.attachExecutionWorkspaceId(persistedExecutionWorkspace?.id ?? null);
    if (
      existingExecutionWorkspace &&
      persistedExecutionWorkspace &&
      existingExecutionWorkspace.id !== persistedExecutionWorkspace.id &&
      existingExecutionWorkspace.status === "active"
    ) {
      await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
        status: "idle",
        cleanupReason: null,
      });
    }
    if (issueId && persistedExecutionWorkspace && issueRef?.executionWorkspaceId !== persistedExecutionWorkspace.id) {
      await issuesSvc.update(issueId, {
        executionWorkspaceId: persistedExecutionWorkspace.id,
        ...(resolvedProjectWorkspaceId ? { projectWorkspaceId: resolvedProjectWorkspaceId } : {}),
      });
    }
    if (persistedExecutionWorkspace) {
      context.executionWorkspaceId = persistedExecutionWorkspace.id;
      refreshStepInputManifest(context, deriveTaskKey(context, null));
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
    }
    const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
      agentId: agent.id,
      previousSessionParams,
      resolvedWorkspace: {
        ...resolvedWorkspace,
        cwd: executionWorkspace.cwd,
      },
    });
    const runtimeSessionParams = runtimeSessionResolution.sessionParams;
    const runtimeWorkspaceWarnings = [
      ...resolvedWorkspace.warnings,
      ...executionWorkspace.warnings,
      ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
      ...(resetTaskSession && sessionResetReason
        ? [
            taskKey
              ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
              : `Skipping saved session resume because ${sessionResetReason}.`,
          ]
        : []),
    ];
    context.paperclipWorkspace = {
      cwd: executionWorkspace.cwd,
      source: executionWorkspace.source,
      mode: executionWorkspaceMode,
      strategy: executionWorkspace.strategy,
      projectId: executionWorkspace.projectId,
      workspaceId: executionWorkspace.workspaceId,
      repoUrl: executionWorkspace.repoUrl,
      repoRef: executionWorkspace.repoRef,
      branchName: executionWorkspace.branchName,
      worktreePath: executionWorkspace.worktreePath,
      agentHome: await (async () => {
        const home = resolveDefaultAgentWorkspaceDir(agent.id);
        // worktree: check file-write before agent home mkdir
        await worktreeCheck({
          agent,
          tool: "file-write",
          args: { operation: "agent_home_mkdir" },
          cwd: home,
          filePath: home,
        });
        await fs.mkdir(home, { recursive: true });
        return home;
      })(),
    };
    context.paperclipWorkspaces = resolvedWorkspace.workspaceHints;
    // [operator instruction cursor] 최근 코멘트 5개(표시용 창) + 커서 이후 미소비 운영자
    //   지시(보장 전달용)를 함께 조립한다. 반환값은 이번 실행에 포함된 미소비 중 최신
    //   코멘트 id — 어댑터 실행 직전 커서 전진에 사용한다.
    const operatorInstructionCursorCommentId = await assembleIssueCommentContext(
      db,
      agent.companyId,
      issueId,
      context,
    );
    // [runaway recovery] 이 이슈의 직전 실행이 폭주(재고민 루프)로 종료됐다면, 이번 실행
    //   프롬프트 선두에 회복 지시를 붙인다(런타임 브리프가 렌더). 6시간 창 — 오래된 폭주는
    //   새 컨텍스트에서 무의미하므로 제외.
    if (issueId) {
      const runawayPrevious = await db
        .select({
          id: heartbeatRuns.id,
          logBytes: heartbeatRuns.logBytes,
        })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.agentId, agent.id),
          eq(heartbeatRuns.issueId, issueId),
          eq(heartbeatRuns.companyId, agent.companyId),
          eq(heartbeatRuns.status, "failed"),
          eq(heartbeatRuns.errorCode, "runaway_context"),
          sql`${heartbeatRuns.id} <> ${run.id}`,
          gte(heartbeatRuns.createdAt, new Date(Date.now() - 6 * 60 * 60 * 1000)),
        ))
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (runawayPrevious) {
        context.paperclipRunawayRecoveryBrief = {
          kind: "runaway_recovery",
          previousRunId: runawayPrevious.id,
          logBytes: runawayPrevious.logBytes ?? 0,
        };
      } else {
        delete context.paperclipRunawayRecoveryBrief;
      }
    } else {
      delete context.paperclipRunawayRecoveryBrief;
    }
    // [no-progress ladder 2단계] 직전 성공 run들에 공식 도구 증가·실측 산출물 생성/변경이 없으면
    //   이번 실행 선두에 회복 지시를 붙인다(런타임 브리프가 렌더). 판정은 DB 증거 쿼리로
    //   매번 stateless 재계산 — 어드바이저(N회) 다음 단계, K회 도달 시 release 게이트에서 auto-block.
    if (issueId) {
      const noProgressAssessment = await computeConsecutiveNoProgress(db, {
        companyId: agent.companyId,
        issueId,
        agentId: agent.id,
      });
      const noProgressAdvisoryThreshold = resolveNoProgressAdvisoryThreshold();
      if (
        noProgressAssessment &&
        noProgressAdvisoryThreshold > 0 &&
        noProgressAssessment.count >= noProgressAdvisoryThreshold
      ) {
        context.paperclipNoProgressRecoveryBrief = {
          kind: "no_progress_recovery",
          consecutiveCount: noProgressAssessment.count,
          lastRunId: noProgressAssessment.lastRunId,
          advisoryThreshold: noProgressAdvisoryThreshold,
          autoBlockThreshold: resolveNoProgressAutoBlockThreshold(),
        };
      } else {
        delete context.paperclipNoProgressRecoveryBrief;
      }
    } else {
      delete context.paperclipNoProgressRecoveryBrief;
    }
    const wakeCommentId = readNonEmptyString(context.wakeCommentId);
    const wakeComment = wakeCommentId ? await issuesSvc.getComment(wakeCommentId) : null;
    const fileViews = await buildContextSafeFileViews({
      text:
        wakeComment && wakeComment.issueId === issueId
          ? wakeComment.body
          : null,
      workspaceCwd: executionWorkspace.cwd,
      workspaceId: executionWorkspace.workspaceId,
    });
    if (fileViews.length > 0) {
      context.paperclipFileViews = fileViews;
    } else {
      delete context.paperclipFileViews;
    }
    if (issueId) {
      const runtimeSearchPaths = await buildRuntimeSearchPathPermissions({
        db, agentId: agent.id,
        companyId: agent.companyId,
        issueId,
        workingDirectory: executionWorkspace.cwd,
      });
      if (runtimeSearchPaths) {
        context.paperclipRuntimeSearchPaths = runtimeSearchPaths;
      } else {
        delete context.paperclipRuntimeSearchPaths;
      }
    } else {
      delete context.paperclipRuntimeSearchPaths;
    }
    const runtimeServiceIntents = (() => {
      const runtimeConfig = parseObject(resolvedConfig.workspaceRuntime);
      return Array.isArray(runtimeConfig.services)
        ? runtimeConfig.services.filter(
            (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
          )
        : [];
    })();
    if (runtimeServiceIntents.length > 0) {
      context.paperclipRuntimeServiceIntents = runtimeServiceIntents;
    } else {
      delete context.paperclipRuntimeServiceIntents;
    }
    if (executionWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = executionWorkspace.projectId;
    }
    const runtimeSessionFallback = resetTaskSession
      ? null
      : missionSessionId ?? (taskKey ? null : runtime.sessionId);
    let previousSessionDisplayId = truncateDisplayId(
      missionSessionId ??
        taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    let runtimeSessionIdForAdapter =
      readNonEmptyString(runtimeSessionParams?.sessionId) ?? runtimeSessionFallback;
    let runtimeSessionParamsForAdapter = runtimeSessionParams;

    const issueScopedRawSessionResume = await evaluateIssueScopedRawSessionResume({
      agentId: agent.id,
      currentIssueId: issueId,
      currentMissionId: missionId,
      currentRunId: run.id,
      sessionId: runtimeSessionIdForAdapter,
    });
    const sessionCompaction = issueScopedRawSessionResume.rotate
      ? null
      : await evaluateSessionCompaction({
          agent,
          sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
          issueId,
          missionId,
        });
    if (issueScopedRawSessionResume.rotate) {
      context.paperclipSessionRotationReason = issueScopedRawSessionResume.reason;
      context.paperclipPreviousSessionId = previousSessionDisplayId ?? issueScopedRawSessionResume.previousSessionId;
      runtimeSessionIdForAdapter = null;
      runtimeSessionParamsForAdapter = null;
      previousSessionDisplayId = null;
      runtimeWorkspaceWarnings.push(
        `Starting a fresh session because ${issueScopedRawSessionResume.reason}.`,
      );
    } else if (sessionCompaction?.rotate) {
      context.paperclipSessionHandoffMarkdown = sessionCompaction.handoffMarkdown;
      context.paperclipSessionHandoff = sessionCompaction.handoffArtifact;
      context.paperclipSessionRotationReason = sessionCompaction.reason;
      context.paperclipPreviousSessionId = previousSessionDisplayId ?? runtimeSessionIdForAdapter;
      runtimeSessionIdForAdapter = null;
      runtimeSessionParamsForAdapter = null;
      previousSessionDisplayId = null;
      if (sessionCompaction.reason) {
        runtimeWorkspaceWarnings.push(
          `Starting a fresh session because ${sessionCompaction.reason}.`,
        );
      }
    } else {
      delete context.paperclipSessionHandoffMarkdown;
      delete context.paperclipSessionHandoff;
      delete context.paperclipSessionRotationReason;
      delete context.paperclipPreviousSessionId;
    }
    let instructionInjectionPlan = null as Awaited<ReturnType<typeof prepareInstructionInjection>>;
    try {
      instructionInjectionPlan = await prepareInstructionInjection({
        db,
        context,
        agent,
        issueId,
        adapterConfig: runtimeConfig,
        cwd: executionWorkspace.cwd,
        runId: run.id,
        providerSessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
      });
    } catch (err) {
      delete context.paperclipInstructionInjection;
      logger.warn({ err, agentId: agent.id, issueId }, "failed to apply instruction injection ledger");
    }

    const runtimeForAdapter = {
      sessionId: runtimeSessionIdForAdapter,
      sessionParams: runtimeSessionParamsForAdapter,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };
    refreshStepInputManifest(context, taskKey);

    let seq = 1;
    const runLog = createHeartbeatRunLog({
      db,
      getRun: () => run,
      adapterType: agent.adapterType,
      context,
      config: resolvedConfig,
      store: runLogStore,
      getRedactionOptions: getCurrentUserRedactionOptions,
      appendEvent: (event) => appendRunEvent(run, seq++, event),
      appendBroadScanEvent: async (details) => {
        await appendBroadScanBlockEvent(run, seq, details);
        seq++;
      },
    });
    let earlySessionIdAfter: string | null = null;
    let canonicalActualTerminalEvidence: Partial<Pick<typeof heartbeatRuns.$inferInsert,
      | "exitCode" | "signal" | "usageJson" | "resultJson" | "sessionIdAfter"
      | "stdoutExcerpt" | "stderrExcerpt" | "logBytes" | "logSha256" | "logCompressed">> | null = null;
    const buildCanonicalActualTerminalEvidence = async (input: {
      result: AdapterExecutionResult;
      nextSessionState: ReturnType<typeof resolveNextSessionState>;
      persistedSessionIdAfter: string | null;
      logSummary: Awaited<ReturnType<typeof runLog.finalize>>;
    }) => {
      const { result, nextSessionState, persistedSessionIdAfter, logSummary } = input;
      const rawUsage = normalizeUsageTotals(result.usage);
      const sessionUsageResolution = await resolveNormalizedUsageForSession({
        companyId: agent.companyId,
        agentId: agent.id,
        runId: run.id,
        sessionId: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        rawUsage,
      });
      const normalizedUsage = sessionUsageResolution.normalizedUsage;
      const usageJson = normalizedUsage || result.costUsd != null
        ? ({
            ...(normalizedUsage ?? {}),
            ...(rawUsage ? {
              rawInputTokens: rawUsage.inputTokens,
              rawCachedInputTokens: rawUsage.cachedInputTokens,
              rawOutputTokens: rawUsage.outputTokens,
            } : {}),
            ...(sessionUsageResolution.derivedFromSessionTotals ? { usageSource: "session_delta" } : {}),
            ...(persistedSessionIdAfter ? { persistedSessionId: persistedSessionIdAfter } : {}),
            sessionReused: runtimeForAdapter.sessionId != null || runtimeForAdapter.sessionDisplayId != null,
            taskSessionReused: taskSessionForRun != null,
            freshSession: runtimeForAdapter.sessionId == null && runtimeForAdapter.sessionDisplayId == null,
            sessionRotated: issueScopedRawSessionResume.rotate || sessionCompaction?.rotate === true,
            sessionRotationReason: issueScopedRawSessionResume.rotate
              ? issueScopedRawSessionResume.reason
              : sessionCompaction?.reason ?? null,
            provider: readNonEmptyString(result.provider) ?? "unknown",
            biller: resolveLedgerBiller(result),
            model: readNonEmptyString(result.model) ?? "unknown",
            ...(result.costUsd != null ? { costUsd: result.costUsd } : {}),
            billingType: normalizeLedgerBillingType(result.billingType),
          } as Record<string, unknown>)
        : null;
      return {
        normalizedUsage,
        usageJson,
        terminalEvidence: {
          exitCode: result.exitCode,
          signal: result.signal,
          usageJson,
          resultJson: capHeartbeatRunResultJsonForStorage(result.resultJson),
          sessionIdAfter: persistedSessionIdAfter,
          stdoutExcerpt: runLog.stdoutExcerpt,
          stderrExcerpt: runLog.stderrExcerpt,
          logBytes: logSummary?.bytes,
          logSha256: logSummary?.sha256,
          logCompressed: logSummary?.compressed ?? false,
        },
      };
    };
    try {
      const startedAt = run.startedAt ?? new Date();
      const runningWithSession = await db
        .update(heartbeatRuns)
        .set({
          startedAt,
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (runningWithSession) run = runningWithSession;

      const runningAgent = await db
        .update(agents)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (runningAgent) {
        publishLiveEvent({
          companyId: runningAgent.companyId,
          type: "agent.status",
          payload: {
            agentId: runningAgent.id,
            status: runningAgent.status,
            outcome: "running",
          },
        });
      }

      const currentRun = run;
      await appendRunEvent(currentRun, seq++, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "run started",
      });

      await runLog.begin();
      const currentUserRedactionOptions = runLog.redactionOptions;
      const { onLog } = runLog;
      for (const warning of runtimeWorkspaceWarnings) {
        const logEntry = formatRuntimeWorkspaceWarningLog(warning);
        await onLog(logEntry.stream, logEntry.chunk);
      }
      const adapterEnv = Object.fromEntries(
        Object.entries(parseObject(resolvedConfig.env)).filter(
          (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      );
      const runtimeServices = await ensureRuntimeServicesForRun({
        db,
        runId: run.id,
        agent: {
          id: agent.id,
          name: agent.name,
          companyId: agent.companyId,
        },
        issue: issueRef,
        workspace: executionWorkspace,
        executionWorkspaceId: persistedExecutionWorkspace?.id ?? issueRef?.executionWorkspaceId ?? null,
        config: resolvedConfig,
        adapterEnv,
        onLog,
      });
      if (runtimeServices.length > 0) {
        context.paperclipRuntimeServices = runtimeServices;
        context.paperclipRuntimePrimaryUrl =
          runtimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
      }
      refreshStepInputManifest(context, taskKey);
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
      if (issueId && (executionWorkspace.created || runtimeServices.some((service) => !service.reused))) {
        try {
          await issuesSvc.addComment(
            issueId,
            buildWorkspaceReadyComment({ language: context.paperclipUserFacingLanguage === "ko" ? "ko" : "en",
              workspace: executionWorkspace,
              runtimeServices,
            }),
            { agentId: agent.id, enqueuePlanQaWakeup },
          );
        } catch (err) {
          await onLog(
            "stderr",
            `[paperclip] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      let earlySessionUpdate: AdapterSessionUpdate | null = null;
      const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
        if (meta.env && secretKeys.size > 0) {
          for (const key of secretKeys) {
            if (key in meta.env) meta.env[key] = "***REDACTED***";
          }
        }
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: meta as unknown as Record<string, unknown>,
        });
      };
      const onAdapterSessionUpdate = async (update: AdapterSessionUpdate) => {
        const sessionId = readNonEmptyString(update.sessionId);
        if (!sessionId) return;
        const sessionDisplayId = readNonEmptyString(update.sessionDisplayId) ?? sessionId;
        if (earlySessionUpdate?.sessionDisplayId === sessionDisplayId || earlySessionUpdate?.sessionId === sessionId) {
          return;
        }
        earlySessionUpdate = {
          ...update,
          sessionId,
          sessionDisplayId,
          sessionParams: parseObject(update.sessionParams),
        };
        earlySessionIdAfter = sessionDisplayId ?? sessionId;
        await db
          .update(heartbeatRuns)
          .set({
            sessionIdAfter: sessionDisplayId,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.session.update",
          stream: "system",
          level: "info",
          message: "adapter session discovered",
          payload: earlySessionUpdate as unknown as Record<string, unknown>,
        });
      };

      const adapter = getServerAdapter(agent.adapterType);
      const authToken = adapter.supportsLocalAgentJwt
        ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, run.id)
        : null;
      if (authToken) {
        runtimeConfig = {
          ...runtimeConfig,
          env: {
            ...parseObject(runtimeConfig.env),
            PAPERCLIP_API_KEY: authToken,
          },
        };
      }
      if (adapter.supportsLocalAgentJwt && !authToken) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            adapterType: agent.adapterType,
          },
          "local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY",
        );
      }
      let hasResumableSession = hasResumableSessionForRun(runtimeForAdapter, executionWorkspace.cwd);
      // [QA rework context reduction] rework contract(kind=workflow_qa_rework, WORKFLOW_REWORK_CONTRACT_KIND)가
      //   있으면 이전 세션을 resume하지 않는다. rework verdict가 이전 결론을 무효화했으므로 같은 thread의
      //   self-belief가 지배하면 producer가 rework를 무시하고 complete하는 사고(GAZ-265 라이브 케이스)를 막는다.
      //   prevSessionId는 참조용으로만 보존(handoff).
      const reworkContractRaw = context.paperclipWorkflowReworkContract;
      const hasReworkContract = typeof reworkContractRaw === "object" && reworkContractRaw !== null
        && (reworkContractRaw as Record<string, unknown>).kind === "workflow_qa_rework";
      if (hasReworkContract && hasResumableSession) {
        const previousSessionId = runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId ?? null;
        runtimeForAdapter.sessionId = null;
        runtimeForAdapter.sessionParams = null;
        runtimeForAdapter.sessionDisplayId = null;
        hasResumableSession = false;
        context.paperclipSessionRotationReason = "qa_rework_fresh_session";
        if (previousSessionId) context.paperclipPreviousSessionId = previousSessionId;
        instructionInjectionPlan = forceFullInstructionInjection(context, instructionInjectionPlan);
        refreshStepInputManifest(context, taskKey);
      }
      let contextBudgetPreflight = await evaluateContextBudgetPreflight({
        runtimeConfig: agent.runtimeConfig,
        adapterType: agent.adapterType,
        adapterConfig: runtimeConfig,
        agent,
        runId: run.id,
        context,
        hasResumableSession,
        cwd: executionWorkspace.cwd,
        authTokenPresent:
          typeof parseObject(resolvedConfig.env).PAPERCLIP_API_KEY === "string" || Boolean(authToken),
      });
      if (contextBudgetPreflight.blocked && hasResumableSession) {
        const previousSessionId = runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId ?? null;
        runtimeForAdapter.sessionId = null;
        runtimeForAdapter.sessionParams = null;
        runtimeForAdapter.sessionDisplayId = null;
        hasResumableSession = false;
        context.paperclipSessionRotationReason = "context_budget_preflight";
        context.paperclipPreviousSessionId = previousSessionId;
        // [A안] 컨텍스트 예산 회전에서도 결정원장 포인터(미션+판번호)를 실어 보낸다.
        const budgetDecisionLogPointer = missionId
          ? await resolveMissionDecisionLogPointer(db, missionId)
          : null;
        context.paperclipSessionHandoffMarkdown = [
          "# Session Handoff",
          "",
          `Previous session: ${previousSessionId ?? "unknown"}`,
          "Rotation reason: context_budget_preflight",
          `Issue ID: ${issueId ?? "none"}`,
          "",
          contextBudgetPreflight.reason ?? "Context budget preflight blocked resumed session.",
          ...(budgetDecisionLogPointer
            ? [
                `Mission decision log: mission ${budgetDecisionLogPointer.missionId} rolling state revision ${budgetDecisionLogPointer.revision} (authoritative decision statuses: confirmed/under_review/retired)`,
              ]
            : []),
        ].join("\n");
        context.paperclipSessionHandoff = {
          version: 1,
          previousSessionId,
          issueId,
          rotationReason: "context_budget_preflight",
          lastRunSummaryText: contextBudgetPreflight.reason,
          ...(budgetDecisionLogPointer ? { missionDecisionLogPointer: budgetDecisionLogPointer } : {}),
        };
        instructionInjectionPlan = forceFullInstructionInjection(context, instructionInjectionPlan);
        refreshStepInputManifest(context, taskKey);
        contextBudgetPreflight = await evaluateContextBudgetPreflight({
          runtimeConfig: agent.runtimeConfig,
          adapterType: agent.adapterType,
          adapterConfig: runtimeConfig,
          agent,
          runId: run.id,
          context,
          hasResumableSession,
          cwd: executionWorkspace.cwd,
          authTokenPresent:
            typeof parseObject(resolvedConfig.env).PAPERCLIP_API_KEY === "string" || Boolean(authToken),
        });
      }
      if (contextBudgetPreflight.blocked) {
        refreshStepInputManifest(context, taskKey);
        await db
          .update(heartbeatRuns)
          .set({ contextSnapshot: context, updatedAt: new Date() })
          .where(eq(heartbeatRuns.id, run.id));
        throw Object.assign(
          new Error(
            contextBudgetPreflight.reason ?? "Context budget preflight blocked adapter execution",
          ),
          { code: "context_budget_exceeded" },
        );
      }
      // [file-view staleness] 재개 세션의 직전 run 컨텍스트 스냅샷에 기록된 파일 뷰가
      //   현재 워크스페이스와 어긋나면(변경/삭제) 같은 세션 메모리로 실행하지 않고
      //   핸드오프와 함께 새 세션으로 회전한다. 하드 블록이 아니라 회전이며,
      //   판정은 머신 생성 해시 비교(file_view_session_staleness)뿐이다.
      if (hasResumableSession && parseFileViewStalenessRotationPolicy(agent.runtimeConfig).enabled) {
        const fileViewStaleness = await evaluateSessionFileStaleness(db, {
          agentId: agent.id,
          resumedSessionId: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId ?? null,
          currentRunId: run.id,
          fallbackWorkspaceCwd: executionWorkspace.cwd,
        });
        if (fileViewStaleness.rotate) {
          const previousSessionId = runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId ?? null;
          runtimeForAdapter.sessionId = null;
          runtimeForAdapter.sessionParams = null;
          runtimeForAdapter.sessionDisplayId = null;
          hasResumableSession = false;
          context.paperclipSessionRotationReason = FILE_VIEW_STALENESS_ROTATION_REASON;
          context.paperclipPreviousSessionId = previousSessionId;
          // [A안] 파일 뷰 스테일 회전에서도 결정원장 포인터(미션+판번호)를 실어 보낸다.
          const stalenessDecisionLogPointer = missionId
            ? await resolveMissionDecisionLogPointer(db, missionId)
            : null;
          const stalenessReasonText =
            fileViewStaleness.reason ?? "Recorded files changed since the last run in this session.";
          context.paperclipSessionHandoffMarkdown = [
            "# Session Handoff",
            "",
            `Previous session: ${previousSessionId ?? "unknown"}`,
            `Rotation reason: ${FILE_VIEW_STALENESS_ROTATION_REASON}`,
            `Issue ID: ${issueId ?? "none"}`,
            "",
            stalenessReasonText,
            ...(fileViewStaleness.staleFiles.length > 0
              ? [
                  "",
                  "Changed files:",
                  ...fileViewStaleness.staleFiles.map((entry) => `- ${entry.relativePath} (${entry.status})`),
                ]
              : []),
            ...(stalenessDecisionLogPointer
              ? [
                  "",
                  `Mission decision log: mission ${stalenessDecisionLogPointer.missionId} rolling state revision ${stalenessDecisionLogPointer.revision} (authoritative decision statuses: confirmed/under_review/retired)`,
                ]
              : []),
          ].join("\n");
          context.paperclipSessionHandoff = {
            version: 1,
            previousSessionId,
            issueId,
            rotationReason: FILE_VIEW_STALENESS_ROTATION_REASON,
            lastRunSummaryText: stalenessReasonText,
            ...(stalenessDecisionLogPointer ? { missionDecisionLogPointer: stalenessDecisionLogPointer } : {}),
          };
          instructionInjectionPlan = forceFullInstructionInjection(context, instructionInjectionPlan);
          refreshStepInputManifest(context, taskKey);
          contextBudgetPreflight = await evaluateContextBudgetPreflight({
            runtimeConfig: agent.runtimeConfig,
            adapterType: agent.adapterType,
            adapterConfig: runtimeConfig,
            agent,
            runId: run.id,
            context,
            hasResumableSession,
            cwd: executionWorkspace.cwd,
            authTokenPresent:
              typeof parseObject(resolvedConfig.env).PAPERCLIP_API_KEY === "string" || Boolean(authToken),
          });
          if (contextBudgetPreflight.blocked) {
            refreshStepInputManifest(context, taskKey);
            await db
              .update(heartbeatRuns)
              .set({ contextSnapshot: context, updatedAt: new Date() })
              .where(eq(heartbeatRuns.id, run.id));
            throw Object.assign(
              new Error(
                contextBudgetPreflight.reason ?? "Context budget preflight blocked adapter execution",
              ),
              { code: "context_budget_exceeded" },
            );
          }
        }
      }
      const stepInputManifestGuard = await evaluateStepInputManifestGuard({
        adapterConfig: runtimeConfig,
        agent,
        runId: run.id,
        context,
        hasResumableSession,
        cwd: executionWorkspace.cwd,
      });
      if (stepInputManifestGuard.blocked) {
        await appendBroadScanBlockEvent(run, seq, {
          reason: stepInputManifestGuard.reason ?? "Step Input Manifest blocked broad scan instruction",
          errorCode: "manifest_broad_scan_blocked",
          phase: "preflight",
          matchedPhrase: stepInputManifestGuard.matchedPhrase ?? null,
        });
        seq++;
        throw Object.assign(
          new Error(
            stepInputManifestGuard.reason ?? "Step Input Manifest blocked broad scan instruction",
          ),
          { code: "manifest_broad_scan_blocked" },
        );
      }
      refreshStepInputManifest(context, taskKey);
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
      if (missionAgentRuntimeForRun && missionIssueEnvelopePolicy.fullContextInjection) {
        await markMissionRuntimeBootstrapInjected(db, missionAgentRuntimeForRun.runtime.id).catch((err) => {
          logger.warn({ err, missionId, agentId: agent.id }, "failed to mark mission runtime bootstrap injected");
        });
      }
      const acknowledged = await acknowledgeHeartbeatRunBeforeAdapter(db, run, new Date());
      if (!acknowledged) {
        logger.warn({ runId: run.id }, "heartbeat owner capability acknowledgement lost");
        return;
      }
      run = acknowledged;

      // [operator instruction cursor] 어댑터 호출 경계 소비(adapter-boundary consumption,
      //   not model-receipt proof). 모든 사전 검사를 통과해 실제 어댑터 실행 직전에만
      //   커서를 전진한다(전진 전용, 순서쌍 비교). 실패해도 실행은 계속(로그만).
      if (issueId && operatorInstructionCursorCommentId) {
        try {
          await advanceOperatorInstructionCursor(
            db,
            agent.companyId,
            issueId,
            operatorInstructionCursorCommentId,
          );
        } catch (err) {
          logger.warn(
            { err, companyId: agent.companyId, issueId, runId: run.id },
            "failed to advance operator instruction cursor before adapter execution",
          );
        }
      }

      // [effect envelope] adapter 실행 경계 멱역 펜스(로드맵 3/5). 동일 논리 효과
      //   (anchor=발주 정체성 + generation=공인 재시도 세대 + params=실행 설정)의 이중
      //   실행 방지 — 실행 전 내구 intent, 실행 후 CAS applied. skipped_replay 면
      //   code=fenced_effect_replay_skipped 예외로 실패 종결한다. 일시 재시도·fallback
      //   큐잉은 errorCode==='adapter_failed' 조건이므로 이 코드에서 자동 억제된다.
      let adapterProcessStarted = false;
      adapterStartIdentity = { runId: run.id, wakeupRequestId: run.wakeupRequestId,
        executorOwnerLeaseToken: run.executorOwnerLeaseToken, executionEpoch: run.executionEpoch,
        workflowExecutionGeneration: run.workflowExecutionGeneration };
      adapterStartScope = createHeartbeatAdapterScope(runtimeExecutionLifecycle, adapterStartIdentity);
      try {
        actualDrainIdentity = await freezeHeartbeatActualDrainIdentity(db, run, context);
      } catch (identityErr) {
        logger.warn({ err: identityErr, runId: run.id }, "heartbeat actual-drain identity could not be frozen");
      } finally {
        executionFrame.identityObserved = true;
        executionFrame.actualDrainIdentity = actualDrainIdentity;
      }
      const fencedAdapterExecution = await executeFencedEffect(db, {
        companyId: agent.companyId,
        effectKind: HEARTBEAT_ADAPTER_EXECUTE_EFFECT_KIND,
        anchor: {
          agentId: agent.id,
          issueId: issueId ?? null,
          taskKey: taskKey ?? null,
          // 앵커 없는 런(timer 깨움 등)은 안정 앵커 부재로 오탐 펜스 위험이 있어
          // 런 고유 id 로 각 디스패치를 구분한다(사실상 비펜스, 장부 기록은 유지).
          ...(issueId || taskKey ? {} : { unanchoredDispatchRunId: run.id }),
          wakeReason: readNonEmptyString(context.wakeReason) ?? null,
          workflowRunId: readNonEmptyString(context.workflowRunId) ?? null,
          stepId: readNonEmptyString(context.workflowStepId ?? context.stepId) ?? null,
        },
        generation: {
          processLossRetryCount: run.processLossRetryCount ?? 0,
          fallbackAttempt: resolveAdapterFallbackAttempt(context),
          workflowExecutionGeneration: run.workflowExecutionGeneration ?? null,
          dispatchGeneration:
            typeof context.dispatchGeneration === "number" && Number.isFinite(context.dispatchGeneration)
              ? context.dispatchGeneration
              : null,
        },
        params: {
          adapterType: agent.adapterType,
          command: readNonEmptyString(runtimeConfig.command) ?? null,
          model: readNonEmptyString(runtimeConfig.model) ?? null,
          provider: readNonEmptyString(runtimeConfig.provider) ?? null,
        },
        attemptRunId: run.id,
        isDeferredBeforeStart: error => !!adapterStartScope && !!adapterStartIdentity
          && isHeartbeatUnstartedDeferral(error, adapterStartScope, adapterStartIdentity, runtimeExecutionLifecycle),
        execute: () => {
          const executeActual = () => pauseExecution.execute(run, () => {
          assertHeartbeatAdapterMayStart(adapterStartScope!, runtimeExecutionLifecycle);
          executionFrame.adapterInvocationAttempted = true;
          const actualPromise = actualObservation.invoke(() => runWithinHeartbeatAdapterScope(adapterStartScope!, () => adapter.execute({
            runId: run.id,
            agent: { ...agent, adapterConfig: runtimeConfig },
            runtime: runtimeForAdapter,
            config: runtimeConfig,
            context,
            onLog,
            onMeta: onAdapterMeta,
            onSessionUpdate: onAdapterSessionUpdate,
            onSpawn: async (meta) => {
              adapterProcessStarted = true;
              await persistRunProcessMetadata(run.id, meta);
            },
            authToken: authToken ?? undefined,
          })));
          executionFrame.actualCaptured = actualObservation.wasInvoked();
          return actualPromise;
          });
          const ownerRuntime = c5OwnerRuntime;
          if (!ownerRuntime) return executeHeartbeatWithRecoveryGuard(db, run, executeActual);
          return (async () => {
            const outerNotifications = createReplacementRootNotifications();
            const resolutionMap = new Map<string, unknown>();
            const rootResolutionMaps = new WeakMap<ReplacementRootNotifications, Map<string, unknown>>();
            const sharedAdmission: QaRemediationSharedAdmissionRuntime = {
              ownerRuntime,
              outerNotifications,
              resolutionMap,
              bindResolutionMap: (notifications, map) => rootResolutionMaps.set(notifications, map),
              driftBudget: { corrections: 0 },
            };
            c5RootNotifications = outerNotifications;
          const started = await withReplacementRootNotificationDb(db, outerNotifications, async () => {
            const identity = captureQaCorrectionExecutionIdentity(run);
            c5AdmissionEntered = true;
            const boundary = await startHeartbeatWithC5ExecutionGuard(db, run, executeActual, sharedAdmission);
            return { boundary, identity };
          });
          c5RootSettlementConfirmed = true;
          const { boundary, identity } = started;
          if (boundary.kind === "c5_held_not_invoked") {
            const binding = readC5NotInvokedProof(boundary.proof, db, identity, "adapter_start");
            executionFrame.c5NotInvoked = { proof: boundary.proof, identity: binding.identity };
            throw new C5NotInvokedExecutionError(boundary.proof);
          }
          if (boundary.kind !== "performed") {
            throw Object.assign(conflict("heartbeat_execution_deferred"), { code: "heartbeat_recovery_blocked" });
          }
          return boundary.value.result;
          })();
        },
      });
      if (fencedAdapterExecution.outcome === "skipped_replay") {
        throw Object.assign(
          new Error(
            `fenced effect replay skipped: adapter execution for this effect already recorded (status=${fencedAdapterExecution.status}, priorAttemptRunId=${fencedAdapterExecution.attemptRunId ?? "unknown"}, effectId=${fencedAdapterExecution.effectId})`,
          ),
          { code: "fenced_effect_replay_skipped" },
        );
      }
      const adapterResult = fencedAdapterExecution.value;
      await runLog.flushRuntimeGuardLines();
      const adapterManagedRuntimeServices = adapterResult.runtimeServices
        ? await persistAdapterManagedRuntimeServices({
            db,
            adapterType: agent.adapterType,
            runId: run.id,
            agent: {
              id: agent.id,
              name: agent.name,
              companyId: agent.companyId,
            },
            issue: issueRef,
            workspace: executionWorkspace,
            reports: adapterResult.runtimeServices,
          })
        : [];
      if (adapterManagedRuntimeServices.length > 0) {
        const combinedRuntimeServices = [
          ...runtimeServices,
          ...adapterManagedRuntimeServices,
        ];
        context.paperclipRuntimeServices = combinedRuntimeServices;
        context.paperclipRuntimePrimaryUrl =
          combinedRuntimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        refreshStepInputManifest(context, taskKey);
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
        if (issueId) {
          try {
            await issuesSvc.addComment(
              issueId,
              buildWorkspaceReadyComment({ language: context.paperclipUserFacingLanguage === "ko" ? "ko" : "en",
                workspace: executionWorkspace,
                runtimeServices: adapterManagedRuntimeServices,
              }),
              { agentId: agent.id, enqueuePlanQaWakeup },
            );
          } catch (err) {
            await onLog(
              "stderr",
              `[paperclip] Failed to post adapter-managed runtime comment: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
      }
      const nextSessionState = resolveNextSessionState({
        codec: sessionCodec,
        adapterResult,
        previousParams: previousSessionParams,
        previousDisplayId: runtimeForAdapter.sessionDisplayId,
        previousLegacySessionId: runtimeForAdapter.sessionId,
      });
      const persistedSessionIdAfter =
        nextSessionState.displayId ??
        nextSessionState.legacySessionId ??
        earlySessionIdAfter ??
        null;
      let instructionDeliveryConfirmed = false;
      try {
        instructionDeliveryConfirmed = await confirmInstructionInjectionDelivery({
          db,
          context,
          plan: instructionInjectionPlan,
          providerSessionId: persistedSessionIdAfter,
          adapterProcessStarted,
        });
      } catch (err) {
        logger.warn(
          { err, agentId: agent.id, issueId, runId: run.id },
          "failed to confirm instruction injection delivery",
        );
      }
      if (!instructionDeliveryConfirmed && instructionInjectionPlan && adapterProcessStarted) {
        try {
          await invalidateInstructionInjectionSession({ db, plan: instructionInjectionPlan });
          logger.warn(
            { agentId: agent.id, issueId, runId: run.id },
            "instruction injection delivery was not confirmed; next run will use full instructions",
          );
        } catch (err) {
          logger.warn(
            { err, agentId: agent.id, issueId, runId: run.id },
            "failed to invalidate unconfirmed instruction injection session",
          );
        }
      }
      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
      const latestRun = await getRun(run.id);
      const latestTerminalRun = latestRun && isTerminalHeartbeatRunStatus(latestRun.status) ? latestRun : null;
      if (latestTerminalRun?.status === "cancelled") {
        outcome = "cancelled";
      } else if (latestTerminalRun?.status === "timed_out") {
        outcome = "timed_out";
      } else if (latestTerminalRun?.status === "failed") {
        outcome = "failed";
      } else if (latestTerminalRun?.status === "succeeded") {
        outcome = "succeeded";
      } else if (adapterResult.timedOut) {
        outcome = "timed_out";
      } else if ((adapterResult.exitCode ?? 0) === 0 && !adapterResult.errorMessage) {
        outcome = "succeeded";
      } else {
        outcome = "failed";
      }
      const codexAuthAutoBlock =
        outcome === "failed"
          ? detectCodexAuthFailureForAutoBlock({
              adapterType: agent.adapterType,
              errorCode: adapterResult.errorCode ?? null,
              errorMessage: adapterResult.errorMessage ?? null,
              stdoutExcerpt: runLog.stdoutExcerpt,
              stderrExcerpt: runLog.stderrExcerpt,
            })
          : null;

      const logSummary = await runLog.finalize();
      const canonicalEvidence = await buildCanonicalActualTerminalEvidence({
        result: adapterResult,
        nextSessionState,
        persistedSessionIdAfter,
        logSummary,
      });
      canonicalActualTerminalEvidence = canonicalEvidence.terminalEvidence;
      const { normalizedUsage, usageJson } = canonicalEvidence;

      const status =
        outcome === "succeeded"
          ? "succeeded"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "timed_out"
              ? "timed_out"
              : "failed";

        if (codexAuthAutoBlock) {
          try {
            await pauseAgentForReauthRequired(agent.id, codexAuthAutoBlock);
          } catch (pauseErr) {
            await onLog(
              "stderr",
              `[paperclip] Failed to mark agent reauth_required after codex auth failure: ${
                pauseErr instanceof Error ? pauseErr.message : String(pauseErr)
              }\n`,
            );
          }
        }

        if (
          codexAuthAutoBlock &&
          issueId &&
          issueContext?.status === "in_progress" &&
          issueContext.assigneeAgentId === agent.id
        ) {
          try {
            const autoBlockedIssue = await issuesSvc.update(issueId, {
              status: "blocked",
              workflowSyncSource: "heartbeat_codex_autoblock",
            });
            if (autoBlockedIssue) {
              const { workflowService } = await import("./workflow/engine.js");
              await workflowService.syncRunStatusForIssue(db, autoBlockedIssue.id, "heartbeat_codex_autoblock");
              await syncSrbSourceIssueStatus({
                db,
                issueId: autoBlockedIssue.id,
                status: autoBlockedIssue.status,
              });
            }
            await issuesSvc.addComment(
              issueId,
              buildCodexAuthAutoBlockedComment({
                ...codexAuthAutoBlock,
                runId: run.id,
              }),
              { agentId: agent.id, enqueuePlanQaWakeup },
            );
          } catch (autoBlockErr) {
            await onLog(
              "stderr",
              `[paperclip] Failed to auto-block issue after codex auth failure: ${
                autoBlockErr instanceof Error ? autoBlockErr.message : String(autoBlockErr)
              }\n`,
            );
          }
      }

      const completedRun = { ...run, status } as typeof heartbeatRuns.$inferSelect;
      await updateRuntimeState(agent, completedRun, adapterResult, {
          legacySessionId: nextSessionState.legacySessionId,
        }, normalizedUsage);
      if (effectiveTaskKey) {
        if (adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)) {
          await clearTaskSessions(agent.companyId, agent.id, {
            taskKey: effectiveTaskKey,
            adapterType: agent.adapterType,
          });
        } else {
          await upsertTaskSession({
            companyId: agent.companyId,
            agentId: agent.id,
            adapterType: agent.adapterType,
            taskKey: effectiveTaskKey,
            sessionParamsJson: nextSessionState.params,
            sessionDisplayId: nextSessionState.displayId,
            lastRunId: completedRun.id,
            lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
          });
        }
      }
      // Touch the mission session record when missionId is present, to update
      // lastActiveAt and increment runCount for idle-timeout tracking.
      if (missionId) {
        const msnStore = missionSessionStore(db);
        if (missionSessionBinding) {
          await persistMissionSessionBinding({
            agent,
            sessionSecretId: missionSessionBinding.session.sessionSecretId,
            sessionId: nextSessionState.legacySessionId,
          }).catch((err) => {
            logger.warn({ err, missionId, agentId: agent.id }, "failed to persist mission session binding");
          });
          await msnStore.touch(missionSessionBinding.session.id).catch((err) => {
            logger.warn({ err, missionId, agentId: agent.id }, "failed to touch mission session");
          });
        }
      }

      // Evidence columns shared by both branches below. When the run was
      // terminalized externally while the adapter was still executing (issue
      // done/cancelled/blocked via finalizeLinkedRunsForIssueStatus, cancel, or
      // reap), status/finishedAt/error stay owned by that path — but the
      // adapter result still carries the factual record of what the process
      // actually did (exit code, signal, usage, final session, log summary).
      // Backfill those so externally-terminalized runs keep their evidence
      // (usage accounting, session lineage, log integrity) instead of landing
      // terminal with every evidence column null.
      const terminalEvidence = canonicalEvidence.terminalEvidence;
      const finalizedRun = latestTerminalRun
        ? await backfillTerminalRunEvidence(run.id, terminalEvidence)
        : await setRunStatus(run.id, status, {
          finishedAt: new Date(),
          error:
            outcome === "succeeded"
              ? null
              : redactCurrentUserText(
                adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
                currentUserRedactionOptions,
              ),
          errorCode:
            outcome === "timed_out"
              ? "timeout"
              : outcome === "cancelled"
                ? "cancelled"
                : outcome === "failed"
                  ? runLog.runawayTriggered
                    ? "runaway_context"
                    : (adapterResult.errorCode ?? "adapter_failed")
                  : null,
          ...terminalEvidence,
        }, { expectedStatuses: ["running"] });

      await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
        finishedAt: latestTerminalRun?.finishedAt ?? new Date(),
        error: latestTerminalRun?.error ?? adapterResult.errorMessage ?? null,
      });

      if (finalizedRun) {
        await finalizeHermesChatRun(db, finalizedRun.id).catch((err) => {
          logger.warn({ err, runId: finalizedRun.id }, "failed to finalize Hermes chat response");
        });
        if (!latestTerminalRun) {
          await appendRunEvent(finalizedRun, seq++, {
            eventType: "lifecycle",
            stream: "system",
            level: outcome === "succeeded" ? "info" : "error",
            message: `run ${outcome}`,
            payload: {
              status,
              exitCode: adapterResult.exitCode,
            },
          });
        }
        if (missionAgentRuntimeForRun && missionId) {
          const resultSummary = summarizeHeartbeatRunResultJson(adapterResult.resultJson ?? null);
          const summaryText =
            (typeof resultSummary?.summary === "string" ? resultSummary.summary : null) ??
            (typeof resultSummary?.result === "string" ? resultSummary.result : null) ??
            (typeof resultSummary?.message === "string" ? resultSummary.message : null) ??
            (typeof resultSummary?.error === "string" ? resultSummary.error : null) ??
            adapterResult.errorMessage ??
            `Heartbeat run ${status}`;
          const handoffMarkdown = buildMissionIssueHandoffMarkdown({
            missionId,
            issueId: issueContext?.id ?? issueId ?? null,
            agentId: agent.id,
            runId: finalizedRun.id,
            status,
            issueGoal: issueContext?.description ?? issueContext?.title ?? null,
            summaryText,
            evidenceRefs: [
              { type: "heartbeat_run", id: finalizedRun.id, description: `Run ended with ${status}` },
              ...(finalizedRun.logSha256 ? [{ type: "run_log", id: finalizedRun.logSha256, description: "Finalized run log sha256" }] : []),
            ],
          });
          const handoff = await persistMissionIssueHandoff(db, {
            companyId: agent.companyId,
            missionId,
            issueId: issueContext?.id ?? issueId ?? null,
            agentId: agent.id,
            runId: finalizedRun.id,
            missionSessionId: missionSessionBinding?.session.id ?? null,
            status,
            handoffMarkdown,
            handoffJson: {
              issueGoal: issueContext?.description ?? issueContext?.title ?? undefined,
              actionsTaken: [summaryText],
              evidence: [
                { type: "heartbeat_run", id: finalizedRun.id, description: `Run ended with ${status}` },
              ],
              importantCaveats: ["Handoff is generated from runtime result summary; verify evidence refs before relying on completion claims."],
              stateDelta: { status, runId: finalizedRun.id },
              recommendedNextPrompt: `Continue mission ${missionId}; reconcile handoff ${finalizedRun.id} before selecting next issue.`,
            },
            evidenceRefsJson: [
              { type: "heartbeat_run", id: finalizedRun.id, description: `Run ended with ${status}` },
            ],
          });
          await updateMissionRollingStateFromHandoff(db, {
            companyId: agent.companyId,
            missionId,
            runId: finalizedRun.id,
            issueId: issueContext?.id ?? issueId ?? null,
            handoffId: handoff.id,
            status,
            summaryText,
            // [A안] 지속화된 핸드오프 행의 구조화된 결정 델타를 롤링 상태 결정 로그로
            // 병합한다. 런타임 생성 handoffJson에는 결정이 없으므로 오늘은 undefined —
            // 결정을 실은 생산자(향후 에이전트 제출 경로)가 생기면 자동으로 흐른다.
            decisionUpdates: handoff.handoffJson?.decisionUpdates ?? undefined,
            evidenceVerifyRoots: [executionWorkspace.cwd],
            inputTokens: normalizedUsage?.inputTokens ?? null,
            outputTokens: normalizedUsage?.outputTokens ?? null,
            costCents: missionRuntimeCostCents(adapterResult.costUsd),
          });
          await completeMissionAgentRuntimeRun(db, {
            runtimeId: missionAgentRuntimeForRun.runtime.id,
            status,
            sessionId: persistedSessionIdAfter,
            inputTokens: normalizedUsage?.inputTokens ?? null,
            outputTokens: normalizedUsage?.outputTokens ?? null,
            costCents: missionRuntimeCostCents(adapterResult.costUsd),
            error: outcome === "succeeded" ? null : adapterResult.errorMessage ?? status,
          });
        }
        let queuedAdapterFallbackRun: typeof heartbeatRuns.$inferSelect | null = null;
        let transientAdapterRetryQueued = false;
        // Adapter failures can use a fallback command, but do not repeat the same
        // fallback after a deterministic provider/model configuration failure.
        if (outcome === "failed" && finalizedRun) {
          // [run stability] 일시 adapter_failed(실측 평균 107초)는 같은 설정으로 1회만
          //   자동 재시도한다. 재시도 우선 — fallback 명령은 재시도도 실패한 다음에 쓴다.
          const transientRetryMaxSec = resolveAdapterFailedTransientRetryMaxSec();
          const failedErrorCode = finalizedRun.errorCode ?? adapterResult.errorCode ?? null;
          const finishedRef = finalizedRun.finishedAt ?? new Date();
          const runDurationSec = finalizedRun.startedAt
            ? Math.max(0, (finishedRef.getTime() - finalizedRun.startedAt.getTime()) / 1000)
            : Number.POSITIVE_INFINITY;
          const transientRetryQueued =
            failedErrorCode === "adapter_failed" &&
            transientRetryMaxSec > 0 &&
            (finalizedRun.processLossRetryCount ?? 0) < 1 &&
            runDurationSec <= transientRetryMaxSec &&
            // 결정적 provider/model 설정 실패는 재시도로 나아지지 않는다.
            !isTerminalAdapterFallbackConfigurationFailure(finalizedRun) &&
            // fallback 실행 자체의 실패는 fallback 시도 카운팅을 존중해 재시도하지 않는다.
            !readNonEmptyString(parseObject(finalizedRun.contextSnapshot).fallbackOfRunId)
              ? await enqueueProcessLossRetry(retryEnqueueDeps, finalizedRun, agent, new Date(), {
                  kind: "adapter_failed_transient",
                }).then(
                  (retryRun) => {
                    appendRunEvent(finalizedRun, seq++, {
                      eventType: "lifecycle",
                      stream: "system",
                      level: "warn",
                      message: `Run failed (transient adapter failure) — queued automatic retry ${retryRun?.id ?? ""}`.trim(),
                      payload: {
                        exitCode: adapterResult.exitCode ?? null,
                        errorMessage: adapterResult.errorMessage ?? null,
                        retryRunId: retryRun?.id ?? null,
                        runDurationSec: Number.isFinite(runDurationSec) ? Math.round(runDurationSec) : null,
                      },
                    }).catch(() => undefined);
                    return Boolean(retryRun);
                  },
                ).then((queued) => {
                  transientAdapterRetryQueued = transientAdapterRetryQueued || queued;
                  return queued;
                }).catch(() => false)
              : false;
          if (!transientRetryQueued) {
          const fb = resolveAdapterFallbackConfig(agent.adapterConfig);
          if (fb && shouldQueueRunFailureAdapterFallback({ run: finalizedRun, fallback: fb })) {
            const fallbackRun = await enqueueAdapterFallbackRun(retryEnqueueDeps, finalizedRun, agent, new Date(), {
              fallbackCommand: fb.command,
              fallbackProvider: fb.provider,
              fallbackModel: fb.model,
              fallbackThinking: resolveAdapterFallbackThinking(
                fb,
                resolveAdapterFallbackAttempt(finalizedRun.contextSnapshot) + 1,
              ),
              fallbackReason: "run_failed",
            });
            queuedAdapterFallbackRun = fallbackRun;
            await appendRunEvent(finalizedRun, seq++, {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: `Run failed — queued fallback ${fallbackRun?.id ?? ""}`.trim(),
              payload: {
                exitCode: adapterResult.exitCode ?? null,
                errorMessage: adapterResult.errorMessage ?? null,
                fallbackRunId: fallbackRun?.id ?? null,
              },
            });
          } else if (fb) {
            await appendRunEvent(finalizedRun, seq++, {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: "Run failed - adapter fallback suppressed",
              payload: {
                exitCode: adapterResult.exitCode ?? null,
                errorMessage: adapterResult.errorMessage ?? null,
                fallbackCommand: fb.command,
                fallbackAttempt: resolveAdapterFallbackAttempt(finalizedRun.contextSnapshot),
                reason: isTerminalAdapterFallbackConfigurationFailure(finalizedRun)
                  ? "terminal_fallback_configuration_failure"
                  : "fallback_attempt_limit_reached",
              },
            });
          }
          }
        }
        if (!queuedAdapterFallbackRun && !transientAdapterRetryQueued) {
          const releaseDisposition = await releaseFinishedRun(finalizedRun);
          // [instant-advance v1.2] 런 종결+이슈 정산 커밋 후 즉시 진행. fallback/retry 재큐 시엔 스텝이
          // 아직 미종결(재시도 런이 완료 시점에 훅 발화)이라 스킵한다.
          if (releaseDisposition.kind === "legacy") fireInstantWorkflowAdvanceForTerminalRun(finalizedRun);
        }
      }
      await finalizeAgentStatus(agent.id, outcome);
    } catch (err) {
      // The transaction/guard can reject before the adapter Promise settles. Wait only for
      // the actual Promise captured at adapter.execute; an uninvoked adapter stays unknown.
      const actual = await actualObservation.awaitSettled();
      c5RefusalConfirmed = !c5AdmissionEntered || (!(err instanceof QaRemediationAdmissionHold)
        && (err instanceof QaCorrectionClaimRejected || isC5PreInvocationRollback(err, db, captureQaCorrectionExecutionIdentity(run), "adapter_start")));
      if (c5RefusalConfirmed && adapterStartScope && adapterStartIdentity && actual === null
        && !actualObservation.wasInvoked() && !executionFrame.adapterInvocationAttempted
        && isHeartbeatUnstartedDeferral(err, adapterStartScope, adapterStartIdentity, runtimeExecutionLifecycle)) {
        await runLog.finalizeAfterError();
        const queued = await db.transaction(async (tx) => {
          if (run.wakeupRequestId) {
            const wake = await tx.update(agentWakeupRequests).set({ status: "queued", claimedAt: null, updatedAt: new Date() })
              .where(and(eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, run.companyId),
                eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.runId, run.id), eq(agentWakeupRequests.status, "claimed")))
              .returning({ id: agentWakeupRequests.id });
            if (wake.length !== 1) throw new Error("heartbeat_deferral_wakeup_scope_changed");
          }
          const restored = await setHeartbeatRunStatus(tx as unknown as Db, run.id, "queued", { startedAt: null },
            { expectedStatuses: ["running"], expectedRun: run, deferLiveEvent: true });
          if (!restored) throw new Error("heartbeat_deferral_run_scope_changed");
          return restored;
        });
        if (queued) { publishHeartbeatRunStatus(publishLiveEvent, queued); unstartedShutdownDeferral = true; return; }
      }
      const c5Held = err instanceof C5NotInvokedExecutionError
        && executionFrame.c5NotInvoked?.proof === err.proof;
      if (executionFrame.c5ExecutionOptedIn && !c5Held && !c5RefusalConfirmed && actual === null
        && !executionFrame.adapterInvocationAttempted) {
        executionFrame.ownerReleaseBlocked = true;
        logger.warn({ err, runId }, "opt-in heartbeat adapter start remains held without authenticated no-invocation proof");
        return;
      }
      const message = redactCurrentUserText(
        err instanceof Error ? err.message : "Unknown adapter failure",
        await getCurrentUserRedactionOptions(),
      );
      const errorCode = resolveHeartbeatFailureCode(err, "adapter_failed");
      logger.error({ err, runId }, "heartbeat execution failed");

      const logSummary = await runLog.finalizeAfterError();

      if (actual?.outcome === "fulfilled") {
        const result = actual.value;
        const nextSessionState = resolveNextSessionState({
          codec: sessionCodec,
          adapterResult: result,
          previousParams: previousSessionParams,
          previousDisplayId: runtimeForAdapter.sessionDisplayId,
          previousLegacySessionId: runtimeForAdapter.sessionId,
        });
        const persistedSessionIdAfter = nextSessionState.displayId
          ?? nextSessionState.legacySessionId
          ?? earlySessionIdAfter
          ?? null;
        const terminalEvidence = canonicalActualTerminalEvidence ?? (await buildCanonicalActualTerminalEvidence({
          result,
          nextSessionState,
          persistedSessionIdAfter,
          logSummary,
        })).terminalEvidence;
        canonicalActualTerminalEvidence = terminalEvidence;
        actualEvidencePreserved = await preserveActualRunEvidence(run, terminalEvidence).catch(() => false);
        if (!actualEvidencePreserved) {
          logger.warn({ runId }, "actual adapter result evidence conflicted with the existing heartbeat record; preserved existing values");
        }
        // Keep the guard error diagnostic and settle running→failed, while retaining the
        // returned actual evidence and skipping fallback/retry/session restoration below.
      }

      const failedRun = await setRunStatus(run.id, "failed", {
        error: message,
        errorCode,
        finishedAt: new Date(),
        ...(actual?.outcome === "fulfilled" ? {} : {
          stdoutExcerpt: runLog.stdoutExcerpt,
          stderrExcerpt: runLog.stderrExcerpt,
          logBytes: logSummary?.bytes,
          logSha256: logSummary?.sha256,
          logCompressed: logSummary?.compressed ?? false,
        }),
      }, { expectedStatuses: ["running"] });

      if (c5Held && failedRun?.status === "failed" && failedRun.errorCode === "c5_held_not_invoked"
        && executionFrame.run.status === "running"
        && sameHeartbeatExecutionAttempt(executionFrame.run, failedRun)) {
        executionFrame.c5TerminalWriterSnapshot = failedRun;
      }

      if (failedRun) {
        await failWakeupForFailedHeartbeat(db, failedRun);
        if (!c5Held) await finalizeHermesChatRun(db, failedRun.id).catch((finalizeErr) => {
          logger.warn({ err: finalizeErr, runId: failedRun.id }, "failed to finalize Hermes chat failure response");
        });
        await appendRunEvent(failedRun, seq++, {
          eventType: "error",
          stream: "system",
          level: "error",
          message,
        });
        let queuedAdapterFallbackRun: typeof heartbeatRuns.$inferSelect | null = null;
        let transientAdapterRetryQueued = false;
        // The adapter was invoked, but the scoped child boundary proves no child started.
        // Keep the failed reason and use the existing one-attempt transient retry budget.
        const retryMaxSec = resolveAdapterFailedTransientRetryMaxSec();
        const failedDurationSec = failedRun.startedAt
          ? Math.max(0, ((failedRun.finishedAt ?? new Date()).getTime() - failedRun.startedAt.getTime()) / 1000)
          : Number.POSITIVE_INFINITY;
        if (!c5Held && actual?.outcome === "rejected" && actual.error === err
          && errorCode === "child_process_start_rejected" && adapterStartScope && adapterStartIdentity
          && isHeartbeatUnstartedDeferral(err, adapterStartScope, adapterStartIdentity, runtimeExecutionLifecycle)
          && retryMaxSec > 0 && failedDurationSec <= retryMaxSec && (failedRun.processLossRetryCount ?? 0) < 1
          && !isTerminalAdapterFallbackConfigurationFailure(failedRun)
          && !readNonEmptyString(parseObject(failedRun.contextSnapshot).fallbackOfRunId)) {
          transientAdapterRetryQueued = Boolean(await enqueueProcessLossRetry(retryEnqueueDeps, failedRun, agent, new Date(),
            { kind: "adapter_failed_transient" }).catch(() => null));
        }
        if (!c5Held && (actual === null || (actual.outcome === "rejected" && actual.error === err))
        && errorCode === "adapter_failed") {
          const fb = resolveAdapterFallbackConfig(agent.adapterConfig);
          if (fb && shouldQueueRunFailureAdapterFallback({ run: failedRun, fallback: fb })) {
            const fallbackRun = await enqueueAdapterFallbackRun(retryEnqueueDeps, failedRun, agent, new Date(), {
              fallbackCommand: fb.command,
              fallbackProvider: fb.provider,
              fallbackModel: fb.model,
              fallbackThinking: resolveAdapterFallbackThinking(
                fb,
                resolveAdapterFallbackAttempt(failedRun.contextSnapshot) + 1,
              ),
              fallbackReason: "run_failed",
            });
            queuedAdapterFallbackRun = fallbackRun;
            await appendRunEvent(failedRun, seq++, {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: `Run failed — queued fallback ${fallbackRun?.id ?? ""}`.trim(),
              payload: {
                errorMessage: message,
                fallbackRunId: fallbackRun?.id ?? null,
              },
            });
          } else if (fb) {
            await appendRunEvent(failedRun, seq++, {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: "Run failed - adapter fallback suppressed",
              payload: {
                errorMessage: message,
                fallbackCommand: fb.command,
                fallbackAttempt: resolveAdapterFallbackAttempt(failedRun.contextSnapshot),
                reason: isTerminalAdapterFallbackConfigurationFailure(failedRun)
                  ? "terminal_fallback_configuration_failure"
                  : "fallback_attempt_limit_reached",
              },
            });
          }
        }
        if (!c5Held && missionAgentRuntimeForRun) {
          await completeMissionAgentRuntimeRun(db, {
            runtimeId: missionAgentRuntimeForRun.runtime.id,
            status: "failed",
            sessionId: actual?.outcome === "fulfilled"
              ? readNonEmptyString(actual.value.sessionDisplayId) ?? readNonEmptyString(actual.value.sessionId) ?? null
              : actual === null ? runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId ?? null : null,
            error: message,
          }).catch((runtimeErr) => {
            logger.warn({ err: runtimeErr, runId, agentId: agent.id }, "failed to mark mission runtime failed");
          });
        }
        if (!queuedAdapterFallbackRun && !transientAdapterRetryQueued) {
          const releaseDisposition = await releaseFinishedRun(failedRun);
          // [instant-advance v1.2] 실패도 진행 트리거 — 실패 정산(이슈 blocked/스텝 failed) 커밋 후 즉시 재평가.
          if (!c5Held && releaseDisposition.kind === "legacy") fireInstantWorkflowAdvanceForTerminalRun(failedRun);
        }

        if (!c5Held && actual === null) {
          await updateRuntimeState(agent, failedRun, {
            exitCode: null,
            signal: null,
            timedOut: false,
            errorMessage: message,
          }, {
            legacySessionId: runtimeForAdapter.sessionId,
          });

          if (effectiveTaskKey && (previousSessionParams || previousSessionDisplayId || taskSession)) {
            await upsertTaskSession({
              companyId: agent.companyId,
              agentId: agent.id,
              adapterType: agent.adapterType,
              taskKey: effectiveTaskKey,
              sessionParamsJson: previousSessionParams,
              sessionDisplayId: previousSessionDisplayId,
              lastRunId: failedRun.id,
              lastError: message,
            });
          }
        }
      }

      if (!c5Held) await finalizeAgentStatus(agent.id, "failed");
    }
    } catch (outerErr) {
          // Setup code before adapter.execute threw (e.g. ensureRuntimeState, resolveWorkspaceForRun).
          // The inner catch did not fire, so we must record the failure here.
          const message = outerErr instanceof Error ? outerErr.message : "Unknown setup failure";
          logger.error({ err: outerErr, runId }, "heartbeat execution setup failed");
          // [quality-cancel race] 비종말→failed 원자 전이만 시도한다. 외부 취소/reap/finalize 가 이미
          // 종말 상태를 쓴 경우(판독→기록 사이에 끼어드는 창 포함) 그 상태를 되찾지 않는다. 완료
          // 경로의 외부 종말 계약(외부 종말 시 증거만 backfill, :7951)과 동일 규칙이지만 여기서는
          // 단일 조건부 UPDATE 로 원자적으로 판정하고, 판정 결과로 run/wakeup 후속 기록을 파생한다.
          // 재시도/대체 쓰기는 없다(판정 실패면 종말 기록을 건너뛰고 아래 증거 이벤트로 계속한다).
          const setupFailedRun = await db
            .update(heartbeatRuns)
            .set({
              status: "failed",
              error: message,
              errorCode: resolveHeartbeatFailureCode(outerErr, "adapter_failed"),
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(and(eq(heartbeatRuns.id, runId), inArray(heartbeatRuns.status, ["queued", "running"])))
            .returning()
            .then((rows) => rows[0] ?? null)
            .catch(() => null);
          if (setupFailedRun) {
            await setWakeupStatus(run.wakeupRequestId, "failed", {
              finishedAt: new Date(),
              error: message,
            }).catch(() => undefined);
            // setRunStatus 가 종말 전이 직후 수행하는 관측 파생 기록을 동일하게 유지한다.
            await recordHeartbeatTerminalOutcomeShadow(db, setupFailedRun).catch(() => undefined);
            publishLiveEvent({
              companyId: setupFailedRun.companyId,
              type: "heartbeat.run.status",
              payload: {
                runId: setupFailedRun.id,
                agentId: setupFailedRun.agentId,
                status: setupFailedRun.status,
                invocationSource: setupFailedRun.invocationSource,
                triggerDetail: setupFailedRun.triggerDetail,
                error: setupFailedRun.error ?? null,
                errorCode: setupFailedRun.errorCode ?? null,
                startedAt: setupFailedRun.startedAt ? new Date(setupFailedRun.startedAt).toISOString() : null,
                finishedAt: setupFailedRun.finishedAt ? new Date(setupFailedRun.finishedAt).toISOString() : null,
              },
            });
            await recordHeartbeatRunTerminalTransitionEvent(db, setupFailedRun).catch(() => undefined);
            await maybeRecordTerminalFinalization(db, setupFailedRun, new Date()).catch(() => undefined);
          }
          const failedRun = await getRun(runId).catch(() => null);
          if (failedRun) {
            // Emit a run-log event so the failure is visible in the run timeline,
            // consistent with what the inner catch block does for adapter failures.
            await appendRunEvent(failedRun, 1, {
              eventType: "error",
              stream: "system",
              level: "error",
              message,
            }).catch(() => undefined);
            const releaseInput = executionFrame.c5NotInvoked
              ? executionFrame.c5TerminalWriterSnapshot ?? failedRun
              : failedRun;
            const releaseDisposition = await releaseFinishedRun(releaseInput)
              .catch(() => holdOwnerRelease("release_finished_run_failed"));
            // [instant-advance v1.2] setup 실패 확정 후에도 워크플로우 런이면 즉시 재평가(실패 스텝 처리 촉진).
            if (!executionFrame.c5NotInvoked && releaseDisposition.kind === "legacy") {
              fireInstantWorkflowAdvanceForTerminalRun(failedRun);
            }
          }
          // Ensure the agent is not left stuck in "running" if the inner catch handler's
          // DB calls threw (e.g. a transient DB error in finalizeAgentStatus).
          await finalizeAgentStatus(run.agentId, "failed").catch(() => undefined);
        } finally {
          if (actualDrainIdentity && (terminalReleaseOptedIn || unresolvedTerminalReleaseHoldReason)
            && !terminalContinuationEventId) {
            const existing = await readTerminalReleaseManifestForSource(db, actualDrainIdentity, run.agentId).catch(error => {
              logger.warn({ err: error, runId: run.id }, "terminal release manifest reentry could not be read");
              return null;
            });
            if (existing?.kind === "found") {
              terminalContinuationEventId = existing.eventId;
              terminalReleaseOptedIn = true;
              unresolvedTerminalReleaseHoldReason = null;
            }
            else if (existing?.kind === "held") logger.warn({ runId: run.id, reason: existing.reason },
              "terminal release manifest remains held before actual cleanup");
          }
          try {
            await finishPauseExecution({
            db,
            releaseRuntimeServicesForRun: async id => {
              cleanupObservation.releaseCalled = true;
              try {
                await releaseRuntimeServicesForRun(id);
                cleanupObservation.releaseSucceeded = true;
              } catch (error) {
                logger.warn({ err: error, runId: id }, "actual-drain runtime-service release failed");
                throw error;
              }
            },
            activeRunExecutions, getRun,
            deferQueuePromotion: unstartedShutdownDeferral || terminalReleaseOptedIn
              || (executionFrame.ownerReleaseBlocked
                && !(executionFrame.c5ExecutionOptedIn && executionFrame.c5NotInvoked
                  && executionFrame.noActualInvocationConfirmed)),
            settleHeartbeatAfterExecution: async (settleDb, settledRun, now) => {
              cleanupObservation.settlementCalled = true;
              try {
                const actual = await actualObservation.awaitSettled();
                if (unresolvedTerminalReleaseHoldReason) {
                  throw new Error(`heartbeat_issue_release_unresolved:${unresolvedTerminalReleaseHoldReason}`);
                }
                if (executionFrame.c5NotInvoked) {
                  if (!executionFrame.noActualInvocationConfirmed || executionFrame.ownerReleaseBlocked
                    || !cleanupObservation.releaseSucceeded || actual !== null || executionFrame.adapterInvocationAttempted) {
                    throw new Error("c5_no_invocation_cleanup_or_owner_release_unproven");
                  }
                  const current = await getRun(settledRun.id);
                  if (!current || !sameHeartbeatExecutionAttempt(executionFrame.run, current)
                    || current.status !== "failed" || current.errorCode !== "c5_held_not_invoked") {
                    throw new Error("c5_no_invocation_terminal_attempt_unproven");
                  }
                  const settlement = await attemptFullSettlement(settleDb, current, now);
                  if (settlement !== "settled" && settlement !== "not_ready") {
                    throw new Error(`c5 no-invocation settlement was blocked: ${settlement}`);
                  }
                  if (settlement === "settled") {
                    const durableRun = await getRun(current.id);
                    if (!durableRun || !sameHeartbeatExecutionAttempt(current, durableRun)
                      || durableRun.finalizationVersion !== 1 || !durableRun.settledAt) {
                      throw new Error("c5 no-invocation settlement is not durable for its exact attempt");
                    }
                  }
                } else if (actualDrainIdentity && actual !== null) {
                  const identity = actualDrainIdentity;
                  const matchesFrozenAttempt = (candidate: typeof heartbeatRuns.$inferSelect) =>
                    candidate.id === identity.heartbeatRunId && candidate.companyId === identity.companyId
                    && candidate.issueId === identity.issueId && candidate.wakeupRequestId === identity.wakeupRequestId
                    && candidate.workflowStepRunId === identity.workflowStepRunId
                    && candidate.workflowExecutionGeneration === identity.executionGeneration
                    && candidate.executionScopeKind === identity.executionScopeKind
                    && candidate.executionEpoch === identity.executionEpoch && candidate.executionToken === identity.executionToken
                    && candidate.executorOwnerId === identity.executorOwnerId
                    && candidate.executorOwnerLeaseEpoch === identity.ownerLeaseEpoch
                    && candidate.executorOwnerLeaseToken === identity.ownerLeaseToken
                    && candidate.retryOfRunId === identity.retryOfRunId
                    && candidate.processLossRetryCount === identity.processLossRetryCount;
                  if (!matchesFrozenAttempt(settledRun)) {
                    throw new Error("heartbeat actual-drain settlement attempt no longer matches its frozen identity");
                  }
                  if (terminalReleaseOptedIn && !terminalContinuationEventId) {
                    throw new Error("terminal_release_manifest_not_committed_before_settlement");
                  }
                  const settlement = await attemptFullSettlement(settleDb, settledRun, now,
                    terminalReleaseOptedIn ? terminalContinuationEventId! : undefined);
                  if (settlement !== "settled" && settlement !== "not_ready") {
                    throw new Error(`heartbeat actual-drain settlement was blocked: ${settlement}`);
                  }
                  const durableRun = await getRun(settledRun.id);
                  if (!durableRun || !matchesFrozenAttempt(durableRun) || durableRun.finalizationVersion !== 1
                    || !durableRun.settledAt) {
                    throw new Error(`heartbeat actual-drain settlement is not durable for its exact attempt: ${settlement}`);
                  }
                } else if ((executionFrame.finalizationVersion === 1 || settledRun.finalizationVersion === 1)
                  && executionFrame.adapterInvocationAttempted) {
                  const current = await getRun(settledRun.id).catch(() => null);
                  const nonworkflow = actual !== null && await positivelyClassifiesNonworkflowV1(
                    settledRun, current, executionFrame,
                  ).catch(() => false);
                  if (!nonworkflow) throw new Error("heartbeat_actual_or_workflow_identity_unobserved");
                  await settleHeartbeatAfterExecution(settleDb, settledRun, now);
                } else {
                  await settleHeartbeatAfterExecution(settleDb, settledRun, now);
                }
                cleanupObservation.settlementSucceeded = true;
              } catch (error) {
                logger.warn({ err: error, runId: settledRun.id }, "actual-drain heartbeat settlement failed");
                throw error;
              }
            },
              requeueCoalescedWakeupsForFinishedRun: (settleDb, input) =>
                unresolvedTerminalReleaseHoldReason || executionFrame.c5NotInvoked
                  ? Promise.resolve(0) : requeueCoalescedWakeupsForFinishedRun(settleDb, input),
              finalizeAgentStatus: executionFrame.c5NotInvoked ? async () => undefined : finalizeAgentStatus,
              startNextQueuedRunForAgent,
            }, run, pauseExecution);
          } finally {
            removeExecutionFrame();
          }
        }
    const actual = await actualObservation.awaitSettled();
    if (actual && actualDrainIdentity) {
      if (unresolvedTerminalReleaseHoldReason) {
        logger.warn({ runId: run.id, reason: unresolvedTerminalReleaseHoldReason },
          "held terminal issue release prevents actual-drain receipt and workflow progress");
      } else {
      let resources: Record<string, boolean> = {};
      try {
        const current = await getRun(run.id);
        if (current) {
          resources = await observeQuiescenceResources(db, current);
          const tracked = runningProcesses.get(run.id);
          let knownChildAlive = Boolean(tracked && tracked.child.exitCode === null && tracked.child.signalCode === null);
          if (current.processPid !== null) {
            try {
              process.kill(current.processPid, 0);
              knownChildAlive = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") knownChildAlive = true;
            }
          }
          if (knownChildAlive) resources = { ...resources, knownChildAlive: false };
        }
      } catch (resourceErr) {
        logger.warn({ err: resourceErr, runId: run.id }, "actual-drain cleanup resource observation failed");
      }
      try {
        const drainActual = (terminalReleaseOptedIn && !terminalContinuationEventId)
          || (actual.outcome === "fulfilled" && !actualEvidencePreserved) ? null : actual;
        const recorded = await writeHeartbeatActualDrain(db, actualDrainIdentity, drainActual, {
          ...cleanupObservation, resources,
        });
        if ((recorded.outcome === "written" || recorded.outcome === "existing") && terminalReleaseOptedIn) {
          if (!terminalContinuationEventId) {
            logger.warn({ runId: run.id, reason: "terminal_release_manifest_missing" },
              "terminal actual drain is durable but its continuation event is unavailable");
          } else {
            const continuation = await runTerminalReleaseContinuation(terminalContinuationEventId);
            if (continuation.kind !== "complete") logger.warn({ runId: run.id,
              continuationEventId: terminalContinuationEventId, reason: continuation.reason },
            "terminal heartbeat followup remains durably pending after actual drain");
          }
        } else if ((recorded.outcome === "written" || recorded.outcome === "existing") && actual.outcome === "fulfilled") {
          try {
            const { syncWorkflowRunState } = await import("./workflow/dag-engine.js");
            await syncWorkflowRunState(db, actualDrainIdentity.workflowRunId, "heartbeat_promotion", { requireRunning: true });
          } catch (syncErr) {
            logger.warn({ err: syncErr, runId: run.id, workflowRunId: actualDrainIdentity.workflowRunId },
              "heartbeat actual-drain workflow re-evaluation failed; durable evidence remains available");
          }
        } else if (recorded.outcome === "held") {
          logger.warn({ runId: run.id, reason: recorded.reason }, "heartbeat actual-drain evidence remains held");
        }
      } catch (recordErr) {
        logger.warn({ err: recordErr, runId: run.id }, "heartbeat actual-drain evidence was not recorded");
      }
      }
    }
    if (c5RootSettlementConfirmed && c5RootNotifications) await drainC5RootNotifications(c5RootNotifications);
  }

  type TerminalIssueReleaseResult = { kind: "release_committed_followup_pending"; continuationEventId: string }
    | { kind: "release_unproven" | "release_deferred" | "release_held"; reason: string };
  async function holdLegacyReleaseForActiveTerminalFrame(run: typeof heartbeatRuns.$inferSelect):
    Promise<TerminalIssueReleaseResult | null> {
    const frame = activeHeartbeatExecutionFramesByDb.get(db)?.get(run.id);
    const blockOwnerRelease = (kind: "release_deferred" | "release_held", reason: string): TerminalIssueReleaseResult => {
      if (frame) frame.ownerReleaseBlocked = true;
      return { kind, reason };
    };
    let current: typeof heartbeatRuns.$inferSelect | null = null;
    try {
      current = await getRun(run.id);
    } catch (error) {
      logger.warn({ err: error, runId: run.id }, "legacy issue release could not reread its heartbeat identity");
      return run.finalizationVersion === 1 || frame?.finalizationVersion === 1 || frame?.actualDrainIdentity
        ? blockOwnerRelease("release_held", "durable_attempt_unreadable")
        : null;
    }
    const expectedV1 = run.finalizationVersion === 1 || current?.finalizationVersion === 1 || frame?.finalizationVersion === 1;
    if (!current) {
      return expectedV1 || frame?.actualDrainIdentity
        ? blockOwnerRelease("release_held", "durable_attempt_missing") : null;
    }
    if (frame?.actualDrainIdentity) {
      if (frame.conflicted || !sameHeartbeatExecutionAttempt(frame.run, current)
        || !sameHeartbeatExecutionAttempt(run, current)
        || !heartbeatActualIdentityMatchesRun(frame.actualDrainIdentity, current)) {
        return blockOwnerRelease("release_held", "active_frame_frozen_identity_mismatch");
      }
      if (frame.noActualInvocationConfirmed && !frame.adapterInvocationAttempted && !frame.actualCaptured) return null;
      return blockOwnerRelease("release_deferred", frame.actualCaptured
        ? "active_terminal_actual_owns_release" : "active_terminal_actual_invocation_pending");
    }
    if (!expectedV1) return null;
    if (await positivelyClassifiesNonworkflowV1(run, current, frame).catch(() => false)) return null;
    if (!frame) return blockOwnerRelease("release_held", "active_terminal_frame_unobserved");
    if (frame.conflicted || !sameHeartbeatExecutionAttempt(frame.run, current)
      || !sameHeartbeatExecutionAttempt(run, current)) {
      return blockOwnerRelease("release_held", "active_frame_attempt_mismatch");
    }
    if (frame.noActualInvocationConfirmed && !frame.adapterInvocationAttempted && !frame.actualCaptured) return null;
    const identity = frame.actualDrainIdentity;
    if (frame.identityObserved && !identity) {
      return blockOwnerRelease("release_held", "active_terminal_identity_missing");
    }
    if (identity && !heartbeatActualIdentityMatchesRun(identity, current)) {
      return blockOwnerRelease("release_held", "active_frame_frozen_identity_mismatch");
    }
    if (frame.actualCaptured) {
      return identity
        ? blockOwnerRelease("release_deferred", "active_terminal_actual_owns_release")
        : blockOwnerRelease("release_held", "active_terminal_actual_identity_unobserved");
    }
    if (frame.adapterInvocationAttempted) {
      return blockOwnerRelease("release_held", "active_terminal_actual_capture_unobserved");
    }
    return blockOwnerRelease("release_deferred", "active_terminal_actual_invocation_pending");
  }
  function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect,
    options: { readonly skipLocked?: boolean; readonly resumeQueue?: boolean; readonly terminalSource: HeartbeatActualDrainIdentity }):
    Promise<TerminalIssueReleaseResult>;
  function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect,
    options?: { readonly skipLocked?: boolean; readonly resumeQueue?: boolean }): Promise<void | TerminalIssueReleaseResult>;
  async function releaseIssueExecutionAndPromote(
    run: typeof heartbeatRuns.$inferSelect,
    options: { readonly skipLocked?: boolean; readonly resumeQueue?: boolean;
      readonly terminalSource?: HeartbeatActualDrainIdentity } = {},
  ): Promise<void | TerminalIssueReleaseResult> {
    const terminalSource = options.terminalSource;
    if (!terminalSource) {
      const disposition = await holdLegacyReleaseForActiveTerminalFrame(run);
      if (disposition) return disposition;
    }
    const terminalProspective = terminalSource ? createTerminalReleaseManifest(terminalSource, run.agentId, [
      { stage: "issue_promotion", action: { kind: "promote_issue_wakes", companyId: terminalSource.companyId,
        issueId: terminalSource.issueId } },
      { stage: "issue_promotion", action: { kind: "promote_agent_queue", companyId: terminalSource.companyId,
        agentId: run.agentId } },
      { stage: "workflow_evidence_sync", action: { kind: "sync_issue", companyId: terminalSource.companyId,
        issueId: terminalSource.issueId } },
      { stage: "workflow_evidence_sync", action: { kind: "reevaluate_source" } },
    ]) : null;
    let terminalContinuationEventId: string | null = null;
    let terminalReleaseCommitEligible = false;
    if (terminalSource) {
      if (!terminalProspective || !terminalReleaseMatchesRun(terminalProspective.source, run)) {
        return { kind: "release_unproven", reason: "frozen_actual_run_mismatch" };
      }
      const prior = await readTerminalReleaseManifestForSource(db, terminalSource, run.agentId);
      if (prior.kind === "found") {
        const retained = await db.transaction(async tx => {
          const [lockedRun] = await tx.select().from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, terminalSource.heartbeatRunId), eq(heartbeatRuns.companyId, terminalSource.companyId),
          )).for("key share");
          const [lockedIssue] = await tx.select().from(issues).where(and(
            eq(issues.id, terminalSource.issueId), eq(issues.companyId, terminalSource.companyId),
          )).for("update");
          const current = await readTerminalReleaseManifestForSource(tx, terminalSource, run.agentId);
          if (!lockedRun || !lockedIssue || lockedIssue.missionId !== terminalSource.missionId
            || !terminalReleaseMatchesRun(prior.manifest.source, lockedRun)
            || current.kind !== "found" || current.eventId !== prior.eventId
            || lockedIssue.executionRunId === terminalSource.heartbeatRunId
            || lockedIssue.checkoutRunId === terminalSource.heartbeatRunId) {
            return { kind: "held" as const, reason: "terminal_release_reentry_owner_or_source_changed" };
          }
          // The accepted event proves the original owner-clear commit. A later owner is retained verbatim.
          return { kind: "found" as const, eventId: current.eventId };
        });
        return retained.kind === "found"
          ? { kind: "release_committed_followup_pending", continuationEventId: retained.eventId }
          : { kind: "release_unproven", reason: retained.reason };
      }
      if (prior.kind === "held") return { kind: "release_unproven", reason: prior.reason };
    }
    const postTransactionWorkflowIssueSyncIssueIds = new Set<string>();
    const queuePostTransactionWorkflowIssueSync = (issueId: string | null | undefined) => {
      if (issueId) postTransactionWorkflowIssueSyncIssueIds.add(issueId);
    };
    // [GAZ-315] mission_main_executor_unblock 은 raw tx.update(done) auto-complete 로 닫히면
    //   assertCanCompleteOwnerActionWithHandback 가 우회된다. checkout 필드는 tx 내에서 정리하되
    //   done 전환은 post-tx completeUnblockActionWithSourceHandback(issueService.update → guard) 에게
    //   넘긴다. owner-recovery happy path 는 유지된다(report 기록 → guard 통과 → done).
    const postTransactionUnblockCompletions: Array<{ issueId: string; companyId: string; agentId: string | null }> = [];
    const queuePostTransactionUnblockCompletion = (entry: { issueId: string; companyId: string; agentId: string | null }) => {
      postTransactionUnblockCompletions.push(entry);
    };
    const postTransactionDelegatedArtifactHandbacks: Array<{
      childIssueId: string;
      childWorkProductId: string;
      sourceRunId: string;
    }> = [];
    // [slice-4 closeout evidence gate] post-tx bounded re-dispatch / exception card for runs that
    //   succeeded without the completion evidence their issue contract requires. Budget-capped:
    //   attempts 1..MISSING_EVIDENCE_REDISPATCH_BUDGET re-dispatch (when no live wake coverage),
    //   beyond that a single operator_decisions exception card (requestKey missing-evidence:<issueId>).
    const MISSING_EVIDENCE_REDISPATCH_BUDGET = 2;
    const MISSING_EVIDENCE_REQUIRED_ACTION = "register the required work product via the official Workflow API and call workflow/complete";
    const postTransactionMissingEvidenceRedispatches: Array<{
      companyId: string; issueId: string; agentId: string; missionId: string | null;
      attempt: number; requiredAction: string;
    }> = [];
    const transactionResult = await withTxTimeout(db, async (tx) => {
      // [recovery liveness hardening] recovery lane(skipLocked=true) 에서만 행 락 대기가 lane 을
      // 막지 않도록 bounded 한다: lock_timeout/statement_timeout + FOR UPDATE SKIP LOCKED 로
      // 이미 잠긴 issue 는 건너뛴다(빈 결과 → 조기 반환, 다음 recovery tick 에 재시도).
      // 정상 run 종료 경로(skipLocked=false) 는 기존 FOR UPDATE 동작 유지 — 락 획득 실패는
      // 예외로 전파되어 호출부가 재처리 근거를 가진다.
      const skipLocked = options.skipLocked === true;
      // [D2 lock-order] 이 release 트랜잭션은 issues FOR UPDATE → activity_log(run_id FK →
      // heartbeat_runs KEY SHARE) 순서로 잠금을 요구한다. 러너 세팅의 resume 직렬화 트랜잭션
      // (withResumeSerialization → readProducer(lock=true))은 heartbeat_runs FOR UPDATE 를 먼저
      // 잡고 mission_agent_runtimes(current_issue_id FK → issues KEY SHARE)를 나중에 요구한다.
      // 순서가 반대여서 취소×세팅 동시 창에서 AB-BA 교착(40P01)이 실증됐다. 양 레인 모두
      // run 행을 먼저 잡도록 첫 잠금 문장으로 run 행 선점을 추가한다.
      // 선점은 FOR UPDATE 가 아니라 FOR KEY SHARE 로 한다(실측 근거: FOR UPDATE 선점은 run 행을
      // 트랜잭션 전체 기간 배타적으로 붙잡아 heartbeat_run_events/activity_log 의 run_id FK
      // KEY SHARE 수요와 종말 상태 UPDATE 를 전부 대기시키고, 대기가 연결을 붙잡은 채 쌓이면
      // 풀 고갈로 release 트랜잭션 자체가 진행 불능이 된다 — 2026-09-12 라이브 샘플러 관찰).
      // FOR KEY SHARE 는 교착 상대(readProducer 의 FOR UPDATE)와만 충돌하고 KEY SHARE 수요와는
      // 양립하므로, 이후 activity_log 의 run_id FK 검사는 자기 잠금으로 충족되어 대기 없이 통과된다.
      //   - 정상 레인: 행이 없어도 그대로 진행한다(기존 동작 보존 — 없는 행은 사이클에 참여할 수
      //     없고, activity_log run_id FK 위반은 종전과 같은 지점에서 같게 발화한다).
      //   - 복구 레인: 기존 issues SKIP LOCKED 의 조기 반환 계약과 동일하게, run 행이 강한 잠금에
      //     잡혀 있으면 null 조기 반환(다음 recovery tick 재시도). 기존 lock_timeout GUC 가 이
      //     선점 대기도 함께 bound 한다(기존 issues SKIP LOCKED 문장 자체는 변경하지 않는다).
      if (skipLocked) {
        await tx.execute(sql`set local lock_timeout = '8s'`);
        await tx.execute(sql`set local statement_timeout = '30s'`);
        const prelockedRunRow = await tx.execute(
          sql`select id from heartbeat_runs where id = ${run.id} and company_id = ${run.companyId} for key share skip locked`,
        );
        if (!((Array.isArray(prelockedRunRow) ? prelockedRunRow : []).length > 0)) {
          return null;
        }
        const lockedRows = await tx.execute(
          sql`select id from issues where company_id = ${run.companyId} and (execution_run_id = ${run.id} or checkout_run_id = ${run.id} or id = ${run.issueId}) for update skip locked`,
        );
        const lockedList = Array.isArray(lockedRows) ? lockedRows : [];
        if (lockedList.length === 0) {
          return null;
        }
      } else {
        await tx.execute(
          sql`select id from heartbeat_runs where id = ${run.id} and company_id = ${run.companyId} for key share`,
        );
        await tx.execute(
          sql`select id from issues where company_id = ${run.companyId} and (execution_run_id = ${run.id} or checkout_run_id = ${run.id}) for update`,
        );
      }

      const issue = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          missionId: issues.missionId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          description: issues.description,
          originKind: issues.originKind,
          originId: issues.originId,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
          startedAt: issues.startedAt,
        })
        .from(issues)
        .where(
          terminalSource
            ? and(eq(issues.companyId, terminalSource.companyId), eq(issues.id, terminalSource.issueId))
            : and(eq(issues.companyId, run.companyId), run.issueId
              ? or(eq(issues.executionRunId, run.id), eq(issues.checkoutRunId, run.id), eq(issues.id, run.issueId))
              : or(eq(issues.executionRunId, run.id), eq(issues.checkoutRunId, run.id))),
        )
        .then((rows) => rows[0] ?? null);

      if (!issue) return;

      if (terminalSource) {
        const prior = await readTerminalReleaseManifestForSource(tx, terminalSource, run.agentId);
        if (prior.kind === "found") {
          terminalContinuationEventId = prior.eventId;
          return null;
        }
        if (prior.kind === "held") throw new Error(`terminal_release_manifest_reentry_held:${prior.reason}`);
        const [lockedRun] = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, terminalSource.heartbeatRunId), eq(heartbeatRuns.companyId, terminalSource.companyId),
        )).for("key share");
        if (!lockedRun || !terminalProspective || !terminalReleaseMatchesRun(terminalProspective.source, lockedRun)
          || issue.id !== terminalSource.issueId || issue.companyId !== terminalSource.companyId
          || (issue.executionRunId !== run.id && issue.checkoutRunId !== run.id)
          || (issue.executionRunId !== null && issue.executionRunId !== run.id)
          || (issue.checkoutRunId !== null && issue.checkoutRunId !== run.id)) {
          throw new Error("terminal_release_exact_issue_owner_unproven");
        }
        terminalReleaseCommitEligible = true;
      }

      try {

      const runAgent = await tx
        .select({
          id: agents.id,
          name: agents.name,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
          runtimeConfig: agents.runtimeConfig,
        })
        .from(agents)
        .where(eq(agents.id, run.agentId))
        .then((rows) => rows[0] ?? null);
      const usage = parseObject(run.usageJson);
      const agentAdapterConfig = parseObject(runAgent?.adapterConfig);
      const agentRuntimeConfig = parseObject(runAgent?.runtimeConfig);
      const classification = classifyHeartbeatRunFailure({
        status: run.status,
        adapterType: runAgent?.adapterType ?? null,
        errorCode: run.errorCode,
        errorMessage: run.error,
        stdoutExcerpt: run.stdoutExcerpt,
        stderrExcerpt: run.stderrExcerpt,
        provider: readNonEmptyString(usage.provider),
        model: readNonEmptyString(usage.model),
        command: readNonEmptyString(agentAdapterConfig.command) ?? readNonEmptyString(agentRuntimeConfig.command),
      });

      // Agent self-learning wiki (Phase 1): provider overload / runaway-stdout 패턴 기록 (non-blocking).
      if (classification.category === "overload") {
        fireWikiRecord(wikiSvc, {
          companyId: run.companyId,
          agentId: run.agentId,
          pattern: "provider overload (529/503/500)",
          cause: "외부 LLM provider 일시 과부하(500/503/529)로 요청을 거부/재시도.",
          solution: "adapter가 exponential backoff 재시도를 수행. 회복 후 자동 재개되므로 즉시 수동 개입은 불필요.",
          errorCode: classification.reasonCode ?? "provider_overload",
        }, run.id);
      }
      if (/\bstdout\b.{0,40}exceeded|runaway output/i.test(run.stderrExcerpt ?? "")) {
        fireWikiRecord(wikiSvc, {
          companyId: run.companyId,
          agentId: run.agentId,
          pattern: "adapter 자식 stdout 폭발",
          cause: "어댑터 자식 프로세스가 stdout을 닫지 않고 무한 출력 → event loop 독점 → 64MB cap-kill.",
          solution: "자식의 대량 stdout은 파일 리다이렉트 후 tail. 명령/플래그로 스트리밍 출력 억제.",
          errorCode: "child_stdout_runaway_capkill",
        }, run.id);
      }
      const heartbeatFailureWikiLesson = buildHeartbeatFailureWikiLesson({
        classification,
        runStatus: run.status,
        runErrorCode: run.errorCode,
      });
      if (heartbeatFailureWikiLesson) {
        fireWikiRecord(wikiSvc, {
          companyId: run.companyId,
          agentId: run.agentId,
          ...heartbeatFailureWikiLesson,
        }, run.id);
      }

      const isLinkedToRun = issue.checkoutRunId === run.id || issue.executionRunId === run.id || issue.id === run.issueId;
      const latestIssueRunId = run.status === "succeeded" && issue.status === "todo" && issue.id === run.issueId
        ? await tx
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(and(eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.issueId, issue.id)))
            .orderBy(desc(heartbeatRuns.createdAt))
            .limit(1)
            .then((rows) => rows[0]?.id ?? null)
        : null;
      const isRecoverableTodoSuccessfulRun =
        run.status === "succeeded" &&
        isLinkedToRun &&
        issue.status === "todo" &&
        !!issue.missionId &&
        issue.id === run.issueId &&
        latestIssueRunId === run.id &&
        issue.assigneeAgentId === run.agentId &&
        issue.originKind !== "mission_main_executor_oversight";
      const successfulRunCanFinalizeIssue = issue.status === "in_progress" || isRecoverableTodoSuccessfulRun;
      const successfulRunCanApplyCompletionGates =
        issue.status === "in_progress" || issue.status === "done" || isRecoverableTodoSuccessfulRun;
      const shouldAutoCaptureMissionChildOutput =
        run.status === "succeeded" &&
        !!issue.missionId &&
        !!issue.parentId &&
        issue.assigneeAgentId === run.agentId &&
        issue.status !== "done" &&
        issue.status !== "cancelled" &&
        (issue.status === "in_progress" || (issue.status === "blocked" && containsToolLimitLifecycleFailure(run)));
      const shouldAutoCompleteSuccessfulIssue =
        run.status === "succeeded" &&
        isLinkedToRun &&
        successfulRunCanFinalizeIssue &&
        issue.assigneeAgentId === run.agentId;
      const workflowValidationCompletionLedger =
        isSucceededHeartbeatRunStatus(run.status) &&
        isLinkedToRun &&
        successfulRunCanApplyCompletionGates &&
        issue.assigneeAgentId === run.agentId
          ? await hasWorkflowValidationCompletionLedger({ db: tx, issue })
          : null;
      const shouldBlockInsufficientEvidenceWorkflowVerdict =
        workflowValidationCompletionLedger?.isCandidate === true &&
        workflowValidationCompletionLedger.satisfied === false &&
        workflowValidationCompletionLedger.insufficientEvidence === true;
      const shouldBlockMissingWorkflowValidationVerdict =
        workflowValidationCompletionLedger?.isCandidate === true &&
        workflowValidationCompletionLedger.satisfied === false &&
        workflowValidationCompletionLedger.insufficientEvidence !== true;
      const missionWorkProductPaths = issue.missionId
        ? await resolveMissionWorkProductPaths(tx, {
          companyId: issue.companyId,
          missionId: issue.missionId,
          projectId: issue.projectId,
        })
        : null;
      const allowedArtifactRoot = missionWorkProductPaths?.missionOutputDir ?? null;
      // 이 issue의 workflow step-run metadata에서 명시 graphWorkProductRequired 플래그 조회.
      // stamp가 없으면(undefined) gate가 종래 휴리스틱으로 fallback한다.
      const stepRunMetadata = isLinkedToRun && !!issue.missionId
        ? await tx
          .select({ metadata: workflowStepRuns.metadata })
          .from(workflowStepRuns)
          .where(eq(workflowStepRuns.issueId, issue.id))
          .limit(1)
          .then((rows) => rows[0]?.metadata ?? null)
        : null;
      const stepRunRequiresWorkProduct = resolveStepRunRequiresWorkProduct(stepRunMetadata);
      const shouldCheckMissingWorkProductRegistration =
        isSucceededHeartbeatRunStatus(run.status) &&
        // produced-nothing guard: producer-type issue 가 succeeded run 후 workProduct 가 하나도 없으면
        // claimed paths 유무와 무관하게 gate 발화(자동 done 차단). workProduct 가 있으면 통과.
        isLinkedToRun &&
        !!issue.missionId &&
        canApplyMissingWorkProductRegistrationGate(issue, stepRunRequiresWorkProduct) &&
        successfulRunCanApplyCompletionGates &&
        issue.assigneeAgentId === run.agentId;


      if (shouldBlockInsufficientEvidenceWorkflowVerdict) {
        // [verdict abstention] 최신 공식 판정이 insufficient_evidence: 미제출(missing) 과 구분되는 사유로
        //   blocked. QA 재작업 백엣지/qa-cap 은 request_changes 경로와 명시 분기되므로 소비되지 않는다.
        const now = new Date();
        await tx
          .update(issues)
          .set({
            status: "blocked",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            completedAt: null,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));
        await tx.insert(issueComments).values({
          companyId: issue.companyId,
          issueId: issue.id,
          authorAgentId: run.agentId,
          body: buildInsufficientEvidenceWorkflowVerdictGateComment({
            run,
            reason: workflowValidationCompletionLedger.insufficientEvidenceReason,
          }),
        });
        await tx.insert(activityLog).values({
          companyId: issue.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "issue.workflow_validation_insufficient_evidence_blocked",
          entityType: "issue",
          entityId: issue.id,
          agentId: run.agentId,
          runId: run.id,
          details: {
            previousStatus: issue.status,
            nextStatus: "blocked",
            reason: "workflow_validation_insufficient_evidence",
            workflowRunId: workflowValidationCompletionLedger.workflowRunId,
            workflowStepRunId: workflowValidationCompletionLedger.workflowStepRunId,
            stepId: workflowValidationCompletionLedger.stepId,
          },
        });
        queuePostTransactionWorkflowIssueSync(issue.id);
        return { promotedRun: null };
      }

      if (shouldBlockMissingWorkflowValidationVerdict) {
        const now = new Date();
        await tx
          .update(issues)
          .set({
            status: "blocked",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            completedAt: null,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));
        await tx.insert(issueComments).values({
          companyId: issue.companyId,
          issueId: issue.id,
          authorAgentId: run.agentId,
          body: buildMissingWorkflowValidationVerdictGateComment({ run }),
        });
        await tx.insert(activityLog).values({
          companyId: issue.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "issue.workflow_validation_verdict_missing_auto_blocked",
          entityType: "issue",
          entityId: issue.id,
          agentId: run.agentId,
          runId: run.id,
          details: {
            previousStatus: issue.status,
            nextStatus: "blocked",
            reason: "workflow_validation_verdict_missing",
            workflowRunId: workflowValidationCompletionLedger.workflowRunId,
            workflowStepRunId: workflowValidationCompletionLedger.workflowStepRunId,
            stepId: workflowValidationCompletionLedger.stepId,
          },
        });
        queuePostTransactionWorkflowIssueSync(issue.id);
        return { promotedRun: null };
      }

      if (shouldCheckMissingWorkProductRegistration) {
        const existingWorkProducts = await tx
          .select({
            id: issueWorkProducts.id,
            url: issueWorkProducts.url,
            externalId: issueWorkProducts.externalId,
            status: issueWorkProducts.status,
            isPrimary: issueWorkProducts.isPrimary,
            metadata: issueWorkProducts.metadata,
          })
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.issueId, issue.id))
          .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt))
          .limit(10);
        // [structured artifact authority] only scoped work-product DB records (registered via the
        //   Workflow API) satisfy the completion gate. comment/stdout/[ARTIFACT] path markers must NOT
        //   register or complete; when evidence is missing the existing bounded rework path runs.
        if (!hasSatisfiedWorkProductRegistration({
          existingWorkProducts,
          claimedArtifactPaths: [],
          issue,
          allowedArtifactRoot,
        })) {
          const now = new Date();
          await tx
            .update(issues)
            .set({
              status: "blocked",
              checkoutRunId: null,
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              completedAt: null,
              updatedAt: now,
            })
            .where(eq(issues.id, issue.id));
          await tx.insert(issueComments).values({
            companyId: issue.companyId,
            issueId: issue.id,
            authorAgentId: run.agentId,
            body: buildMissingWorkProductRegistrationGateComment({ language: parseObject(run.contextSnapshot).paperclipUserFacingLanguage === "ko" ? "ko" : "en",
              runId: run.id,
              claimedArtifactPaths: [],
              allowedArtifactRoot,
            }),
          });
          await tx.insert(activityLog).values({
            companyId: issue.companyId,
            actorType: "system",
            actorId: "heartbeat",
            action: "issue.artifact_work_product_missing_auto_blocked",
            entityType: "issue",
            entityId: issue.id,
            agentId: run.agentId,
            runId: run.id,
            details: {
              previousStatus: issue.status,
              nextStatus: "blocked",
              reason: "missing_work_product_registration",
            },
          });
          queuePostTransactionWorkflowIssueSync(issue.id);
          return null;
        }
      }

      // [no-progress ladder 3단계] 성공했지만 아무 변화 없는 run 연쇄 — 어드바이저 이벤트(N회) 후
      //   K회 도달 시 정직한 auto-block. 판정 입력은 구조화된 DB 기록만(work product 등록 /
      //   에이전트 코멘트 시간창·본문 미파싱 / 워크플로 전이). stdout·comment 본문·resultJson
      //   텍스트 파식 금지(규칙 8), 카운터 컬럼 없이 매번 재계산(규칙 7).
      const noProgressAdvisoryThreshold = resolveNoProgressAdvisoryThreshold();
      const noProgressAutoBlockThreshold = resolveNoProgressAutoBlockThreshold();
      const noProgressLadderScope =
        noProgressAdvisoryThreshold > 0 &&
        isSucceededHeartbeatRunStatus(run.status) &&
        isLinkedToRun &&
        issue.status === "in_progress" &&
        issue.assigneeAgentId === run.agentId &&
        issue.originKind !== "mission_main_executor_oversight" &&
        // producer+mission 이슈는 기존 단발 게이트(산출물 미등록 → blocked)가 담당 — 사다리와 대상 분리.
        !(
          !!issue.missionId &&
          canApplyMissingWorkProductRegistrationGate(issue, stepRunRequiresWorkProduct)
        );
      const noProgressAssessment = noProgressLadderScope
        ? await computeConsecutiveNoProgress(tx, {
            companyId: issue.companyId,
            issueId: issue.id,
            agentId: issue.assigneeAgentId!,
          })
        : null;
      if (
        noProgressAssessment &&
        noProgressAssessment.count >= noProgressAdvisoryThreshold &&
        (noProgressAutoBlockThreshold <= 0 ||
          noProgressAssessment.count < noProgressAutoBlockThreshold)
      ) {
        await appendRunEvent(run, await nextRunEventSeq(run.id), {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: `No-progress advisory: last ${noProgressAssessment.count} succeeded runs on this issue produced no accepted tool advance or measured work-product creation/change (advisory threshold ${noProgressAdvisoryThreshold}, auto-block threshold ${noProgressAutoBlockThreshold})`,
          payload: {
            consecutiveNoProgress: noProgressAssessment.count,
            advisoryThreshold: noProgressAdvisoryThreshold,
            autoBlockThreshold: noProgressAutoBlockThreshold,
            evidenceSummary: noProgressAssessment.evidenceSummary,
            windowStart: noProgressAssessment.windowStart.toISOString(),
            lastRunId: noProgressAssessment.lastRunId,
          },
        }).catch(() => undefined);
      }
      if (
        noProgressAutoBlockThreshold > 0 &&
        noProgressAssessment &&
        noProgressAssessment.count >= noProgressAutoBlockThreshold
      ) {
        const now = new Date();
        await tx
          .update(issues)
          .set({
            status: "blocked",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));
        await tx.insert(issueComments).values({
          companyId: issue.companyId,
          issueId: issue.id,
          authorAgentId: run.agentId,
          body: buildNoProgressAutoBlockedComment({
            run,
            assessment: noProgressAssessment,
            advisoryThreshold: noProgressAdvisoryThreshold,
            autoBlockThreshold: noProgressAutoBlockThreshold,
          }),
        });
        await tx.insert(activityLog).values({
          companyId: issue.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "issue.no_progress_auto_blocked",
          entityType: "issue",
          entityId: issue.id,
          agentId: run.agentId,
          runId: run.id,
          details: {
            previousStatus: issue.status,
            nextStatus: "blocked",
            reason: "consecutive_no_progress",
            consecutiveNoProgress: noProgressAssessment.count,
            evidenceChecked: noProgressAssessment.evidenceSummary,
            windowStart: noProgressAssessment.windowStart.toISOString(),
            lastRunId: noProgressAssessment.lastRunId,
          },
        });
        if (issue.missionId) {
          const oversightIssueId = issue.parentId ?? issue.id;
          if (oversightIssueId !== issue.id) {
            await tx.insert(issueComments).values({
              companyId: issue.companyId,
              issueId: oversightIssueId,
              authorAgentId: run.agentId,
              body: buildMissionWorkerNoProgressOversightComment({
                run,
                sourceIssue: { id: issue.id, identifier: issue.identifier, title: issue.title },
                assessment: noProgressAssessment,
                autoBlockThreshold: noProgressAutoBlockThreshold,
              }),
            });
          }
          await tx.insert(activityLog).values({
            companyId: issue.companyId,
            actorType: "system",
            actorId: "heartbeat",
            action: "mission.worker_no_progress_observed",
            entityType: "mission",
            entityId: issue.missionId,
            agentId: run.agentId,
            runId: run.id,
            details: {
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              oversightIssueId,
              consecutiveNoProgress: noProgressAssessment.count,
              autoBlockThreshold: noProgressAutoBlockThreshold,
            },
          });
        }
        queuePostTransactionWorkflowIssueSync(issue.id);
        return { promotedRun: null };
      }

      if (
        shouldAutoCompleteSuccessfulIssue &&
        issue.originKind === "mission_main_executor_oversight" &&
        issue.missionId
      ) {
        const [mission] = await tx
          .select({ id: missions.id, status: missions.status })
          .from(missions)
          .where(and(eq(missions.id, issue.missionId), eq(missions.companyId, issue.companyId)))
          .limit(1);
        if (mission && !TERMINAL_MISSION_STATUSES.has(mission.status)) {
          const now = new Date();
          const latestRunForComment = await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, run.id))
            .limit(1)
            .then((rows) => rows[0] ?? run);
          await tx
            .update(issues)
            .set({
              status: "todo",
              checkoutRunId: null,
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              completedAt: null,
              cancelledAt: null,
              updatedAt: now,
            })
            .where(eq(issues.id, issue.id));
          await tx.insert(issueComments).values({
            companyId: issue.companyId,
            issueId: issue.id,
            authorAgentId: run.agentId,
            body: buildMissionOversightRunSucceededReleaseComment(latestRunForComment, mission.status),
          });
          await tx.insert(activityLog).values({
            companyId: issue.companyId,
            actorType: "system",
            actorId: "heartbeat",
            action: "mission.oversight_run_succeeded_released",
            entityType: "mission",
            entityId: issue.missionId,
            agentId: run.agentId,
            runId: run.id,
            details: {
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              previousStatus: issue.status,
              nextStatus: "todo",
              reason: "oversight_successful_run_kept_alive_until_mission_terminal",
              missionStatus: mission.status,
            },
          });
          queuePostTransactionWorkflowIssueSync(issue.id);
          return {
            promotedRun: null,
          };
        }
      }


      if (
        shouldAutoCompleteSuccessfulIssue &&
        issue.originKind === "mission_plan_qa"
      ) {
        const ledger = await hasMissionPlanQaCompletionLedger({
          db: tx,
          companyId: issue.companyId,
          missionId: issue.missionId,
          planQaIssueId: issue.id,
        });
        if (!ledger.satisfied) {
          await blockMissionPlanQaCompletionWithoutLedger({ db: tx, issue, run, ledger });
          queuePostTransactionWorkflowIssueSync(issue.id);
          return null;
        }
      }

      if (shouldAutoCompleteSuccessfulIssue && issue.originKind === "mission_main_executor_unblock") {
        const unblockNow = new Date();
        await tx
          .update(issues)
          .set({
            status: "blocked",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: unblockNow,
          })
          .where(eq(issues.id, issue.id));
        await tx.insert(activityLog).values({
          companyId: issue.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "issue.unblock_handback_pending",
          entityType: "issue",
          entityId: issue.id,
          agentId: run.agentId,
          runId: run.id,
          details: { previousStatus: issue.status, nextStatus: "blocked", reason: "mission_main_executor_unblock_closeout_via_handback_guard" },
        });
        await tx.insert(issueComments).values({
          companyId: issue.companyId,
          issueId: issue.id,
          authorAgentId: run.agentId,
          body: runText(run, "복구 실행은 성공했지만 원래 업무에 결과를 돌려준 기록이 없습니다. 복구 업무는 차단 상태를 유지합니다. 다음 행동: 구조화된 결과 인계 기록을 확인해 주세요. 실행 성공만으로 원래 업무의 복구를 확인할 수 없습니다.", "Recovery run succeeded, but the source handback is not yet recorded. This owner-action remains blocked. Next action: check the structured handback record; run success alone does not confirm source recovery."),
        });
        queuePostTransactionUnblockCompletion({ issueId: issue.id, companyId: issue.companyId, agentId: run.agentId });
        return {
          promotedRun: null,
        };
      }

      // [slice-4 closeout evidence gate] Shared structured outcome for successful runs that
      //   produced none of the completion evidence their issue contract requires: clear the four
      //   execution-lock fields (status stays as-is — defer, not block), write the structured
      //   issue.completion_evidence_missing activity, and queue a bounded post-tx follow-up.
      const applyMissingCompletionEvidenceOutcome = async (opts: {
        requiredAction: string;
        requiredEvidence?: string[];
      }): Promise<void> => {
        const priorAttempts = await tx
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(and(
            eq(activityLog.companyId, issue.companyId),
            eq(activityLog.entityId, issue.id),
            eq(activityLog.action, "issue.completion_evidence_missing"),
          ))
          .then((rows) => rows.length);
        const attempt = priorAttempts + 1;
        const outcomeNow = new Date();
        await tx
          .update(issues)
          .set({
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: outcomeNow,
          })
          .where(eq(issues.id, issue.id));
        await tx.insert(activityLog).values({
          companyId: issue.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "issue.completion_evidence_missing",
          entityType: "issue",
          entityId: issue.id,
          agentId: run.agentId,
          runId: run.id,
          details: {
            previousStatus: issue.status,
            reason: "missing_evidence_redispatch",
            requiredAction: opts.requiredAction,
            attempt,
            budget: MISSING_EVIDENCE_REDISPATCH_BUDGET,
            ...(opts.requiredEvidence ? { requiredEvidence: opts.requiredEvidence } : {}),
          },
        });
        postTransactionMissingEvidenceRedispatches.push({
          companyId: issue.companyId,
          issueId: issue.id,
          agentId: run.agentId,
          missionId: issue.missionId ?? null,
          attempt,
          requiredAction: opts.requiredAction,
        });
      };

      // [slice-4 MISMATCH B] Standalone execution cards declare completionContract.requiredEvidence;
      //   until now nothing consumed it at closeout — a manual issue auto-completed on run success
      //   with zero registered evidence. Only scoped work-product DB records count (same authority
      //   rule as the produced-nothing guard); comments/stdout never do.
      if (shouldAutoCompleteSuccessfulIssue && issue.originKind === "manual") {
        const card = await tx
          .select({ cardVersion: issueExecutionCards.cardVersion, cardJson: issueExecutionCards.cardJson })
          .from(issueExecutionCards)
          .where(and(
            eq(issueExecutionCards.companyId, issue.companyId),
            eq(issueExecutionCards.issueId, issue.id),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const cardJson = (card?.cardJson ?? null) as {
          version?: unknown;
          executionMode?: unknown;
          completionContract?: { requiredEvidence?: unknown } | null;
        } | null;
        const requiredEvidence = card
          && card.cardVersion === 2
          && cardJson?.version === 2
          && cardJson.executionMode === "standalone"
          && Array.isArray(cardJson.completionContract?.requiredEvidence)
          ? (cardJson.completionContract!.requiredEvidence as unknown[])
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [];
        if (requiredEvidence.length > 0) {
          const registeredEvidence = await tx
            .select({ id: issueWorkProducts.id })
            .from(issueWorkProducts)
            .where(and(
              eq(issueWorkProducts.companyId, issue.companyId),
              eq(issueWorkProducts.issueId, issue.id),
            ))
            .limit(1)
            .then((rows) => rows.length);
          if (registeredEvidence === 0) {
            await applyMissingCompletionEvidenceOutcome({
              requiredAction: `${MISSING_EVIDENCE_REQUIRED_ACTION} (standalone card requiredEvidence: ${requiredEvidence.join(", ")})`,
              requiredEvidence,
            });
            queuePostTransactionWorkflowIssueSync(issue.id);
            return { promotedRun: null };
          }
        }
      }

      if (shouldAutoCaptureMissionChildOutput || shouldAutoCompleteSuccessfulIssue) {
        // [2026-09-11 run08a86baf incident] 폴링성 실행(새 산출물·검증 기록 없음)의 자동 완료 차단.
        // 워크플로 단계 이슈는 산출물/버딕트 등록이 완료 계약이므로, 이번 실행이 아무 기록도
        // 남기지 않았다면 done 전환이 아니라 명시적 완료 안내만 남긴다(상태 불변).
        if (shouldAutoCompleteSuccessfulIssue && !shouldAutoCaptureMissionChildOutput) {
          const linkedStepRun = await tx
            .select({ id: workflowStepRuns.id })
            .from(workflowStepRuns)
            .where(eq(workflowStepRuns.issueId, issue.id))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (linkedStepRun) {
            const runCompletionEvidence = await tx
              .select({ id: issueWorkProducts.id, createdByRunId: issueWorkProducts.createdByRunId })
              .from(issueWorkProducts)
              .where(and(
                eq(issueWorkProducts.companyId, issue.companyId),
                eq(issueWorkProducts.issueId, issue.id),
              ))
              .limit(2)
              .then((rows) => rows);
            const hasAnyProduct = runCompletionEvidence.length > 0;
            const thisRunRegistered = runCompletionEvidence.some(
              (row) => row.createdByRunId === run.id,
            );
            // 후속 무변화 실행 차단: 이슈에 산출물이 있어 완료 계약이 성립했는데 이번 실행이
            // 새로 등록한 것이 없다면(폴링성 실행) 자동 완료하지 않는다. 산출물이 아직 없는
            // 첫 완료는 기존 자동 완료 동작을 그대로 유지한다.
            if (hasAnyProduct && !thisRunRegistered) {
              await tx.insert(issueComments).values({
                companyId: issue.companyId,
                issueId: issue.id,
                authorAgentId: run.agentId,
                body: runText(run, "업무 자동 완료를 보류했습니다. 실행은 성공으로 종료됐지만 이번 실행의 등록 산출물이나 검증 기록이 없습니다. 다음 행동: 작업 흐름 계약에 맞게 산출물을 등록하고 workflow/complete를 호출해 주세요. 실행 성공만으로 업무 완료가 확인되지는 않습니다.", "Automatic completion is on hold. The run succeeded, but this run has no registered work product or validation record. Next action: register artifacts under the workflow contract and call workflow/complete. Run success alone does not confirm issue completion."),
              });
              await tx.insert(activityLog).values({
                companyId: issue.companyId,
                actorType: "system",
                actorId: "heartbeat",
                action: "issue.auto_complete_deferred_no_evidence",
                entityType: "issue",
                entityId: issue.id,
                agentId: run.agentId,
                runId: run.id,
                details: {
                  reason: "successful_run_without_completion_evidence",
                  previousStatus: issue.status,
                  nextStatus: issue.status,
                },
              });
              // [slice-4 MISMATCH A] The defer used to stop here, leaving the issue holding a
              //   terminal run's execution locks with no re-dispatch — a silent failure. Apply the
              //   shared structured outcome: clear the lock fields, write the structured
              //   issue.completion_evidence_missing activity, queue the bounded post-tx follow-up.
              await applyMissingCompletionEvidenceOutcome({
                requiredAction: MISSING_EVIDENCE_REQUIRED_ACTION,
              });
              queuePostTransactionWorkflowIssueSync(issue.id);
              return { promotedRun: null };
            }
          }
        }
        // [Task6c-C] resume run settlement fence: acting run 의 기록 링크(stepRunId, generation)
        //   이 현재 행과 정확히 일치할 때만 issue→done / step closeout 로 진행한다. 불일치면
        //   mutation 을 건너뛰고 구조화 진단 activity log(workflow.resume_stale_result_rejected)
        //   1건만 기록한다 — 표시/감사 전용이며 실행 권위로 파싱되지 않는다 — heartbeat 자체는
        //   실패시키지 않는다. ordinary run 은 fence 가 즉시 allow (stamp 없는 step) — 기존과
        //   byte-identical.
        const resumeScopeVerdict = await resolveHeartbeatResumeScopeFence(tx as unknown as Parameters<typeof resolveHeartbeatResumeScopeFence>[0], run);
        if (resumeScopeVerdict.action === "reject") {
          await recordResumeStaleResultRejected(tx as unknown as Parameters<typeof recordResumeStaleResultRejected>[0], {
            companyId: issue.companyId,
            issueId: issue.id,
            heartbeatRunId: run.id,
            agentId: run.agentId,
            verdict: resumeScopeVerdict,
            source: "heartbeat_settlement",
          });
          queuePostTransactionWorkflowIssueSync(issue.id);
        } else {
        const now = new Date();
        const latestRunForComment = await tx
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, run.id))
          .limit(1)
          .then((rows) => rows[0] ?? run);
        await tx
          .update(issues)
          .set({
            status: "done",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));
        await completeLinkedWorkflowStepRunsForIssue({
          db: tx,
          issueId: issue.id,
          completedAt: now,
          source: "heartbeat_promotion",
          heartbeatRunId: run.id,
        });
        await tx.insert(issueComments).values({
          companyId: issue.companyId,
          issueId: issue.id,
          authorAgentId: run.agentId,
          body: shouldAutoCaptureMissionChildOutput
            ? buildMissionChildRunOutputComment(latestRunForComment)
            : buildSuccessfulIssueRunAutoCompletedComment(latestRunForComment),
        });
        await tx.insert(activityLog).values({
          companyId: issue.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: shouldAutoCaptureMissionChildOutput
            ? "issue.lifecycle_gap_auto_completed"
            : "issue.run_succeeded_auto_completed",
          entityType: "issue",
          entityId: issue.id,
          agentId: run.agentId,
          runId: run.id,
          details: {
            previousStatus: issue.status,
            nextStatus: "done",
            reason: shouldAutoCaptureMissionChildOutput
              ? "successful_mission_child_run_output_captured"
              : "successful_checked_out_run_auto_completed",
          },
        });
        queuePostTransactionWorkflowIssueSync(issue.id);
        return {
          promotedRun: null,
        };
        }
      }

      // [stale-run auto-block guard, 2026-10-07 CMP-328] 자동 차단은 이슈를 지금 소유한 run 만 할 수 있다.
      //   다른 run 이 소유 칸을 가진 상태에서 끝난 이전(비소유) run 은 이슈·소유 칸·대기 wake 를
      //   건드리지 않고 끝난다(새 소유 run 의 잠금을 지우지 않기 위함).
      const isOwnerRun = issue.executionRunId === run.id || issue.checkoutRunId === run.id;
      const lockOwnedByOtherRun =
        (issue.executionRunId != null && issue.executionRunId !== run.id) ||
        (issue.checkoutRunId != null && issue.checkoutRunId !== run.id);
      if (run.status !== "succeeded" && !isOwnerRun && lockOwnedByOtherRun) {
        return { promotedRun: null };
      }
      // 통제판이 이미 이슈 blocked 로 절단한 run 은 늦게 끝나도 다시 자동 차단하지 않는다.
      const cutByIssueBlock = run.status === "cancelled" && run.errorCode === "issue_status_blocked";

      if (
        ["failed", "timed_out", "cancelled"].includes(run.status) &&
        isOwnerRun &&
        !cutByIssueBlock &&
        issue.status === "in_progress" &&
        issue.assigneeAgentId === run.agentId
      ) {
        if (issue.originKind === "mission_main_executor_oversight" && issue.missionId) {
          const now = new Date();
          await tx
            .update(issues)
            .set({
              status: "todo",
              checkoutRunId: null,
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: now,
            })
            .where(eq(issues.id, issue.id));
          await tx.insert(issueComments).values({
            companyId: issue.companyId,
            issueId: issue.id,
            authorAgentId: run.agentId,
            body: buildMissionOversightRunFailureComment({ run, classification }),
          });
          await tx.insert(activityLog).values({
            companyId: issue.companyId,
            actorType: "system",
            actorId: "heartbeat",
            action: "mission.oversight_run_failure_observed",
            entityType: "mission",
            entityId: issue.missionId,
            agentId: run.agentId,
            runId: run.id,
            details: {
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              previousStatus: "in_progress",
              nextStatus: "todo",
              reason: "oversight_terminal_run_failure_released",
              runStatus: run.status,
              classification,
            },
          });
          return null;
        }

        const now = new Date();
        await tx
          .update(issues)
          .set({
            status: "blocked",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));
        await tx.insert(issueComments).values({
          companyId: issue.companyId,
          issueId: issue.id,
          authorAgentId: run.agentId,
          body: buildFailedIssueRunAutoBlockedComment({ run, classification }),
        });
        await tx.insert(activityLog).values({
          companyId: issue.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "issue.run_failure_auto_blocked",
          entityType: "issue",
          entityId: issue.id,
          agentId: run.agentId,
          runId: run.id,
          details: {
            previousStatus: "in_progress",
            nextStatus: "blocked",
            reason: "terminal_run_failure",
            runStatus: run.status,
            classification,
          },
        });
        if (issue.missionId) {
          const oversightIssueId = issue.parentId ?? issue.id;
          if (oversightIssueId !== issue.id) {
            await tx.insert(issueComments).values({
              companyId: issue.companyId,
              issueId: oversightIssueId,
              authorAgentId: run.agentId,
              body: buildMissionWorkerFailureOversightComment({
                run,
                sourceIssue: { id: issue.id, identifier: issue.identifier, title: issue.title },
                classification,
              }),
            });
          }
          await tx.insert(activityLog).values({
            companyId: issue.companyId,
            actorType: "system",
            actorId: "heartbeat",
            action: "mission.worker_run_failure_observed",
            entityType: "mission",
            entityId: issue.missionId,
            agentId: run.agentId,
            runId: run.id,
            details: {
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              oversightIssueId,
              runStatus: run.status,
              classification,
            },
          });
        }
        return null;
      }

      await tx
        .update(issues)
        .set({
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));

      if (terminalSource) return { promotedRun: null };

      // Bounded iterations and wall-clock keep a reinserting deferred wake from blocking recovery.
      const deferredPromotionBudget = {
        maxIterations: 50,
        startedAtMs: Date.now(),
        wallClockMs: 30_000,
      };
      let deferredPromotionIterations = 0;
      while (true) {
        if (deferredPromotionIterations >= deferredPromotionBudget.maxIterations) {
          logger.warn(
            { issueId: issue.id, iterations: deferredPromotionIterations },
            "deferred wake promotion loop exceeded max iterations; deferring remainder to next tick",
          );
          break;
        }
        if (Date.now() - deferredPromotionBudget.startedAtMs >= deferredPromotionBudget.wallClockMs) {
          logger.warn(
            { issueId: issue.id, elapsedMs: Date.now() - deferredPromotionBudget.startedAtMs },
            "deferred wake promotion loop exceeded wall-clock budget; deferring remainder to next tick",
          );
          break;
        }
        deferredPromotionIterations += 1;
        const candidate = await selectDeferredWakeupRequest(tx, issue);
        if (!candidate) return null;
        const { request: deferred, agent: deferredAgent } = candidate;
        if (isStoredOperatorDecisionWake(deferred, DEFERRED_WAKE_CONTEXT_KEY))
          return { promotedRun: null, operatorDeferredAgentId: deferred.agentId };
        if (readQaCorrectionWakeRef(deferred)) {
          return { promotedRun: null, correctionCandidate: { wakeupRequestId: deferred.id } };
        }

        if (
          !deferredAgent ||
          deferredAgent.companyId !== issue.companyId ||
          deferredAgent.status === "paused" ||
          deferredAgent.status === "terminated" ||
          deferredAgent.status === "pending_approval"
        ) {
          await failFollowupWake(tx, deferred.id, "Deferred wake could not be promoted: agent is not invokable");
          continue;
        }

        return promoteDeferredWakeupRequest(followupPromotionDeps, tx, { deferred, deferredAgent, issue });
      }
      } finally {
        if (terminalSource && terminalReleaseCommitEligible) {
          if (postTransactionDelegatedArtifactHandbacks.length > 0) {
            throw new Error("terminal_release_unmodeled_delegated_handback");
          }
          if ([...postTransactionWorkflowIssueSyncIssueIds].some(issueId => issueId !== terminalSource.issueId)) {
            throw new Error("terminal_release_unmodeled_issue_sync");
          }
          if (postTransactionUnblockCompletions.some(entry => entry.companyId !== terminalSource.companyId
            || entry.issueId !== terminalSource.issueId || entry.agentId !== run.agentId)) {
            throw new Error("terminal_release_unmodeled_unblock_handback");
          }
          if (postTransactionMissingEvidenceRedispatches.some(entry => entry.companyId !== terminalSource.companyId
            || entry.issueId !== terminalSource.issueId || entry.agentId !== run.agentId
            || entry.missionId !== terminalSource.missionId || !Number.isSafeInteger(entry.attempt)
            || entry.attempt < 0 || entry.requiredAction.length > 120)) {
            throw new Error("terminal_release_unmodeled_missing_evidence");
          }
          const [releasedIssue] = await tx.select({ executionRunId: issues.executionRunId,
            checkoutRunId: issues.checkoutRunId }).from(issues).where(and(
            eq(issues.id, terminalSource.issueId), eq(issues.companyId, terminalSource.companyId),
          ));
          if (!releasedIssue || releasedIssue.executionRunId !== null || releasedIssue.checkoutRunId !== null) {
            throw new Error("terminal_release_issue_owner_not_released_exactly");
          }
          const obligations: Array<{ stage: "issue_promotion" | "workflow_evidence_sync"; action: TerminalFollowup }> = [
            { stage: "issue_promotion", action: { kind: "promote_issue_wakes", companyId: terminalSource.companyId, issueId: terminalSource.issueId } },
            { stage: "workflow_evidence_sync", action: { kind: "sync_issue", companyId: terminalSource.companyId, issueId: terminalSource.issueId } },
          ];
          for (const entry of postTransactionUnblockCompletions) obligations.push({ stage: "workflow_evidence_sync",
            action: { kind: "unblock_handback", companyId: entry.companyId, issueId: entry.issueId, agentId: entry.agentId } });
          for (const entry of postTransactionMissingEvidenceRedispatches) obligations.push({ stage: "workflow_evidence_sync",
            action: { kind: "missing_evidence", companyId: entry.companyId, issueId: entry.issueId,
              agentId: entry.agentId, missionId: entry.missionId, attempt: entry.attempt, requiredAction: entry.requiredAction } });
          obligations.push({ stage: "issue_promotion", action: { kind: "promote_agent_queue",
            companyId: terminalSource.companyId, agentId: run.agentId } });
          obligations.push({ stage: "workflow_evidence_sync", action: { kind: "reevaluate_source" } });
          const manifest = createTerminalReleaseManifest(terminalSource, run.agentId, obligations);
          const written = await writeTerminalReleaseManifest(tx, manifest);
          terminalContinuationEventId = written.eventId;
        }
      }
    });

    if (terminalSource) {
      return terminalContinuationEventId
        ? { kind: "release_committed_followup_pending", continuationEventId: terminalContinuationEventId }
        : { kind: "release_unproven", reason: "exact_issue_release_or_manifest_unproven" };
    }

    const transactionObject =
      !!transactionResult && typeof transactionResult === "object" ? transactionResult : null;
    const transactionRecord = transactionObject as Record<string, unknown> | null;
    type PostTransactionRequestChangesOwnerAction =
      Parameters<typeof ensureMissionOwnerActionForRequestChanges>[0];
    const hasPostTransactionRequestChangesOwnerAction =
      !!transactionObject && "postTransactionRequestChangesOwnerAction" in transactionObject;
    const postTransactionRequestChangesOwnerAction = hasPostTransactionRequestChangesOwnerAction
      ? transactionRecord?.postTransactionRequestChangesOwnerAction as PostTransactionRequestChangesOwnerAction
      : null;
    // [structured plan-decision authority] comment-driven postTransactionMissionOwnerPlanDecision
    //   / recordMissionOwnerPlanDecisionAfterComment was intentionally removed (655e889). Do not
    //   restore NL comment parsing as plan-decision control-plane authority.
    const hasPromotedRunField = !!transactionObject && "promotedRun" in transactionObject;
    let promotedRun = (
      hasPromotedRunField || hasPostTransactionRequestChangesOwnerAction
        ? transactionRecord?.promotedRun
        : transactionResult
    ) as typeof heartbeatRuns.$inferSelect | null | undefined;

    if (postTransactionRequestChangesOwnerAction) {
      await ensureMissionOwnerActionForRequestChanges(postTransactionRequestChangesOwnerAction);
    }

    if (postTransactionWorkflowIssueSyncIssueIds.size > 0) {
      const { workflowService } = await import("./workflow/engine.js");
      for (const issueId of postTransactionWorkflowIssueSyncIssueIds) {
        await workflowService.syncRunStatusForIssue(db, issueId, "heartbeat_promotion");
      }
    }

    // [GAZ-315] flush deferred unblock closeout through the guarded handback route. This writes the
    //   validated report (+ native dispatch / Oversight handoff as applicable) and sets done via
    //   issueService.update → assertCanCompleteOwnerActionWithHandback fires. Happy path preserved.
    if (postTransactionUnblockCompletions.length > 0) {
      const { completeUnblockActionWithSourceHandback } = await import("./missions/owner-action-completion.js");
      for (const entry of postTransactionUnblockCompletions) {
        await completeUnblockActionWithSourceHandback(db, {
          unblockIssueId: entry.issueId,
          companyId: entry.companyId,
          actor: { agentId: entry.agentId },
          workflowSyncSource: "heartbeat_promotion",
        }).catch((err: unknown) => {
          logger.warn({ err, issueId: entry.issueId }, "failed to close mission_main_executor_unblock via handback guard");
        });
      }
    }

    // [slice-4 closeout evidence gate] Bounded post-tx follow-up for successful runs that registered
    //   none of the required completion evidence. Within budget: re-dispatch once via enqueueWakeup
    //   when no live wake coverage exists for the issue. Beyond budget: raise ONE operator_decisions
    //   exception card (idempotent requestKey); card failure must never break closeout.
    if (postTransactionMissingEvidenceRedispatches.length > 0) {
      const { hasLiveWakeCoverage } = await import("./missions/qa-rework-cap-oversight-wake.js");
      for (const entry of postTransactionMissingEvidenceRedispatches) {
        try {
          if (entry.attempt > MISSING_EVIDENCE_REDISPATCH_BUDGET) {
            const requestKey = `missing-evidence:${entry.issueId}`;
            const requestHash = createHash("sha256")
              .update(JSON.stringify({ requestKey, issueId: entry.issueId, requiredAction: entry.requiredAction }), "utf8")
              .digest("hex");
            const inserted = await db
              .insert(operatorDecisions)
              .values({
                companyId: entry.companyId,
                requestKey,
                requestHash,
                schemaVersion: 1,
                status: "pending",
                priority: "high",
                interactionType: "single_select",
                title: "Completion evidence missing after successful runs",
                description: entry.requiredAction,
                sourceType: "issue",
                sourceId: entry.issueId,
                sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
                issueId: entry.issueId,
                requestedByAgentId: entry.agentId,
                definition: {
                  options: [
                    {
                      id: "redispatch-once",
                      label: "Re-dispatch once more",
                      description: "Queue one more execution attempt for the assignee.",
                      facts: [
                        { label: "Required action", value: entry.requiredAction, status: "known" },
                        { label: "Attempts already made", value: String(entry.attempt), status: "known" },
                      ],
                      evidenceRefs: [],
                    },
                    {
                      id: "block-issue",
                      label: "Block the issue",
                      description: "Keep the issue blocked until a human unblocks it.",
                      facts: [
                        { label: "Required action", value: entry.requiredAction, status: "known" },
                      ],
                      evidenceRefs: [],
                    },
                    {
                      id: "cancel-issue",
                      label: "Cancel the issue",
                      description: "Cancel the issue as unfinishable.",
                      facts: [
                        { label: "Required action", value: entry.requiredAction, status: "known" },
                      ],
                      evidenceRefs: [],
                    },
                  ],
                  actions: [
                    { id: "apply", label: "Apply selected option", outcome: "submit", tone: "primary", requiresSelection: true },
                  ],
                  selection: { min: 1, max: 1 },
                  comment: { mode: "optional", label: null, placeholder: null, maxLength: 2000 },
                  approvedScope: [],
                  forbiddenScope: [],
                  humanReview: {
                    schemaVersion: "human-review-v1",
                    decisionSubject: `Issue ${entry.issueId} repeatedly finished runs without registering the required completion evidence`,
                    evidence: [],
                    interpretation: `The assignee succeeded ${entry.attempt} runs but registered none of the required work products. Auto re-dispatch stopped after the budget (${MISSING_EVIDENCE_REDISPATCH_BUDGET}).`,
                    impact: {
                      ifApproved: "The selected option is applied by an operator-driven flow.",
                      ifRejected: "The issue stays as-is (not auto-completed) until a human acts.",
                      ifWrong: "A wrong option could cancel or block work that only needed a different evidence format.",
                    },
                    unresolvedFacts: ["Why the assignee does not register the required work product"],
                    questions: ["Is the required evidence list still accurate for this issue?"],
                    recommendedNextStep: entry.requiredAction,
                    requiredReviewer: "operator",
                  },
                },
              })
              .onConflictDoNothing({ target: [operatorDecisions.companyId, operatorDecisions.requestKey] })
              .returning({ id: operatorDecisions.id });
            if (inserted.length === 0) {
              logger.info({ issueId: entry.issueId }, "missing-evidence exception card already exists; skipped");
            }
          } else {
            const covered = await hasLiveWakeCoverage(db, entry.companyId, entry.issueId);
            if (!covered) {
              await enqueueWakeup(entry.agentId, {
                reason: "missing_evidence_redispatch",
                triggerDetail: "closeout evidence missing after successful run",
                contextSnapshot: {
                  issueId: entry.issueId,
                  ...(entry.missionId ? { missionId: entry.missionId } : {}),
                  requiredAction: entry.requiredAction,
                  attempt: entry.attempt,
                },
                source: "on_demand",
                requestedByActorType: "system",
                requestedByActorId: "heartbeat",
                idempotencyKey: `missing-evidence-redispatch:${entry.issueId}:${entry.attempt}`,
              });
            }
          }
        } catch (err) {
          logger.warn({ err, ...entry }, "missing-evidence closeout follow-up failed");
        }
      }
    }

    for (const delegatedHandback of postTransactionDelegatedArtifactHandbacks) {
      await handleDelegatedArtifactHandback({
        db,
        heartbeat: { wakeup: enqueueWakeup },
        childIssueId: delegatedHandback.childIssueId,
        childWorkProductId: delegatedHandback.childWorkProductId,
        sourceRunId: delegatedHandback.sourceRunId,
        requestedByActorType: "system",
        requestedByActorId: "heartbeat",
      }).catch((err: unknown) => {
        logger.warn(
          {
            err,
            childIssueId: delegatedHandback.childIssueId,
            childWorkProductId: delegatedHandback.childWorkProductId,
          },
          "failed to hand back delegated artifact to parent workflow issue",
        );
      });
    }

    if (transactionObject && "correctionCandidate" in transactionObject) {
      return deliverStoredQaCorrectionWake(
        (transactionRecord!.correctionCandidate as { wakeupRequestId: string }).wakeupRequestId,
        options.skipLocked === true ? "recovery_skip_locked" : "public_callback",
        options.resumeQueue !== false,
      );
    }
    if (transactionObject && "operatorDeferredAgentId" in transactionObject) {
      if (options.resumeQueue !== false) await startNextQueuedRunForAgent(String(transactionRecord!.operatorDeferredAgentId)); return; }
    if (!promotedRun) return;
    publishQueuedRun(promotedRun);

    if (options.resumeQueue !== false) await startNextQueuedRunForAgent(promotedRun.agentId);
  }

  async function promoteTerminalIssueWake(eventId: string, action: Extract<TerminalFollowup, { kind: "promote_issue_wakes" }>) {
    const initial = await readTerminalContinuationSource(eventId, db);
    if (initial.kind !== "ready" || initial.manifest.source.issueId !== action.issueId
      || initial.manifest.source.companyId !== action.companyId) {
      return { kind: "held" as const, reason: initial.kind === "held" ? initial.reason : "terminal_issue_promotion_scope_mismatch" };
    }
    const existingPromotions = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, action.companyId), eq(agentWakeupRequests.issueId, action.issueId),
      eq(agentWakeupRequests.reason, "issue_execution_promoted"), isNotNull(agentWakeupRequests.runId),
    ));
    for (const wake of existingPromotions) {
      const [linked] = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId, issueId: heartbeatRuns.issueId, wakeupRequestId: heartbeatRuns.wakeupRequestId })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
      if (linked && linked.companyId === action.companyId && linked.issueId === action.issueId
        && linked.wakeupRequestId === wake.id && linked.agentId === wake.agentId) return { kind: "ready" as const };
    }
    const result = await withTxTimeout(db, async tx => {
      const [issue] = await tx.select().from(issues).where(and(
        eq(issues.id, action.issueId), eq(issues.companyId, action.companyId),
      )).for("update");
      if (!issue || issue.missionId !== initial.manifest.source.missionId
        || (issue.executionRunId !== null && issue.executionRunId !== initial.manifest.source.heartbeatRunId)
        || (issue.checkoutRunId !== null && issue.checkoutRunId !== initial.manifest.source.heartbeatRunId)) {
        return { kind: "held" as const, reason: "terminal_issue_promotion_owner_or_scope_changed" };
      }
      const candidate = await selectDeferredWakeupRequest(tx, issue);
      if (!candidate) {
        const remaining = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, action.companyId), eq(agentWakeupRequests.issueId, action.issueId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        )).limit(1);
        return remaining.length ? { kind: "held" as const, reason: "terminal_issue_deferred_wake_not_selected" }
          : { kind: "ready" as const };
      }
      const { request, agent } = candidate;
      if (isStoredOperatorDecisionWake(request, DEFERRED_WAKE_CONTEXT_KEY)) {
        return { kind: "operator" as const, wakeupRequestId: request.id };
      }
      if (readQaCorrectionWakeRef(request)) return { kind: "correction" as const, wakeupRequestId: request.id };
      if (!agent || agent.companyId !== action.companyId || agent.status === "paused"
        || agent.status === "terminated" || agent.status === "pending_approval") {
        await failFollowupWake(tx, request.id, "Deferred wake could not be promoted: agent is not invokable");
        return { kind: "failed" as const, wakeupRequestId: request.id };
      }
      const promoted = await promoteDeferredWakeupRequest(followupPromotionDeps, tx, { deferred: request, deferredAgent: agent, issue });
      return { kind: "promoted" as const, wakeupRequestId: request.id, runId: promoted.id };
    }, { label: "heartbeat:terminal-issue-promotion" });
    if (result.kind === "held") return result;
    if (result.kind === "correction") {
      const delivery = await connectCorrectionDelivery({ wakeupRequestId: result.wakeupRequestId }, "public_callback");
      if (!delivery.run) return { kind: "held" as const, reason: "terminal_correction_delivery_not_durable" };
    }
    const wakeupRequestId = "wakeupRequestId" in result ? result.wakeupRequestId : null;
    if (wakeupRequestId) {
      const [wake] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.id, wakeupRequestId), eq(agentWakeupRequests.companyId, action.companyId),
      ));
      if (!wake || wake.issueId !== action.issueId) return { kind: "held" as const, reason: "terminal_issue_wake_reread_failed" };
      if (result.kind === "operator" && (wake.status !== "deferred_issue_execution" || wake.runId !== null)) {
        return { kind: "held" as const, reason: "terminal_operator_wake_changed" };
      }
      if (result.kind === "failed" && wake.status !== "failed") return { kind: "held" as const, reason: "terminal_failed_wake_not_durable" };
      if (result.kind === "promoted" || result.kind === "correction") {
        const [linked] = await db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, wake.runId ?? ""), eq(heartbeatRuns.companyId, action.companyId),
        ));
        if (!linked || linked.wakeupRequestId !== wake.id || linked.issueId !== action.issueId || wake.runId !== linked.id) {
          return { kind: "held" as const, reason: "terminal_issue_promotion_link_not_durable" };
        }
      }
    }
    return { kind: "ready" as const };
  }

  async function runTerminalReleaseContinuation(eventId: string): Promise<{ kind: "complete" } | { kind: "held"; reason: string }> {
    if (terminalContinuationInflight.has(eventId)) {
      const source = await readTerminalContinuationSource(eventId, db).catch(() => null);
      if (source?.kind === "held" && source.reason === "terminal_continuation_replacement_owner_changed") return source;
      return { kind: "held", reason: "terminal_continuation_already_inflight" };
    }
    terminalContinuationInflight.add(eventId);
    try {
      return await drainTerminalReleaseContinuation(db, eventId);
    } finally {
      terminalContinuationInflight.delete(eventId);
    }
  }

  type TerminalQualityRead = { kind: "not_applicable" } | { kind: "ready" } | { kind: "held"; reason: string };
  async function readExactTerminalQualityCompletion(source: {
    companyId: string; missionId: string; workflowRunId: string; dispatchAuthorityVersion: number;
    workflowStepRunId: string; stepId: string; issueId: string; executionGeneration: number;
    retryCount: number; iterationIndex: number;
  }): Promise<TerminalQualityRead> {
    const { QA_REMEDIATION_PREPARATION_EVENT_TYPE, QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3,
      parseQaRemediationPreparation, qaRemediationPreparationKey } = await import("./workflow/control-flow/qa-remediation-preparation-contract.js");
    const rows = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, source.companyId),
      eq(workflowTransitionEvents.workflowRunId, source.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, source.workflowStepRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE),
    ));
    if (rows.length === 0) return { kind: "not_applicable" };
    const candidates: Array<{ row: typeof workflowTransitionEvents.$inferSelect;
      preparation: ReturnType<typeof parseQaRemediationPreparation> }> = [];
    for (const row of rows) {
      let preparation: ReturnType<typeof parseQaRemediationPreparation>;
      try { preparation = parseQaRemediationPreparation(row.payload); }
      catch { return { kind: "held", reason: "quality_reservation_malformed" }; }
      if (row.id !== preparation.preparationId || row.companyId !== preparation.companyId
        || row.missionId !== preparation.missionId || row.workflowRunId !== preparation.workflowRunId
        || row.workflowStepRunId !== preparation.producer.stepRunId || row.issueId !== preparation.producer.issueId
        || row.executionGeneration !== preparation.producer.executionGeneration
        || row.idempotencyKey !== qaRemediationPreparationKey(preparation)) {
        return { kind: "held", reason: "quality_reservation_row_binding_mismatch" };
      }
      if (preparation.companyId === source.companyId && preparation.missionId === source.missionId
        && preparation.workflowRunId === source.workflowRunId
        && preparation.dispatchAuthorityVersion === source.dispatchAuthorityVersion
        && preparation.producer.stepRunId === source.workflowStepRunId && preparation.producer.stepId === source.stepId
        && preparation.producer.issueId === source.issueId
        && preparation.producer.executionGeneration === source.executionGeneration
        && preparation.producer.retryCount === source.retryCount
        && preparation.producer.iterationIndex === source.iterationIndex) candidates.push({ row, preparation });
    }
    if (candidates.length === 0) return { kind: "not_applicable" };
    if (candidates.length !== 1) return { kind: "held", reason: "quality_reservation_exact_source_ambiguous" };
    const { row, preparation } = candidates[0]!;
    if (preparation.schemaVersion !== QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3) return { kind: "not_applicable" };

    const { classifyQualityActionHistory } = await import("./workflow/control-flow/qa-remediation-quality-history.js");
    const classified = await db.transaction(tx => classifyQualityActionHistory(tx, {
      companyId: preparation.companyId, missionId: preparation.missionId, workflowRunId: preparation.workflowRunId,
      producerStepRunId: preparation.producer.stepRunId,
      qaStepRunIds: preparation.verdicts.map(verdict => verdict.qa.stepRunId),
      qualityActionId: preparation.qualityBinding.actionId,
    }));
    if (!classified || "detail" in classified || classified.row.id !== row.id
      || !isDeepStrictEqual(classified.preparation, preparation)) {
      return { kind: "held", reason: "quality_reservation_exact_readback_failed" };
    }

    const { qaRemediationCompletionKey, validateQaRemediationCompletionEvidence } =
      await import("./workflow/control-flow/qa-remediation-completion-evidence.js");
    const { QA_REMEDIATION_COMPLETION_EVENT_TYPE } = await import("./workflow/control-flow/qa-remediation-completion.js");
    const completions = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, source.companyId),
      eq(workflowTransitionEvents.workflowRunId, source.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, source.workflowStepRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE),
      eq(workflowTransitionEvents.idempotencyKey, qaRemediationCompletionKey(preparation)),
    ));
    if (completions.length !== 1) return { kind: "held", reason: "quality_completion_missing_or_ambiguous" };
    const completion = await validateQaRemediationCompletionEvidence(db, completions[0]!, preparation);
    if (!completion.ok || completion.completion.schemaVersion !== "workflow.qa-remediation.complete.v3"
      || !completion.completion.qualityUseEvidenceRefId || completion.completion.wakes.length === 0) {
      return { kind: "held", reason: completion.ok ? "quality_completion_not_v3" : `quality_completion_${completion.reason}` };
    }
    return { kind: "ready" };
  }

  function safeTypedQualityHold(error: unknown): { outcome: string; reason?: string } | null {
    if (!error || typeof error !== "object" || !("result" in error)) return null;
    const result = (error as { result?: unknown }).result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    const fields = result as Record<string, unknown>;
    const safe = (value: unknown) => typeof value === "string" && /^[a-z0-9_:-]{1,96}$/.test(value) ? value : undefined;
    const outcome = safe(fields.outcome), reason = safe(fields.reason);
    return outcome ? { outcome, ...(reason ? { reason } : {}) } : null;
  }

  async function drainTerminalReleaseContinuation(db: Db, eventId: string): Promise<{ kind: "complete" } | { kind: "held"; reason: string }> {
    const loaded = await readTerminalReleaseManifest(db, eventId);
    if (loaded.kind !== "found") return loaded;
    const ready = await readReadyTerminalReleaseContinuation(db, eventId);
    if (ready.kind !== "ready") return ready;
    let sourceRead = await readTerminalContinuationSource(eventId, db);
    if (sourceRead.kind !== "ready") {
      if (sourceRead.kind === "held" && sourceRead.reason === "terminal_continuation_source_or_authority_changed") {
        return settleTerminalContinuationFromQaSuccessor(db, eventId);
      }
      return sourceRead;
    }
    for (const obligation of loaded.manifest.obligations) {
      const prior = await readTerminalReleaseAcknowledgment(db, eventId, obligation.effectKey);
      if (prior.kind === "acknowledged") continue;
      if (prior.kind === "held") return prior;
      sourceRead = await readTerminalContinuationSource(eventId, db);
      if (sourceRead.kind !== "ready") {
        if (sourceRead.kind === "held" && sourceRead.reason === "terminal_continuation_source_or_authority_changed") {
          return settleTerminalContinuationFromQaSuccessor(db, eventId);
        }
        return sourceRead;
      }
      const { action } = obligation;
      let effect: { kind: "ready" } | { kind: "held"; reason: string } = { kind: "ready" };
      if (action.kind === "promote_issue_wakes") {
        effect = await promoteTerminalIssueWake(eventId, action);
      } else if (action.kind === "promote_agent_queue") {
        if (action.companyId !== sourceRead.manifest.source.companyId || action.agentId !== sourceRead.manifest.source.agentId) {
          effect = { kind: "held", reason: "terminal_queue_promotion_scope_mismatch" };
        } else {
          await startNextQueuedRunForAgent(action.agentId);
          const queuedRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
            eq(heartbeatRuns.companyId, action.companyId), eq(heartbeatRuns.agentId, action.agentId),
            eq(heartbeatRuns.status, "queued"),
          )).limit(1);
          const queuedWakes = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
            eq(agentWakeupRequests.companyId, action.companyId), eq(agentWakeupRequests.agentId, action.agentId),
            eq(agentWakeupRequests.status, "queued"),
          )).limit(1);
          if (queuedRuns.length || queuedWakes.length) effect = { kind: "held", reason: "terminal_agent_queue_still_pending" };
        }
      } else if (action.kind === "sync_issue") {
        if (action.companyId !== sourceRead.manifest.source.companyId || action.issueId !== sourceRead.manifest.source.issueId) {
          effect = { kind: "held", reason: "terminal_issue_sync_scope_mismatch" };
        } else {
          const quality = await readExactTerminalQualityCompletion(sourceRead.manifest.source);
          if (quality.kind === "held") {
            logger.warn({ companyId: sourceRead.manifest.source.companyId, missionId: sourceRead.manifest.source.missionId,
              workflowRunId: sourceRead.manifest.source.workflowRunId,
              workflowStepRunId: sourceRead.manifest.source.workflowStepRunId,
              heartbeatRunId: sourceRead.manifest.source.heartbeatRunId, issueId: action.issueId, reason: quality.reason },
            "terminal Quality continuation held; sync_issue obligation remains pending");
            effect = quality;
          } else if (quality.kind === "not_applicable") {
            const { workflowService } = await import("./workflow/engine.js");
            try { await workflowService.syncRunStatusForIssue(db, action.issueId, "heartbeat_promotion"); }
            catch (error) {
              const typed = safeTypedQualityHold(error);
              if (!typed) throw error;
              logger.warn({ companyId: sourceRead.manifest.source.companyId, missionId: sourceRead.manifest.source.missionId,
                workflowRunId: sourceRead.manifest.source.workflowRunId,
                workflowStepRunId: sourceRead.manifest.source.workflowStepRunId,
                heartbeatRunId: sourceRead.manifest.source.heartbeatRunId, issueId: action.issueId, typedHold: typed },
              "terminal workflow sync returned a typed Quality hold; sync_issue obligation remains pending");
              effect = { kind: "held", reason: `terminal_workflow_sync_${typed.outcome}${typed.reason ? `_${typed.reason}` : ""}` };
            }
          }
        }
      } else if (action.kind === "unblock_handback") {
        if (action.companyId !== sourceRead.manifest.source.companyId || action.issueId !== sourceRead.manifest.source.issueId
          || action.agentId !== sourceRead.manifest.source.agentId) effect = { kind: "held", reason: "terminal_unblock_scope_mismatch" };
        else {
          const { completeUnblockActionWithSourceHandback } = await import("./missions/owner-action-completion.js");
          await completeUnblockActionWithSourceHandback(db, { unblockIssueId: action.issueId, companyId: action.companyId,
            actor: { agentId: action.agentId }, workflowSyncSource: "heartbeat_promotion" });
          const [issue] = await db.select({ status: issues.status }).from(issues).where(and(
            eq(issues.id, action.issueId), eq(issues.companyId, action.companyId),
          ));
          if (issue?.status !== "done") effect = { kind: "held", reason: "terminal_unblock_handback_not_durable" };
        }
      } else if (action.kind === "missing_evidence") {
        if (action.companyId !== sourceRead.manifest.source.companyId || action.issueId !== sourceRead.manifest.source.issueId
          || action.agentId !== sourceRead.manifest.source.agentId || action.missionId !== sourceRead.manifest.source.missionId) {
          effect = { kind: "held", reason: "terminal_missing_evidence_scope_mismatch" };
        } else if (action.attempt > 2) {
          const requestKey = `missing-evidence:${action.issueId}`;
          const requestHash = createHash("sha256").update(JSON.stringify({ requestKey, issueId: action.issueId,
            requiredAction: action.requiredAction }), "utf8").digest("hex");
          await db.insert(operatorDecisions).values({ companyId: action.companyId, requestKey, requestHash,
            schemaVersion: 1, status: "pending", priority: "high", interactionType: "single_select",
            title: "Completion evidence missing after successful runs", description: action.requiredAction,
            sourceType: "issue", sourceId: action.issueId, sourceContext: { missionId: null,
              workflowId: null, workflowRunId: null, artifactRefs: [] },
            issueId: action.issueId, requestedByAgentId: action.agentId,
            definition: { options: [{ id: "redispatch-once", label: "Re-dispatch once more",
              description: "Queue one more execution attempt for the assignee.", facts: [{ label: "Required action",
                value: action.requiredAction, status: "known" }, { label: "Attempts already made", value: String(action.attempt), status: "known" }], evidenceRefs: [] },
              { id: "block-issue", label: "Block the issue", description: "Keep the issue blocked until a human unblocks it.",
                facts: [{ label: "Required action", value: action.requiredAction, status: "known" }], evidenceRefs: [] },
              { id: "cancel-issue", label: "Cancel the issue", description: "Cancel the issue as unfinishable.",
                facts: [{ label: "Required action", value: action.requiredAction, status: "known" }], evidenceRefs: [] }],
              actions: [{ id: "apply", label: "Apply selected option", outcome: "submit", tone: "primary", requiresSelection: true }],
              selection: { min: 1, max: 1 }, comment: { mode: "optional", label: null, placeholder: null, maxLength: 2000 },
              approvedScope: [], forbiddenScope: [], humanReview: { schemaVersion: "human-review-v1",
                decisionSubject: `Issue ${action.issueId} repeatedly finished runs without registering the required completion evidence`,
                evidence: [], interpretation: `The assignee succeeded ${action.attempt} runs but registered none of the required work products. Auto re-dispatch stopped after the budget (2).`,
                impact: { ifApproved: "The selected option is applied by an operator-driven flow.",
                  ifRejected: "The issue stays as-is (not auto-completed) until a human acts.",
                  ifWrong: "A wrong option could cancel or block work that only needed a different evidence format." },
                unresolvedFacts: ["Why the assignee does not register the required work product"],
                questions: ["Is the required evidence list still accurate for this issue?"],
                recommendedNextStep: action.requiredAction, requiredReviewer: "operator" } },
          }).onConflictDoNothing({ target: [operatorDecisions.companyId, operatorDecisions.requestKey] });
          const cards = await db.select().from(operatorDecisions).where(and(
            eq(operatorDecisions.companyId, action.companyId), eq(operatorDecisions.requestKey, requestKey),
          ));
          if (cards.length !== 1 || cards[0]!.requestHash !== requestHash || cards[0]!.issueId !== action.issueId
            || cards[0]!.requestedByAgentId !== action.agentId) effect = { kind: "held", reason: "terminal_missing_evidence_card_not_durable" };
        } else {
          const { hasLiveWakeCoverage } = await import("./missions/qa-rework-cap-oversight-wake.js");
          let covered = await hasLiveWakeCoverage(db, action.companyId, action.issueId);
          if (!covered) {
            await enqueueWakeup(action.agentId, { reason: "missing_evidence_redispatch",
              triggerDetail: "closeout evidence missing after successful run", contextSnapshot: {
                issueId: action.issueId, ...(action.missionId ? { missionId: action.missionId } : {}),
                requiredAction: action.requiredAction, attempt: action.attempt,
              }, source: "on_demand", requestedByActorType: "system", requestedByActorId: "heartbeat",
              idempotencyKey: `missing-evidence-redispatch:${action.issueId}:${action.attempt}` });
            covered = await hasLiveWakeCoverage(db, action.companyId, action.issueId);
          }
          const exactWake = await db.select().from(agentWakeupRequests).where(and(
            eq(agentWakeupRequests.companyId, action.companyId),
            eq(agentWakeupRequests.idempotencyKey, `missing-evidence-redispatch:${action.issueId}:${action.attempt}`),
          ));
          if (!covered && (exactWake.length !== 1 || exactWake[0]!.agentId !== action.agentId
            || exactWake[0]!.issueId !== action.issueId || exactWake[0]!.missionId !== action.missionId)) {
            effect = { kind: "held", reason: "terminal_missing_evidence_wake_not_durable" };
          }
        }
      } else if (action.kind === "reevaluate_source") {
        const { syncWorkflowRunStateWithOutcome } = await import("./workflow/dag-engine.js");
        const outcome = await syncWorkflowRunStateWithOutcome(db, sourceRead.manifest.source.workflowRunId,
          "heartbeat_promotion", { requireRunning: true });
        if (outcome.kind === "busy") effect = { kind: "held", reason: "terminal_source_reevaluation_busy" };
      }
      if (effect.kind === "held") return effect;
      sourceRead = await readTerminalContinuationSource(eventId, db);
      if (sourceRead.kind !== "ready") {
        if (sourceRead.kind === "held" && sourceRead.reason === "terminal_continuation_source_or_authority_changed") {
          return settleTerminalContinuationFromQaSuccessor(db, eventId);
        }
        return sourceRead;
      }
      const acknowledged = await acknowledgeTerminalReleaseObligation(db, eventId, obligation.effectKey);
      if (acknowledged.kind === "held") return acknowledged;
      const reread = await readTerminalReleaseAcknowledgment(db, eventId, obligation.effectKey);
      if (reread.kind !== "acknowledged") return { kind: "held", reason: reread.kind === "held"
        ? reread.reason : "terminal_obligation_ack_not_durable" };
    }
    return { kind: "complete" };
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}) {
    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = withoutWorkflowAttemptProof(opts.contextSnapshot ?? {})!;
    const reason = opts.reason ?? null;
    const payload = withoutWorkflowAttemptProof(opts.payload ?? null);
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = enrichWakeContextSnapshot({
      contextSnapshot,
      reason,
      source,
      triggerDetail,
      payload,
    });
    const issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

    let agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");

    if (reason === "retry_failed_run" && issueId) {
      const currentIssueAssignee = await db
        .select({ assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0]?.assigneeAgentId ?? null);

      if (currentIssueAssignee && currentIssueAssignee !== agentId) {
        const assigneeAgent = await getAgent(currentIssueAssignee);
        if (assigneeAgent && assigneeAgent.companyId === agent.companyId) {
          agentId = currentIssueAssignee;
          agent = assigneeAgent;
        }
      }
    }

    const writeSkippedRequest = createSkippedWakeWriter(db, {
      companyId: agent.companyId,
      agentId,
      source,
      triggerDetail,
      payload,
      requestedByActorType: opts.requestedByActorType ?? null,
      requestedByActorId: opts.requestedByActorId ?? null,
      idempotencyKey: opts.idempotencyKey ?? null,
      issueId: issueId ?? null,
      contextSnapshot: enrichedContextSnapshot,
      recordEvent: (recordDb, event) => recordHeartbeatQueueTransitionEvent(recordDb, event),
    });

    let projectId = readNonEmptyString(enrichedContextSnapshot.projectId);
    if (!projectId && issueId) {
      projectId = await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0]?.projectId ?? null);
    }

    const missionIdForWake =
      readNonEmptyString(enrichedContextSnapshot.missionId) ??
      (issueId
        ? await db
            .select({ missionId: issues.missionId })
            .from(issues)
            .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
            .then((rows) => rows[0]?.missionId ?? null)
        : null);
    const requestedWorkflowRunId = readNonEmptyString(enrichedContextSnapshot.workflowRunId)
      ?? readNonEmptyString((payload as Record<string, unknown> | null)?.["workflowRunId"] as string)
      ?? null;
    const requestedWorkflowStepRunId = readNonEmptyString(enrichedContextSnapshot.workflowStepRunId)
      ?? readNonEmptyString((payload as Record<string, unknown> | null)?.["workflowStepRunId"] as string)
      ?? null;
    const workflowLink = await resolveWorkflowExecutionLink(db, {
      companyId: agent.companyId,
      issueId: issueId ?? null,
      workflowRunId: requestedWorkflowRunId,
      workflowStepRunId: requestedWorkflowStepRunId,
    });
    const workflowRunIdForWake = workflowLink.workflowRunId;
    const workflowStepRunIdForWake = workflowLink.workflowStepRunId;
    const workflowExecutionGeneration = workflowLink.generation;
    if (workflowRunIdForWake) enrichedContextSnapshot.workflowRunId = workflowRunIdForWake;
    if (workflowStepRunIdForWake) enrichedContextSnapshot.workflowStepRunId = workflowStepRunIdForWake;
    // [AREA: structured-events Task 1D] typed queue context derived from payload/contextSnapshot.
    // 모든 agent_wakeup_requests insert 경로에 mirror. payload 원본은 변경하지 않는다(호환성).
    const typedQueueColumns = {
      requestKind: readNonEmptyString((payload as Record<string, unknown> | null)?.["kind"] as string)
        ?? readNonEmptyString((payload as Record<string, unknown> | null)?.["mutation"] as string)
        ?? reason
        ?? source,
      issueId: issueId ?? null,
      missionId: (missionIdForWake ?? readNonEmptyString(enrichedContextSnapshot.missionId)) ?? null,
      workflowRunId: workflowRunIdForWake,
      workflowStepRunId: workflowStepRunIdForWake,
      ...(workflowExecutionGeneration !== null ? { workflowExecutionGeneration } : {}),
    };
    const correctionRef = readQaCorrectionWakeRef({
      payload, idempotencyKey: opts.idempotencyKey ?? null,
    } as typeof agentWakeupRequests.$inferSelect);
    if (correctionRef) {
      requireDelivery(issueId && missionIdForWake && workflowRunIdForWake && workflowStepRunIdForWake
        && workflowExecutionGeneration !== null, "scope");
      const result = await connectCorrectionDelivery({
        mode: "initial", ref: correctionRef, companyId: agent.companyId, agentId, issueId,
        missionId: missionIdForWake, workflowRunId: workflowRunIdForWake, workflowStepRunId: workflowStepRunIdForWake,
        workflowExecutionGeneration, candidateWakeupRequestId: null,
        request: { source, triggerDetail, reason, payload, contextSnapshot: enrichedContextSnapshot,
          idempotencyKey: opts.idempotencyKey!, requestKind: typedQueueColumns.requestKind,
          requestedByActorType: opts.requestedByActorType ?? null, requestedByActorId: opts.requestedByActorId ?? null },
      }, "public_callback");
      if (result.kind === "new_delivery" && result.run) {
        await recordQueueTransitionEvent({
          companyId: agent.companyId, missionId: missionIdForWake, issueId,
          wakeupRequestId: result.run.wakeupRequestId, heartbeatRunId: result.run.id,
          eventType: "queue_accepted", layer: "queue", decision: "accepted",
          reason: "heartbeat_run_created", reasonCode: "heartbeat_run_created",
          idempotencyKey: `queue-accepted:${result.run.wakeupRequestId ?? "no-wake"}:${result.run.id}`,
        });
        publishQueuedRun(result.run);
        await startNextQueuedRunForAgent(agent.id);
      }
      return result.run;
    }
    const wakeDefaults = {
      companyId: agent.companyId, agentId, source, triggerDetail, reason, payload, ...typedQueueColumns,
      status: "queued", requestedByActorType: opts.requestedByActorType ?? null,
      requestedByActorId: opts.requestedByActorId ?? null, idempotencyKey: opts.idempotencyKey ?? null,
    };
    const recoveryAdmission = { companyId: agent.companyId, agentId, ...typedQueueColumns,
      contextSnapshot: enrichedContextSnapshot, idempotencyKey: opts.idempotencyKey ?? null,
      source, reason, payload, requestedByActorType: opts.requestedByActorType ?? null,
      requestedByActorId: opts.requestedByActorId ?? null, operatorDecisionInitialAdmission: true };
    const queuePausedAgentWakeup = () => withTxTimeout(db, async tx => {
      await assertHeartbeatRecoveryAdmission(tx as unknown as Db, { ...recoveryAdmission, operatorDecisionOnly: true });
      await queuePausedAgentWakeupRequest(tx as unknown as Db, {
        companyId: agent.companyId, agentId, source, triggerDetail, reason, payload, typedQueueColumns,
        requestedByActorType: opts.requestedByActorType ?? null, requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null, missionIdForWake, contextSnapshot: enrichedContextSnapshot,
        contextSnapshotKey: DEFERRED_WAKE_CONTEXT_KEY,
        recordEvent: (recordDb, event) => recordHeartbeatQueueTransitionEvent(recordDb, event),
      });
    }, { label: "enqueueWakeup:paused-admission" });
    if (missionIdForWake) {
      try {
        await assertMissionRuntimeAcceptsWork(db, {
          companyId: agent.companyId,
          missionId: missionIdForWake,
        });
      } catch (err) {
        await writeSkippedRequest("mission.terminal");
        throw conflict(err instanceof Error ? err.message : "Mission is terminal", {
          missionId: missionIdForWake,
        });
      }
    }

    if (issueId && missionIdForWake) {
      const deferredOpsIssue = await deferOperationsMissionIssueToMainExecutor({
        agent,
        issueId,
        missionId: missionIdForWake,
      });
      if (deferredOpsIssue) {
        await writeSkippedRequest("operations_mission_issue_deferred_to_main_executor");
        if (deferredOpsIssue.mission.ownerAgentId !== agentId) {
          await enqueueWakeup(deferredOpsIssue.mission.ownerAgentId, {
            source: "automation",
            triggerDetail: "operations_mission_boundary",
            reason: "operations_mission_issue_deferred_to_main_executor",
            idempotencyKey: `ops-mission-boundary:${missionIdForWake}:${issueId}:${deferredOpsIssue.ownerAction.id}`,
            requestedByActorType: "system",
            requestedByActorId: "heartbeat",
            payload: {
              issueId: deferredOpsIssue.ownerAction.id,
              sourceIssueId: issueId,
              operationsAgentId: agentId,
            },
            contextSnapshot: {
              taskKey: `issue:${deferredOpsIssue.ownerAction.id}`,
              issueId: deferredOpsIssue.ownerAction.id,
              missionId: missionIdForWake,
              sourceIssueId: issueId,
              roleBoundary: "hermes_ops_chief_of_staff_liaison",
            },
          });
        }
        return null;
      }
    }

    const budgetBlock = await budgets.getInvocationBlock(agent.companyId, agentId, {
      issueId,
      projectId,
    });
    if (budgetBlock) {
      await writeSkippedRequest("budget.blocked");
      throw conflict(budgetBlock.reason, {
        scopeType: budgetBlock.scopeType,
        scopeId: budgetBlock.scopeId,
      });
    }

    if (
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      if (agent.status === "paused") {
        await queuePausedAgentWakeup();
        return null;
      }
      await writeSkippedRequest(`agent.${agent.status}`);
      return null;
    }

    const policy = parseHeartbeatPolicy(agent);

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled");
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
      return null;
    }

    const bypassIssueExecutionLock =
      reason === "issue_comment_mentioned" ||
      readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

    if (issueId && !bypassIssueExecutionLock) {
      const agentNameKey = normalizeAgentNameKey(agent.name);
      const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey, {
        missionId: readNonEmptyString(enrichedContextSnapshot.missionId),
      });
      const isWorkflowStepResume = isWorkflowStepResumeWake({
        requestKind: typedQueueColumns.requestKind,
        reason,
        payload,
        contextSnapshot: enrichedContextSnapshot,
      });

      const outcome = await withTxTimeout(db, async (tx) => {
        await assertHeartbeatRecoveryAdmission(tx as unknown as Db, recoveryAdmission);
        await tx.execute(
          sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
        );

        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            status: issues.status,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);

        if (!issue) {
          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_issue_not_found",
            payload,
            status: "skipped",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
            ...typedQueueColumns,
            finishedAt: new Date(),
          });
          return { kind: "skipped" as const };
        }

        // [T4 quality] 같은 quality wake 키의 기존 행이 있으면 새 행을 만들지 않고 그 상태를
        // 그대로 반환한다(통신 재전송 멱등 — 수락 원문은 최초 admission tx 에만 존재).
        const existingQualityWake = await findExistingQualityWakeRow(tx as unknown as Db, {
          companyId: agent.companyId,
          idempotencyKey: opts.idempotencyKey ?? null,
        });
        if (existingQualityWake) {
          return { kind: "quality_existing" as const, row: existingQualityWake };
        }

        let activeExecutionRun = issue.executionRunId
          ? await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, issue.executionRunId))
            .then((rows) => rows[0] ?? null)
          : null;

        if (activeExecutionRun && activeExecutionRun.status !== "queued" && activeExecutionRun.status !== "running") {
          activeExecutionRun = null;
        }

        if (!activeExecutionRun && issue.executionRunId) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issue.id));
        }

        if (!activeExecutionRun) {
          const legacyRun = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, issue.companyId),
                inArray(heartbeatRuns.status, ["queued", "running"]),
                or(eq(heartbeatRuns.issueId, issue.id), sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`),
              ),
            )
            .orderBy(
              sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
              asc(heartbeatRuns.createdAt),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (legacyRun) {
            activeExecutionRun = legacyRun;
            const legacyAgent = await tx
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, legacyRun.agentId))
              .then((rows) => rows[0] ?? null);
            await tx
              .update(issues)
              .set({
                executionRunId: legacyRun.id,
                executionAgentNameKey: normalizeAgentNameKey(legacyAgent?.name),
                executionLockedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }
        }

        if (activeExecutionRun) {
          // [PLAN-QA rework serialization] mission_owner_plan_rework_requested and the T8
          // plan_qa_evidence_resubmission wake must not coalesce into the active same-agent
          // run and must not use deferred_issue_execution: the mission_plan_qa completion gate
          // auto-blocks the issue before the deferred-promotion loop runs, which would strand
          // the wake forever. Persist one queued agent_wakeup_requests row (runId=null) so the
          // queue runner owns promotion after the active run ends. Dedupe by the exact
          // idempotency key so distinct keys are never silently merged. Store the full enriched
          // context snapshot so the promoted follow-up retains its wake context.
          if ((reason === "mission_owner_plan_rework_requested" || reason === "plan_qa_evidence_resubmission") && opts.idempotencyKey) {
            const planReworkQueuedPayload = {
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
            };
            const existingQueuedPlanRework = await tx
              .select({ id: agentWakeupRequests.id, coalescedCount: agentWakeupRequests.coalescedCount, payload: agentWakeupRequests.payload })
              .from(agentWakeupRequests)
              .where(and(
                eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "queued"),
                eq(agentWakeupRequests.idempotencyKey, opts.idempotencyKey),
                sql`${agentWakeupRequests.runId} is null`,
              ))
              .orderBy(asc(agentWakeupRequests.requestedAt))
              .limit(1)
              .then((rows) => rows[0] ?? null);
            if (existingQueuedPlanRework) {
              await tx
                .update(agentWakeupRequests)
                .set({ payload: preserveWorkflowAttemptProof(existingQueuedPlanRework.payload, planReworkQueuedPayload), coalescedCount: (existingQueuedPlanRework.coalescedCount ?? 0) + 1, updatedAt: new Date() })
                .where(eq(agentWakeupRequests.id, existingQueuedPlanRework.id));
            } else {
              await insertWorkflowWakeRequest(tx as unknown as Db, {
                ...wakeDefaults, payload: planReworkQueuedPayload,
              });
            }
            return { kind: "deferred" as const };
          }

          const executionAgent = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, activeExecutionRun.agentId))
            .then((rows) => rows[0] ?? null);
          const executionAgentNameKey =
            normalizeAgentNameKey(issue.executionAgentNameKey) ??
            normalizeAgentNameKey(executionAgent?.name);
          const isSameExecutionAgent =
            Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey;
          const shouldQueueFollowupForCommentWake =
            Boolean(wakeCommentId) &&
            activeExecutionRun.status === "running" &&
            isSameExecutionAgent;

          // [T4 quality] quality wake 는 다른 실행(동일 이름의 다른 agent 포함)에 절대
          // 병합·coalesce 되지 않는다 — 아래 deferred 경로로 별도 대기시킨다.
          if (isSameExecutionAgent && !shouldQueueFollowupForCommentWake && !isBoundedExecutionWakeKey(opts.idempotencyKey)
            && !correctionRef && !await isCorrectionRun(tx as unknown as Db, activeExecutionRun)) {
            const mergedContextSnapshot = mergeCoalescedContextSnapshot(
              activeExecutionRun.contextSnapshot,
              enrichedContextSnapshot,
            );
            refreshStepInputManifest(mergedContextSnapshot, runTaskKey(activeExecutionRun));
            const mergedRun = await tx
              .update(heartbeatRuns)
              .set({
                contextSnapshot: mergedContextSnapshot,
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, activeExecutionRun.id))
              .returning()
              .then((rows) => rows[0] ?? activeExecutionRun);

            await tx.insert(agentWakeupRequests).values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_same_name",
              payload,
              ...typedQueueColumns,
              status: "coalesced",
              coalescedCount: 1,
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              runId: mergedRun.id,
              finishedAt: new Date(),
            });

            return { kind: "coalesced" as const, run: mergedRun };
          }

          const deferredPayload = {
            ...(payload ?? {}),
            issueId,
            [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
          };

          const existingDeferred = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
                mergeableWakeupKeyCondition(opts.idempotencyKey),
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingDeferred) {
            const existingDeferredPayload = parseObject(existingDeferred.payload);
            const existingDeferredContext = parseObject(existingDeferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
            const mergedDeferredContext = mergeCoalescedContextSnapshot(
              existingDeferredContext,
              enrichedContextSnapshot,
            );
            refreshStepInputManifest(
              mergedDeferredContext,
              deriveTaskKey(mergedDeferredContext, null),
            );
            const mergedDeferredPayload = {
              ...existingDeferredPayload,
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: mergedDeferredContext,
            };

            await tx
              .update(agentWakeupRequests)
              .set({
                payload: mergedDeferredPayload,
                coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
                updatedAt: new Date(),
              })
              .where(eq(agentWakeupRequests.id, existingDeferred.id));

            return { kind: "deferred" as const };
          }

          await insertWorkflowWakeRequest(tx as unknown as Db, {
            ...wakeDefaults, reason: "issue_execution_deferred", payload: deferredPayload, status: "deferred_issue_execution",
          });

          return { kind: "deferred" as const };
        }

        // [B] 같은 mission 에 이미 queued/running run 이 있으면 새 run 을 만들지
        // 않는다(중복 run/issue 차단). 대신 wakeup request 를 runId=null queued
        // 상태로 남겨 실행요청 Queue 처럼 처리하고, agent/mission slot 이 비면
        // startNextQueuedRunForAgent 가 실제 heartbeat run 으로 승격한다.
        const missionIdForDedup = readNonEmptyString(enrichedContextSnapshot.missionId);
        if (missionIdForDedup) {
          const inFlightClause = await lifecycleInFlightClause(tx as unknown as Parameters<typeof lifecycleInFlightClause>[0]);
          const existingMissionRun = await tx
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.agentId, agentId),
                inFlightClause,
                sql`heartbeat_runs.context_snapshot ->> 'missionId' = ${missionIdForDedup}`,
                // [oversight exemption] 정기 점검(리뷰) 실행은 같은 미션의 새 단계 실행 등록을 막지 않는다.
                missionDedupExemptOversightReviewClause,
              ),
            )
            .limit(1);
          if (existingMissionRun.length > 0) {
            const queuedPayload = {
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
            };
            const existingQueuedWake = await tx
              .select()
              .from(agentWakeupRequests)
              .where(
                and(
                  eq(agentWakeupRequests.companyId, agent.companyId),
                  eq(agentWakeupRequests.agentId, agentId),
                  eq(agentWakeupRequests.status, "queued"),
                  sql`${agentWakeupRequests.runId} is null`,
                  sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
                  mergeableWakeupKeyCondition(opts.idempotencyKey),
                ),
              )
              .orderBy(asc(agentWakeupRequests.requestedAt))
              .limit(1)
              .then((rows) => rows[0] ?? null);

            if (existingQueuedWake) {
              const existingQueuedPayload = parseObject(existingQueuedWake.payload);
              const existingQueuedContext = parseObject(existingQueuedPayload[DEFERRED_WAKE_CONTEXT_KEY]);
              const mergedQueuedContext = mergeCoalescedContextSnapshot(
                existingQueuedContext,
                enrichedContextSnapshot,
              );
              refreshStepInputManifest(
                mergedQueuedContext,
                deriveTaskKey(mergedQueuedContext, null),
              );
              const mergedQueuedPayload = {
                ...existingQueuedPayload,
                ...(payload ?? {}),
                issueId,
                [DEFERRED_WAKE_CONTEXT_KEY]: mergedQueuedContext,
              };

              await tx
                .update(agentWakeupRequests)
                .set({
                  payload: mergedQueuedPayload,
                  coalescedCount: (existingQueuedWake.coalescedCount ?? 0) + 1,
                  updatedAt: new Date(),
                })
                .where(eq(agentWakeupRequests.id, existingQueuedWake.id));

              return { kind: "deferred" as const };
            }

            await insertWorkflowWakeRequest(tx as unknown as Db, {
              ...wakeDefaults, payload: queuedPayload,
            });
            return { kind: "deferred" as const };
          }
        }

        const wakeupRequest = await insertWorkflowWakeRequest(tx as unknown as Db, wakeDefaults).then((rows) => rows[0]);

        const newRun = await insertInitialWakeupRun(followupPromotionDeps, tx, {
          agent, request: wakeupRequest, contextSnapshot: enrichedContextSnapshot, taskKey,
          sessionBefore, issue, isWorkflowStepResume,
        });

        return { kind: "queued" as const, run: newRun };
      });

      // [Task 6C] mirror queue decision events based on enqueueWakeup outcome
      if (outcome.kind === "queued" && outcome.run) {
        await recordQueueTransitionEvent({
          companyId: agent.companyId,
          missionId: missionIdForWake,
          issueId: issueId ?? null,
          wakeupRequestId: outcome.run.wakeupRequestId,
          heartbeatRunId: outcome.run.id,
          eventType: "queue_accepted",
          layer: "queue",
          decision: "accepted",
          reason: "heartbeat_run_created",
          reasonCode: "heartbeat_run_created",
          idempotencyKey: `queue-accepted:${outcome.run.wakeupRequestId ?? "no-wake"}:${outcome.run.id}`,
        });
      } else if (outcome.kind === "deferred" || outcome.kind === "coalesced") {
        await recordQueueTransitionEvent({
          companyId: agent.companyId,
          missionId: missionIdForWake,
          issueId: issueId ?? null,
          eventType: "queue_waiting",
          layer: "queue",
          decision: "waiting",
          reason: "active_run_or_execution_lock",
          reasonCode: "active_run_or_execution_lock",
          idempotencyKey: `queue-waiting:${agent.companyId}:${agentId}:${issueId ?? "no-issue"}`,
        });
      }

      if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;
      if (outcome.kind === "quality_existing") return null;
      if (outcome.kind === "coalesced") return outcome.run;

      const newRun = outcome.run;
      publishQueuedRun(newRun);

      await startNextQueuedRunForAgent(agent.id);
      return newRun;
    }

    // [mention-wake serialization] 잠긴 경로와 같은 입장 로직을 db/tx 양쪽에서 재사용한다.
    // 논리·필드는 기존 제네릭 입장과 동일하고, 실행기(execDb)만 갈린다.
    const admitUnlockedRun = async (execDb: Db) => {
      const activeRuns = await execDb
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
        .orderBy(desc(heartbeatRuns.createdAt));

      const mergeableRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const candidate of activeRuns) {
        if (!correctionRef && !await isCorrectionRun(execDb, candidate)) mergeableRuns.push(candidate);
      }
      const sameScopeQueuedRun = mergeableRuns.find(
        (candidate) => candidate.status === "queued" && isSameTaskScope(runTaskKey(candidate), taskKey),
      );
      const sameScopeRunningRun = mergeableRuns.find(
        (candidate) => candidate.status === "running" && isSameTaskScope(runTaskKey(candidate), taskKey),
      );
      const shouldQueueFollowupForCommentWake =
        Boolean(wakeCommentId) && Boolean(sameScopeRunningRun) && !sameScopeQueuedRun;

      const coalescedTargetRun =
        sameScopeQueuedRun ??
        (shouldQueueFollowupForCommentWake ? null : sameScopeRunningRun ?? null);

      if (coalescedTargetRun) {
        const mergedContextSnapshot = mergeCoalescedContextSnapshot(
          coalescedTargetRun.contextSnapshot,
          contextSnapshot,
        );
        refreshStepInputManifest(mergedContextSnapshot, runTaskKey(coalescedTargetRun));
        const mergedRun = await execDb
          .update(heartbeatRuns)
          .set({
            contextSnapshot: mergedContextSnapshot,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
          .returning()
          .then((rows) => rows[0] ?? coalescedTargetRun);

        await execDb.insert(agentWakeupRequests).values({
          companyId: agent.companyId,
          agentId,
          source,
          triggerDetail,
          reason,
          payload,
          status: "coalesced",
          coalescedCount: 1,
          ...typedQueueColumns,
          requestedByActorType: opts.requestedByActorType ?? null,
          requestedByActorId: opts.requestedByActorId ?? null,
          idempotencyKey: opts.idempotencyKey ?? null,
          runId: mergedRun.id,
          finishedAt: new Date(),
        });
        return { run: mergedRun, coalesced: true };
      }

      const wakeupRequest = await insertWorkflowWakeRequest(execDb, wakeDefaults).then((rows) => rows[0]);

      const wakeupMissionId = readNonEmptyString(enrichedContextSnapshot.missionId);
      const wakeupEffectiveTaskKey = wakeupMissionId ? `mission:${wakeupMissionId}` : taskKey;
      const sessionBefore = await resolveSessionBeforeForWakeup(agent, wakeupEffectiveTaskKey, {
        missionId: wakeupMissionId,
      });

      const newRun = await insertQueuedHeartbeat(execDb, {
        agent, issueId, source, triggerDetail, wakeupRequestId: wakeupRequest.id,
        contextSnapshot: enrichedContextSnapshot, taskKey, sessionBefore,
      });

      await execDb
        .update(agentWakeupRequests)
        .set({
          runId: newRun.id,
          updatedAt: new Date(),
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      return { run: newRun, coalesced: false };
    };

    // [mention-wake serialization] issueId 있는 코멘트-멘션 우회 깨움의 런 입장도 잠긴
    // 경로와 같은 직렬화 객체 — 같은 이슈 행 FOR UPDATE + withTxTimeout — 아래에서
    // 실행한다(동시 멘션 깨움의 런 중복 입장과 세대 경쟁, 멘션 × 일반 깨움의 교차-커밋
    // 경쟁을 입장 단계에서 차단). 우회 의미론은 유지: 이 트랜잭션은 issues 의
    // executionRunId/executionLockedAt 등 어느 필드도 쓰지 않고 직렬화 잠금만 가져간다.
    // [dispatchGeneration 비잠금 창 폐쇄] issueId 없는 taskKey 전용 경로도 같은
    //   withTxTimeout 안에서 입장한다 — resolveNextDispatchGeneration 의 어드바이저리
    //   트랜잭션 락이 count→insert 창을 직렬화하려면 입장 전체가 한 트랜잭션이어야 한다.
    //   입장 본문은 짧은 쿼리들뿐(외부 호출 없음)이라 타임아웃 상한 안에서 끝난다.
    const admission = issueId
      ? await withTxTimeout(
          db,
          async (tx) => {
            await assertHeartbeatRecoveryAdmission(tx as unknown as Db, recoveryAdmission);
            await tx.execute(
              sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
            );
            return admitUnlockedRun(tx as unknown as Db);
          },
          { label: "enqueueWakeup:mention-admission" },
        )
      : await withTxTimeout(
          db,
          async (tx) => {
            await assertHeartbeatRecoveryAdmission(tx as unknown as Db, recoveryAdmission);
            return admitUnlockedRun(tx as unknown as Db);
          },
          { label: "enqueueWakeup:taskkey-admission" },
        );

    if (!admission.coalesced) {
      publishQueuedRun(admission.run);

      await startNextQueuedRunForAgent(agent.id);
    }

    return admission.run;
  }

  const { cancelRunInternal, cancelBudgetScope, control } = createHeartbeatAgentCancellation({
    db, getRun, setRunStatus, setWakeupStatus, appendRunEvent,
    setTransactionalRunStatus: setHeartbeatRunStatus,
    publishRunStatus: (run) => publishHeartbeatRunStatus(publishLiveEvent, run),
    releaseIssueExecutionAndPromote, finalizeAgentStatus, startNextQueuedRunForAgent,
    terminateRecordedProcess, runningProcesses,
  });

  async function cancelBudgetScopeWork(scope: BudgetEnforcementScope) {
    await cancelBudgetScope(scope);
  }

  return {
    list: async (companyId: string, agentId?: string, limit?: number) => {
      const effectiveLimit = clampRunListLimit(limit);
      const rows = await db
        .select(heartbeatRunListColumns)
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.companyId, companyId),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(effectiveLimit);

      return rows.map((row) => ({
        ...row,
        resultJson: summarizeHeartbeatRunResultJson(row.resultJson),
      }));
    },

    listSummaryPage: (input: { companyId: string; agentId?: string; limit?: number; cursor?: { createdAt: Date; id: string } | null }) =>
      listHeartbeatRunSummaryPage(db, input),

    count: (input: { companyId: string; agentId?: string; statuses?: HeartbeatRunStatus[] }) =>
      countHeartbeatRuns(db, input),

    stats: (input: { companyId: string; agentId?: string; days?: number }) =>
      statsHeartbeatRuns(db, input),

    attention: (input: { companyId: string; agentId?: string; limit?: number; cursor?: { createdAt: Date; id: string } | null; dismissedRunIds?: string[] }) =>
      attentionHeartbeatRuns(db, input),

    getRun,

    getRuntimeState: async (agentId: string) => {
      const state = await getRuntimeState(agentId);
      const agent = await getAgent(agentId);
      if (!agent) return null;
      const ensured = state ?? (await ensureRuntimeState(agent));
      const latestTaskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agent.id)))
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const activeMissionSessions = await db
        .select()
        .from(missionSessions)
        .where(
          and(
            eq(missionSessions.companyId, agent.companyId),
            eq(missionSessions.agentId, agent.id),
            eq(missionSessions.status, "active"),
          ),
        )
        .orderBy(desc(missionSessions.lastActiveAt), desc(missionSessions.createdAt));
      const latestMissionSession = activeMissionSessions[0] ?? null;
      const latestMissionSessionId = latestMissionSession
        ? await secretsSvc
            .resolveSecretValue(agent.companyId, latestMissionSession.sessionSecretId, "latest")
            .catch(() => null)
        : null;
      const sessionAuthority =
        activeMissionSessions.length > 0
          ? "mission_session"
          : latestTaskSession?.sessionDisplayId
            ? "task_session"
            : ensured.sessionId
              ? "runtime_state"
              : "none";

      return {
        ...ensured,
        sessionDisplayId: latestMissionSessionId ?? latestTaskSession?.sessionDisplayId ?? ensured.sessionId,
        sessionParamsJson: sessionAuthority === "task_session" ? (latestTaskSession?.sessionParamsJson ?? null) : null,
        sessionAuthority,
        activeMissionSessionCount: activeMissionSessions.length,
        latestMissionSession: latestMissionSession
          ? {
              missionId: latestMissionSession.missionId,
              sessionId: latestMissionSessionId,
              lastActiveAt: latestMissionSession.lastActiveAt,
              runCount: latestMissionSession.runCount,
            }
          : null,
      };
    },

    listTaskSessions: async (agentId: string) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");

      return db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agentId)))
        .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt));
    },

    resetRuntimeSession: async (agentId: string, opts?: { taskKey?: string | null }) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");
      await ensureRuntimeState(agent);
      const taskKey = readNonEmptyString(opts?.taskKey);
      const clearedTaskSessions = await clearTaskSessions(
        agent.companyId,
        agent.id,
        taskKey ? { taskKey, adapterType: agent.adapterType } : undefined,
      );
      const runtimePatch: Partial<typeof agentRuntimeState.$inferInsert> = {
        sessionId: null,
        lastError: null,
        updatedAt: new Date(),
      };
      if (!taskKey) {
        runtimePatch.stateJson = {};
      }

      const updated = await db
        .update(agentRuntimeState)
        .set(runtimePatch)
        .where(eq(agentRuntimeState.agentId, agentId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) return null;
      return {
        ...updated,
        sessionDisplayId: null,
        sessionParamsJson: null,
        clearedTaskSessions,
      };
    },

    listEvents: (runId: string, afterSeq = 0, limit = 200) =>
      db
        .select()
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, afterSeq)))
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(Math.max(1, Math.min(limit, 1000))),

    readLog: async (runId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (!run.logStore || !run.logRef) throw notFound("Run log not found");

      const result = await runLogStore.read(
        {
          store: run.logStore as "local_file",
          logRef: run.logRef,
        },
        opts,
      );

      return {
        runId,
        store: run.logStore,
        logRef: run.logRef,
        ...result,
        content: redactCurrentUserText(result.content, await getCurrentUserRedactionOptions()),
      };
    },

    invoke: async (
      agentId: string,
      source: "timer" | "assignment" | "on_demand" | "automation" | "scheduler" = "on_demand",
      contextSnapshot: Record<string, unknown> = {},
      triggerDetail: string = "manual",
      actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
    ) =>
      enqueueWakeup(agentId, {
        source,
        triggerDetail,
        contextSnapshot,
        requestedByActorType: actor?.actorType,
        requestedByActorId: actor?.actorId ?? null,
      }),

    wakeup: enqueueWakeup,

    reportRunActivity: clearDetachedRunWarning,

    reapOrphanedRuns,

    // Exact durable recovery entrypoint: the manifest, actual-drain receipt and current source are
    // revalidated before any existing writer can run; this does not grant execution authority.
    recoverTerminalReleaseContinuation: runTerminalReleaseContinuation,

    markRunsShutdownInterrupted,

    reapStaleBusyMissionRuntimes,

    reapStalledIssueExecutionLocks,

    resumeQueuedRuns,
    resumeQaCorrectionWake: (wakeupRequestId: string) =>
      deliverStoredQaCorrectionWake(wakeupRequestId, "public_callback", true),

    tickTimers: async (now = new Date()) => {
      const allAgents = await db.select().from(agents);
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;

      for (const agent of allAgents) {
        if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled || policy.intervalSec <= 0) continue;

        checked += 1;
        const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
        const elapsedMs = now.getTime() - baseline;
        if (elapsedMs < policy.intervalSec * 1000) continue;

        // [수정시 영향] 이 에이전트가 이미 queued/running run 을 가지고 있으면
        // timer wake 를 skip 한다. run 이 finalize 되지 않아 lastHeartbeatAt 가
        // 갱신되지 않더라도, active run 이 존재하면 매 tick 새 wake 를 만들지
        // 않는다(매 tick 재발사 + queued run 적체 방지).
        const activeRun = await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.agentId, agent.id),
              sql`${heartbeatRuns.status} in ('queued','running')`,
            ),
          )
          .limit(1);
        if (activeRun.length > 0) {
          skipped += 1;
          continue;
        }

        const run = await enqueueWakeup(agent.id, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          contextSnapshot: {
            source: "scheduler",
            reason: "interval_elapsed",
            now: now.toISOString(),
          },
        });
        if (run) enqueued += 1;
        else skipped += 1;
      }

      return { checked, enqueued, skipped };
    },

    finalizeLinkedRunsForIssueStatus,

    ...control,

    cancelBudgetScopeWork,

    getActiveRunForAgent: async (agentId: string) => {
      const activeClause = await lifecycleActiveClause(db);
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), activeClause))
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },
  };
}
import { isPgUniqueViolation } from "./pg-error.js";
