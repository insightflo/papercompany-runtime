import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issues, missionAgents, missionPlanArtifacts, missionSessions, missions, operatorDecisions } from "@paperclipai/db";
import type { MissionRow } from "../missions.js";
import { logger } from "../../middleware/logger.js";
import {
  captureMissionTerminalAuthority,
  lockAndCheckMissionTerminalAuthority,
  type MissionTerminalAuthority,
} from "./terminal-cleanup-authority.js";
import { resetSafeTerminalAgents, settleMissionTerminalResources } from "./terminal-cleanup-resources.js";
import { stopMissionTerminalProcesses } from "./terminal-cleanup-processes.js";

/** Terminal status and DB cleanup share one epoch-checked transaction, including no-run missions.
 * Producer-owned child handles are captured under locks and signalled only after commit.
 */
export type MissionTerminalCleanupDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface MissionTerminalCleanupInput {
  companyId: string;
  missionId: string;
  status: "completed" | "cancelled";
  now: Date;
  /** update() 가 계산한 completedAt (없으면 null) — oversight 종결에만 사용된다. */
  completedAt: Date | null;
  /** caller 가 읽은 미션 행 스냅샷(ownerAgentId 등) — 재조회는 잠금 하에서 별도로 한다. */
  missionSnapshot: MissionRow;
  capturedAuthority?: MissionTerminalAuthority;
  /** Terminal updates are written only after the captured epoch passes under locks. */
  pendingMissionUpdates?: Partial<MissionRow>;
  /** @deprecated Source compatibility only; ignored. Generic cancellation may dispatch replacement work. */
  cancelHeartbeatRun?: (runId: string) => Promise<unknown>;
  completeOpenMissionOversightIfSettled?: (mission: MissionRow, completedAt: Date, executor: MissionTerminalCleanupDb) => Promise<void>;
}

export interface MissionTerminalCleanupResult {
  aborted: boolean;
  reason: "resume_reactivated" | null;
  stoppedRuntimeIds: string[];
}

async function executeMissionTerminalCleanup(
  executor: MissionTerminalCleanupDb,
  input: MissionTerminalCleanupInput,
) {
  const { companyId, missionId, status, now } = input;
  const terminalPlanStatus = status === "completed" ? "completed" : "archived";
  const resources = await settleMissionTerminalResources(executor, input);

  await executor
    .update(missionPlanArtifacts)
    .set({ status: terminalPlanStatus, updatedAt: now })
    .where(and(
      eq(missionPlanArtifacts.companyId, companyId),
      eq(missionPlanArtifacts.missionId, missionId),
      eq(missionPlanArtifacts.status, "active"),
    ));

  await executor
    .update(missionSessions)
    .set({ status: "closed", lastActiveAt: now })
    .where(and(
      eq(missionSessions.companyId, companyId),
      eq(missionSessions.missionId, missionId),
      eq(missionSessions.status, "active"),
    ));

  // [취소 회수] 취소된 미션에 매달린 pending 승인요청(operator decision)은 이후 결정될 수 없다.
  // resolve(승인/기각 — 재실행 트리거)가 아니라 cancel로 회수한다(웨이크업·연속 실행 없음).
  // completed에는 적용하지 않는다(종결 후 처리 요청은 여전히 유효할 수 있다).
  if (status === "cancelled") {
    const missionIssueIds = executor
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.missionId, missionId)));
    const withdrawn = await executor
      .update(operatorDecisions)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(and(
        eq(operatorDecisions.companyId, companyId),
        eq(operatorDecisions.status, "pending"),
        or(
          sql`${operatorDecisions.sourceContext}->>'missionId' = ${missionId}`,
          inArray(operatorDecisions.issueId, missionIssueIds),
        ),
      ))
      .returning({ id: operatorDecisions.id, requestKey: operatorDecisions.requestKey });
    if (withdrawn.length > 0) {
      await executor.insert(activityLog).values(withdrawn.map((row) => ({
        companyId,
        actorType: "system",
        actorId: "mission_terminal_cleanup",
        action: "operator_decision.cancelled",
        entityType: "operator_decision",
        entityId: row.id,
        details: {
          schemaVersion: 1,
          operatorDecisionId: row.id,
          requestKey: row.requestKey,
          missionId,
          reason: "mission_cancelled",
        },
      })));
    }
  }

  const missionAgentRows = await executor
    .select({ agentId: missionAgents.agentId })
    .from(missionAgents)
    .where(eq(missionAgents.missionId, missionId));
  const issueAssigneeRows = await executor
    .select({ agentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.missionId, missionId), sql`${issues.assigneeAgentId} is not null`));
  const affectedAgentIds = Array.from(new Set([
    input.missionSnapshot.ownerAgentId,
    ...missionAgentRows.map((row) => row.agentId),
    ...issueAssigneeRows.map((row) => row.agentId).filter((agentId): agentId is string => Boolean(agentId)),
  ]));
  await resetSafeTerminalAgents(executor, companyId, affectedAgentIds, now);

  if (status === "completed" && input.completeOpenMissionOversightIfSettled) {
    await input.completeOpenMissionOversightIfSettled(
      { ...input.missionSnapshot, status: "completed", completedAt: input.completedAt ?? input.missionSnapshot.completedAt ?? now },
      input.completedAt ?? input.missionSnapshot.completedAt ?? now,
      executor,
    );
  }

  try {
    const { missionDelegationService } = await import("../mission-delegations.js");
    await missionDelegationService(executor as Db).finalizeTargetMission({
      targetMissionId: missionId,
      targetStatus: status,
    });
  } catch (err) {
    logger.warn({ err, missionId, status }, "failed to finalize delegated target mission");
  }

  return resources;
}

/** Legacy callers capture at entry and must already have the requested terminal status. */
export async function runMissionTerminalCleanup(
  db: Db,
  input: MissionTerminalCleanupInput,
): Promise<MissionTerminalCleanupResult> {
  const captured = input.capturedAuthority ?? await captureMissionTerminalAuthority(
    db, input.companyId, input.missionId,
    input.pendingMissionUpdates ? input.missionSnapshot : undefined,
  );
  const settled = await db.transaction(async (tx) => {
    const matches = await lockAndCheckMissionTerminalAuthority(tx, input.companyId, input.missionId, captured);
    if (!matches || (!input.pendingMissionUpdates && captured.missionStatus !== input.status)) {
      return { aborted: true, reason: "resume_reactivated" as const, stoppedRuntimeIds: [], processStops: [] };
    }
    if (input.pendingMissionUpdates) {
      await tx.update(missions).set({ ...input.pendingMissionUpdates, status: input.status })
        .where(and(eq(missions.companyId, input.companyId), eq(missions.id, input.missionId)));
    }
    const resources = await executeMissionTerminalCleanup(tx, input);
    return { aborted: false, reason: null, ...resources };
  });
  if (!settled.aborted) stopMissionTerminalProcesses(settled.processStops);
  return { aborted: settled.aborted, reason: settled.reason, stoppedRuntimeIds: settled.stoppedRuntimeIds };
}
