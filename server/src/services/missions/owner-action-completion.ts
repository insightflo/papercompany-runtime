// server/src/services/missions/owner-action-completion.ts
//
// [파일 목적] mission_main_executor_unblock 이슈가 done으로 닫히기 전에 source(originId) 실행 큐를
//   materialize하는 completion service. guard(assertCanCompleteOwnerActionWithHandback)의 backstop에
//   대응하는 정상 경로: source wakeup 생성(heartbeat.wakeup 경로) → 댓글에 id 기록 → done.
// [주요 흐름]
//   1. unblock + source(originId) 조회(company scope).
//   2. heartbeat.wakeup으로 source 향 wakeup enqueue(검증/coalescing/typed column/transition event 계약 유지).
//   3. wakeup evidence 재조회(wakeup이 null 반환한 deferred/coalesced/skipped 케이스도 row 존재 확인).
//   4. evidence 있으면 handback 댓글 + done(guard 통과). 없으면 throw.
// [수정시 주의] direct insert 금지. 항상 heartbeat.wakeup(enqueueWakeup) 경로 사용.
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issues, missions } from "@paperclipai/db";
import { issueService } from "../issues.js";
import { heartbeatService } from "../heartbeat.js";
import { conflict, notFound, unprocessable } from "../../errors.js";

export async function completeUnblockActionWithSourceHandback(
  db: Db,
  input: {
    unblockIssueId: string;
    companyId: string;
    actor: { agentId?: string | null; userId?: string | null };
  },
): Promise<{ wakeupRequestId: string | null }> {
  const svc = issueService(db);
  const heartbeat = heartbeatService(db);

  // unblock 이슈 조회 — company scope.
  const [unblock] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, input.unblockIssueId), eq(issues.companyId, input.companyId)))
    .limit(1);
  if (!unblock) throw notFound("Unblock issue not found");
  if (unblock.originKind !== "mission_main_executor_unblock") {
    throw unprocessable("Issue is not a mission_main_executor_unblock issue");
  }

  const sourceIssueId = unblock.originId;
  // source가 없으면 그냥 done(guard도 originId null로 early return).
  if (!sourceIssueId) {
    await svc.update(unblock.id, { status: "done" });
    return { wakeupRequestId: null };
  }

  // source 이슈 조회 — 같은 company scope.
  const [source] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, input.companyId)))
    .limit(1);
  if (!source) throw notFound("Source issue not found");

  // source가 이미 회복(blocked 아님)이면 wakeup 불필요 — 그냥 done.
  if (source.status !== "blocked") {
    await svc.update(unblock.id, { status: "done" });
    return { wakeupRequestId: null };
  }

  if (!source.assigneeAgentId) {
    throw unprocessable("Source issue has no assignee agent to wake for handback");
  }

  // mission terminal check — terminal mission의 issue는 handback하면 안 됨.
  if (source.missionId) {
    const [mission] = await db
      .select({ status: missions.status })
      .from(missions)
      .where(and(eq(missions.id, source.missionId), eq(missions.companyId, input.companyId)))
      .limit(1);
    if (mission && (mission.status === "completed" || mission.status === "cancelled")) {
      throw conflict("Cannot complete handback for a source issue in a terminal (completed/cancelled) mission");
    }
  }

  // [핵심] heartbeat.wakeup(enqueueWakeup) 경로로 source 향 wakeup enqueue.
  //   direct insert 금지 — 이 경로가 company/agent 검증, typed queue columns, queued coalescing,
  //   issue execution lock/defer, queue transition event를 처리.
  await heartbeat.wakeup(source.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "owner_action_completion_handback",
    payload: { issueId: source.id, missionId: source.missionId, mutation: "issue_assignment" },
    contextSnapshot: {
      issueId: source.id,
      missionId: source.missionId,
      source: "owner_action_handback",
      sourceUnblockIssueId: unblock.id,
    },
    requestedByActorType: input.actor.userId ? "user" : "agent",
    requestedByActorId: input.actor.userId ?? input.actor.agentId ?? "unknown",
    idempotencyKey: `owner-action-handback:${unblock.id}:${source.id}`,
  });

  // [peer review] heartbeat.wakeup이 null을 반환한(deferred/coalesced/skipped) 케이스도
  //   실제 wakeup evidence row가 존재하는지 company+source 기준으로 재조회.
  const [evidence] = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.issueId, source.id),
        eq(agentWakeupRequests.companyId, input.companyId),
      ),
    )
    .orderBy(desc(agentWakeupRequests.requestedAt))
    .limit(1);

  if (!evidence) {
    throw conflict(
      "Owner-action handback failed: no wakeup evidence was created for the source issue. The source issue remains blocked.",
    );
  }

  const wakeupId = evidence.id;

  // unblock 이슈에 handback 댓글 기록(wakeup id 포함, 감사 추적용).
  await svc.addComment(
    unblock.id,
    `Owner-action handback complete: source issue ${source.identifier ?? source.id} wakeup dispatched (wakeup: ${wakeupId.slice(0, 8)}).`,
    {
      agentId: input.actor.agentId ?? undefined,
      userId: input.actor.userId ?? undefined,
    },
  );

  // 이제 done 표시 — guard가 source wakeup evidence(company+issueId)를 확인하고 통과.
  await svc.update(unblock.id, { status: "done" });
  return { wakeupRequestId: wakeupId };
}
