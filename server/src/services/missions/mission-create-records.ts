// server/src/services/missions/mission-create-records.ts
//
// [purpose] T3 §2 정식 기록·감사 추출. mission/missionAgents 행 생성의 DB 전용 코어.
//   부작용(working.md provisioning·이벤트)이 없어 정식 생성 트랜잭션 안에서 쓸 수 있다.
//   기존 missionService.create() 는 같은 함수를 재사용한다(의미 불변 — fs 준비는 커밋 후).

import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, missionAgents, missions } from "@paperclipai/db";
import type { WorkflowDefinition } from "../workflow/types.js";

export type MissionWriteDb = Pick<Db, "insert" | "select">;

/** mission 행 생성. 상태·제목·설명은 호출자가 명시적으로 준다(기본 상태 없음). */
export async function createMissionRecord(
  dbOrTx: MissionWriteDb,
  input: {
    companyId: string;
    ownerAgentId: string;
    title: string;
    description: string | null;
    projectId: string | null;
    goalId: string | null;
    status: string;
  },
): Promise<typeof missions.$inferSelect> {
  const [mission] = await dbOrTx
    .insert(missions)
    .values({
      companyId: input.companyId,
      ownerAgentId: input.ownerAgentId,
      title: input.title,
      description: input.description,
      goalId: input.goalId,
      projectId: input.projectId,
      status: input.status,
    })
    .returning();
  return mission!;
}

/** mission_agents 행 추가. role 제약(executor/reviewer/observer)은 DB 가 강제한다. */
export async function addMissionAgentRecord(
  dbOrTx: MissionWriteDb,
  input: { missionId: string; agentId: string; role: "executor" | "reviewer" | "observer"; skipDuplicate?: boolean },
): Promise<void> {
  const query = dbOrTx.insert(missionAgents).values({
    missionId: input.missionId,
    agentId: input.agentId,
    role: input.role,
  });
  if (input.skipDuplicate) {
    await query.onConflictDoNothing();
    return;
  }
  await query;
}

/**
 * workflow 실행용 mission 소유 에이전트 해석(T3 §2 추출, 의미 불변): 정의 step 의 첫 지정
 * 에이전트 → 없으면 회사의 승인/종료 제외 최창조 에이전트. 후보 없음은 기존 오류 그대로.
 */
export async function resolveWorkflowMissionOwnerAgentId(
  db: Db,
  companyId: string,
  workflow: WorkflowDefinition,
): Promise<string> {
  const stepAgentId = workflow.steps.find((step) => typeof step.agentId === "string" && step.agentId.trim())?.agentId;
  if (stepAgentId) return stepAgentId;

  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      ne(agents.status, "terminated"),
      ne(agents.status, "pending_approval"),
    ))
    .orderBy(asc(agents.createdAt))
    .limit(1);

  if (!agent) {
    throw new Error("Cannot create workflow mission: no agent exists for company");
  }
  return agent.id;
}
