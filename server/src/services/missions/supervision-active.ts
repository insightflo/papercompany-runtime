import { heartbeatRuns, issues, missionPlanDecisionSubmissions, missions, workflowRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { MissionServiceDeps } from "../missions.js";
import type { createOwnerActions } from "./owner-actions.js";
import { isTerminalFailureStatus, listMissionExecutionSourceSnapshots, type MissionExecutionStatus } from "./mission-execution-sources.js";
import { isRejectedMissionPlanDecisionSubmissionStatus } from "./mission-plan-decision-ledger.js";
import { asRecord, trimmedString } from "./supervision-helpers.js";
import { prepareSupervisionMissions } from "./supervision-lifecycle.js";
import { loadActiveSupervisionData } from "./supervision-active-data.js";
import { isPlanSubmissionRecoveryIssueStatus } from "./supervision-support.js";
import type { ActiveMissionOwnerSupervisionResult, MissionOwnerSupervisionResult } from "./supervision-types.js";

export function createRunActiveMissionOwnerSupervision({ db, deps, ownerActions, runMainExecutorSupervision }: {
  db: Db;
  deps: MissionServiceDeps;
  ownerActions: ReturnType<typeof createOwnerActions>;
  runMainExecutorSupervision: (input: {
    missionId: string;
    staleAfterMinutes?: number;
    now?: Date;
    applySafeActions?: boolean;
    applyOwnerDecisionActions?: boolean;
    dispatchOwnerDecisionWakeups?: boolean;
    dispatchStalledOwnerActionWakeups?: boolean;
    dispatchStaleSourceIssueWakeups?: boolean;
  }, promotedFromPlanning?: boolean) => Promise<MissionOwnerSupervisionResult>;
}) {
  const ACTIVE_SUPERVISION_EXECUTION_STATUSES = new Set<MissionExecutionStatus>(["pending", "running", "failed", "cancelled", "timed_out"]);

  function isActiveSupervisionExecutionStatus(status: MissionExecutionStatus): boolean {
    return status === "pending" || status === "running" || isTerminalFailureStatus(status);
  }

  async function runActiveMissionOwnerSupervision(input: {
    companyId?: string;
    missionIds?: string[];
    staleAfterMinutes?: number;
    now?: Date;
    applySafeActions?: boolean;
    applyOwnerDecisionActions?: boolean;
    dispatchOwnerDecisionWakeups?: boolean;
    dispatchStaleSourceIssueWakeups?: boolean;
  } = {}): Promise<ActiveMissionOwnerSupervisionResult> {
    const { missionRows, terminalResults, promotedPlanningMissionIds } = await prepareSupervisionMissions(db, ownerActions, input);

    const missionIds: string[] = [];
    const missionRowsByCompanyId = new Map<string, typeof missionRows>();
    for (const row of missionRows) {
      const rows = missionRowsByCompanyId.get(row.companyId) ?? [];
      rows.push(row);
      missionRowsByCompanyId.set(row.companyId, rows);
    }

    const now = input.now ?? new Date();
    const staleCutoff = new Date(now.getTime() - Math.max(1, input.staleAfterMinutes ?? 120) * 60 * 1000);

    for (const [companyId, rows] of missionRowsByCompanyId) {
      const rowMissionIds = rows.map((row) => row.id);
      const snapshots = await listMissionExecutionSourceSnapshots(db, {
        companyId,
        missionIds: rowMissionIds,
      });
      const {
        staleFailedHeartbeatMissionIds,
        staleQueueIssueRows,
        staleOwnerActionIssueRows,
        activeHeartbeatMissionIds,
        activePlanByMissionId,
        planQaVerdictKeys,
        boardWaiting,
      } = await loadActiveSupervisionData(db, companyId, rowMissionIds, staleCutoff);
      const planMaterializationGapMissionIds = new Set(
        rows.map((row) => row.id)
          .filter((missionId) => {
            if (activeHeartbeatMissionIds.has(missionId) || boardWaiting.has(missionId)) return false;
            const planRow = activePlanByMissionId.get(missionId);
            if (!planRow) return false;
            const refs = asRecord(planRow.refs);
            const ownerPlanDecisionRef = asRecord(refs.ownerPlanDecision);
            const paqoWorkflowRef = asRecord(refs.paqoWorkflow);
            const planQaRef = asRecord(refs.planQa);
            const decisionHash = trimmedString(ownerPlanDecisionRef.decisionHash);
            const planQaIssueId = trimmedString(planQaRef.issueId);
            const planQaDecisionHash = trimmedString(planQaRef.decisionHash) || decisionHash;
            const hasPlanQaVerdict = Boolean(planQaIssueId && planQaDecisionHash && planQaVerdictKeys.has(`${planQaIssueId}:${planQaDecisionHash}`));
            return Boolean(
              decisionHash
              && !trimmedString(paqoWorkflowRef.workflowRunId)
              && (trimmedString(planQaRef.status) !== "pending" || hasPlanQaVerdict),
            );
          }),
      );
      const staleInProgressFailedHeartbeatMissionIds = new Set(rowMissionIds.length > 0
          ? (await db
            .select({ missionId: issues.missionId })
            .from(issues)
            .innerJoin(heartbeatRuns, eq(heartbeatRuns.issueId, issues.id))
            .where(and(
              eq(issues.companyId, companyId),
              inArray(issues.missionId, rowMissionIds),
              isNull(issues.hiddenAt),
              eq(issues.status, "in_progress"),
              lte(issues.createdAt, staleCutoff),
              inArray(heartbeatRuns.status, ["failed", "timed_out"]),
              sql`${issues.originKind} not in ('mission_main_executor_oversight', 'mission_main_executor_unblock')`,
            )))
            .map((row) => row.missionId)
            .filter((missionId): missionId is string => Boolean(missionId))
            .filter((missionId) => !activeHeartbeatMissionIds.has(missionId))
          : [],
      );
      const staleInProgressMissionIds = new Set(
        rowMissionIds.length > 0
          ? (await db
            .select({ missionId: issues.missionId })
            .from(issues)
            .where(and(
              eq(issues.companyId, companyId),
              inArray(issues.missionId, rowMissionIds),
              isNull(issues.hiddenAt),
              eq(issues.status, "in_progress"),
              lte(issues.createdAt, staleCutoff),
              sql`${issues.originKind} not in ('mission_main_executor_oversight', 'mission_main_executor_unblock')`,
            )))
            .map((row) => row.missionId)
            .filter((missionId): missionId is string => Boolean(missionId))
          : [],
      );
      const staleQueueNoActiveExecutionMissionIds = new Set(
        staleQueueIssueRows
          .map((row) => row.missionId)
          .filter((missionId): missionId is string => Boolean(missionId))
          .filter((missionId) => !activeHeartbeatMissionIds.has(missionId)),
      );
      const stalledOwnerActionMissionIds = new Set(
        staleOwnerActionIssueRows
          .map((row) => row.missionId)
          .filter((missionId): missionId is string => Boolean(missionId))
          .filter((missionId) => !activeHeartbeatMissionIds.has(missionId)),
      );
      // [terminal-mission Human Operator report 회복 · 교정] stale owner-action 회복이 todo/backlog 만
      //   보아 blocked 된 mission_main_executor_unblock 을 놓치는 root-cause 보정. recovery run 이
      //   failed/timed_out 된 blocked unblock 을 가진 mission 을 supervision 후보로 올린다. issue age 가
      //   아닌 settled run state(terminal failed/timed_out run) 가 트리거이므로 createdAt delay 를 두지
      //   않는다(교정: 새로 만들어진 owner-action 도 final recovery run 이 이미 실패했으면 다음 sweep 에
      //   바로 eligible). 실제 terminal 판정은 per-mission supervision 의 classifyTerminalMissionContinuation
      //   가 담당(active heartbeat / live wakeup / open recovery / runnable step 이 남으면 suppress).
      const blockedOwnerActionFailedRunMissionIds = new Set(
        rowMissionIds.length > 0
          ? (await db
            .select({ missionId: issues.missionId })
            .from(issues)
            .innerJoin(heartbeatRuns, eq(heartbeatRuns.issueId, issues.id))
            .where(and(
              eq(issues.companyId, companyId),
              inArray(issues.missionId, rowMissionIds),
              isNull(issues.hiddenAt),
              eq(issues.status, "blocked"),
              eq(issues.originKind, "mission_main_executor_unblock"),
              inArray(heartbeatRuns.status, ["failed", "timed_out"]),
            )))
            .map((row) => row.missionId)
            .filter((missionId): missionId is string => Boolean(missionId))
            .filter((missionId) => !activeHeartbeatMissionIds.has(missionId))
          : [],
      );
      // [settlement-pending mission] 실행 단위가 전부 terminal-good(활성 없음 + 최소 1개 completed)하고
      //   열린 소유 work 가 없으면(oversight 제외) mission 을 정리(settle)해야 한다. monitor 선택은
      //   svc.getById 를 거치지 않아 lazy reconcile 이 안 돌기 때문에 별도 후보로 올린다
      //   (2026-08-15 GAZ ef12d027: run completed 후 mission 이 active 로 orphan — 수동 supervision/run 으로만 정리됨).
      const openNonOversightWorkMissionIds = new Set(
        rowMissionIds.length > 0
          ? (await db
            .select({ missionId: issues.missionId })
            .from(issues)
            .where(and(
              eq(issues.companyId, companyId),
              inArray(issues.missionId, rowMissionIds),
              isNull(issues.hiddenAt),
              sql`${issues.status} not in ('done', 'cancelled')`,
              sql`${issues.originKind} <> 'mission_main_executor_oversight'`,
            )))
            .map((row) => row.missionId)
            .filter((missionId): missionId is string => Boolean(missionId))
          : [],
      );

      for (const row of rows) {
        const snapshot = snapshots[row.id];
        const hasSupervisionUnit = snapshot?.units.some((unit) => ACTIVE_SUPERVISION_EXECUTION_STATUSES.has(unit.status) && isActiveSupervisionExecutionStatus(unit.status));
        const units = snapshot?.units ?? [];
        const settlementPending = !hasSupervisionUnit
          && units.length > 0
          && units.some((unit) => unit.status === "completed")
          && units.every((unit) => !ACTIVE_SUPERVISION_EXECUTION_STATUSES.has(unit.status))
          && !openNonOversightWorkMissionIds.has(row.id)
          && !activeHeartbeatMissionIds.has(row.id);
        if (hasSupervisionUnit || settlementPending || staleFailedHeartbeatMissionIds.has(row.id) || staleQueueNoActiveExecutionMissionIds.has(row.id) || stalledOwnerActionMissionIds.has(row.id) || blockedOwnerActionFailedRunMissionIds.has(row.id) || staleInProgressFailedHeartbeatMissionIds.has(row.id) || staleInProgressMissionIds.has(row.id) || planMaterializationGapMissionIds.has(row.id)) missionIds.push(row.id);
      }

      const planningRows = rows.filter((row) => row.id && !missionIds.includes(row.id));
      if (planningRows.length > 0 && deps.onPlanSubmissionMissing) {
        const planningMissionIds = planningRows.map((row) => row.id);
        const planIssues = planningMissionIds.length > 0
          ? await db
            .select({ id: issues.id, missionId: issues.missionId, status: issues.status, originKind: issues.originKind })
            .from(issues)
            .where(and(
              eq(issues.companyId, companyId),
              inArray(issues.missionId, planningMissionIds),
              eq(issues.originKind, "mission_main_executor_plan"),
              isNull(issues.hiddenAt),
            ))
          : [];
        for (const planIssue of planIssues) {
          if (!isPlanSubmissionRecoveryIssueStatus(planIssue.status)) continue;
          const missionId = planIssue.missionId;
          if (!missionId) continue;
          const [existingSubmission] = await db
            .select({ id: missionPlanDecisionSubmissions.id, status: missionPlanDecisionSubmissions.status })
            .from(missionPlanDecisionSubmissions)
            .where(and(
              eq(missionPlanDecisionSubmissions.companyId, companyId),
              eq(missionPlanDecisionSubmissions.missionId, missionId),
            ))
            .orderBy(desc(missionPlanDecisionSubmissions.createdAt))
            .limit(1);
          const hasRejectedSubmission = existingSubmission
            ? isRejectedMissionPlanDecisionSubmissionStatus(existingSubmission.status)
            : false;
          if (existingSubmission && !hasRejectedSubmission) continue;
          if (!hasRejectedSubmission) {
            const succeededRuns = await db
              .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
              .from(heartbeatRuns)
              .where(and(eq(heartbeatRuns.issueId, planIssue.id), eq(heartbeatRuns.status, "succeeded")))
              .orderBy(asc(heartbeatRuns.createdAt))
              .limit(1);
            if (succeededRuns.length === 0) continue;
            const existingPlanQa = await db
              .select({ id: issues.id })
              .from(issues)
              .where(and(
                eq(issues.companyId, companyId),
                eq(issues.missionId, missionId),
                eq(issues.originKind, "mission_plan_qa"),
                isNull(issues.hiddenAt),
              ))
              .limit(1);
            if (existingPlanQa.length > 0) continue;
            const existingWorkflowRuns = await db
              .select({ id: workflowRuns.id })
              .from(workflowRuns)
              .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, missionId)))
              .limit(1);
            if (existingWorkflowRuns.length > 0) continue;
          }
          if (activeHeartbeatMissionIds.has(missionId)) continue;
          if (!missionIds.includes(missionId)) missionIds.push(missionId);
        }
      }
    }

    const results: MissionOwnerSupervisionResult[] = [...terminalResults];
    for (const missionId of missionIds) {
      results.push(await runMainExecutorSupervision({
        missionId,
        staleAfterMinutes: input.staleAfterMinutes,
        now: input.now,
        applySafeActions: input.applySafeActions,
        applyOwnerDecisionActions: input.applyOwnerDecisionActions,
        dispatchOwnerDecisionWakeups: input.dispatchOwnerDecisionWakeups,
        dispatchStalledOwnerActionWakeups: true,
        dispatchStaleSourceIssueWakeups: input.dispatchStaleSourceIssueWakeups,
      }, promotedPlanningMissionIds.has(missionId)));
    }

    return { companyId: input.companyId, missionIds: [...terminalResults.map((result) => result.missionId), ...missionIds], missions: results };
  }

  return runActiveMissionOwnerSupervision;
}
