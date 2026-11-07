import { collectGateValidatedProducerStepIds } from "./workflow-step-issue.js";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { currentQaCorrectionSyncTime, queueCurrentIssuedQaCorrectionTargets } from "./control-flow/qa-correction-followup-reconcile.js";
import { issues, workflowStepRuns } from "@paperclipai/db";
import { normalizeRecord } from "./dag-metadata-helpers.js";
import { isValidationGateCandidate } from "./dag-readiness-facts.js";
import { desiredValidationCheckStepStatus, loadLatestValidationVerdicts, type WorkflowValidationIssueBinding } from "./dag-validation-verdicts.js";
import { setWorkflowStepRunStatus } from "./step-status-fencing.js";
import { desiredStepRunStatusFromIssueStatus } from "./workflow-step-issue-records.js";
import { recheckValidationStepIssues } from "./workflow-validation-recheck.js";
import { readWorkflowReworkContract } from "./control-flow/rework-contract.js";
import { isPendingReworkAwaitingCurrentIssueCompletion, matchesCurrentCapAcceptedProducer } from "./dag-rework-observation.js";
import { applyWorkProductDependencyGate, collectUniqueStepRunIssueIds, loadWorkProductDependencyGate, reloadWorkflowStepRunsForSameRun } from "./workproduct-dependency-gate.js";
import { shouldPreservePendingRetryFromIssueState, stripRetryTrackingOnSuccess } from "./retry-launch-dispatch.js";
import type { WorkflowStep, WorkflowExecutionContext } from "./dag-engine.js";
import { readWorkflowToolCorrection } from "./workflow-tool-correction.js";

