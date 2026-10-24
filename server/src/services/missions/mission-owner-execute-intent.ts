// [목적] 미션 오너 실행의 기존 인증과 intent 저장을 분리한다.
// 같은 context/db와 원본 refusal 함수를 전달받아 오류 객체와 트랜잭션 계약을 보존한다.
// 실제 실행·재전달·현재성 재검증은 mission-owner-execute.ts에 남긴다.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, missions, workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { MissionOwnerExecuteRequest } from "@paperclipai/shared/validators/mission-owner-authority";
import type { OwnerExecutionContext } from "./mission-owner-execute.js";
import { intentIdempotencyKey, intentKeyWhere, latestIntentEventId, ownerIntentResponseSource,
  stable } from "./mission-owner-execution-state.js";
import { consumeOwnerHumanResponse } from "./owner-human-response.js";

type OwnerExecutionRefusal = (status: 403 | 404 | 409 | 422, reasonCode: string) => never;
const SOURCE = "mission_owner_execute";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function authenticateOwnerExecution(context: OwnerExecutionContext, request: MissionOwnerExecuteRequest,
  refusal: OwnerExecutionRefusal): Promise<void> {
  const [heartbeat] = await context.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, context.heartbeatRunId), eq(heartbeatRuns.companyId, context.companyId), eq(heartbeatRuns.agentId, context.agentId), eq(heartbeatRuns.issueId, request.ownerActionIssueId))).limit(1);
  if (!heartbeat) refusal(403, "heartbeat_mismatch");
  const [issue] = await context.db.select({ missionId: issues.missionId }).from(issues).where(and(eq(issues.id, request.ownerActionIssueId), eq(issues.companyId, context.companyId))).limit(1);
  if (!issue || issue.missionId !== request.missionId) refusal(404, "owner_action_issue_not_found");
  const [mission] = await context.db.select({ status: missions.status, ownerAgentId: missions.ownerAgentId }).from(missions)
    .where(and(eq(missions.id, request.missionId), eq(missions.companyId, context.companyId))).limit(1);
  if (!mission) refusal(404, "mission_not_found");
  if (mission.status !== "active") refusal(403, "mission_not_active");
  if (mission.ownerAgentId !== context.agentId) refusal(403, "not_mission_owner"); }

export async function saveOwnerExecutionIntent(context: OwnerExecutionContext, request: MissionOwnerExecuteRequest,
  refusal: OwnerExecutionRefusal): Promise<{ actionId: string; replay: boolean }> {
  const idempotencyKey = intentIdempotencyKey(context.companyId, request.missionId, request.ownerActionIssueId, request.actionRequestId);
  const fingerprint = createHash("sha256").update(stable(request)).digest("hex").slice(0, 24);
  let actionId: string | null = null;
  let replay = false;
  await context.db.transaction(async (tx) => {
    const [lockedMission] = await tx.select({ id: missions.id }).from(missions).where(and(
      eq(missions.id, request.missionId), eq(missions.companyId, context.companyId))).for("update");
    if (!lockedMission) refusal(404, "mission_not_found");
    const [existing] = await tx.select({ id: workflowTransitionEvents.id, payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(intentKeyWhere(context.companyId, idempotencyKey)).limit(1);
    if (existing) {
      if (record(existing.payload).bodyFingerprint !== fingerprint) refusal(409, "action_request_conflict");
      actionId = existing.id; replay = true; return;
    }
    const [heartbeat] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, context.heartbeatRunId),
      eq(heartbeatRuns.companyId, context.companyId), eq(heartbeatRuns.agentId, context.agentId),
      eq(heartbeatRuns.issueId, request.ownerActionIssueId))).limit(1);
    if (!heartbeat) refusal(403, "heartbeat_mismatch");
    const response = await consumeOwnerHumanResponse(tx as unknown as Db, heartbeat);
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, request.ownerActionIssueId), eq(issues.companyId, context.companyId))).for("update");
    const [racedExisting] = await tx.select({ id: workflowTransitionEvents.id, payload: workflowTransitionEvents.payload })
      .from(workflowTransitionEvents).where(intentKeyWhere(context.companyId, idempotencyKey)).limit(1);
    if (racedExisting) {
      if (record(racedExisting.payload).bodyFingerprint !== fingerprint) refusal(409, "action_request_conflict");
      actionId = racedExisting.id; replay = true; return;
    }
    if (request.expectedIntentEventId != null && await latestIntentEventId(tx as unknown as Db,
      context.companyId, request.ownerActionIssueId) !== request.expectedIntentEventId) refusal(409, "stale_intent");
    const responseSource = ownerIntentResponseSource(response, heartbeat.id);
    const inserted = await tx.insert(workflowTransitionEvents).values({ companyId: context.companyId,
      missionId: request.missionId, issueId: request.ownerActionIssueId, heartbeatRunId: context.heartbeatRunId,
      eventType: "owner_execute_intent_v1", layer: "mission_owner_authority", reason: SOURCE, reasonCode: SOURCE,
      idempotencyKey, correlationId: responseSource?.lifetimeId ?? null,
      payload: { schemaVersion: 1, kind: "owner_execute_intent_v1", missionId: request.missionId,
        ownerActionIssueId: request.ownerActionIssueId, actionRequestId: request.actionRequestId,
        heartbeatRunId: context.heartbeatRunId, agentId: context.agentId, action: request.action,
        bodyFingerprint: fingerprint, ownerHumanResponse: responseSource } })
      .onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
    if (inserted[0]) { actionId = inserted[0].id; return; }
    // Same key inserted concurrently — resolve the authoritative row under the same lock.
    const [raced] = await tx.select({ id: workflowTransitionEvents.id, payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(intentKeyWhere(context.companyId, idempotencyKey)).limit(1);    if (!raced || record(raced.payload).bodyFingerprint !== fingerprint) refusal(409, "action_request_conflict");
    actionId = raced.id; replay = true;
  });
  return { actionId: actionId!, replay };
}
