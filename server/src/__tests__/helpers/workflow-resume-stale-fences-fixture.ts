import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, issues, workflowResumeExecutions, workflowResumeRequests, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import {
  seedCompanyWithMission,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./workflow-execution-definition-fixture.js";
import { captureExecutionDefinition } from "../../services/workflow/execution-definition.js";

/**
 * [파일 목적] Task6c stale-generation result fence 실DB 테스트 픽스처.
 *   승인된 기존 fixture(workflow-execution-definition-fixture)를 import 로만 재사용(수정 금지)하고,
 *   resume stamp run/step_run/issue/heartbeat run/wakeup 행을 실제 임베디드 PostgreSQL 위에
 *   시딩하는 최소 조립기만 추가한다. mock DB/트랜잭션/엔진 없음 — UUID 는 randomUUID/DB default.
 * [stamp 규약] resumeRequestId 는 resume/apply.ts(reset.ts) 와 동일하게 run.metadata 와
 *   step_run.metadata 의 own non-null string key 로만 판정한다(prototype key 허용 안 함).
 * [Task5a1 계약] resume run 은 executionDefinitionVersion 마커 run 이므로 run 생성 스냅샷이
 *   필수다 — pending 마커 run 으로 captureExecutionDefinition 을 1회 실행한 뒤 running 으로
 *   전이하고 resume stamp 을 metadata 에 얹는다(프로덕션 apply.ts 와 동일한 순서).
 */

export type FenceFixture = ExecutionDefinitionFixture;

export async function startFenceFixture(testName: string): Promise<FenceFixture> {
  return startExecutionDefinitionFixture(testName);
}

export interface FenceGraph {
  companyId: string;
  agentId: string;
  missionId: string;
  workflowId: string;
  runId: string;
}

let fenceGraphCounter = 0;

/** company/agent/mission + definition(agent 1 step) + 실행정의 스냅샷 캡처 후 running run. */
export async function seedFenceGraph(
  db: Db,
  prefix: string,
  options: { runMetadata?: Record<string, unknown> } = {},
): Promise<FenceGraph> {
  fenceGraphCounter += 1;
  const uniquePrefix = `${prefix}-${fenceGraphCounter.toString(36)}-${randomUUID().slice(0, 8)}`;
  const { companyId, agentId, missionId } = await seedCompanyWithMission(db.$client, uniquePrefix);
  const workflowId = await seedWorkflowDefinition(db.$client, {
    companyId,
    name: `stale-fence-${uniquePrefix}`,
    stepsJson: [{ id: "fence-step", name: "Fence step", agentId: "agent-1" }],
  });
  const runId = await db.$client`
    INSERT INTO workflow_runs (id, workflow_id, company_id, mission_id, status, triggered_by, metadata, started_at)
    VALUES (
      ${randomUUID()}, ${workflowId}, ${companyId}, ${missionId},
      'pending', 'task6c', ${JSON.stringify({ executionDefinitionVersion: 1 })}, null
    )
    RETURNING id
  `.then((rows) => (rows[0] as { id: string }).id);
  await db.transaction(async (tx) => {
    await captureExecutionDefinition(tx, runId);
  });
  await db.update(workflowRuns).set({
    status: "running",
    startedAt: new Date("2026-09-09T01:00:00.000Z"),
    metadata: { executionDefinitionVersion: 1, ...(options.runMetadata ?? {}) },
  }).where(eq(workflowRuns.id, runId));
  return { companyId, agentId, missionId, workflowId, runId };
}

/** run metadata 를 통째로 교체한다(resume stamp 부여/제어). */
export async function setFenceRunMetadata(
  db: Db,
  runId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db.update(workflowRuns).set({ metadata }).where(eq(workflowRuns.id, runId));
}

/** accepted resume 계약(request+execution+run stamp/authority)을 시딩한다 — assertResumeAccepted 통과 형태. */
export async function seedAcceptedResumeContract(
  db: Db,
  input: {
    graph: FenceGraph;
    resumeRequestId: string;
    authorityVersion: number;
    appliedGenerations: Record<string, number>;
    executionState?: "queued" | "running" | "completed";
  },
): Promise<void> {
  await db.update(workflowRuns).set({
    dispatchAuthorityVersion: input.authorityVersion,
    metadata: {
      executionDefinitionVersion: 1,
      resumeRequestId: input.resumeRequestId,
      resumeAuthorityVersion: input.authorityVersion,
      resumeEpoch: input.authorityVersion,
    },
  }).where(eq(workflowRuns.id, input.graph.runId));
  await db.insert(workflowResumeRequests).values({
    id: input.resumeRequestId,
    companyId: input.graph.companyId,
    missionId: input.graph.missionId,
    workflowRunId: input.graph.runId,
    idempotencyKey: randomUUID(),
    requestHash: "r".repeat(64),
    snapshotHash: "s".repeat(64),
    definitionHash: "d".repeat(64),
    requestBody: {},
    beforeState: {},
    appliedGenerations: input.appliedGenerations,
    state: "accepted",
    acceptedAt: new Date("2026-09-09T01:30:00.000Z"),
  });
  await db.insert(workflowResumeExecutions).values({
    requestId: input.resumeRequestId,
    companyId: input.graph.companyId,
    missionId: input.graph.missionId,
    workflowRunId: input.graph.runId,
    authorityVersion: input.authorityVersion,
    generations: input.appliedGenerations,
    state: input.executionState ?? "running",
  });
}

/** 전체 컬럼을 values override 로 제어하는 step_run 시딩 — 완성된 select row 반환. */
export async function seedFenceStepRun(
  db: Db,
  input: { runId: string; stepId?: string; values?: Partial<typeof workflowStepRuns.$inferInsert> },
) {
  const [row] = await db.insert(workflowStepRuns).values({
    workflowRunId: input.runId,
    stepId: input.stepId ?? "fence-step",
    ...input.values,
  }).returning();
  return row!;
}

export async function seedFenceIssue(
  db: Db,
  input: { companyId: string; missionId?: string | null; title?: string },
): Promise<string> {
  const [row] = await db.insert(issues).values({
    id: randomUUID(),
    companyId: input.companyId,
    ...(input.missionId ? { missionId: input.missionId } : {}),
    title: input.title ?? "Stale fence issue",
    status: "in_progress",
    originKind: "workflow_execution",
  }).returning();
  return row!.id;
}

export async function seedFenceHeartbeatRun(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId?: string | null;
    workflowStepRunId?: string | null;
    workflowExecutionGeneration?: number | null;
    wakeupRequestId?: string | null;
    contextSnapshot?: Record<string, unknown> | null;
    status?: string;
  },
) {
  const [row] = await db.insert(heartbeatRuns).values({
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId ?? null,
    invocationSource: "automation",
    status: input.status ?? "succeeded",
    workflowStepRunId: input.workflowStepRunId ?? null,
    workflowExecutionGeneration: input.workflowExecutionGeneration ?? null,
    wakeupRequestId: input.wakeupRequestId ?? null,
    contextSnapshot: input.contextSnapshot ?? null,
  }).returning();
  return row!;
}

