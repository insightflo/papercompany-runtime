import { randomUUID } from "node:crypto";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  createFrozenRun,
  editLiveDefinition,
  loadCapturedDefinition,
  markRunStatus,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  stepRunsOf,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./workflow-frozen-execution-fixture.js";

/**
 * [목적] Task5a2d mission supervision/recovery frozen 테스트 픽스처. 승인된 Task5a1/5a2a
 *   헬퍼를 import 로만 재사용(수정 금지)하고, company/agent/mission+definition 과 실제
 *   frozen run(createWorkflowRun 스냅샷 캡처)을 만든 뒤 step/issue/verdict/workproduct/
 *   heartbeat/wakeup 행을 시딩하는 최소 조립기만 추가한다. mock DB/loader/해시 없음.
 */

export {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  createFrozenRun,
  editLiveDefinition,
  loadCapturedDefinition,
  markRunStatus,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  stepRunsOf,
};
export type { ExecutionDefinitionFixture, RawSql };

export interface FrozenMissionSeed {
  companyId: string;
  agentId: string;
  missionId: string;
  workflowId: string;
  runId: string;
}

/** company/agent/mission + definition + 실제 frozen run(스냅샷 캡처)을 한 번에 시딩한다. */
export async function seedFrozenMissionGraph(
  sql: RawSql,
  db: Db,
  input: { issuePrefix: string; name?: string; stepsJson: unknown[]; executionMode?: string | null },
): Promise<FrozenMissionSeed> {
  const { companyId, agentId, missionId } = await seedCompanyWithMission(sql, input.issuePrefix);
  const workflowId = await seedWorkflowDefinition(sql, {
    companyId,
    name: input.name ?? "frozen-mission-workflow",
    stepsJson: input.stepsJson,
    executionMode: input.executionMode ?? null,
  });
  const run = await createFrozenRun(db, { workflowId, companyId, missionId });
  return { companyId, agentId, missionId, workflowId, runId: run.id };
}

export interface FrozenStepRunSeed {
  stepRunId: string;
}

/** issue-less stepRun 행(테스트가 issue 를 직접 관리할 때). */
export async function seedFrozenStepRun(
  db: Db,
  input: {
    runId: string;
    stepId: string;
    issueId?: string | null;
    status?: string;
    startedAt?: Date | null;
    completedAt?: Date | null;
    lastDispatchRequestId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<FrozenStepRunSeed> {
  const [stepRun] = await db.insert(workflowStepRuns).values({
    workflowRunId: input.runId,
    stepId: input.stepId,
    ...(input.issueId ? { issueId: input.issueId } : {}),
    status: input.status ?? "pending",
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    ...(input.lastDispatchRequestId !== undefined ? { lastDispatchRequestId: input.lastDispatchRequestId } : {}),
    metadata: input.metadata ?? {},
  }).returning();
  return { stepRunId: stepRun!.id };
}

export interface FrozenIssueStepSeed {
  issueId: string;
  stepRunId: string;
}

/** issue + 동일 run 의 stepRun 행을 묶어 시딩한다(명시적 issueId 재사용 가능). */
export async function seedFrozenIssueStep(
  db: Db,
  input: {
    companyId: string;
    missionId?: string | null;
    runId: string;
    stepId: string;
    issueId?: string;
    title?: string;
    originKind?: string;
    originId?: string | null;
    originRunId?: string | null;
    issueStatus?: string;
    status?: string;
    startedAt?: Date | null;
    completedAt?: Date | null;
    metadata?: Record<string, unknown>;
  },
): Promise<FrozenIssueStepSeed> {
  let issueId = input.issueId ?? null;
  if (!issueId) {
    const [issue] = await db.insert(issues).values({
      id: randomUUID(),
      companyId: input.companyId,
      ...(input.missionId ? { missionId: input.missionId } : {}),
      title: input.title ?? "Frozen issue",
      status: input.issueStatus ?? "in_progress",
      originKind: input.originKind ?? "workflow_execution",
      ...(input.originId !== undefined ? { originId: input.originId } : {}),
      ...(input.originRunId ? { originRunId: input.originRunId } : {}),
    }).returning();
    issueId = issue!.id;
  }
  const step = await seedFrozenStepRun(db, {
    runId: input.runId,
    stepId: input.stepId,
    issueId,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    metadata: input.metadata,
  });
  return { issueId: issueId!, stepRunId: step.stepRunId };
}

export async function seedFrozenHeartbeat(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId?: string | null;
    status?: string;
    startedAt?: Date | null;
    finishedAt?: Date | null;
  },
): Promise<string> {
  const [row] = await db.insert(heartbeatRuns).values({
    companyId: input.companyId,
    agentId: input.agentId,
    ...(input.issueId ? { issueId: input.issueId } : {}),
    status: input.status ?? "succeeded",
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
  }).returning();
  return row!.id;
}

/** 공식 workflow_validation_verdict 이벤트. ledger reason 기본 workflow_api(heartbeat 바인딩 경로). */
export async function seedFrozenValidationVerdict(
  db: Db,
  input: {
    companyId: string;
    missionId?: string | null;
    issueId: string;
    workflowRunId: string;
    workflowStepRunId: string;
    heartbeatRunId?: string | null;
    verdict: "pass" | "request_changes";
    ledgerReason?: string;
    payloadReason?: string;
    createdAt: Date;
  },
): Promise<string> {
  const [row] = await db.insert(workflowTransitionEvents).values({
    companyId: input.companyId,
    ...(input.missionId ? { missionId: input.missionId } : {}),
    workflowRunId: input.workflowRunId,
    workflowStepRunId: input.workflowStepRunId,
    issueId: input.issueId,
    ...(input.heartbeatRunId ? { heartbeatRunId: input.heartbeatRunId } : {}),
    eventType: "workflow_validation_verdict",
    layer: "workflow_validation",
    verdict: input.verdict,
    reason: input.ledgerReason ?? "workflow_api",
    payload: { reason: input.payloadReason ?? input.ledgerReason ?? "workflow_api" },
    createdAt: input.createdAt,
  }).returning();
  return row!.id;
}

export async function seedFrozenWorkProduct(
  db: Db,
  input: { companyId: string; issueId: string; title?: string; updatedAt: Date },
): Promise<string> {
  const [row] = await db.insert(issueWorkProducts).values({
    companyId: input.companyId,
    issueId: input.issueId,
    type: "artifact",
    provider: "frozen-test",
    title: input.title ?? "Frozen artifact",
    status: "active",
    updatedAt: input.updatedAt,
  }).returning();
  return row!.id;
}

export async function seedFrozenWakeup(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId?: string | null;
    missionId?: string | null;
    reason: string;
    status?: string;
    payload?: Record<string, unknown>;
  },
): Promise<string> {
  const [row] = await db.insert(agentWakeupRequests).values({
    companyId: input.companyId,
    agentId: input.agentId,
    source: "frozen-test",
    reason: input.reason,
    status: input.status ?? "queued",
    payload: input.payload ?? {},
    ...(input.issueId ? { issueId: input.issueId } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {}),
  }).returning();
  return row!.id;
}
