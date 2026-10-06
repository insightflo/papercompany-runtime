import { and, eq } from "drizzle-orm";
import { missions, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { assertAgentReplacementRequired, type TriggerActor } from "./replacement-admission.js";
import { createWorkflowRun } from "./workflow-store.js";
import { assertSeedActor, createSeededWorkflowRun } from "./workflow-seed-admission.js";
import type { CreateWorkflowRunInput } from "./types.js";
import { assertRevisionBoardStart } from "./revision-run-admission.js";
import { assertWorkflowToolReadinessForDefinition } from "./admission-tool-readiness.js";
import { lockMissionPlanQaAuthority } from "../missions/plan-qa-admission-lock.js";

export async function createAdmittedWorkflowRun(db: Db, input: CreateWorkflowRunInput, actor?: TriggerActor) {
  assertSeedActor(input, actor);
  await assertRevisionBoardStart(db, input, actor);
  if (input.metadata && ("replacementAuthorityId" in input.metadata || "executionDefinitionVersion" in input.metadata)) throw conflict("workflow_reserved_metadata");
  if (input.missionId) return db.transaction(async tx => {
    const t = tx as unknown as Db;
    const [mission] = await tx.select().from(missions).where(and(eq(missions.id, input.missionId!), eq(missions.companyId, input.companyId))).for("update");
    if ((actor?.type === "agent" || mission?.sourceMissionId) && (!mission || mission.status === "cancelled")) throw conflict("workflow_mission_cancelled");
    if (mission?.sourceMissionId) await lockMissionPlanQaAuthority(t, input.companyId, mission.id);
    await assertRevisionBoardStart(t, input, actor);
    // [Q7 시작 승인 도구 권한 재검사] 미션 잠금 트랜잭션 안, seed/일반 생성 분기 직전에 현재 정의
    //   기준 도구 준비성(등록·활성·담당 grant·구조 게이트)을 잠금 하의 같은 스냅샷으로 다시 검사한다.
    //   승인 시점 통과 후 도구 삭제·grant 철회가 있었으면 생성을 거절한다(실행 0건 — 롤백/미생성).
    //   engine.trigger 의 트랜잭션 밖 사전 검사와 입장 트랜잭션 사이 TOCTOU 구멍을 막는다.
    await assertWorkflowToolReadinessForDefinition(t, { companyId: input.companyId, workflowId: input.workflowId });
    if (input.seedFromRun) return createSeededWorkflowRun(t, input, actor);
    if (actor?.type === "agent") await assertAgentReplacementRequired(t, input, actor);
    return createWorkflowRun(t, input);
  });
  if (input.seedFromRun) return createSeededWorkflowRun(db, input, actor);
  return createWorkflowRun(db, input);
}
