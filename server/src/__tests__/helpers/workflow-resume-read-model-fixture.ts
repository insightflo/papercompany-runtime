import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  missions,
  workflowDelegations,
  workflowRunDefinitions,
  workflowRuns,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import {
  captureHttpError,
  readSnapshotRow,
} from "./workflow-execution-definition-fixture.js";
import {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  createFrozenRun,
  editLiveDefinition,
  loadCapturedDefinition,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./workflow-frozen-execution-fixture.js";

/**
 * [목적] Task5c2a scoped read-model 테스트 픽스처. 승인된 5a1/5a2a 헬퍼를 import 로만
 *   재사용(수정 금지)하고, 실제 임베디드 PostgreSQL 위에 frozen run + step/issue/wakeup/
 *   heartbeat/delegation 이력을 시딩하는 최소 조립기만 추가한다. mock DB/loader/해시 없음.
 *   모든 UUID id 는 randomUUID 또는 DB defaultRandom — Math.random slice 금지(과거 flake 원인).
 */

export {
  captureHttpError,
  cleanupFrozenTables,
  corruptSnapshotSteps,
  createFrozenRun,
  editLiveDefinition,
  loadCapturedDefinition,
  readSnapshotRow,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
};
export type { ExecutionDefinitionFixture, RawSql };

/** frozen 캡처에 들어갈 2-step 정의. 실제 step id 집합의 authority 는 캡처 결과다
 *  (normalize/delivery-gate 로 id 가 늘어날 수 있으므로 테스트는 캡처된 id 를 사용한다). */
export const READ_MODEL_STEPS_JSON = [
  { id: "resume-step-a", name: "Resume step A", agentId: "", dependencies: [], tools: ["resume-test-tool"], toolArgs: {} },
  { id: "resume-step-b", name: "Resume step B", agentId: "agent-1", dependencies: ["resume-step-a"] },
];

export interface ReadModelGraph {
  companyId: string;
  agentId: string;
  missionId: string;
  workflowId: string;
  runId: string;
  definitionStepIds: string[];
}

/** company/agent/mission + 2-step definition + 실제 frozen run(createWorkflowRun 캡처). */
export async function seedReadModelGraph(sql: RawSql, db: Db): Promise<ReadModelGraph> {
  const { companyId, agentId, missionId } = await seedCompanyWithMission(
    sql,
    "RM" + randomUUID().slice(0, 8),
  );
  const workflowId = await seedWorkflowDefinition(sql, {
    companyId,
    name: "read-model-workflow",
    stepsJson: READ_MODEL_STEPS_JSON,
  });
  const run = await createFrozenRun(db, { workflowId, companyId, missionId });
  const captured = await loadCapturedDefinition(db, run.id);
  return {
    companyId,
    agentId,
    missionId,
    workflowId,
    runId: run.id,
    definitionStepIds: captured.steps.map((step) => step.id),
  };
}

/** 같은 company 안의 보조 mission(다른-mission 오염/오류 경로 테스트용). */
export async function seedAdditionalMission(sql: RawSql, companyId: string, agentId: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO missions (id, company_id, owner_agent_id, title)
    VALUES (${id}, ${companyId}, ${agentId}, ${"Read model other mission " + id.slice(0, 8)})`;
  return id;
}

export function readModelScope(
  graph: ReadModelGraph,
  startStepId?: string,
): { companyId: string; missionId: string; workflowRunId: string; startStepId: string } {
  return {
    companyId: graph.companyId,
    missionId: graph.missionId,
    workflowRunId: graph.runId,
    startStepId: startStepId ?? graph.definitionStepIds[0]!,
  };
}

export async function seedReadModelStepRun(
  db: Db,
  input: {
    runId: string;
    stepId: string;
    issueId?: string | null;
    status?: string;
    executionGeneration?: number;
    startedAt?: Date | null;
    completedAt?: Date | null;
    lastDispatchRequestId?: string | null;
    dispatchOwnerWakeupRequestId?: string | null;
    dispatchOwnerHeartbeatRunId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const [row] = await db.insert(workflowStepRuns).values({
    workflowRunId: input.runId,
    stepId: input.stepId,
    status: input.status ?? "pending",
    ...(input.issueId ? { issueId: input.issueId } : {}),
    ...(input.executionGeneration !== undefined ? { executionGeneration: input.executionGeneration } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    ...(input.lastDispatchRequestId !== undefined ? { lastDispatchRequestId: input.lastDispatchRequestId } : {}),
    ...(input.dispatchOwnerWakeupRequestId !== undefined
      ? { dispatchOwnerWakeupRequestId: input.dispatchOwnerWakeupRequestId }
      : {}),
    ...(input.dispatchOwnerHeartbeatRunId !== undefined
      ? { dispatchOwnerHeartbeatRunId: input.dispatchOwnerHeartbeatRunId }
      : {}),
    metadata: input.metadata ?? {},
  }).returning();
  return row!.id;
}

export async function seedReadModelIssue(
  db: Db,
  input: {
    companyId: string;
    missionId?: string | null;
    title?: string;
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  },
): Promise<string> {
  const [row] = await db.insert(issues).values({
    id: randomUUID(),
    companyId: input.companyId,
    ...(input.missionId ? { missionId: input.missionId } : {}),
    title: input.title ?? "Read model issue",
    status: "in_progress",
    originKind: "workflow_execution",
    ...(input.checkoutRunId ? { checkoutRunId: input.checkoutRunId } : {}),
    ...(input.executionRunId ? { executionRunId: input.executionRunId } : {}),
  }).returning();
  return row!.id;
}

export async function seedReadModelWakeup(
  db: Db,
  input: {
    id?: string;
    companyId: string;
    agentId: string;
    status?: string;
    issueId?: string | null;
    missionId?: string | null;
    workflowRunId?: string | null;
    workflowStepRunId?: string | null;
    workflowExecutionGeneration?: number | null;
  },
): Promise<string> {
  const executionGeneration = input.workflowExecutionGeneration;
  const [row] = await db.insert(agentWakeupRequests).values({
    ...(input.id ? { id: input.id } : {}),
    companyId: input.companyId,
    agentId: input.agentId,
    source: "read-model-test",
    reason: "read-model-test",
    status: input.status ?? "queued",
    ...(input.issueId ? { issueId: input.issueId } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {}),
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.workflowStepRunId ? { workflowStepRunId: input.workflowStepRunId } : {}),
    // explicit 0 도 유실하지 않는다 — truthiness 가 아니라 undefined 여부로 판정(null 허용).
    ...(executionGeneration !== undefined ? { workflowExecutionGeneration: executionGeneration } : {}),
  }).returning();
  return row!.id;
}

export async function seedReadModelHeartbeat(
  db: Db,
  input: {
    id?: string;
    companyId: string;
    agentId: string;
    issueId?: string | null;
    status?: string;
    workflowStepRunId?: string | null;
    wakeupRequestId?: string | null;
    workflowExecutionGeneration?: number | null;
  },
): Promise<string> {
  const executionGeneration = input.workflowExecutionGeneration;
  const [row] = await db.insert(heartbeatRuns).values({
    ...(input.id ? { id: input.id } : {}),
    companyId: input.companyId,
    agentId: input.agentId,
    status: input.status ?? "succeeded",
    ...(input.issueId ? { issueId: input.issueId } : {}),
    ...(input.workflowStepRunId ? { workflowStepRunId: input.workflowStepRunId } : {}),
    ...(input.wakeupRequestId ? { wakeupRequestId: input.wakeupRequestId } : {}),
    ...(executionGeneration !== undefined ? { workflowExecutionGeneration: executionGeneration } : {}),
  }).returning();
  return row!.id;
}

export async function seedReadModelDelegation(
  db: Db,
  input: {
    sourceCompanyId: string;
    sourceWorkflowRunId: string;
    sourceWorkflowStepRunId: string;
    sourceIssueId?: string | null;
    targetCompanyId: string;
    targetIssueId: string;
    status?: string;
  },
): Promise<string> {
  const [row] = await db.insert(workflowDelegations).values({
    sourceCompanyId: input.sourceCompanyId,
    sourceWorkflowRunId: input.sourceWorkflowRunId,
    sourceWorkflowStepRunId: input.sourceWorkflowStepRunId,
    ...(input.sourceIssueId ? { sourceIssueId: input.sourceIssueId } : {}),
    targetCompanyId: input.targetCompanyId,
    targetIssueId: input.targetIssueId,
    ...(input.status ? { status: input.status } : {}),
  }).returning();
  return row!.id;
}

export interface ForeignReadModelGraph {
  companyId: string;
  agentId: string;
  missionId: string;
  runId: string;
  stepRunId: string;
  issueId: string;
}

/** 외부 회사 그래프 — delegation incoming source / scope 오염 행 공급원. */
export async function seedForeignReadModelGraph(sql: RawSql, db: Db): Promise<ForeignReadModelGraph> {
  const { companyId, agentId, missionId } = await seedCompanyWithMission(
    sql,
    "RMF" + randomUUID().slice(0, 8),
  );
  const workflowId = await seedWorkflowDefinition(sql, {
    companyId,
    name: "foreign-read-model-workflow",
    stepsJson: READ_MODEL_STEPS_JSON,
  });
  const runId = await seedWorkflowRun(sql, { workflowId, companyId, missionId });
  const stepRunId = await seedReadModelStepRun(db, { runId, stepId: "resume-step-a" });
  const issueId = await seedReadModelIssue(db, { companyId, missionId });
  return { companyId, agentId, missionId, runId, stepRunId, issueId };
}

/** [read-only 증명용] reader 전후 실제 DB 행 스냅샷 — canonical SELECT 데이터. */
export async function canonicalHistoryRows(db: Db, runId: string) {
  const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).orderBy(workflowRuns.id);
  const stepRuns = await db.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId)).orderBy(workflowStepRuns.id);
  const wakeups = await db.select().from(agentWakeupRequests).orderBy(agentWakeupRequests.id);
  const heartbeats = await db.select().from(heartbeatRuns).orderBy(heartbeatRuns.id);
  const delegations = await db.select().from(workflowDelegations).orderBy(workflowDelegations.id);
  const issueRows = await db.select().from(issues).orderBy(issues.id);
  // missions/workflowRunDefinitions 전체 행도 포함 — reader 의 mutate/backfill 부재를 before/after 비교로 증명.
  const missionRows = await db.select().from(missions).orderBy(missions.id);
  const definitions = await db.select().from(workflowRunDefinitions).orderBy(workflowRunDefinitions.workflowRunId);
  return { runs, stepRuns, wakeups, heartbeats, delegations, issues: issueRows, missions: missionRows, definitions };
}

/** reader 소유 격리 fixture 정리 — heartbeat_runs 포함 전부 삭제(cleanupFrozenTables 보완). */
export async function cleanupReadModelTables(db: Db): Promise<void> {
  await db.delete(heartbeatRuns);
  await cleanupFrozenTables(db);
}
