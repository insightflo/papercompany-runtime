// server/src/services/missions/supervision-post-loop-phases.ts
//
// [수정시 주의] main executor supervision 의 per-issue 루프 **이후** 단계 묶음.
// supervision-main.ts 의 runMainExecutorSupervision 꼬리(원본 1606-2206)를 본문 변경 없이 옮긴 모듈이다.
// 이 모듈이 만드는 것: (1) workflow run 자체가 종단 실패일 때의 Human Operator 리포트 발행,
// (2) 실행 단계 누락(dispatch_missing_step) 진단과 안전 동기화, (3) oversight 진단 본문 중복 판정,
// (4) execution snapshot 의 stale 실행 단위 진단, (5) plan 제출/승인 입력 누락·종결 브리지,
// (6) 안전 액션 적용(applySafeActions)과 applied actions 기록, (7) 최종 oversight 코멘트 발행.
// 원본은 runMainExecutorSupervision 의 클로저 값을 그대로 읽었으므로, 여기서는 입력을
// MissionPostLoopPhaseInputs 하나로 받는다. 반환은 원본의 세 return(MissionOwnerSupervisionResult)을
// 그대로 이어받는다. 호출부는 이 함수를 즉시 return 하므로 추가 await·분기 없이 의미가 동일하다.
// 입력 필드를 바꾸면 supervision-main.ts 의 호출 인자도 함께 고쳐야 한다(타입 검사가 잡는다).
import { issueComments, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import type { MissionServiceDeps } from "../missions.js";
import { recordLatestAuthorizedMissionOwnerPlanDecision } from "../mission-owner-plan-decisions.js";
import { syncWorkflowRunState, type WorkflowStep } from "../workflow/dag-engine.js";
import type { createOwnerActions } from "./owner-actions.js";
import type { MissionExecutionSourceRef } from "./mission-execution-sources.js";
import {
  buildMissionSupervisionContext,
  type MissionSupervisionIssue,
  type MissionSupervisionWorkflowStepRow,
} from "./mission-supervision-context.js";
import { formatMissionPlanDecisionSubmissionDiagnostics } from "./mission-plan-decision-ledger.js";
import { buildMaterializePlanDecisionAction } from "./mission-plan-consumer-diagnostics.js";
import { buildRevisionMissionPlanningDescription } from "./mission-revision-planning.js";
import { missionPlanTemplateService } from "./mission-plan-templates.js";
import { buildOwnerActionExplanations } from "./mission-owner-recovery-explanations.js";
import { isTerminalIssueStatus } from "./mission-owner-recovery-comments.js";
import type { OwnerToolRecoveryOutcome } from "./owner-tool-recovery.js";
import {
  asRecord,
  asRecordArray,
  executionUnitKey,
  executionUnitKeyFromSourceRef,
  isApprovalRuleMode,
  normalizedPlanStatus,
  trimmedString,
  unitRequiresGovernedAction,
} from "./supervision-helpers.js";
import type { runMissionPreLoopPhases } from "./supervision-pre-loop-phases.js";
import {
  claimSupervisionMarkerOnce,
  formatAppliedAction,
  hasOpenOrMissingIssueLessToolRecoveryCard,
  recordRecoveryAction,
  TERMINAL_CLOSEOUT_RUN_STATUSES,
} from "./supervision-support.js";
import type {
  MissionOwnerSupervisionAppliedAction,
  MissionOwnerSupervisionRecommendation,
  MissionOwnerSupervisionResult,
} from "./supervision-types.js";
import { selectTerminalWorkflowAuthoritySource } from "./terminal-mission-authority-source.js";
import { isIssueLessToolWorkflowStep } from "./tool-step-failure.js";
import { issueLessToolRecoveryOwnsFailure } from "./tool-step-recovery-authority.js";

/** 앞 단계(runMissionPreLoopPhases)가 만들어 넘기는 값. 필드가 바뀌면 양쪽이 함께 컴파일 오류로 드러난다. */
type PreLoopPhaseResult = Awaited<ReturnType<typeof runMissionPreLoopPhases>>;

/** 이 단계가 바깥에서 받는 입력. 원본 runMainExecutorSupervision 의 클로저 값과 팩토리 파라미터를 그대로 옮겼다. */
export interface MissionPostLoopPhaseInputs {
  db: Db;
  deps: MissionServiceDeps;
  ownerActions: ReturnType<typeof createOwnerActions>;
  /** 원본 input 중 이 구간이 읽는 필드만(나머지 input.* 는 이 모듈 안 중첩 클로저의 자체 파라미터다). */
  input: { applySafeActions?: boolean; staleAfterMinutes?: number };
  /** context 중 이 구간은 mission·missionIssues·missionIssueById·commentsByIssueId·stepRows·executionSnapshot·activePlan 만 읽는다. */
  context: Awaited<ReturnType<typeof buildMissionSupervisionContext>>;
  governanceEvidenceLines: string[];
  oversightIssue: MissionSupervisionIssue;
  now: Date;
  staleAfterMs: number;
  findings: string[];
  recommendations: MissionOwnerSupervisionRecommendation[];
  addRecommendation: (recommendation: MissionOwnerSupervisionRecommendation) => void;
  /** findings·recommendations·appliedActions·recoveryOutcomes 는 호출부와 같은 배열 객체를 그대로 받아 쌓는다. */
  appliedActions: MissionOwnerSupervisionAppliedAction[];
  recoveryOutcomes: OwnerToolRecoveryOutcome[];
  canonicalTerminalOwnerAction: MissionSupervisionIssue | null;
  terminalReportGroups: PreLoopPhaseResult["terminalReportGroups"];
  tryEmitTerminalReport: PreLoopPhaseResult["tryEmitTerminalReport"];
  qaCapOwnerActionByWorkflowRunId: PreLoopPhaseResult["qaCapOwnerActionByWorkflowRunId"];
  qaCapPendingWorkflowRunIds: PreLoopPhaseResult["qaCapPendingWorkflowRunIds"];
  planSubmissionMissingCandidate: PreLoopPhaseResult["planSubmissionMissingCandidate"];
}

export async function runMissionPostLoopPhases({
  db,
  deps,
  ownerActions,
  input,
  context,
  governanceEvidenceLines,
  oversightIssue,
  now,
  staleAfterMs,
  findings,
  recommendations,
  addRecommendation,
  appliedActions,
  recoveryOutcomes,
  canonicalTerminalOwnerAction,
  terminalReportGroups,
  tryEmitTerminalReport,
  qaCapOwnerActionByWorkflowRunId,
  qaCapPendingWorkflowRunIds,
  planSubmissionMissingCandidate,
}: MissionPostLoopPhaseInputs): Promise<MissionOwnerSupervisionResult> {
  const { mission, missionIssues, missionIssueById, commentsByIssueId, stepRows, executionSnapshot, activePlan } = context;

    // A workflow run can itself be the terminal failure even when no recovery owner-action
    // heartbeat has failed yet. Evaluate that authoritative run snapshot directly; only after
    // continuation is proven absent do we materialize the owner-action used by the Human
    // Operator channel. Suppress on any active/uncertain continuation signal.
    const workflowRunIdsAlreadyReportedByRecovery = new Set(
      [...terminalReportGroups.values()]
        .map((group) => group.workflowRunId)
        .filter((runId): runId is string => Boolean(runId)),
    );
    const hasMissionLevelRecoveryReport = terminalReportGroups.has("mission");
    const failedWorkflowRowsByRunId = new Map<string, MissionSupervisionWorkflowStepRow[]>();
    for (const row of stepRows) {
      if (row.run.status !== "failed") continue;
      const rows = failedWorkflowRowsByRunId.get(row.run.id) ?? [];
      rows.push(row);
      failedWorkflowRowsByRunId.set(row.run.id, rows);
    }
    for (const [workflowRunId, workflowStepRows] of [...failedWorkflowRowsByRunId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (hasMissionLevelRecoveryReport || workflowRunIdsAlreadyReportedByRecovery.has(workflowRunId)) continue;
      if (qaCapPendingWorkflowRunIds.has(workflowRunId) && !qaCapOwnerActionByWorkflowRunId.has(workflowRunId)) continue;
      if (workflowStepRows.some(issueLessToolRecoveryOwnsFailure)
        && await hasOpenOrMissingIssueLessToolRecoveryCard(db, {
          companyId: mission.companyId,
          missionId: mission.id,
          workflowStepRows,
        })) {
        findings.push(`terminal_mission_human_operator_request_suppressed: workflow run=${workflowRunId}; issue-less tool recovery authority remains with manual recovery owner action`);
        continue;
      }
      if (workflowStepRows.some(issueLessToolRecoveryOwnsFailure)) {
        findings.push(`terminal_mission_tool_recovery_authority_consumed: workflow run=${workflowRunId}; every linked issue-less tool recovery card is terminal — continuing to terminal human operator reporting`);
      }

      const sourceIssue = selectTerminalWorkflowAuthoritySource({
        missionIssues,
        missionIssueById,
        workflowStepRows,
      });
      if (!sourceIssue) {
        findings.push(`terminal_mission_human_operator_request_suppressed: workflow run=${workflowRunId}; continuation authority uncertain (no company+mission scoped source/main-executor issue)`);
        continue;
      }
      await tryEmitTerminalReport({
        ownerAction: qaCapOwnerActionByWorkflowRunId.get(workflowRunId) ?? canonicalTerminalOwnerAction,
        ensureOwnerAction: () => ownerActions.ensureMainExecutorUnblockIssue(mission, sourceIssue, {
          notifyOwner: false,
          governanceEvidence: [
            `Workflow run ${workflowRunId} failed and no executable continuation remains.`,
            "Human Operator decision is required before any retry, replan, reassignment, or cancellation.",
          ],
        }),
        group: {
          workflowRunId,
          failedRuns: [{ id: workflowRunId, status: "failed", errorCode: "workflow_run_failed" }],
          sourceIssue,
          workflowStepRows,
        },
        label: `workflow run=${workflowRunId}`,
      });
    }

    const stepRowsByRunId = new Map<string, typeof stepRows>();
    for (const row of stepRows) {
      const list = stepRowsByRunId.get(row.run.id) ?? [];
      list.push(row);
      stepRowsByRunId.set(row.run.id, list);
    }
    for (const [runId, rowsForRun] of stepRowsByRunId) {
      const stepRunByStepId = new Map(rowsForRun.map((row) => [row.stepRun.stepId, row.stepRun]));
      const steps = (rowsForRun[0]?.definition.stepsJson as WorkflowStep[] | null) ?? [];
      for (const step of steps) {
        const stepRun = stepRunByStepId.get(step.id);
        if (stepRun?.issueId && stepRun.status !== "completed") {
          const stepIssue = missionIssueById.get(stepRun.issueId);
          if (stepIssue?.status === "done") {
            findings.push(`dispatch_missing_step: run=${runId} step=${step.id} linked issue done but workflow run needs safe sync`);
            addRecommendation({
              type: "dispatch_missing_step",
              missionId: mission.id,
              workflowRunId: runId,
              stepId: step.id,
              issueId: stepRun.issueId,
              reason: `Workflow step ${step.id} has a done issue; safely sync workflow state and dispatch newly-ready internal steps`,
              safeToAutoApply: true,
            });
          }
        }
        if (!stepRun || stepRun.status !== "pending" || stepRun.issueId) continue;
        const dependenciesComplete = step.dependencies.every((dependencyId) => stepRunByStepId.get(dependencyId)?.status === "completed");
        if (!dependenciesComplete) continue;
        findings.push(`dispatch_missing_step: run=${runId} step=${step.id} ready but no workflow execution issue exists`);
        addRecommendation({
          type: "dispatch_missing_step",
          missionId: mission.id,
          workflowRunId: runId,
          stepId: step.id,
          reason: `Workflow step ${step.id} is runnable but has no execution issue`,
          safeToAutoApply: true,
        });
      }
    }

    const oversightBodies = (commentsByIssueId.get(oversightIssue.id) ?? []).join("\n");
    const failedStepRows = stepRows.filter((row) => row.stepRun.status === "failed");
    for (const row of failedStepRows) {
      if (issueLessToolRecoveryOwnsFailure(row)) {
        const workflowName = row.definition.name || row.run.workflowId;
        const workflowSteps = (row.definition.stepsJson as WorkflowStep[] | null) ?? [];
        const workflowStep = workflowSteps.find((step) => step.id === row.stepRun.stepId) ?? null;
        const recovery = await ownerActions.ensureToolStepFailureRecoveryIssue({
          mission,
          oversightIssue,
          run: row.run,
          stepRun: row.stepRun,
          step: workflowStep,
          workflowName,
        });
        const toolNamesLabel = recovery.toolNames.length > 0 ? recovery.toolNames.join(",") : "unknown";
        findings.push(`tool_step_failed_requires_recovery: run=${row.run.id} step=${row.stepRun.stepId} tool=${toolNamesLabel} class=${recovery.classification.className}${recovery.created ? " recovery_issue_created" : " recovery_issue_exists"}`);
        addRecommendation({
          type: "request_replan",
          missionId: mission.id,
          workflowRunId: row.run.id,
          stepId: row.stepRun.stepId,
          issueId: recovery.issue.id,
          sourceRef: {
            type: "native_workflow_run",
            id: row.run.id,
            workflowRunId: row.run.id,
            stepId: row.stepRun.stepId,
            issueId: null,
            pluginId: null,
            externalId: null,
          },
          reason: `Tool step ${row.stepRun.stepId} failed as ${recovery.classification.className}; main executor must diagnose tool logs/input/external state before retry`,
          safeToAutoApply: false,
        });
        continue;
      }
      const workflowSteps = (row.definition.stepsJson as WorkflowStep[] | null) ?? [];
      const workflowStep = workflowSteps.find((step) => step.id === row.stepRun.stepId) ?? null;
      if (isIssueLessToolWorkflowStep(workflowStep, row.stepRun.issueId)) {
        findings.push(`tool_step_failure_unlaunched_skipped: run=${row.run.id} step=${row.stepRun.stepId} has failed status without dispatch evidence`);
        continue;
      }
      const marker = `workflow-failure:${row.run.id}:${row.stepRun.stepId}`;
      // [structured-only] oversight marker(기계 마커)만 진단 신호. 자연어 keyword 추론은 제거(fail-closed).
      const hasDiagnosis = oversightBodies.includes(marker);
      if (!hasDiagnosis) {
        findings.push(`failed_step_without_diagnosis: run=${row.run.id} step=${row.stepRun.stepId}`);
        addRecommendation({
          type: "retry_failed_step_if_safe",
          missionId: mission.id,
          workflowRunId: row.run.id,
          stepId: row.stepRun.stepId,
          issueId: row.stepRun.issueId ?? undefined,
          reason: `Failed workflow step ${row.stepRun.stepId} needs owner diagnosis before any retry`,
          safeToAutoApply: false,
        });
        addRecommendation({
          type: "retry_unit_if_safe",
          missionId: mission.id,
          workflowRunId: row.run.id,
          stepId: row.stepRun.stepId,
          issueId: row.stepRun.issueId ?? undefined,
          sourceRef: {
            type: "native_workflow_run",
            id: row.run.id,
            workflowRunId: row.run.id,
            stepId: row.stepRun.stepId,
            issueId: row.stepRun.issueId ?? null,
            pluginId: null,
            externalId: null,
          },
          reason: `Failed execution unit ${row.run.id}/${row.stepRun.stepId} needs owner diagnosis before any retry`,
          safeToAutoApply: false,
        });
        addRecommendation({
          type: "request_replan",
          missionId: mission.id,
          workflowRunId: row.run.id,
          stepId: row.stepRun.stepId,
          issueId: row.stepRun.issueId ?? undefined,
          reason: `Failed workflow step ${row.stepRun.stepId} needs recovery/replan path signal`,
          safeToAutoApply: false,
        });
      }
    }
    for (const unit of executionSnapshot.units) {
      if (!(unit.kind === "plugin_workflow_run" || unit.kind === "plugin_workflow_step_run")) continue;
      if (!(unit.status === "failed" || unit.status === "timed_out")) continue;
      const marker = `unit-failure:${unit.sourceRef.type}:${unit.sourceRef.id}`;
      // [structured-only] oversight marker(기계 마커)만 진단 신호. 자연어 keyword 추론은 제거(fail-closed).
      const hasDiagnosis = oversightBodies.includes(marker);
      if (hasDiagnosis) continue;
      findings.push(`failed_unit_without_diagnosis: source=${unit.sourceRef.type} id=${unit.sourceRef.id} status=${unit.status}${unit.stepId ? ` step=${unit.stepId}` : ""}`);
      addRecommendation({
        type: "retry_unit_if_safe",
        missionId: mission.id,
        workflowRunId: unit.workflowRunId ?? undefined,
        stepId: unit.stepId ?? undefined,
        issueId: unit.issueId ?? undefined,
        sourceRef: unit.sourceRef,
        reason: `Failed execution unit ${unit.sourceRef.type}:${unit.sourceRef.id} needs owner diagnosis before retry`,
        safeToAutoApply: false,
      });
      addRecommendation({
        type: "request_replan",
        missionId: mission.id,
        workflowRunId: unit.workflowRunId ?? undefined,
        stepId: unit.stepId ?? undefined,
        issueId: unit.issueId ?? undefined,
        sourceRef: unit.sourceRef,
        reason: `Failed execution unit ${unit.sourceRef.type}:${unit.sourceRef.id} needs recovery/replan path signal`,
        safeToAutoApply: false,
      });
    }

    for (const unit of executionSnapshot.units) {
      if (!(unit.kind === "plugin_workflow_run" || unit.kind === "plugin_workflow_step_run" || unit.kind === "native_workflow_run")) continue;
      const isActiveExecutionStatus = unit.status === "pending" || unit.status === "running";
      if (!isActiveExecutionStatus) continue;
      const lastObservedAt = unit.updatedAt ?? unit.startedAt ?? unit.createdAt;
      if (lastObservedAt && now.getTime() - lastObservedAt.getTime() >= staleAfterMs) {
        findings.push(`stale_execution_unit: source=${unit.sourceRef.type} id=${unit.sourceRef.id} status=${unit.status} stale_since=${lastObservedAt.toISOString()}${unit.stepId ? ` step=${unit.stepId}` : ""}`);
        addRecommendation({
          type: "request_replan",
          missionId: mission.id,
          workflowRunId: unit.workflowRunId ?? undefined,
          stepId: unit.stepId ?? undefined,
          issueId: unit.issueId ?? undefined,
          sourceRef: unit.sourceRef,
          reason: `Execution unit ${unit.sourceRef.type}:${unit.sourceRef.id} is still ${unit.status} after ${input.staleAfterMinutes ?? 120} minutes; owner should recover/replan/escalate`,
          safeToAutoApply: false,
        });
        if (unit.issueId) {
          const linkedIssue = missionIssueById.get(unit.issueId);
          if (linkedIssue && linkedIssue.originKind !== "mission_main_executor_unblock" && !linkedIssue.hiddenAt && !isTerminalIssueStatus(linkedIssue.status)) {
            await ownerActions.ensureMainExecutorUnblockIssue(mission, linkedIssue, { renewAfterNoActionWaiting: true });
          }
        }
      }
      if (unit.issueId && unit.status === "running") {
        const linkedIssue = missionIssueById.get(unit.issueId);
        if (linkedIssue?.status === "blocked") {
          findings.push(`execution_issue_status_mismatch: source=${unit.sourceRef.type} id=${unit.sourceRef.id} status=running linked_issue=${linkedIssue.identifier ?? linkedIssue.id} status=blocked${unit.stepId ? ` step=${unit.stepId}` : ""}`);
          addRecommendation({
            type: "request_replan",
            missionId: mission.id,
            workflowRunId: unit.workflowRunId ?? undefined,
            stepId: unit.stepId ?? undefined,
            issueId: unit.issueId,
            sourceRef: unit.sourceRef,
            reason: `Linked issue ${linkedIssue.identifier ?? linkedIssue.id} is blocked while execution unit ${unit.sourceRef.type}:${unit.sourceRef.id} remains running`,
            safeToAutoApply: false,
          });
        }
      }
    }

    if (activePlan) {
      for (const requiredInput of asRecordArray(activePlan.requiredInputs)) {
        const key = trimmedString(requiredInput.key) ?? trimmedString(requiredInput.title) ?? "required-input";
        if (normalizedPlanStatus(requiredInput.status) === "received") continue;
        findings.push(`missing_required_input: ${key} not received for active plan revision=${activePlan.revision}`);
      }

      const refs = asRecord(activePlan.refs);
      const planUnits = asRecordArray(refs.executionUnits);
      const planUnitKeys = new Set(planUnits.map((unit) => executionUnitKeyFromSourceRef(unit.sourceRef)).filter((key): key is string => Boolean(key)));
      const paqoWorkflow = asRecord(refs.paqoWorkflow);
      const paqoWorkflowRunId = trimmedString(paqoWorkflow.workflowRunId);
      if (paqoWorkflowRunId) {
        planUnitKeys.add(`native_workflow_run:${paqoWorkflowRunId}`);
      }
      for (const unit of executionSnapshot.units) {
        if (!planUnitKeys.has(executionUnitKey(unit))) {
          findings.push(`plan_outdated: active execution unit missing from plan refs source=${unit.sourceRef.type} id=${unit.sourceRef.id}`);
        }
      }

      const approvalRuleRefs = asRecordArray(refs.ruleRefs).filter((ruleRef) => isApprovalRuleMode(ruleRef.mode));
      for (const ruleRef of approvalRuleRefs) {
        const ruleLabel = trimmedString(ruleRef.key) ?? trimmedString(ruleRef.id) ?? trimmedString(ruleRef.name) ?? "rule";
        for (const planUnit of planUnits) {
          if (!unitRequiresGovernedAction(planUnit)) continue;
          const key = executionUnitKeyFromSourceRef(planUnit.sourceRef) ?? "unknown-unit";
          findings.push(`approval_required: ${ruleLabel} requires owner approval for governed action unit=${key}`);
          addRecommendation({
            type: "request_approval",
            missionId: mission.id,
            sourceRef: asRecord(planUnit.sourceRef) as unknown as MissionExecutionSourceRef,
            reason: `Rule ${ruleLabel} requires owner approval for governed action unit ${key}`,
            safeToAutoApply: false,
          });
        }
      }

      for (const planUnit of planUnits) {
        const expectedStatus = normalizedPlanStatus(planUnit.status);
        if (!expectedStatus) continue;
        const key = executionUnitKeyFromSourceRef(planUnit.sourceRef);
        if (!key) continue;
        const runtimeUnit = executionSnapshot.units.find((unit) => executionUnitKey(unit) === key);
        if (!runtimeUnit || normalizedPlanStatus(runtimeUnit.status) === expectedStatus) continue;
        findings.push(`rule_mismatch: plan unit=${key} status=${expectedStatus} runtime_status=${runtimeUnit.status}`);
        // [terminal-run closeout bridge] 실행 단위는 종단 상태인데 plan 이 아직 running 이고 mission 이
        //   active 면(위 settlement 가 정리하지 못한 상황), 오너에게 종결 처리를 1회 요청한다(멱등 마커).
        //   2026-08-17 GAZ: run completed 이후 오너가 깨어나지 않아 mission/oversight 가 11시간 방치.
        const runtimeStatus = normalizedPlanStatus(runtimeUnit.status);
        if (
          mission.status === "active"
          && expectedStatus === "running"
          && runtimeStatus !== null
          && TERMINAL_CLOSEOUT_RUN_STATUSES.has(runtimeStatus)
          && deps.onMissionTerminalRunCloseoutWakeRequested
        ) {
          const closeoutKey = `mission-terminal-closeout:${mission.id}:${runtimeUnit.sourceRef.id}:${runtimeStatus}`;
          const claimed = await claimSupervisionMarkerOnce({
            db, companyId: mission.companyId, missionId: mission.id,
            issueId: oversightIssue?.id ?? null,
            idempotencyKey: closeoutKey, eventType: "mission_terminal_closeout_wake",
            payload: { planUnitKey: key, runStatus: runtimeStatus, sourceRefId: runtimeUnit.sourceRef.id },
          });
          if (claimed) {
            try {
              await deps.onMissionTerminalRunCloseoutWakeRequested({
                mission,
                run: { id: runtimeUnit.sourceRef.id, status: runtimeStatus },
                planUnitKey: key,
                oversightIssueId: oversightIssue?.id ?? null,
                idempotencyKey: closeoutKey,
              });
              findings.push(`workflow_run_terminal_closeout_wake_requested: run=${runtimeUnit.sourceRef.id} status=${runtimeStatus} — mission still active after terminal run; owner asked to reconcile and close out`);
            } catch (err) {
              logger.warn({ err, missionId: mission.id }, "mission terminal closeout wake callback failed");
            }
          }
        }
      }
    }

    const ownerActionExplanations = await buildOwnerActionExplanations({
      ownerActionIssues: missionIssues
        .filter((issue) => issue.originKind === "mission_main_executor_unblock" && !issue.hiddenAt)
        .map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          originKind: issue.originKind,
          originId: issue.originId,
        })),
      commentsByIssueId,
      resolveSourceIssue: async (sourceIssueId) => db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, mission.companyId), eq(issues.missionId, mission.id), isNull(issues.hiddenAt)))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      resolveSourceComments: async (sourceIssueId) => db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(and(eq(issueComments.companyId, mission.companyId), eq(issueComments.issueId, sourceIssueId)))
        .then((rows) => rows.map((comment) => comment.body)),
    });

    const uniqueFindings = Array.from(new Set(findings));
    const materializePlanRecommendation = recommendations.find((recommendation) => (
      recommendation.type === "materialize_plan_decision" && recommendation.safeToAutoApply
    ));
    if (input.applySafeActions && materializePlanRecommendation) {
      const result = await recordLatestAuthorizedMissionOwnerPlanDecision({
        db,
        companyId: mission.companyId,
        missionId: mission.id,
        requestedBy: { actorType: "system", actorId: "mission-owner-supervision" },
        enqueuePlanQaWakeup: deps.onPlanQaIssueCreated,
        enqueuePlanningIssueWakeup: deps.onPlanRevisionRequested
          ? (input) => deps.onPlanRevisionRequested?.({
            mission,
            planIssueId: input.issueId,
            planQaIssueId: input.planQaIssueId,
            targetAgentId: input.agentId,
            decisionHash: input.decisionHash,
            idempotencyKey: `mission-owner-plan-rework:${input.issueId}:${input.decisionHash}`,
          })
          : undefined,
      });
      const refs = asRecord(result.status === "recorded" ? result.missionPlanArtifact.refs : undefined);
      const paqoWorkflow = asRecord(refs.paqoWorkflow);
      appliedActions.push(buildMaterializePlanDecisionAction(mission.id, result, trimmedString(paqoWorkflow.workflowRunId)));
    }

    if (
      input.applySafeActions &&
      planSubmissionMissingCandidate &&
      (planSubmissionMissingCandidate.kind !== "rejected" || planSubmissionMissingCandidate.retryAllowed)
    ) {
      const { planIssue, markerText, idempotencyKey } = planSubmissionMissingCandidate;
      const diagnosticsSummary = planSubmissionMissingCandidate.kind === "rejected"
        ? formatMissionPlanDecisionSubmissionDiagnostics(planSubmissionMissingCandidate.diagnostics)
        : "";
      const planTemplateCatalog = planSubmissionMissingCandidate.kind === "rejected"
        ? await missionPlanTemplateService(db).list(mission.companyId, { includeDisabled: false })
        : [];
      const refreshedDescription = planSubmissionMissingCandidate.kind === "rejected"
        ? await buildRevisionMissionPlanningDescription(db, {
            companyId: mission.companyId,
            missionId: mission.id,
            title: mission.title,
            description: mission.description,
            runnableCandidates: planSubmissionMissingCandidate.candidateRoster,
            runnableRosterLines: planSubmissionMissingCandidate.candidateRosterLines,
            planTemplateCatalog,
            revisionContext: {
              previousDecision: planSubmissionMissingCandidate.previousDecision instanceof Object
                && !Array.isArray(planSubmissionMissingCandidate.previousDecision)
                ? (planSubmissionMissingCandidate.previousDecision as Record<string, unknown>)
                : { value: planSubmissionMissingCandidate.previousDecision },
              diagnostics: Array.isArray(planSubmissionMissingCandidate.diagnostics)
                ? planSubmissionMissingCandidate.diagnostics
                : [],
            },
          })
        : undefined;
      await db
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
          ...(refreshedDescription ? { description: refreshedDescription } : {}),
        })
        .where(eq(issues.id, planIssue.id));

      const wakeComment = await issueService(db).addComment(
        planIssue.id,
        planSubmissionMissingCandidate.kind === "rejected"
          ? [
            "### Mission owner plan submission rejected\nThe plan was rejected for the reason below; execution cannot proceed from this submission. Next action: correct the plan and submit it through the dedicated structured plan-decision API.",
            `<!-- ${markerText} -->`,
            `- Mission: ${mission.title}`,
            `- Planning issue: ${planIssue.identifier ?? planIssue.id}`,
            `- Decision hash: ${planSubmissionMissingCandidate.decisionHash}`,
            `- Rejection reason: ${planSubmissionMissingCandidate.rejectionReason ?? "unknown"}`,
            ...(diagnosticsSummary ? [`- Diagnostics: ${diagnosticsSummary}`] : []),
            "",
            "Required next action:",
            "- Reopen this PLAN work and post a revised structured `### Mission owner plan decision` JSON block on this issue.",
            "- Do not perform ACTION or QA work from this PLAN issue; only submit the corrected executable plan decision.",
            "- After the revised decision is posted, the normal Plan QA gate will continue the mission.",
          ].join("\n")
          : [
            "### Mission owner plan submission required\nThe run succeeded, but no executable plan submission is recorded. Next action: submit the plan through the dedicated structured plan-decision API; run success does not start Plan QA.",
            `<!-- ${markerText} -->`,
            `- Mission: ${mission.title}`,
            `- Planning issue: ${planIssue.identifier ?? planIssue.id}`,
            `- Observed run: ${planSubmissionMissingCandidate.succeededRun.id} finished with status succeeded.`,
            "- Current blocker: no structured `### Mission owner plan decision` submission is recorded, so Plan QA and workflow materialization cannot start.",
            "",
            "Required next action:",
            "- Reopen this PLAN work and post exactly one structured `### Mission owner plan decision` JSON block on this issue.",
            "- Do not perform ACTION or QA work from this PLAN issue; only submit the executable plan decision.",
            "- After the structured decision is posted, the normal Plan QA gate will continue the mission.",
          ].join("\n"),
        { agentId: mission.ownerAgentId },
      );

      let resultStatus = "commented_no_wakeup_callback";
      if (deps.onPlanSubmissionMissing) {
        try {
          await deps.onPlanSubmissionMissing({
            mission,
            planIssueId: planIssue.id,
            targetAgentId: mission.ownerAgentId,
            idempotencyKey,
            wakeCommentId: wakeComment.id,
          });
          resultStatus = "wakeup_requested";
        } catch (err) {
          logger.warn({ err, missionId: mission.id, planIssueId: planIssue.id }, "failed to wake mission owner for plan submission recovery");
          resultStatus = "wakeup_failed";
        }
      }
      await recordRecoveryAction({
        db,
        companyId: mission.companyId,
        missionId: mission.id,
        issueId: planIssue.id,
        sourceIssueId: planIssue.id,
        idempotencyKey,
        eventType: planSubmissionMissingCandidate.kind === "rejected"
          ? "mission_owner_plan_submission_rejected"
          : "mission_owner_plan_submission_missing",
        decision: "replan_mission",
        resultStatus,
      });

      if (planSubmissionMissingCandidate.kind === "rejected") {
        appliedActions.push({
          type: "plan_submission_rejected",
          missionId: mission.id,
          planIssueId: planIssue.id,
          decisionHash: planSubmissionMissingCandidate.decisionHash,
          resultStatus,
          idempotencyKey,
        });
      } else {
        appliedActions.push({
          type: "plan_submission_missing",
          missionId: mission.id,
          planIssueId: planIssue.id,
          succeededRunId: planSubmissionMissingCandidate.succeededRun.id,
          resultStatus,
          idempotencyKey,
        });
      }
    }

    const safeDispatchRecommendations = recommendations.filter((recommendation) => recommendation.type === "dispatch_missing_step" && recommendation.safeToAutoApply && recommendation.workflowRunId);
    if (input.applySafeActions && safeDispatchRecommendations.length > 0) {
      const stepIdsByRunId = new Map<string, string[]>();
      for (const recommendation of safeDispatchRecommendations) {
        const runId = recommendation.workflowRunId!;
        const list = stepIdsByRunId.get(runId) ?? [];
        if (recommendation.stepId) list.push(recommendation.stepId);
        stepIdsByRunId.set(runId, list);
      }
      for (const [runId, stepIds] of stepIdsByRunId) {
        const result = await syncWorkflowRunState(db, runId, "mission_supervision");
        appliedActions.push({
          type: "dispatch_missing_step",
          missionId: mission.id,
          workflowRunId: runId,
          stepIds,
          resultStatus: result.status,
        });
      }
    }

    if (uniqueFindings.length === 0) {
      return { missionId: mission.id, oversightIssueId: oversightIssue.id, findings: uniqueFindings, recommendations, appliedActions, recoveryOutcomes, ownerActionExplanations, commented: false };
    }

    const findingsSignature = createHash("sha256")
      .update(uniqueFindings.slice().sort().join("\n"))
      .digest("hex")
      .slice(0, 16);
    const markerText = `mission-owner-supervision:${mission.id}:${now.toISOString().slice(0, 13)}:${findingsSignature}`;
    if (oversightBodies.includes(markerText)) {
      return { missionId: mission.id, oversightIssueId: oversightIssue.id, findings: uniqueFindings, recommendations, appliedActions, recoveryOutcomes, ownerActionExplanations, commented: false };
    }

    await issueService(db).addComment(
      oversightIssue.id,
      [
        "### Mission owner supervision diagnosis\nThis is a progress observation, not proof that a recommended action ran. Next action: review the findings, then check structured decisions and run records before requesting recovery.",
        `<!-- ${markerText} -->`,
        `- Mission: ${mission.title}`,
        `- Observed at: ${now.toISOString()}`,
        "- Mode: decision alignment observation; this is not a hard block or RPA gate.",
        "",
        "Findings:",
        ...uniqueFindings.map((finding) => `- ${finding}`),
        "",
        "Recommended owner actions:",
        ...(recommendations.length > 0
          ? recommendations.map((recommendation) => `- ${recommendation.type}${recommendation.safeToAutoApply ? " (safe internal auto-apply candidate)" : " (owner decision required)"}: ${recommendation.reason}`)
          : ["- None"]),
        "",
        ...(governanceEvidenceLines.length > 0
          ? [
            ...governanceEvidenceLines,
            "",
          ]
          : []),
        "Applied safe actions:",
        ...(appliedActions.length > 0
          ? appliedActions.map(formatAppliedAction)
          : ["- None"]),
        "",
        "Main executor action:",
        "- Decide whether to dispatch/retry, recover, replan, escalate, or report impossible completion with evidence.",
        "- If the path changes, use this as a future replan path signal; no replan artifact is generated by this observation yet.",
      ].join("\n"),
      { agentId: mission.ownerAgentId },
    );

    return { missionId: mission.id, oversightIssueId: oversightIssue.id, findings: uniqueFindings, recommendations, appliedActions, recoveryOutcomes, ownerActionExplanations, commented: true };
}
