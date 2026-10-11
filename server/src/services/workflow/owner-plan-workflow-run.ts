// server/src/services/workflow/owner-plan-workflow-run.ts
//
// [Stage 5] owner 계획 실행의 run 생성·실행 경계. ordinary plan 은 create/execute 를 그대로 하되,
//   owner 가 revise_plan intent 로 시작한 계획은 저장 파생 판별(latest revise_plan intent 의 decision
//   hash 가 지금 materialize 되는 hash 와 일치)로 연결해 생성·실행 양쪽 경계에서 현재 intent/owner/
//   미션 활성을 재확인한다(validateIntent). intent 가 바뀐 채 도착한 지연 QA 는 시작을 차단한다.
//   무관한 ordinary plan 에는 새로운 보편 승인을 추가하지 않는다. 새 run context(actionId·plan hash)
//   를 run metadata 에 저장해 후속 admission 이 읽을 수 있게 한다.
import { and, desc, eq } from "drizzle-orm";
import { missions, workflowRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { createWorkflowRun } from "./workflow-store.js";
import { executeWorkflowRun } from "./dag-engine.js";
import { latestIntentEventId } from "../missions/mission-owner-execution-state.js";
import { hashOwnerPlanDecision } from "../mission-owner-plan-decisions.js";

export type OwnerPlanRunFence = { actionId: string; decisionHash: string;
  validateIntent: (db: Db) => Promise<boolean> };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** [저장 파생 owner 연결] 이 미션의 최신 오너 실행 intent 들 중 지금 materialize 되는 decisionHash
 *  를 가진 것을 찾아 시작 경계 펜스를 만든다. hash 가 다른 제출은 이 시작의 소유가 아니다.
 *  [Stage 7 일반화] revise_plan 뿐 아니라 계획을 수반한 모든 오너 operation(recollect changed_collection,
 *  delegate_fix 의 plan/collection.plan 경로)의 intent 가 시작을 소유할 수 있다 — 일반 미션의 재수집/
 *  수정위임 계획도 QA-시작 사이 의도 변경에 대해 같은 펜스로 재확인된다. */
async function deriveOwnerPlanRunFence(db: Db, companyId: string, missionId: string,
  decisionHash: string): Promise<OwnerPlanRunFence | null> {
  const intents = await db.select({ id: workflowTransitionEvents.id, issueId: workflowTransitionEvents.issueId,
    payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.missionId, missionId),
    eq(workflowTransitionEvents.eventType, "owner_execute_intent_v1"),
    eq(workflowTransitionEvents.layer, "mission_owner_authority")))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(10);
  for (const intent of intents) {
    const payload = record(intent.payload), action = record(payload.action);
    const decision = [record(record(action.plan).decision), record(record(record(action.collection).plan).decision)]
      .find((candidate) => Object.keys(candidate).length > 0) ?? null;
    if (!intent.issueId || !decision) continue;
    if (hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]) !== decisionHash) continue;
    const actionId = intent.id, issueId = intent.issueId, agentId = payload.agentId;
    return { actionId, decisionHash, validateIntent: async (tx) => {
      const [mission] = await tx.select({ status: missions.status, ownerAgentId: missions.ownerAgentId })
        .from(missions).where(and(eq(missions.id, missionId), eq(missions.companyId, companyId))).limit(1);
      if (!mission || mission.status !== "active" || typeof agentId !== "string"
        || mission.ownerAgentId !== agentId) return false;
      return await latestIntentEventId(tx, companyId, issueId) === actionId;
    } };
  }
  return null;
}

/** Revision PLAN creates the definition, but board must explicitly choose seed or fresh start. */
export async function ensureOwnerPlanWorkflowRun(input: { db: Db; companyId: string; missionId: string;
  workflowId: string; triggeredBy: string; decisionHash?: string; requirePlanQaPass: () => Promise<void>;
  ownerExecution?: OwnerPlanRunFence }): Promise<string | null> {
  const [existing] = await input.db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, input.companyId),
    eq(workflowRuns.workflowId, input.workflowId), eq(workflowRuns.missionId, input.missionId))).limit(1);
  if (existing) return existing.id;
  const [mission] = await input.db.select().from(missions).where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId)));
  if (mission?.sourceMissionId) return null;
  const fence = input.ownerExecution ?? (input.decisionHash
    ? await deriveOwnerPlanRunFence(input.db, input.companyId, input.missionId, input.decisionHash) : null);
  await input.requirePlanQaPass();
  if (fence && !(await fence.validateIntent(input.db))) throw new Error("owner_plan_start_intent_stale");
  const run = await createWorkflowRun(input.db, input);
  if (fence) await input.db.update(workflowRuns).set({ metadata: { ...((run as { metadata?: Record<string, unknown> }).metadata ?? {}),
    ownerPlanExecution: { actionId: fence.actionId, decisionHash: fence.decisionHash } } }).where(eq(workflowRuns.id, run.id));
  await input.requirePlanQaPass();
  if (fence && !(await fence.validateIntent(input.db))) throw new Error("owner_plan_start_intent_stale");
  await executeWorkflowRun(input.db, run.id);
  return run.id;
}
