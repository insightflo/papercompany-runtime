// server/src/services/missions/owner-action-completion.ts
//
// [파일 목적] mission_main_executor_unblock 이슈가 done으로 닫히기 전에 source(originId) 실행 큐를
//   materialize하는 completion service. guard(assertCanCompleteOwnerActionWithHandback)의 backstop에
//   대응하는 정상 경로를 제공: source wakeup 생성 → 댓글에 id 기록 → done.
// [주요 흐름]
//   1. unblock 이슈 + source(originId) 조회.
//   2. source 향 agent_wakeup_requests row 직접 insert(guard가 issueId로 조회하므로 직접 생성이 가장 확실).
//   3. unblock 이슈에 handback 댓글 기록(wakeup id 포함).
//   4. issueService.update로 done 표시(guard가 wakeup evidence를 보고 통과).
// [외부 연결] issueService(issues.ts), agent_wakeup_requests(@paperclipai/db).
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issues } from "@paperclipai/db";
import { issueService } from "../issues.js";
import { notFound, unprocessable } from "../../errors.js";

export async function completeUnblockActionWithSourceHandback(
  db: Db,
  input: {
    unblockIssueId: string;
    companyId: string;
    actor: { agentId?: string | null; userId?: string | null };
  },
): Promise<{ wakeupRequestId: string | null }> {
  const svc = issueService(db);

  const [unblock] = await db
    .select()
    .from(issues)
    .where(eq(issues.id, input.unblockIssueId))
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

  const [source] = await db
    .select()
    .from(issues)
    .where(eq(issues.id, sourceIssueId))
    .limit(1);
  if (!source) throw notFound("Source issue not found");

  // source가 이미 회복(blocked 아님)이면 wakeup 불필요 — 그냥 done.
  if (source.status !== "blocked") {
    await svc.update(unblock.id, { status: "done" });
    return { wakeupRequestId: null };
  }

  // source assignee 확인 — wake할 대상.
  if (!source.assigneeAgentId) {
    throw unprocessable("Source issue has no assignee agent to wake for handback");
  }

  // [핵심] source 향 wakeup row 직접 insert — guard가 agent_wakeup_requests.issueId = sourceId로 조회.
  //   heartbeat scheduler가 이 row를 polling해서 실제 executor를 wake.
  const [wakeupRow] = await db
    .insert(agentWakeupRequests)
    .values({
      companyId: input.companyId,
      agentId: source.assigneeAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "owner_action_completion_handback",
      issueId: source.id,
      missionId: source.missionId,
      requestedByActorType: input.actor.userId ? "user" : "agent",
      requestedByActorId: input.actor.userId ?? input.actor.agentId ?? "unknown",
      payload: { issueId: source.id, mutation: "issue_assignment", sourceUnblockIssueId: unblock.id },
      requestedAt: new Date(),
    })
    .returning({ id: agentWakeupRequests.id });

  const wakeupId = wakeupRow?.id ?? null;

  // unblock 이슈에 handback 댓글 기록(wakeup id 포함, 감사 추적용).
  await svc.addComment(
    unblock.id,
    `Owner-action handback complete: source issue ${source.identifier ?? source.id} wakeup dispatched${wakeupId ? ` (wakeup: ${wakeupId.slice(0, 8)})` : ""}.`,
    {
      agentId: input.actor.agentId ?? undefined,
      userId: input.actor.userId ?? undefined,
    },
  );

  // 이제 done 표시 — guard가 source wakeup evidence를 확인하고 통과.
  await svc.update(unblock.id, { status: "done" });
  return { wakeupRequestId: wakeupId };
}
