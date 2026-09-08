import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import type { WorkflowRunInput } from "@paperclipai/shared/validators/workflow-run-inputs";

/**
 * [목적] Task 6A 실행 입력(runInputs) 통합 테스트 전용 픽스처. 매 호출마다 새 UUID
 * 회사·활성 claude_local 에이전트·runInputs 선언을 가진 워크플로우 정의를 시드한다.
 * [care] 테스트 전용 헬퍼. 각 테스트가 새 회사를 시드하므로 공유 DB 청소가 필요 없다.
 * 회사 스코프 상태 카운트는 거부(rejection) 전/후 불변 비교의 증거로 쓴다.
 */
export async function seedRunInputWorkflow(
  db: Db,
  runInputs: WorkflowRunInput[],
  schedule?: string,
): Promise<{ companyId: string; workflowId: string; agentId: string }> {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const workflowId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: "Run Input Controls Company",
    issuePrefix: `WRI${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Run Input Agent",
    role: "researcher",
    status: "active",
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(workflowDefinitions).values({
    id: workflowId,
    companyId,
    name: "run-input-workflow",
    status: "active",
    ...(schedule ? { schedule } : {}),
    stepsJson: [
      { id: "collect", name: "Collect", agentId, dependencies: [] },
    ],
    runInputs,
  });

  return { companyId, workflowId, agentId };
}

export type CompanyRunStateCount = {
  missions: number;
  runs: number;
  issues: number;
  stepRuns: number;
  wakeups: number;
};

/**
 * 회사 스코프 상태 스냅샷. 미션·런·이슈는 companyId 직접 필터, 스텝런은 해당 회사
 * 런 ID 경유 조회(runId 스코프 유지). wakeups는 호출부에서 heartbeatWakeup
 * mock.calls.length 로 넣는다(거부된 트리거는 웨이크업을 늘려선 안 된다).
 */
export async function countCompanyRunState(
  db: Db,
  companyId: string,
  wakeupCount: number,
): Promise<CompanyRunStateCount> {
  const [missionRows, runRows, issueRows] = await Promise.all([
    db.select({ id: missions.id }).from(missions).where(eq(missions.companyId, companyId)),
    db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.companyId, companyId)),
    db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId)),
  ]);
  const runIds = runRows.map((run) => run.id);
  const stepRunRows = runIds.length > 0
    ? await db
      .select({ id: workflowStepRuns.id })
      .from(workflowStepRuns)
      .where(inArray(workflowStepRuns.workflowRunId, runIds))
    : [];
  return {
    missions: missionRows.length,
    runs: runRows.length,
    issues: issueRows.length,
    stepRuns: stepRunRows.length,
    wakeups: wakeupCount,
  };
}
