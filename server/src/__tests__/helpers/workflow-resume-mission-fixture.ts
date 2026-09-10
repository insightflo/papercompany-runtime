import { randomUUID } from "node:crypto";
import {
  agentWakeupRequests,
  heartbeatRunFinalizationSteps,
  heartbeatRunFinalizations,
  heartbeatRuns,
  issues,
  missionAgentRuntimes,
  missions,
  workspaceOperations,
  workspaceRuntimeServices,
  workflowDelegations,
  workflowRunDefinitions,
  workflowRuns,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import { readResumeMissionHistory } from "../../services/workflow/resume/read-model-mission.js";
import type { ResumeExecutionHistoryScope } from "../../services/workflow/resume/read-model.js";
import {
  captureHttpError,
  cleanupResourceTables,
  readModelScope,
  seedAdditionalMission,
  seedCompleteStepRuns,
  seedForeignReadModelGraph,
  seedReadModelDelegation,
  seedReadModelGraph,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedReadModelStepRun,
  seedReadModelWakeup,
  seedResourceFinalization,
  seedResourceFinalizationStep,
  seedResourceMissionRuntime,
  seedResourceRuntimeService,
  seedResourceWorkspaceOperation,
  startExecutionDefinitionFixture,
} from "./workflow-resume-resource-fixture.js";
import {
  readSnapshotRow,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  seedWorkflowRun,
  type RawSql,
} from "./workflow-resume-read-model-fixture.js";

/**
 * [목적] Task5c3c whole-mission roots 테스트 픽스처. 승인된 read-model/resource/frozen fixture 를
 *   import 로만 재사용(수정 금지)하고, 이 슬라이스 전용 조립만 추가한다: 공개 collector 의
 *   repeatable-read read-only 호출 wrapper, mission 전체 도메인 canonical SELECT 스냅샷
 *   (선택 run 만이 아니라 모든 workflow_runs/step_runs + missions + frozen definitions +
 *   issues + wakeups + heartbeats + delegations + resource 5 테이블 — PK 오름차순 전체 행),
 *   typed 연관 컬럼이 전부 NULL 인 legacy JSON 전용 wakeup/heartbeat 시더, 같은 mission 의
 *   형제 run 시더. 실제 임베디드 PostgreSQL — mock DB/loader/해시 없음.
 */

export {
  captureHttpError,
  cleanupResourceTables,
  readModelScope,
  readSnapshotRow,
  seedAdditionalMission,
  seedCompanyWithMission,
  seedCompleteStepRuns,
  seedForeignReadModelGraph,
  seedReadModelDelegation,
  seedReadModelGraph,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedReadModelStepRun,
  seedReadModelWakeup,
  seedResourceFinalization,
  seedResourceFinalizationStep,
  seedResourceMissionRuntime,
  seedResourceRuntimeService,
  seedResourceWorkspaceOperation,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
};
export type {
  ExecutionDefinitionFixture,
  ForeignReadModelGraph,
  RawSql,
  ReadModelGraph,
} from "./workflow-resume-read-model-fixture.js";

/** [계약] 공개 collector 호출은 전부 실제 repeatable-read read-only 트랜잭션 안에서 실행된다. */
export function readMissionHistoryReadonly(db: Db, scope: ResumeExecutionHistoryScope) {
  return db.transaction((tx) => readResumeMissionHistory(tx, scope), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/** [reader 전후 전체 도메인 증거] 선택 run 만이 아니라 mission 도메인 전체 테이블 — 전체 행, PK 오름차순. */
export async function canonicalMissionDomain(db: Db) {
  const runs = await db.select().from(workflowRuns).orderBy(workflowRuns.id);
  const stepRuns = await db.select().from(workflowStepRuns).orderBy(workflowStepRuns.id);
  const missionRows = await db.select().from(missions).orderBy(missions.id);
  const definitions = await db.select().from(workflowRunDefinitions)
    .orderBy(workflowRunDefinitions.workflowRunId);
  const issueRows = await db.select().from(issues).orderBy(issues.id);
  const wakeups = await db.select().from(agentWakeupRequests).orderBy(agentWakeupRequests.id);
  const heartbeats = await db.select().from(heartbeatRuns).orderBy(heartbeatRuns.id);
  const delegations = await db.select().from(workflowDelegations).orderBy(workflowDelegations.id);
  const finalizations = await db.select().from(heartbeatRunFinalizations).orderBy(heartbeatRunFinalizations.id);
  const finalizationSteps = await db.select().from(heartbeatRunFinalizationSteps)
    .orderBy(heartbeatRunFinalizationSteps.id);
  const operationRows = await db.select().from(workspaceOperations).orderBy(workspaceOperations.id);
  const serviceRows = await db.select().from(workspaceRuntimeServices).orderBy(workspaceRuntimeServices.id);
  const runtimeRows = await db.select().from(missionAgentRuntimes).orderBy(missionAgentRuntimes.id);
  return {
    runs,
    stepRuns,
    missions: missionRows,
    definitions,
    issues: issueRows,
    wakeups,
    heartbeats,
    delegations,
    finalizations,
    finalizationSteps,
    workspaceOperations: operationRows,
    workspaceRuntimeServices: serviceRows,
    missionAgentRuntimes: runtimeRows,
  };
}

/** legacy JSON 전용 wakeup — typed queue 컬럼은 전부 NULL(미지정)로 남는다. */
export async function seedLegacyJsonWakeup(
  db: Db,
  input: { companyId: string; agentId: string; payload: unknown; status?: string },
): Promise<string> {
  const [row] = await db.insert(agentWakeupRequests).values({
    companyId: input.companyId,
    agentId: input.agentId,
    source: "mission-legacy-test",
    reason: "mission-legacy-test",
    status: input.status ?? "queued",
    payload: input.payload as Record<string, unknown>,
  }).returning();
  return row!.id;
}

/** legacy JSON 전용 heartbeat — typed 연관 컬럼 전부 NULL, contextSnapshot 만 채운다. */
export async function seedLegacyJsonHeartbeat(
  db: Db,
  input: { companyId: string; agentId: string; contextSnapshot: unknown; status?: string },
): Promise<string> {
  const [row] = await db.insert(heartbeatRuns).values({
    companyId: input.companyId,
    agentId: input.agentId,
    status: input.status ?? "succeeded",
    contextSnapshot: input.contextSnapshot as Record<string, unknown>,
  }).returning();
  return row!.id;
}

/** 같은 mission 의 형제 run — 임의 정의/status/metadata, frozen snapshot 없음(raw discovery 대상). */
export async function seedMissionSiblingRun(
  sql: RawSql,
  input: {
    companyId: string;
    missionId: string;
    workflowId?: string;
    status?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const workflowId = input.workflowId
    ?? await seedWorkflowDefinition(sql, {
      companyId: input.companyId,
      name: "sibling-" + randomUUID().slice(0, 8),
      stepsJson: [{ id: "sibling-definition-step", name: "Sibling step", agentId: "", dependencies: [] }],
    });
  return await seedWorkflowRun(sql, {
    workflowId,
    companyId: input.companyId,
    missionId: input.missionId,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  });
}
