import { companies, activityLog, issueComments, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

const SETTLEABLE_OWNER_ACTION_STATUSES = ["backlog", "todo", "blocked"];

type OpenMissionWork = {
  readonly id: string;
  readonly status: string;
};

export function createMissionWorkSettlement(db: Db) {
  return async function settleResolvedOwnerActionsAndFindOpenWork(
    companyId: string,
    missionId: string,
  ): Promise<OpenMissionWork | null> {
    const ownerActions = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        originId: issues.originId,
        status: issues.status,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.missionId, missionId),
        eq(issues.originKind, "mission_main_executor_unblock"),
        isNull(issues.hiddenAt),
        inArray(issues.status, SETTLEABLE_OWNER_ACTION_STATUSES),
      ));
    for (const action of ownerActions) {
      const sourceIssueId = action.originId;
      if (!sourceIssueId) continue;
      await db.transaction(async (tx) => {
        const [source] = await tx
          .select({
            id: issues.id, language: sql<string>`(select ${companies.defaultLanguage} from ${companies} where ${companies.id} = ${issues.companyId})`,
            identifier: issues.identifier,
            status: issues.status,
            completedAt: issues.completedAt,
            cancelledAt: issues.cancelledAt,
          })
          .from(issues)
          .where(and(
            eq(issues.id, sourceIssueId),
            eq(issues.companyId, companyId),
            eq(issues.missionId, missionId),
            inArray(issues.status, ["done", "cancelled"]),
          ))
          .for("update");
        if (!source) return;

        const now = new Date();
        const nextStatus = source.status === "done" ? "done" : "cancelled";
        const terminalAt = nextStatus === "done"
          ? (source.completedAt ?? now)
          : (source.cancelledAt ?? now);
        const [settled] = await tx
          .update(issues)
          .set({
            status: nextStatus,
            completedAt: nextStatus === "done" ? terminalAt : null,
            cancelledAt: nextStatus === "cancelled" ? terminalAt : null,
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(and(
            eq(issues.id, action.id),
            eq(issues.companyId, companyId),
            eq(issues.missionId, missionId),
            eq(issues.originKind, "mission_main_executor_unblock"),
            eq(issues.originId, source.id),
            inArray(issues.status, SETTLEABLE_OWNER_ACTION_STATUSES),
          ))
          .returning({ id: issues.id });
        if (!settled) return;

        await tx.insert(issueComments).values({
          companyId,
          issueId: action.id,
          body: source.language === "ko" ? `원래 업무 ${source.identifier ?? source.id}의 상태가 ${source.status}로 종결되어 복구 업무를 자동 정리했습니다. 다음 행동: 추가 작업이 필요하면 원래 업무의 최종 기록을 확인해 주세요. 이 정리는 새 실행을 요청하지 않습니다.` : `Resolved automatically: source issue ${source.identifier ?? source.id} reached ${source.status}; this unblock action no longer represents open mission work. Next action: check the source issue's final record if further work is needed; this closeout does not start another run.`,
        });
        await tx.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: "mission-work-settlement",
          action: "mission.owner_action_settled_from_source",
          entityType: "issue",
          entityId: action.id,
          details: {
            identifier: action.identifier,
            previousStatus: action.status,
            nextStatus,
            sourceIssueId: source.id,
            sourceStatus: source.status,
          },
        });
      });
    }

    return db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.missionId, missionId),
        isNull(issues.hiddenAt),
        sql`${issues.status} not in ('done', 'cancelled')`,
        sql`${issues.originKind} <> 'mission_main_executor_oversight'`,
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  };
}