export async function syncStepRunsFromIssueState(
  db: Db,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
  steps: WorkflowStep[] = [],
  context?: WorkflowExecutionContext,
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  const correctionToolIds = new Set<string>();
  if (context) {
    for (const stepRun of stepRuns) {
      const step = steps.find(s => s.id === stepRun.stepId);
      if (step && await readWorkflowToolCorrection(db, context.run, stepRun, step)) correctionToolIds.add(stepRun.id);
    }
  }
  // Issued tool targets settle through the tool queue, never through an old issue status or agent wake.
  const issueIds = stepRuns
    .map((stepRun) => stepRun.issueId)
    .filter((issueId): issueId is string => Boolean(issueId));
  if (issueIds.length === 0) return stepRuns;
  // Preserve status/verdict sync; reserve only the issued agent targets from ordinary recheck.
  const correctionIssueIds = context ? await queueCurrentIssuedQaCorrectionTargets(db, context.run,
    stepRuns.filter(s => !correctionToolIds.has(s.id))) : new Set<string>();
  const issueRows = await db.select({
    id: issues.id, companyId: issues.companyId, status: issues.status, startedAt: issues.startedAt,
    completedAt: issues.completedAt, cancelledAt: issues.cancelledAt, title: issues.title, originKind: issues.originKind,
  }).from(issues).where(inArray(issues.id, issueIds));
  const correctionToolIssueIds = new Set(stepRuns.filter(s => correctionToolIds.has(s.id)).map(s => s.issueId));
  const issueById = new Map(issueRows
    .filter(issue => issue.status === "cancelled" || !correctionToolIssueIds.has(issue.id))
    .map((issue) => [issue.id, issue]));
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const workProductDependencyGate = await loadWorkProductDependencyGate(db, stepRuns, steps);
  const validationCandidateIssueIds = collectUniqueStepRunIssueIds(stepRuns.filter((stepRun) => {
      if (!stepRun.issueId) return false;
      const issue = issueById.get(stepRun.issueId);
      if (!issue || (issue.status !== "done" && issue.status !== "blocked")) return false;
      return isValidationGateCandidate({
        issueTitle: issue.title,
        issueOriginKind: issue.originKind,
        step: stepById.get(stepRun.stepId) ?? null,
      });
    }));
  const validationCandidateIssueIdSet = new Set(validationCandidateIssueIds);
  const validationBindings = new Map<string, WorkflowValidationIssueBinding>();
  for (const stepRun of stepRuns) {
    if (!stepRun.issueId || !validationCandidateIssueIdSet.has(stepRun.issueId)) continue;
    const issue = issueById.get(stepRun.issueId);
    if (!issue) continue;
    validationBindings.set(stepRun.issueId, {
      companyId: issue.companyId,
      workflowRunId: stepRun.workflowRunId,
      workflowStepRunId: stepRun.id,
    });
  }
  const latestValidationVerdictByIssueId = await loadLatestValidationVerdicts(db, validationBindings);
  await recheckValidationStepIssues({
    db,
    stepRuns,
    stepById,
    issueById,
    validationCandidateIssueIds: validationCandidateIssueIds.filter(id => !correctionIssueIds.has(id)),
    // The callee iterates stepRuns; its private verdict view is the actual wake fence.
    latestValidationVerdictByIssueId: new Map([...latestValidationVerdictByIssueId].filter(([id]) => !correctionIssueIds.has(id))),
    context,
  }, { isValidationGateCandidate, collectGateValidatedProducerStepIds });

  // A rework reset ignores the prior issue completion but accepts a later
  // completion from the current iteration.
  for (const stepRun of stepRuns) {
    if (!stepRun.issueId) continue;
    const issue = issueById.get(stepRun.issueId);
    if (!issue) continue;
    if (stepRun.issueId && await shouldPreservePendingRetryFromIssueState({
      db,
      companyId: issue.companyId,
      issueId: issue.id,
      stepRunStatus: stepRun.status,
      metadata: stepRun.metadata,
    })) {
      continue;
    }
    if (isPendingReworkAwaitingCurrentIssueCompletion(stepRun, issue.completedAt)) continue;
    // [qa-cap acceptance] cap 수용으로 completed 된 QA 는 request_changes+done 재유도(flap)에서 보호 —
    //   단, sentinel 의 producerStepId/producerIteration 이 현 sync 의 completed producer row 와 정확히
    //   일치(현 generation)할 때만. 새 producer generation(rework) 시 보호 해제 → 재유도 허용.
    if (stepRun.status === "completed" && matchesCurrentCapAcceptedProducer(stepRun, stepRuns)) continue;
    const isValidationCheck = validationCandidateIssueIdSet.has(issue.id);
    const latestValidationVerdict = latestValidationVerdictByIssueId.get(issue.id);
    const ungatedStatus = isValidationCheck
      ? desiredValidationCheckStepStatus({ issueStatus: issue.status, latestVerdict: latestValidationVerdict })
      : desiredStepRunStatusFromIssueStatus(issue.status);
    const desiredStatus = applyWorkProductDependencyGate({
      issueId: issue.id,
      status: ungatedStatus,
      gate: workProductDependencyGate,
    });
    const patch: Partial<typeof workflowStepRuns.$inferInsert> = {};
    const now = new Date();
    // [rework startedAt 타이밍] rework 리셋 후 stepRun.startedAt 이 null 이면 startedAt 이 완료
    //   시각(now)으로 잡혀, 같은 시도가 막 생산한 work product(updatedAt 이 몇 초 먼저)이 "이전 시도
    //   산물(stale)"로 오분류돼 하류 IF 노드의 신선도 검사(condition-source-resolver)가 실패한다.
    //   rework 계약의 createdAt(= 현 시도 시작의 신뢰 가능 하한)으로 폴백해 현 시도 산물이 stale 처리
    //   되지 않게 한다. 비-rework(최초 시도)는 reworkStartedAt 이 null 이라 기존 동작과 동일.
    const reworkContract = readWorkflowReworkContract(
      normalizeRecord(stepRun.metadata).workflowReworkContract,
    );
    const reworkStartedAt = reworkContract?.createdAt ? new Date(reworkContract.createdAt) : null;
    const attemptStartedAt = stepRun.startedAt ?? issue.startedAt ?? reworkStartedAt ?? now;

    if (desiredStatus !== stepRun.status) {
      patch.status = desiredStatus;
    }

    if (desiredStatus === "running") {
      patch.startedAt = attemptStartedAt;
      patch.completedAt = null;
    } else if (desiredStatus === "completed") {
      patch.startedAt = attemptStartedAt;
      patch.completedAt = issue.completedAt ?? currentQaCorrectionSyncTime(db) ?? now;
      // When finalization v1 is active, issue-backed steps also need
      // dispatch_ready_at set so downstream edge-condition evaluation admits
      // successors. Heartbeat-linked steps get this via settlement.ts, but
      // steps that complete via issue status sync (e.g. workflow_agent_api)
      // bypass settlement entirely.
      if (!stepRun.dispatchReadyAt) {
        patch.dispatchReadyAt = now;
      }
      const cleanedRetryMetadata = stripRetryTrackingOnSuccess(stepRun.metadata);
      if (cleanedRetryMetadata) {
        patch.metadata = cleanedRetryMetadata;
      }
    } else if (desiredStatus === "failed") {
      patch.startedAt = attemptStartedAt;
      patch.completedAt = issue.cancelledAt ?? issue.completedAt ?? currentQaCorrectionSyncTime(db) ?? now;
    } else {
      patch.startedAt = null;
      patch.completedAt = null;
    }

    if (Object.keys(patch).length === 0) continue;
    const metadataCleanupCondition = patch.metadata
      ? eq(workflowStepRuns.metadata, stepRun.metadata)
      : undefined;
    // 늦은 이슈 완료가 종결/재설정된 세대의 스텝 행을 덮어쓰지 않게 하는 소비 지점 울타리.
    // 세대가 바뀌었다면 이 패치는 0행으로 흐르고, 이후 reload 가 실제 상태를 반영한다.
    // [step-status fencing v1] 세대 울타리에 스냅샷 status CAS 를 추가 — load 이후 같은 세대
    //   안에서 상태가 이미 옮겨간 행을 늦은 소비자가 덮어쓰는 좀비쓰기를 막는다(0행 폐기+로그).
    await setWorkflowStepRunStatus(db, {
      stepRunId: stepRun.id,
      status: desiredStatus,
      patch,
      expectedStatuses: [stepRun.status],
      extraConditions: [
        eq(workflowStepRuns.executionGeneration, stepRun.executionGeneration),
        ...(metadataCleanupCondition ? [metadataCleanupCondition] : []),
      ],
    });
  }

  return reloadWorkflowStepRunsForSameRun(db, stepRuns);
}
