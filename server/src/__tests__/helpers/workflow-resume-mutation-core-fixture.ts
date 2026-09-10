import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  issues,
  workflowDelegations,
  workflowResumeExecutions,
  workflowResumeRequests,
  workflowStepRuns,
} from "@paperclipai/db";

type WorkflowStepRunsInsert = typeof workflowStepRuns.$inferInsert;
type WorkflowDelegationsInsert = typeof workflowDelegations.$inferInsert;
type WorkflowResumeRequestsInsert = typeof workflowResumeRequests.$inferInsert;
type WorkflowResumeExecutionsInsert = typeof workflowResumeExecutions.$inferInsert;
import {
  seedCompanyWithMission,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./workflow-execution-definition-fixture.js";

/**
 * [목적] Task6a resume mutation core(serialization/reset/acceptance) 실DB 테스트 픽스처.
 *   승인된 기존 헬퍼(workflow-execution-definition-fixture)를 import 로만 재사용(수정 금지)하고
 *   실제 임베디드 PostgreSQL 위에 run/step_run/issue/delegation/resume 요청·실행 행을 시딩하는
 *   최소 조립기만 추가한다. mock DB/트랜잭션/정규화 없음. UUID 는 randomUUID/DB default 만 사용.
 */

export type MutationCoreFixtureDb = {
  connectionString: string;
  db: Db;
  sql: RawSql;
  openConnection(): Db;
  openRawConnection(): RawSql;
  cleanup(): Promise<void>;
};

export type MutationCoreFixture =
  | { supported: false; reason: string }
  | ({ supported: true } & MutationCoreFixtureDb);

export async function startMutationCoreFixture(testName: string): Promise<MutationCoreFixture> {
  const base: ExecutionDefinitionFixture = await startExecutionDefinitionFixture(testName);
  if (!base.supported) return base;
  return {
    supported: true,
    connectionString: base.connectionString,
    db: base.db,
    sql: base.sql,
    openConnection: base.openConnection,
    openRawConnection: base.openRawConnection,
    cleanup: base.cleanup,
  };
}

export interface MutationCoreGraph {
  companyId: string;
  agentId: string;
  missionId: string;
  workflowId: string;
  runId: string;
}

let mutationCoreGraphCounter = 0;

/** company/agent/mission + definition + running run (metadata 없는 기본 run). */
export async function seedMutationCoreGraph(sql: RawSql, prefix: string): Promise<MutationCoreGraph> {
  // companies_issue_prefix_idx (unique, issue_prefix TEXT, 최대 길이 없음) 위반 방지:
  // 한 DB 에서 같은 prefix 로 여러 graph 를 시딩하므로 호출마다 고유 suffix 를 붙인다.
  mutationCoreGraphCounter += 1;
  const uniquePrefix = `${prefix}-${mutationCoreGraphCounter.toString(36)}-${randomUUID().slice(0, 8)}`;
  const { companyId, agentId, missionId } = await seedCompanyWithMission(sql, uniquePrefix);
  const workflowId = await seedWorkflowDefinition(sql, {
    companyId,
    name: `mutation-core-${uniquePrefix}`,
    stepsJson: [{ id: "resume-core-step", name: "Resume core step", agentId: "agent-1" }],
  });
  const runId = await seedWorkflowRun(sql, {
    workflowId,
    companyId,
    missionId,
    status: "running",
    startedAt: new Date("2026-09-07T09:00:00.000Z"),
  });
  return { companyId, agentId, missionId, workflowId, runId };
}

/** 같은 company 의 보조 run(외부 run/row 보존 검증용). */
export async function seedMutationCoreOtherRun(
  sql: RawSql,
  graph: MutationCoreGraph,
  prefix: string,
): Promise<string> {
  const workflowId = await seedWorkflowDefinition(sql, {
    companyId: graph.companyId,
    name: `mutation-core-other-${prefix}`,
  });
  return seedWorkflowRun(sql, {
    workflowId,
    companyId: graph.companyId,
    missionId: graph.missionId,
    status: "running",
  });
}

export async function seedMutationCoreIssue(
  db: Db,
  input: { companyId: string; missionId?: string | null; title?: string },
): Promise<string> {
  const [row] = await db.insert(issues).values({
    id: randomUUID(),
    companyId: input.companyId,
    ...(input.missionId ? { missionId: input.missionId } : {}),
    title: input.title ?? "Mutation core issue",
    status: "in_progress",
    originKind: "workflow_execution",
  }).returning();
  return row!.id;
}

/** 전체 컬럼을 values override 로 제어하는 step_run 시딩 — 완성된 select row 반환. */
export async function seedMutationCoreStepRun(
  db: Db,
  input: { runId: string; stepId: string; values?: Partial<WorkflowStepRunsInsert> },
) {
  const [row] = await db.insert(workflowStepRuns).values({
    workflowRunId: input.runId,
    stepId: input.stepId,
    ...input.values,
  }).returning();
  return row!;
}

export async function seedMutationCoreDelegation(
  db: Db,
  input: Partial<WorkflowDelegationsInsert> & {
    sourceCompanyId: string;
    sourceWorkflowRunId: string;
    sourceWorkflowStepRunId: string;
    targetCompanyId: string;
    targetIssueId: string;
  },
) {
  const [row] = await db.insert(workflowDelegations).values(input).returning();
  return row!;
}

export async function loadMutationCoreStepRun(sql: RawSql, id: string) {
  const rows = await sql`SELECT * FROM workflow_step_runs WHERE id = ${id}`;
  return rows[0] as Record<string, unknown> | undefined;
}

export async function loadMutationCoreTransitionEvents(sql: RawSql, idempotencyKey: string) {
  const rows = await sql`
    SELECT * FROM workflow_transition_events WHERE idempotency_key = ${idempotencyKey}
  `;
  return rows as Array<Record<string, unknown>>;
}

export async function insertMutationCoreResumeRequest(
  db: Db,
  input: Partial<WorkflowResumeRequestsInsert> & {
    companyId: string;
    missionId: string;
    workflowRunId: string;
  },
) {
  const [row] = await db.insert(workflowResumeRequests).values({
    idempotencyKey: randomUUID(),
    requestHash: "r".repeat(64),
    snapshotHash: "s".repeat(64),
    definitionHash: "d".repeat(64),
    requestBody: {},
    beforeState: {},
    appliedGenerations: {},
    ...input,
  }).returning();
  return row!;
}

export async function insertMutationCoreResumeExecution(
  db: Db,
  input: Partial<WorkflowResumeExecutionsInsert> & {
    requestId: string;
    companyId: string;
    missionId: string;
    workflowRunId: string;
  },
) {
  const [row] = await db.insert(workflowResumeExecutions).values(input).returning();
  return row!;
}
