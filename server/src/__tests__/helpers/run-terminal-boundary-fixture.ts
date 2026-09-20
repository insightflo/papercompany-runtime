// helpers/run-terminal-boundary-fixture.ts
//
// [목적] run-terminal-boundary 통합 테스트 픽스처. 임베디드 PG 위에 company/mission/run/
//   stepRun/이슈 채널을 시딩한다. auto-reconcile 테스트의 인라인 시딩 패턴을 그대로 따른다.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  heartbeatRuns,
  issueComments,
  issues,
  missionAgentRuntimes,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTerminalDecisions,
  workflowRecoveryAuthorities,
  workflowTerminalEffectIntents,
  type Db,
} from "@paperclipai/db";

/** FK 역순 전체 삭제 — 각 테스트 DB 는 임시(임베디드 PG)라 전체 비움이 안전하다. */
export async function cleanupTerminalBoundaryTables(db: Db): Promise<void> {
  // recovery 권한이 결정을 FK 참조 — 결정 삭제보다 먼저 지운다.
  await db.delete(workflowRecoveryAuthorities);
  await db.delete(workflowTerminalEffectIntents);
  await db.delete(workflowTerminalDecisions);
  await db.delete(issueComments);
  await db.delete(missionAgentRuntimes);
  // heartbeat_runs.wakeup_request_id → agent_wakeup_requests FK 때문에 heartbeat 를 먼저 삭제한다.
  await db.delete(heartbeatRuns);
  await db.delete(agentWakeupRequests);
  await db.delete(workflowStepRuns);
  await db.delete(workflowRuns);
  await db.delete(workflowDefinitions);
  await db.delete(issues);
  await db.delete(missions);
  await db.delete(agents);
  await db.delete(companies);
}

export interface BoundaryWorld {
  companyId: string;
  agentId: string;
  missionId: string;
  workflowId: string;
  runId: string;
  stepRunId: string;
  stepIssueId: string;
}

export async function seedBoundaryWorld(
  db: Db,
  options?: { runStatus?: string; stepRunMetadata?: Record<string, unknown>; stepIssueStatus?: string },
): Promise<BoundaryWorld> {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  const workflowId = randomUUID();
  const runId = randomUUID();
  const stepIssueId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Terminal Boundary Co",
    issuePrefix: `TB${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId, companyId, name: "Boundary Worker", role: "engineer",
    status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
  });
  await db.insert(missions).values({
    id: missionId, companyId, ownerAgentId: agentId, title: "Boundary mission",
    status: "active", startedAt: new Date(),
  });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "boundary-wf", stepsJson: [] });
  // dispatchAuthorityVersion 은 컬럼 기본값 0 — 호출자 expectedAuthorityVersion 0 과 대응.
  await db.insert(workflowRuns).values({
    id: runId, workflowId, companyId, missionId,
    status: options?.runStatus ?? "running", triggeredBy: "test", startedAt: new Date(),
  });
  await db.insert(issues).values({
    id: stepIssueId, companyId, missionId, identifier: `TB-${randomUUID().slice(0, 6)}`,
    title: "Boundary step issue", status: options?.stepIssueStatus ?? "in_progress",
    originKind: "workflow_execution", originId: runId,
  });
  const [stepRun] = await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: "step-a", status: "running", issueId: stepIssueId,
    metadata: options?.stepRunMetadata ?? {},
  }).returning();
  return { companyId, agentId, missionId, workflowId, runId, stepRunId: stepRun!.id, stepIssueId };
}

/** finalize 입력의 stepRuns 참조 — 시딩된 stepRun 과 동일 모양을 유지한다. */
export function stepRunsOf(world: BoundaryWorld, metadata: Record<string, unknown> = {}) {
  return [{
    id: world.stepRunId,
    stepId: "step-a",
    issueId: world.stepIssueId,
    status: "running",
    metadata,
  }];
}

export async function seedUnblockIssue(db: Db, world: BoundaryWorld, status = "open"): Promise<string> {
  const id = randomUUID();
  await db.insert(issues).values({
    id, companyId: world.companyId, missionId: world.missionId,
    identifier: `TB-${randomUUID().slice(0, 6)}`, title: "Unblock owner action",
    status, originKind: "mission_main_executor_unblock", originId: world.stepIssueId,
  });
  return id;
}

export async function seedHeartbeatRun(
  db: Db,
  world: BoundaryWorld,
  options?: { status?: string; terminalOutcome?: string | null },
): Promise<string> {
  const id = randomUUID();
  await db.insert(heartbeatRuns).values({
    id, companyId: world.companyId, agentId: world.agentId, issueId: world.stepIssueId,
    status: options?.status ?? "queued", invocationSource: "assignment",
    terminalOutcome: options?.terminalOutcome ?? null,
  });
  return id;
}

export async function seedLinkedWakeupRequest(db: Db, world: BoundaryWorld, heartbeatRunId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(agentWakeupRequests).values({
    id, companyId: world.companyId, agentId: world.agentId,
    source: "test", status: "queued", runId: heartbeatRunId,
  });
  // bounded settlement 가 heartbeat_runs.wakeupRequestId 링크로 wakeup 을 찾는다(원본 패턴).
  await db.update(heartbeatRuns).set({ wakeupRequestId: id }).where(eq(heartbeatRuns.id, heartbeatRunId));
  return id;
}

export async function seedMissionRuntime(db: Db, world: BoundaryWorld): Promise<string> {
  const id = randomUUID();
  await db.insert(missionAgentRuntimes).values({
    id, companyId: world.companyId, missionId: world.missionId, agentId: world.agentId,
    adapterType: "codex_local", runtimeKey: `rt-${randomUUID().slice(0, 8)}`,
    status: "busy", queueDepth: 1, currentIssueId: world.stepIssueId,
  });
  return id;
}

export function retryMetadata(state: string, retryNumber: number, maxRetries: number, nextEligibleAt: string) {
  return {
    workflowRetry: {
      state, retryNumber, maxRetries, nextEligibleAt,
      sourceRequestId: null, sourceCompletedAt: null, lastErrorSummary: null,
    },
  };
}

export function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}
