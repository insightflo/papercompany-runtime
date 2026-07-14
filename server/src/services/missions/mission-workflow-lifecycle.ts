// server/src/services/missions/mission-workflow-lifecycle.ts
//
// [파일 목적] 네이티브 워크플로 시작 트랜잭션 내에서 planning 미션을 active 로
//   승격하는 단일 원자적 라이프사이클 mutation. executeWorkflowRun() 이 호출.
// [수정시 주의] 부작용 있음(missions/activity_log 갱신). tx 또는 db 모두 허용.
//   paused/completed/cancelled 와 cross-company 는 WHERE 절로 차단됨.
import { activityLog, missions } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

type TransactionDb = Parameters<Parameters<Db["transaction"]>[0]>[0];
type MissionLifecycleDb = Db | TransactionDb;

export async function activatePlanningMissionForWorkflowRun(
  db: MissionLifecycleDb,
  input: {
    companyId: string;
    missionId: string | null;
    workflowRunId: string;
    startedAt: Date;
  },
): Promise<boolean> {
  if (!input.missionId) return false;

  const [updatedMission] = await db
    .update(missions)
    .set({
      status: "active",
      startedAt: input.startedAt,
      completedAt: null,
      updatedAt: input.startedAt,
    })
    .where(and(
      eq(missions.id, input.missionId),
      eq(missions.companyId, input.companyId),
      eq(missions.status, "planning"),
    ))
    .returning({ id: missions.id });

  if (!updatedMission) return false;

  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: "workflow-dag-engine",
    action: "mission.workflow_started",
    entityType: "mission",
    entityId: updatedMission.id,
    details: {
      workflowRunId: input.workflowRunId,
      previousStatus: "planning",
      nextStatus: "active",
    },
  });
  return true;
}
