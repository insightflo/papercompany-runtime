import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  issues,
  missionAgentRuntimes,
  missionPlanArtifacts,
  missionSessions,
  missions,
  workflowResumeExecutions,
  workflowResumeRequests,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import type { RawSql } from "./workflow-execution-definition-fixture.js";

/**
 * [목적] Task6d mission-resume lifecycle(terminal cleanup fence + resume runtime ensure) 실DB
 *   테스트 픽스처. 승인된 execdef fixture 의 RawSql 타입만 재사용하고 시딩은 raw SQL 로 직접
 *   수행한다. mock DB/트랜잭션/정규화 없음 — 실제 임베디드 PostgreSQL.
 * [불변] process_pid 는 항상 null 로 시딩한다(임의 pid SIGTERM 금지 — terminate 는 attempted=false).
 */

export const LIFECYCLE_STEP_ID = "resume-lifecycle-step";

export type LifecycleMissionGraph = {
  companyId: string;
  ownerAgentId: string;
  assigneeAgentId: string;
  missionId: string;
  workflowId: string;
  runId: string;
  stepRunId: string;
  issueId: string;
  heartbeatRunId: string;
  ownerRuntimeId: string;
  planArtifactId: string;
  missionSessionId: string;
};

export type SeedLifecycleGraphInput = {
  prefix: string;
  missionStatus?: "completed" | "cancelled" | "active";
};

