import { companies, activityLog, issueComments, issues, missions, workflowTransitionEvents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { conflict } from "../../errors.js";
import { lockOwnerHumanRequestAuthority, type OwnerHumanAuthority } from "./owner-human-request-authority.js";
import { ownerHumanCurrentKey, ownerHumanCurrentSchema, ownerHumanLifetimeSchema,
  ownerHumanScopeSchema, sameOwnerHumanValue, type OwnerHumanTx } from "./owner-human-request-contract.js";
import { closeOwnerHumanRequest, readOwnerHumanCurrent } from "./owner-human-request-state.js";

const SETTLEABLE_OWNER_ACTION_STATUSES = ["backlog", "todo", "blocked"];

type OpenMissionWork = {
  readonly id: string;
  readonly status: string;
};

type LockedSettlement = { auth: OwnerHumanAuthority; lifetimeId: string };
const settlementConflict = (): never => { throw conflict("Owner human settlement conflict", {
  reason: "owner_human_request_settlement_mismatch",
}); };

async function lockCurrentSettlement(tx: OwnerHumanTx, pointerRow: typeof workflowTransitionEvents.$inferSelect) {
  const pointer = ownerHumanCurrentSchema.safeParse(pointerRow.payload);
  if (!pointer.success || pointerRow.companyId !== pointer.data.scope.companyId
    || pointerRow.missionId !== pointer.data.scope.missionId
    || pointerRow.eventType !== pointer.data.kind
    || pointerRow.idempotencyKey !== ownerHumanCurrentKey(pointer.data.scope)) return settlementConflict();
  const [lifetimeRow] = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, pointer.data.scope.companyId),
    eq(workflowTransitionEvents.id, pointer.data.lifetimeId)));
  const parsed = ownerHumanLifetimeSchema.safeParse(lifetimeRow?.payload);
  if (!parsed.success || parsed.data.lifetimeId !== pointer.data.lifetimeId
    || parsed.data.anchorIssueId !== pointer.data.anchorIssueId
    || parsed.data.requestKey !== pointer.data.requestKey
    || !sameOwnerHumanValue(parsed.data.scope, pointer.data.scope)) return settlementConflict();
  const lifetime = parsed.data;
  let auth: OwnerHumanAuthority;
  if (lifetime.renewal) {
    let origin = lifetime;
    const seen = new Set([lifetime.lifetimeId]);
    while (origin.renewal) {
      const previousLifetimeId = origin.renewal.previousLifetimeId;
      if (seen.has(previousLifetimeId)) return settlementConflict();
      seen.add(previousLifetimeId);
      const [previousRow] = await tx.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, lifetime.scope.companyId),
        eq(workflowTransitionEvents.id, previousLifetimeId)));
      const previous = ownerHumanLifetimeSchema.safeParse(previousRow?.payload);
      if (!previous.success || previous.data.lifetimeId !== previousLifetimeId
        || previous.data.authorAgentId !== lifetime.authorAgentId
        || previous.data.heartbeatRunId !== lifetime.heartbeatRunId
        || previous.data.decisionEventId !== lifetime.decisionEventId
        || !sameOwnerHumanValue(previous.data.scope, lifetime.scope)
        || !sameOwnerHumanValue(previous.data.submission, lifetime.submission)) return settlementConflict();
      origin = previous.data;
    }
    auth = await lockOwnerHumanRequestAuthority(tx, {
      companyId: lifetime.scope.companyId, missionId: lifetime.scope.missionId,
      ownerActionIssueId: origin.anchorIssueId, agentId: lifetime.authorAgentId,
      heartbeatRunId: lifetime.heartbeatRunId, recoveryTarget: lifetime.submission.recoveryTarget,
      purpose: "settle", renewal: { previousLifetimeId: origin.lifetimeId,
        anchorIssueId: lifetime.anchorIssueId },
    });
  } else {
    auth = await lockOwnerHumanRequestAuthority(tx, {
      companyId: lifetime.scope.companyId, missionId: lifetime.scope.missionId,
      ownerActionIssueId: lifetime.anchorIssueId, agentId: lifetime.authorAgentId,
      heartbeatRunId: lifetime.heartbeatRunId, recoveryTarget: lifetime.submission.recoveryTarget,
      purpose: "settle",
    });
  }
  const current = await readOwnerHumanCurrent(auth);
  if (!current || current.pointerEventId !== pointerRow.id
    || current.lifetime.lifetimeId !== lifetime.lifetimeId) return settlementConflict();
  if (!current.pointer.recoveryNeeded) return null;
  return { auth, lifetimeId: lifetime.lifetimeId } satisfies LockedSettlement;
}

export async function lockSourceOwnerHumanSettlement(tx: OwnerHumanTx, input: {
  companyId: string; missionId: string; sourceIssueId: string;
}): Promise<LockedSettlement | null> {
  const [mission] = await tx.select({ id: missions.id }).from(missions).where(and(
    eq(missions.companyId, input.companyId), eq(missions.id, input.missionId))).for("update");
  if (!mission) return settlementConflict();
  const scope = ownerHumanScopeSchema.parse({ companyId: input.companyId, missionId: input.missionId,
    target: { kind: "source_issue", issueId: input.sourceIssueId } });
  const [pointer] = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, input.companyId),
    eq(workflowTransitionEvents.idempotencyKey, ownerHumanCurrentKey(scope))));
  return pointer ? lockCurrentSettlement(tx, pointer) : null;
}

export async function lockMissionOwnerHumanSettlements(tx: OwnerHumanTx, companyId: string, missionId: string) {
  const [mission] = await tx.select({ id: missions.id }).from(missions).where(and(
    eq(missions.companyId, companyId), eq(missions.id, missionId))).for("update");
  if (!mission) return settlementConflict();
  const pointers = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.missionId, missionId),
    or(eq(workflowTransitionEvents.eventType, "owner_human_current_v1"),
      sql`${workflowTransitionEvents.idempotencyKey} like 'owner-human-current:v1:%'`,
      sql`${workflowTransitionEvents.payload}->>'kind' = 'owner_human_current_v1'`)))
    .orderBy(workflowTransitionEvents.idempotencyKey);
  const locked: LockedSettlement[] = [];
  for (const pointer of pointers) {
    const settlement = await lockCurrentSettlement(tx, pointer);
    if (settlement) locked.push(settlement);
  }
  return locked;
}

export async function closeLockedOwnerHumanSettlements(locked: LockedSettlement[]) {
  for (const settlement of locked) {
    await closeOwnerHumanRequest(settlement.auth, settlement.lifetimeId);
  }
}

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
        const ownerHuman = await lockSourceOwnerHumanSettlement(tx, { companyId, missionId, sourceIssueId });
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

        await closeLockedOwnerHumanSettlements(ownerHuman ? [ownerHuman] : []);

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
