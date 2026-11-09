import { heartbeatRuns, issues, missionPlanArtifacts, missionPlanQaVerdicts } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { revisionBoardWaitingMissionIds } from "./revision-board-wait.js";
import { asRecord, trimmedString } from "./supervision-helpers.js";
import { lifecycleInFlightClause } from "../heartbeat-finalization/lifecycle-active.js";

export async function loadActiveSupervisionData(db: Db, companyId: string, rowMissionIds: string[], staleCutoff: Date) {
      const staleFailedHeartbeatMissionIds = new Set(
        rowMissionIds.length > 0
          ? (await db
            .select({ missionId: issues.missionId })
            .from(issues)
            .innerJoin(heartbeatRuns, eq(heartbeatRuns.issueId, issues.id))
            .where(and(
              eq(issues.companyId, companyId),
              inArray(issues.missionId, rowMissionIds),
              isNull(issues.hiddenAt),
              inArray(issues.status, ["todo", "backlog"]),
              lte(issues.createdAt, staleCutoff),
              inArray(heartbeatRuns.status, ["failed", "timed_out"]),
            )))
            .map((row) => row.missionId)
            .filter((missionId): missionId is string => Boolean(missionId))
          : [],
      );
      const staleQueueIssueRows = rowMissionIds.length > 0
        ? await db
          .select({ missionId: issues.missionId, issueId: issues.id })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            inArray(issues.missionId, rowMissionIds),
            isNull(issues.hiddenAt),
            inArray(issues.status, ["todo", "backlog"]),
            lte(issues.createdAt, staleCutoff),
            sql`${issues.originKind} not in ('mission_main_executor_oversight', 'mission_main_executor_unblock')`,
          ))
        : [];
      const staleOwnerActionIssueRows = rowMissionIds.length > 0
        ? await db
          .select({ missionId: issues.missionId, issueId: issues.id })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            inArray(issues.missionId, rowMissionIds),
            isNull(issues.hiddenAt),
            inArray(issues.status, ["todo", "backlog"]),
            lte(issues.createdAt, staleCutoff),
            eq(issues.originKind, "mission_main_executor_unblock"),
          ))
        : [];
      const activeHeartbeatMissionIds = rowMissionIds.length > 0
        ? new Set((await db
          .select({ missionId: issues.missionId })
          .from(issues)
          .innerJoin(heartbeatRuns, eq(heartbeatRuns.issueId, issues.id))
          .where(and(
            eq(issues.companyId, companyId),
            inArray(issues.missionId, rowMissionIds),
            await lifecycleInFlightClause(db),
          )))
          .map((row) => row.missionId)
          .filter((missionId): missionId is string => Boolean(missionId)))
        : new Set<string>();
      const activePlanArtifactRows = rowMissionIds.length > 0
        ? await db
          .select({
            missionId: missionPlanArtifacts.missionId,
            revision: missionPlanArtifacts.revision,
            refs: missionPlanArtifacts.refs,
          })
          .from(missionPlanArtifacts)
          .where(and(
            eq(missionPlanArtifacts.companyId, companyId),
            inArray(missionPlanArtifacts.missionId, rowMissionIds),
            eq(missionPlanArtifacts.status, "active"),
          ))
          .orderBy(asc(missionPlanArtifacts.missionId), asc(missionPlanArtifacts.revision))
        : [];
      const activePlanByMissionId = new Map<string, typeof activePlanArtifactRows[number]>();
      for (const planRow of activePlanArtifactRows) {
        activePlanByMissionId.set(planRow.missionId, planRow);
      }
      const planQaIssueDecisionPairs = activePlanArtifactRows
        .map((planRow) => {
          const refs = asRecord(planRow.refs);
          const planQaRef = asRecord(refs.planQa);
          const issueId = trimmedString(planQaRef.issueId);
          const decisionHash = trimmedString(planQaRef.decisionHash);
          return issueId && decisionHash ? { issueId, decisionHash } : null;
        })
        .filter((pair): pair is { issueId: string; decisionHash: string } => Boolean(pair));
      const planQaVerdictKeys = new Set(
        planQaIssueDecisionPairs.length > 0
          ? (await db
            .select({
              planQaIssueId: missionPlanQaVerdicts.planQaIssueId,
              decisionHash: missionPlanQaVerdicts.decisionHash,
            })
            .from(missionPlanQaVerdicts)
            .where(and(
              eq(missionPlanQaVerdicts.companyId, companyId),
              inArray(missionPlanQaVerdicts.planQaIssueId, planQaIssueDecisionPairs.map((pair) => pair.issueId)),
            )))
            .map((row) => `${row.planQaIssueId}:${row.decisionHash}`)
          : [],
      );
      const boardWaiting = await revisionBoardWaitingMissionIds(db, companyId, rowMissionIds);
  return {
    staleFailedHeartbeatMissionIds,
    staleQueueIssueRows,
    staleOwnerActionIssueRows,
    activeHeartbeatMissionIds,
    activePlanByMissionId,
    planQaVerdictKeys,
    boardWaiting,
  };
}