/** company/owner/assignee/mission + active run + step + issue + heartbeat run + busy runtime + active artifact/session. */
export async function seedLifecycleMissionGraph(
  sql: RawSql,
  input: SeedLifecycleGraphInput,
): Promise<LifecycleMissionGraph> {
  const unique = `${input.prefix}-${randomUUID().slice(0, 8)}`;
  const companyId = randomUUID();
  const ownerAgentId = randomUUID();
  const assigneeAgentId = randomUUID();
  const missionId = randomUUID();
  const workflowId = randomUUID();
  const runId = randomUUID();
  const stepRunId = randomUUID();
  const issueId = randomUUID();
  const heartbeatRunId = randomUUID();
  const ownerRuntimeId = randomUUID();
  const planArtifactId = randomUUID();
  const missionStatus = input.missionStatus ?? "completed";
  const nowIso = new Date().toISOString();

  await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, ${"ResumeLifecycle Co " + unique}, ${unique})`;
  await sql`INSERT INTO agents (id, company_id, name) VALUES (${ownerAgentId}, ${companyId}, ${"Owner " + unique})`;
  await sql`INSERT INTO agents (id, company_id, name) VALUES (${assigneeAgentId}, ${companyId}, ${"Assignee " + unique})`;
  await sql`
    INSERT INTO missions (id, company_id, owner_agent_id, title, status, completed_at)
    VALUES (${missionId}, ${companyId}, ${ownerAgentId}, ${"ResumeLifecycle Mission " + unique}, ${missionStatus}, ${missionStatus === "active" ? null : nowIso})
  `;
  await sql`
    INSERT INTO workflow_definitions (id, company_id, name, steps_json)
    VALUES (${workflowId}, ${companyId}, ${"resume-lifecycle-" + unique}, ${JSON.stringify([
      { id: LIFECYCLE_STEP_ID, name: "Resume lifecycle step", type: "agent", agentId: assigneeAgentId, dependencies: [] },
    ])})
  `;
  await sql`
    INSERT INTO workflow_runs (id, workflow_id, company_id, mission_id, status, dispatch_authority_version, triggered_by)
    VALUES (${runId}, ${workflowId}, ${companyId}, ${missionId}, 'running', 1, 'manual')
  `;
  await sql`
    INSERT INTO issues (id, company_id, mission_id, title, status, assignee_agent_id, created_by_agent_id)
    VALUES (${issueId}, ${companyId}, ${missionId}, ${"Resume lifecycle issue " + unique}, 'in_progress', ${assigneeAgentId}, ${ownerAgentId})
  `;
  await sql`
    INSERT INTO workflow_step_runs (id, workflow_run_id, step_id, issue_id, status, execution_generation)
    VALUES (${stepRunId}, ${runId}, ${LIFECYCLE_STEP_ID}, ${issueId}, 'pending', 1)
  `;
  await sql`
    INSERT INTO heartbeat_runs (id, company_id, agent_id, issue_id, status)
    VALUES (${heartbeatRunId}, ${companyId}, ${assigneeAgentId}, ${issueId}, 'running')
  `;
  await sql`
    INSERT INTO mission_agent_runtimes (id, company_id, mission_id, agent_id, adapter_type, runtime_key, status, context_injected_at, state_json)
    VALUES (
      ${ownerRuntimeId}, ${companyId}, ${missionId}, ${ownerAgentId}, 'process',
      ${`company:${companyId}|mission:${missionId}|agent:${ownerAgentId}|adapter:process|workspace:default`},
      'busy', ${nowIso}, ${JSON.stringify({ bootstrapContextInjected: true, workspaceKey: "default" })}
    )
  `;
  await sql`
    INSERT INTO mission_plan_artifacts (id, company_id, mission_id, owner_agent_id, mission_goal, status)
    VALUES (${planArtifactId}, ${companyId}, ${missionId}, ${ownerAgentId}, ${"Goal " + unique}, 'active')
  `;
  const secretId = randomUUID();
  const missionSessionId = randomUUID();
  await sql`INSERT INTO company_secrets (id, company_id, name) VALUES (${secretId}, ${companyId}, ${"secret " + unique})`;
  await sql`
    INSERT INTO mission_sessions (id, mission_id, agent_id, company_id, session_secret_id, adapter_type, status)
    VALUES (${missionSessionId}, ${missionId}, ${ownerAgentId}, ${companyId}, ${secretId}, 'process', 'active')
  `;
  return {
    companyId, ownerAgentId, assigneeAgentId, missionId, workflowId, runId,
    stepRunId, issueId, heartbeatRunId, ownerRuntimeId, planArtifactId, missionSessionId,
  };
}

export type ResumeApplySimulation = {
  requestId: string;
  requestState: "pending_delivery" | "accepted" | "blocked" | "cancelled";
  executionState: "queued" | "running" | "completed" | "blocked" | "cancelled";
  reactivateMission: boolean;
};

/** resume apply 흔을 재현: run/step 스탬프 + 요청/실행 행 + (옵션) 미션 재활성. */
export async function simulateResumeApply(
  db: Db,
  graph: LifecycleMissionGraph,
  input: ResumeApplySimulation,
): Promise<void> {
  await db.update(workflowRuns).set({
    status: "running",
    completedAt: null,
    dispatchAuthorityVersion: 2,
    metadata: { resumeRequestId: input.requestId, resumeAuthorityVersion: 2, resumeEpoch: 1 },
  }).where(and(
    eq(workflowRuns.id, graph.runId),
    eq(workflowRuns.companyId, graph.companyId),
    eq(workflowRuns.missionId, graph.missionId),
  ));
  await db.update(workflowStepRuns).set({
    metadata: { resumeRequestId: input.requestId },
  }).where(eq(workflowStepRuns.id, graph.stepRunId));
  await db.insert(workflowResumeRequests).values({
    id: input.requestId,
    companyId: graph.companyId,
    missionId: graph.missionId,
    workflowRunId: graph.runId,
    idempotencyKey: randomUUID(),
    requestHash: "hash-request",
    snapshotHash: "hash-snapshot",
    definitionHash: "hash-definition",
    requestBody: {},
    beforeState: {},
    appliedGenerations: { [LIFECYCLE_STEP_ID]: 1 },
    state: input.requestState,
  });
  await db.insert(workflowResumeExecutions).values({
    requestId: input.requestId,
    companyId: graph.companyId,
    missionId: graph.missionId,
    workflowRunId: graph.runId,
    authorityVersion: 2,
    generations: { [LIFECYCLE_STEP_ID]: 1 },
    state: input.executionState,
  });
  if (input.reactivateMission) {
    await db.update(missions).set({
      status: "active",
      completedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(missions.id, graph.missionId),
      eq(missions.companyId, graph.companyId),
    ));
  }
}

/** 런타임 행 readback. */
export async function readRuntimeRow(db: Db, runtimeId: string) {
  const [row] = await db.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.id, runtimeId)).limit(1);
  return row ?? null;
}

export async function readIssueStatus(db: Db, issueId: string): Promise<string | null> {
  const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).limit(1);
  return row?.status ?? null;
}

export async function readHeartbeatRunStatus(db: Db, runId: string): Promise<string | null> {
  const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1);
  return row?.status ?? null;
}

export async function readPlanArtifactStatus(db: Db, artifactId: string): Promise<string | null> {
  const [row] = await db.select({ status: missionPlanArtifacts.status }).from(missionPlanArtifacts).where(eq(missionPlanArtifacts.id, artifactId)).limit(1);
  return row?.status ?? null;
}

export async function readMissionSessionStatus(db: Db, sessionId: string): Promise<string | null> {
  const [row] = await db.select({ status: missionSessions.status }).from(missionSessions).where(eq(missionSessions.id, sessionId)).limit(1);
  return row?.status ?? null;
}

/** caller(caller의 update 선행 쓰기)가 이미 미션 행을 터미널 상태로 바꿨다는 흉내. */
export async function setMissionStatus(db: Db, graph: LifecycleMissionGraph, status: "completed" | "cancelled"): Promise<void> {
  await db.update(missions).set({ status, updatedAt: new Date() }).where(and(
    eq(missions.id, graph.missionId),
    eq(missions.companyId, graph.companyId),
  ));
}