export async function seedFenceWakeup(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId?: string | null;
    missionId?: string | null;
    workflowRunId?: string | null;
    workflowStepRunId?: string | null;
    workflowExecutionGeneration?: number | null;
  },
) {
  const [row] = await db.insert(agentWakeupRequests).values({
    companyId: input.companyId,
    agentId: input.agentId,
    source: "workflow",
    reason: "workflow_step_runnable",
    issueId: input.issueId ?? null,
    missionId: input.missionId ?? null,
    workflowRunId: input.workflowRunId ?? null,
    workflowStepRunId: input.workflowStepRunId ?? null,
    workflowExecutionGeneration: input.workflowExecutionGeneration ?? null,
  }).returning();
  return row!;
}

export async function loadFenceStepRun(sql: RawSql, id: string) {
  const rows = await sql`SELECT * FROM workflow_step_runs WHERE id = ${id}`;
  return rows[0] as Record<string, unknown> | undefined;
}

export async function loadFenceIssue(sql: RawSql, id: string) {
  const rows = await sql`SELECT * FROM issues WHERE id = ${id}`;
  return rows[0] as Record<string, unknown> | undefined;
}

export async function countFenceTransitionEvents(sql: RawSql, stepRunId: string): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS count FROM workflow_transition_events WHERE workflow_step_run_id = ${stepRunId}`;
  return (rows[0] as { count: number }).count;
}

export async function loadFenceActivityLog(sql: RawSql, action: string) {
  return await sql`SELECT * FROM activity_log WHERE action = ${action} ORDER BY created_at ASC` as Array<Record<string, unknown>>;
}

export async function countFenceWorkProducts(sql: RawSql, issueId: string): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS count FROM issue_work_products WHERE issue_id = ${issueId}`;
  return (rows[0] as { count: number }).count;
}
