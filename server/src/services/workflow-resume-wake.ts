// server/src/services/workflow-resume-wake.ts
//
// [파일 목적] 동일 issue 에 대해 "이미 진행 중인 workflow_resume wake" 가 있는지 찾는
//   단일 source-of-truth 헬퍼. app.ts 와 routes/missions.ts 양쪽에 중복 정의되어 있던
//   것을 한 곳으로 모아 drift 를 막는다.
// [핵심 계약] RES-476 fix — 과거 run 이 성공해 status='completed' 가 된 stale wake 는
//   "이미 처리 중" 으로 보지 않는다(현재 todo 재작업을 덮지 않도록). 오직 in-flight
//   상태(queued/coalesced/deferred_issue_execution) 이고, runId 가 null(아직 run 미생성)
//   이거나 가리키는 heartbeat_runs 이 queued/running 일 때만 live 로 인정한다.
// [외부 연결] app.ts(findExistingWorkflowResumeWake 호출 2곳), routes/missions.ts(1곳),
//   server/src/__tests__/workflow-resume-wake.test.ts.
// [수정시 영향] status 목록이나 liveness 조건을 바꾸면 retry_source_issue /
//   workproduct_reuse wakeup 의 중복 억제 동작이 바뀐다. 두 호출처가 같은 함수를 쓰므로
//   한 번 수정으로 양쪽에 반영된다.
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";

export interface ExistingWorkflowResumeWake {
  id: string;
  runId: string | null;
}

export async function findExistingWorkflowResumeWake(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string },
): Promise<ExistingWorkflowResumeWake | null> {
  return db
    .select({
      id: agentWakeupRequests.id,
      runId: agentWakeupRequests.runId,
    })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId),
      inArray(agentWakeupRequests.reason, ["workflow_step_runnable", "issue_execution_same_name"]),
      // RES-476: "completed" 제거. run 성공으로 종료된 stale wake 는 현재 todo 재작업을
      // 덮으면 안 된다. in-flight 상태만 인정한다.
      inArray(agentWakeupRequests.status, ["queued", "coalesced", "deferred_issue_execution"]),
      sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
      sql`${agentWakeupRequests.payload} ->> 'mutation' = 'workflow_resume'`,
      // liveness guard: runId 가 없거나(아직 run 미생성) 가리키는 run 이 queued/running 일
      // 때만 "진행 중" 으로 인정. terminal run 은 커버하지 않는다.
      sql`(${agentWakeupRequests.runId} is null or exists (select 1 from heartbeat_runs where id = ${agentWakeupRequests.runId} and status in ('queued','running')))`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
