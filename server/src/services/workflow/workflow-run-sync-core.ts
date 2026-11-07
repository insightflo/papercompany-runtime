import { createWorkflowStepIssue } from "./workflow-step-issue.js";
import { isIssueLessToolStep } from "./issue-less-tool-shape.js";
import { type ChildStartFence } from "./workflow-child-start-state.js";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { withReplacementFirstDelivery } from "./replacement-first-delivery.js";
import { createQaRemediationRefire } from "./control-flow/qa-remediation.js";
import { withQaCorrectionFollowupReconcile } from "./control-flow/qa-correction-followup-reconcile.js";
import { QaRemediationAdmissionHold, unresolvedQaRemediationAdmissionPending, type QaRemediationAdmissionContext } from "./control-flow/qa-remediation-admission-root.js";
import { issueComments, issues, workflowDefinitions, workflowStepRuns } from "@paperclipai/db";
import { workflowControlNodeResultSchema } from "@paperclipai/shared";
import { sortWorkflowStepsByPriority } from "./dag-step-priority.js";
import { buildStepRunMap, toConditionalStepObservation } from "./dag-step-observation.js";
import { normalizeRecord } from "./dag-metadata-helpers.js";
import { buildPredFactsMap, findRunnableSteps, type ValidationVerdictObservation } from "./dag-readiness-facts.js";
import { loadLatestValidationVerdicts, type WorkflowValidationIssueBinding } from "./dag-validation-verdicts.js";
import { mapWorkflowExecutionResult } from "./workflow-execution-result.js";
import type { WorkflowExecutionResult } from "./types.js";
import { normalizeWorkflowSyncSource, recordWorkflowStepStatusTransitions, type WorkflowSyncSource } from "./workflow-sync-source.js";
import { setWorkflowStepRunStatus } from "./step-status-fencing.js";
import { dispatchWorkflowChildStep, isWorkflowChildStep, runWorkflowChildCompletionHook } from "./workflow-child-execution.js";
import { wakeReplacementAwareIssueRetry as wakeIssueBackedRetryAndMarkDispatching } from "./replacement-agent-delivery.js";
import { syncQualityStepIssueCommitBeforeWake } from "../quality/native-records.js";
import { wakeExistingWorkflowStepIssue } from "./workflow-step-wake.js";
import { finalizeWorkflowRunState } from "./workflow-run-finalization.js";
import { isHeartbeatFinalizationV1Enabled } from "../heartbeat-finalization/flag.js";
import { TERMINAL_WORKFLOW_STATUSES } from "../missions/mission-runtime-manager.js";
import { logActivity } from "../activity-log.js";
import { logger } from "../../middleware/logger.js";
import { classifyStepActivation, workflowHasConditionalEdges } from "./control-flow/edge-condition.js";
import { applyBackEdgeReworkPass } from "./control-flow/loop-driver.js";
import { cancelResolvedQaSourceDefectOwnerCards } from "./qa-source-defect-owner-card.js";
import { closeResolvedWorkflowUnblocks } from "./resolved-unblock-closeout.js";
import { isRunTerminalBoundaryV1Enabled } from "./run-terminal-boundary-flag.js";
import { isRunReopenGuardEnabled } from "./run-reopen-guard-flag.js";
import { applyStructuralGatePass, requeueStaleStructuralGatesForBlockedQa } from "./control-flow/structural-gate-rework.js";
import { reviveConditionalSkip } from "./conditional-skip-settlement.js";
import { stepRunNeedsWorkflowResume } from "./dag-rework-observation.js";
import { reloadWorkflowStepRunsForSameRun } from "./workproduct-dependency-gate.js";
import { isStructuralGateStep } from "./control-flow/structural-gate.js";
import { executeWorkflowControlNode, isWorkflowControlNode, resetStaleIfControlNodesForResume } from "./control-flow/control-node-executor.js";
import { readWorkflowRetryMetadata } from "./retry-policy.js";
import { markIssueLessRetryDispatchingFromProof } from "./retry-launch-dispatch.js";
import { applyWorkflowStepRetryPass } from "./workflow-step-retry-pass.js";
import { shouldLoadValidationVerdictsForRun } from "./validation-verdict-load-gate.js";
import { getWorkflowLaunchSteps, isDynamicOwnerPlanWorkflowDefinition, type WorkflowDefinitionExecutionShape } from "./execution-steps.js";
import { loadWorkflowExecutionContext } from "./workflow-execution-context.js";
import { assertResumeAccepted } from "./resume/acceptance.js";
import { readWorkflowRunWithStepRuns } from "./workflow-run-step-read.js";
import { discoverWorkflowChildStart } from "./workflow-child-discovery.js";
import { workflowChildStepIds, ensureStepRunRecords, buildWorkflowStepRunMetadata, resetUnlaunchedTerminalStepRuns } from "./workflow-step-run-maintenance.js";
import { syncStepRunsFromIssueState } from "./workflow-issue-state-sync.js";
import { readWorkflowToolCorrection } from "./workflow-tool-correction.js";
import { applyConditionalSkipPropagation } from "./workflow-conditional-skip.js";
import { cancelOutstandingWorkflowIssues } from "./workflow-cancellation.js";
import { startIssueLessToolStepRun } from "./workflow-tool-start.js";
import type { WorkflowExecutionContext } from "./dag-engine.js";

const WORKFLOW_STEP_TERMINAL_STATUSES = new Set(["completed", "failed", "skipped"]);

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

export function getDynamicLaunchStepIds(context: WorkflowExecutionContext): Set<string> | undefined {
  const dynamicOwnerPlan = isDynamicOwnerPlanWorkflowDefinition(buildWorkflowDefinitionExecutionShape(context));
  if (!dynamicOwnerPlan) return undefined;
  return new Set(getWorkflowLaunchSteps(context.steps, { dynamicOwnerPlan }).map((step) => step.id));
}

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
