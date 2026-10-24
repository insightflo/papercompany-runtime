// Canonical workflow reconciliation; owner callbacks retain their existing settlement scope.
import { missions, pluginEntities, workflowRuns, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { logActivity } from "../activity-log.js";
import type { MissionRow, MissionStatus } from "../missions.js";
import { hasActivePlanBlockedRevisionUnits } from "./mission-revision-blocked-work.js";
import type { createMissionWorkSettlement } from "./mission-work-settlement.js";
import { runMissionTerminalCleanup, type MissionTerminalCleanupDb } from "./terminal-cleanup-fence.js";

type ReconciliationDependencies = {
  db: Db;
  findOpenMissionWork: ReturnType<typeof createMissionWorkSettlement>;
  reopenCompletedWorkflowMissionForOpenWork: (mission: MissionRow, openWork: { id: string; status: string }) => Promise<MissionRow>;
  completeOpenMissionOversightIfSettled: (mission: MissionRow, completedAt: Date, executor?: MissionTerminalCleanupDb) => Promise<void>;
};

export function createMissionWorkflowReconciliation({
  db,
  findOpenMissionWork,
  reopenCompletedWorkflowMissionForOpenWork,
  completeOpenMissionOversightIfSettled,
}: ReconciliationDependencies) {
  const activeWorkflowRunStatuses = new Set(["pending", "queued", "running", "in_progress"]);
  const recoverableFailedWorkflowRunStatuses = new Set(["failed", "error"]);
  const cancelledWorkflowRunStatuses = new Set(["aborted", "cancelled", "canceled"]);
  const completedWorkflowRunStatuses = new Set(["completed", "succeeded", "done"]);
  const legacyWorkflowMissionGraceMs = 5 * 60 * 1000;
  async function reconcileMissionStatusFromWorkflowRuns(mission: MissionRow): Promise<MissionRow> {
    if (mission.status === "cancelled") return mission;

    const isWorkflowCreatedMission = mission.description?.startsWith("Created automatically for workflow run:") ?? false;
    const canReconcileTerminalWorkflowMission =
      isWorkflowCreatedMission && mission.status === "completed";
    const canCloseCompletedMissionOversight = mission.status === "completed";
    const canPromoteStartedPlanningMission = mission.status === "planning";
    if (
      mission.status !== "active" &&
      !canReconcileTerminalWorkflowMission &&
      !canPromoteStartedPlanningMission &&
      !canCloseCompletedMissionOversight
    ) return mission;

    const linkedRuns: Array<{ status: string; createdAt: Date | null; startedAt: Date | null; completedAt: Date | null }> = [];
    const nativeRuns = await db
      .select({
        status: workflowRuns.status,
        createdAt: workflowRuns.createdAt,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(and(
        eq(workflowRuns.companyId, mission.companyId),
        eq(workflowRuns.missionId, mission.id),
      ));
    for (const run of nativeRuns) {
      linkedRuns.push({
        status: run.status,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      });
    }

    if (linkedRuns.length === 0) {
      if (mission.status === "completed") {
        await completeOpenMissionOversightIfSettled(mission, mission.completedAt ?? new Date());
      }
      if (
        isWorkflowCreatedMission &&
        mission.status === "active" &&
        mission.startedAt &&
        Date.now() - mission.startedAt.getTime() > legacyWorkflowMissionGraceMs
      ) {
        const legacyPluginRun = await db
          .select({ id: pluginEntities.id, updatedAt: pluginEntities.updatedAt })
          .from(pluginEntities)
          .where(and(
            eq(pluginEntities.entityType, "workflow-run"),
            eq(pluginEntities.scopeKind, "company"),
            eq(pluginEntities.scopeId, mission.companyId),
            sql`${pluginEntities.data} ->> 'missionId' = ${mission.id}`,
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (legacyPluginRun) {
          const openWork = await findOpenMissionWork(mission.companyId, mission.id);
          if (!openWork) {
            const completedAt = legacyPluginRun.updatedAt ?? new Date();
            const updates: Partial<MissionRow> = {
              status: "cancelled",
              completedAt,
              updatedAt: new Date(),
            };
            // [slice-5 MISMATCH C] Terminal writes must finalize mission resources atomically
            //   (runs cancelled with reason, wakeups settled, locks cleared, runtimes stopped,
            //   non-terminal issues cancelled) instead of a bare missions update.
            const settled = await runMissionTerminalCleanup(db, {
              companyId: mission.companyId,
              missionId: mission.id,
              status: "cancelled",
              now: completedAt,
              completedAt,
              missionSnapshot: mission,
              pendingMissionUpdates: updates,
            });
            if (settled.aborted) return mission;
            return { ...mission, ...updates };
          }
        }
      }
      return mission;
    }

    const normalizedStatuses = linkedRuns.map((run) => run.status.trim().toLowerCase()).filter(Boolean);
    const startedAt = mission.startedAt ?? linkedRuns
      .map((run) => run.startedAt)
      .filter((value): value is Date => value instanceof Date)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? new Date();
    const hasStartedExecutionRun = linkedRuns.some((run) =>
      run.startedAt instanceof Date && (
        activeWorkflowRunStatuses.has(run.status.trim().toLowerCase()) ||
        recoverableFailedWorkflowRunStatuses.has(run.status.trim().toLowerCase())
      ),
    );
    if (normalizedStatuses.some((status) => activeWorkflowRunStatuses.has(status))) {
      if (mission.status === "planning" && !hasStartedExecutionRun) return mission;
      if (mission.status === "completed") return mission;
      if (mission.status === "active" && mission.completedAt === null && mission.startedAt !== null) return mission;
      const updates: Partial<MissionRow> = {
        status: "active",
        startedAt,
        completedAt: null,
        updatedAt: new Date(),
      };
      await db.update(missions).set(updates).where(eq(missions.id, mission.id));
      // [감사 정직성] 읽기경로 reconcile 의 상태 되돌림 쓰기도 활동 로그에 남긴다.
      await logActivity(db, {
        companyId: mission.companyId,
        actorType: "system",
        actorId: "mission-owner-supervision",
        agentId: mission.ownerAgentId,
        action: "mission.status_reconciled",
        entityType: "mission",
        entityId: mission.id,
        details: {
          previousStatus: mission.status,
          nextStatus: "active",
          reason: "active_workflow_run",
        },
      });
      return {
        ...mission,
        ...updates,
      };
    }

    const latestRun = [...linkedRuns].sort((left, right) => {
      const leftTime = (left.createdAt ?? left.startedAt ?? left.completedAt)?.getTime() ?? 0;
      const rightTime = (right.createdAt ?? right.startedAt ?? right.completedAt)?.getTime() ?? 0;
      return rightTime - leftTime;
    })[0] ?? null;
    const latestStatus = latestRun?.status.trim().toLowerCase() ?? null;
    if (latestStatus && (completedWorkflowRunStatuses.has(latestStatus) || cancelledWorkflowRunStatuses.has(latestStatus))) {
      if (mission.status === "planning") return mission;
      if (completedWorkflowRunStatuses.has(latestStatus)) {
        const openWork = await findOpenMissionWork(mission.companyId, mission.id);
        if (openWork) {
          if (mission.status === "completed" && canReconcileTerminalWorkflowMission) {
            return reopenCompletedWorkflowMissionForOpenWork(mission, openWork);
          }
          if (mission.status === "active") return mission;
        }
      }
      if (mission.status === "completed" && !canReconcileTerminalWorkflowMission) {
        if (completedWorkflowRunStatuses.has(latestStatus)) {
          await completeOpenMissionOversightIfSettled(mission, mission.completedAt ?? new Date());
        }
        return mission;
      }

      const nextStatus: MissionStatus = cancelledWorkflowRunStatuses.has(latestStatus) ? "cancelled" : "completed";
      // [Q4] 활성 계획 refs 의 차단 단위가 남아 있으면 자동 완료 정산만 보류한다(수동 종료·독립 실행 유지).
      if (nextStatus === "completed" && await hasActivePlanBlockedRevisionUnits(db, mission.companyId, mission.id)) return mission;
      // [목적] 이미 같은 상태로 정산된 미션의 노오퍼레이션 재기록 방지 — 읽기 경로(list/감독
      // 스윕) reconcile이 updated_at을 매번 새로 찍어 "Recently updated" 순서를 흔들었다.
      // 상태/완료시각에 실제 변화가 있을 때만 쓴다(완료시각 원천은 런 기록 우선).
      const runSettledAt = latestRun.completedAt ?? latestRun.startedAt ?? latestRun.createdAt ?? null;
      const completedAt = runSettledAt ?? mission.completedAt ?? new Date();
      const updates: Partial<MissionRow> = {};
      if (mission.status !== nextStatus) updates.status = nextStatus;
      if (mission.completedAt?.getTime() !== completedAt.getTime()) updates.completedAt = completedAt;
      if (Object.keys(updates).length === 0) return mission;
      updates.updatedAt = new Date();
      // [slice-5 MISMATCH C] latestRun-terminal path: same atomic finalization requirement.
      const settledLatest = await runMissionTerminalCleanup(db, {
        companyId: mission.companyId,
        missionId: mission.id,
        status: nextStatus,
        now: updates.updatedAt,
        completedAt,
        missionSnapshot: mission,
        pendingMissionUpdates: updates,
        completeOpenMissionOversightIfSettled,
      });
      if (settledLatest.aborted) return mission;
      return { ...mission, ...updates };
    }

    if (normalizedStatuses.some((status) => recoverableFailedWorkflowRunStatuses.has(status))) {
      if (mission.status === "planning" && !hasStartedExecutionRun) return mission;
      // [1a058177 sibling] 운영자가 명시적으로 종단(completed) 쓴 미션은 recoverable-failed 런
      //   정합으로 되돌리지 않는다 — active-런 분기와 동일한 종단 쓰기 보존 원칙.
      if (mission.status === "completed") return mission;
      if (mission.status === "active" && mission.completedAt === null && mission.startedAt !== null) return mission;
      const updates: Partial<MissionRow> = {
        status: "active",
        startedAt,
        completedAt: null,
        updatedAt: new Date(),
      };
      await db.update(missions).set(updates).where(eq(missions.id, mission.id));
      // [감사 정직성] 읽기경로 reconcile 의 상태 되돌림 쓰기도 활동 로그에 남긴다.
      await logActivity(db, {
        companyId: mission.companyId,
        actorType: "system",
        actorId: "mission-owner-supervision",
        agentId: mission.ownerAgentId,
        action: "mission.status_reconciled",
        entityType: "mission",
        entityId: mission.id,
        details: {
          previousStatus: mission.status,
          nextStatus: "active",
          reason: "recoverable_failed_workflow_run",
        },
      });
      return {
        ...mission,
        ...updates,
      };
    }
    if (normalizedStatuses.some((status) => !cancelledWorkflowRunStatuses.has(status) && !completedWorkflowRunStatuses.has(status))) {
      return mission;
    }
    if (mission.status === "planning") return mission;
    if (mission.status === "completed" && !canReconcileTerminalWorkflowMission) {
      if (normalizedStatuses.every((status) => completedWorkflowRunStatuses.has(status))) {
        await completeOpenMissionOversightIfSettled(mission, mission.completedAt ?? new Date());
      }
      return mission;
    }

    const nextStatus: MissionStatus = normalizedStatuses.some((status) => cancelledWorkflowRunStatuses.has(status))
      ? "cancelled"
      : "completed";
    // [Q4] latestRun 분기와 동일하게 활성 계획 차단 단위가 남아 있으면 자동 완료만 보류한다.
    if (nextStatus === "completed" && await hasActivePlanBlockedRevisionUnits(db, mission.companyId, mission.id)) return mission;
    const completedAt = linkedRuns
      .map((run) => run.completedAt)
      .filter((value): value is Date => value instanceof Date)
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? new Date();

    const updates: Partial<MissionRow> = {
      status: nextStatus,
      completedAt,
      updatedAt: new Date(),
    };
    // [slice-5 MISMATCH C] all-terminal path: same atomic finalization requirement.
    const settledAll = await runMissionTerminalCleanup(db, {
      companyId: mission.companyId,
      missionId: mission.id,
      status: nextStatus,
      now: updates.updatedAt ?? new Date(),
      completedAt,
      missionSnapshot: mission,
      pendingMissionUpdates: updates,
      completeOpenMissionOversightIfSettled,
    });
    if (settledAll.aborted) return mission;
    return { ...mission, ...updates };
  }

  return reconcileMissionStatusFromWorkflowRuns;
}
