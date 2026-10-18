// server/src/services/missions/owner-recovery-window-auth.ts
//
// [목적] owner-recovery 계열 에이전트 API 창구(결정·자가교체·mission_owner_execute 실행)가 공유하는
//   비-결정 인가 체인. 결정 본문 검증은 각 창구의 몫이고, 여기는 통제점(미션 오너 일치 + unblock
//   owner-action 이슈 + 소스 이슈 동일 미션 + heartbeat identity + 체크아웃)만 담는다.
// [연결] authorizeOwnerRecoveryApi(결정)와 동일 순서 — owner-self-replacement.ts·owner-execute-decision-window.ts
//   가 호출한다. label 은 창구 이름(replacement/execute)으로 기존 메시지 계약을 그대로 보존한다.
//   호출부는 트랜잭션 안에서 불러야 잠금(for update/share)이 유효하다.
// [수정시 주의] 체크 순서·메시지는 결정 API 계약과 묶여 있다 — 분기 시 결정 라우트 테스트와 함께 검증.
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, missions, type Db } from "@paperclipai/db";
import { conflict, forbidden, unauthorized } from "../../errors.js";
import { issueService } from "../issues.js";
import {
  ownerRecoveryActorFailure,
  ownerRecoveryIdentityMatches,
  ownerRecoveryIssueFailure,
  ownerRecoveryOwnerMatches,
  ownerRecoverySourceMatches,
} from "./owner-recovery-submission-guards.js";
import type { OwnerRecoveryApiActor } from "./mission-owner-recovery-agent-api.js";

export async function authorizeOwnerRecoveryWindow(db: Db, issueId: string, actor: OwnerRecoveryApiActor, label: string) {
  const actorFailure = ownerRecoveryActorFailure(actor);
  if (actorFailure === "agent_required") throw forbidden("Agent authentication required");
  if (actorFailure === "run_required" || !actor.runId) throw unauthorized("Agent run id required");
  if (!actor.agentId) throw forbidden("Agent authentication required");
  const [issue] = await db.select({ id: issues.id, companyId: issues.companyId, missionId: issues.missionId,
    originKind: issues.originKind, originId: issues.originId }).from(issues).where(eq(issues.id, issueId)).limit(1);
  if (!issue) throw conflict(`Owner-recovery ${label} API can only be used for mission-owner unblock issues`);
  const issueFailure = ownerRecoveryIssueFailure(issue);
  if (issueFailure === "unblock_required") throw conflict(`Owner-recovery ${label} API can only be used for mission-owner unblock issues`);
  if (issueFailure === "mission_required") throw conflict(`Owner-recovery ${label} API requires a mission-scoped owner-action issue`);
  const [mission] = await db.select({ ownerAgentId: missions.ownerAgentId }).from(missions)
    .where(and(eq(missions.id, issue.missionId!), eq(missions.companyId, issue.companyId))).limit(1).for("update");
  if (!ownerRecoveryOwnerMatches(mission, actor.agentId)) throw forbidden("Only the mission owner agent may submit owner-recovery decisions");
  const sourceIssueId = issue.originId;
  if (!sourceIssueId) throw conflict(`Owner-recovery ${label} API requires a source issue in the same company and mission`);
  const [sourceIssue] = await db.select({ missionId: issues.missionId }).from(issues)
    .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, issue.companyId))).limit(1).for("share");
  if (!ownerRecoverySourceMatches(sourceIssue, issue.missionId)) {
    throw conflict(`Owner-recovery ${label} API requires a source issue in the same company and mission`);
  }
  const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, actor.runId)).limit(1).for("share");
  const [currentIssue] = await db.select().from(issues).where(eq(issues.id, issue.id)).limit(1).for("update");
  if (!ownerRecoveryIdentityMatches({ heartbeat, issue, currentIssue, agentId: actor.agentId })) {
    throw conflict("Owner-recovery submission requires the same company, agent and owner-action heartbeat", {
      reason: "owner_recovery_submission_identity_mismatch",
    });
  }
  await issueService(db).assertCheckoutOwner(issue.id, actor.agentId, actor.runId);
  return { issue };
}
