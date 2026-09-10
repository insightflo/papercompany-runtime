// server/src/services/missions/mission-workflow-lifecycle.ts
//
// [파일 목적] 네이티브 워크플로 시작 트랜잭션 내에서 planning 미션을 active 로
//   승격하는 단일 원자적 라이프사이클 mutation. executeWorkflowRun() 이 호출.
// [수정시 주의] 부작용 있음(missions/activity_log 갱신). tx 또는 db 모두 허용.
//   paused/completed/cancelled 와 cross-company 는 WHERE 절로 차단됨.
import { activityLog, missions } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

// [Task6d 계약 D — resume 연결 seam]
// resume apply 가 미션을 completed→active 로 재활성시킨 뒤 런타임을 resume 문맥으로 ensure 하는
// 연결은 services/workflow/resume/mission-lifecycle.ts 의 ensureResumeMissionRuntimes 가 담당한다.
// 승인된 apply.ts/dispatcher.ts 를 이 슬라이스에서 수정할 수 없으므로, dispatch 경로 소유 슬라이스가
// 아래 재노출 심볼로 1줄 연결할 수 있게 이 파일(미션↔워크플로 전이 연결점)에 seam 을 두다.
export { ensureResumeMissionRuntimes as ensureMissionRuntimesForResumeReactivation } from "../workflow/resume/mission-lifecycle.js";

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
