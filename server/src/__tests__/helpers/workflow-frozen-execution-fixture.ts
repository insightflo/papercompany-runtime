import { eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  issueExecutionCards,
  issueComments,
  issueWorkProducts,
  issues,
  missionPlanArtifacts,
  missions,
  pluginEntities,
  plugins,
  toolDefinitions,
  workflowDelegations,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { loadExecutionDefinition } from "../../services/workflow/execution-definition.js";
import { createWorkflowRun } from "../../services/workflow/workflow-store.js";
import {
  seedCompanyOnly,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./workflow-execution-definition-fixture.js";

/**
 * [목적] Task5a2a frozen-execution 테스트 픽스처. Task5a1 fixture 를 import 로만 재사용하고
 *   수정하지 않는다. frozen run 은 실제 store createWorkflowRun(스냅샷 캡처 포함)으로 만들고,
 *   live definition 은 별도 UPDATE 로 편집한다. mock loader/DB/정규화/해시 없음.
 */

export {
  seedCompanyOnly,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
};
export type { ExecutionDefinitionFixture, RawSql };

/** FK 역순 전체 삭제 — 각 테스트 DB 는 임시(임베디드 PG)라 전체 비움이 안전하다. */
export async function cleanupFrozenTables(db: Db): Promise<void> {
  await db.delete(workflowTransitionEvents);
  await db.delete(activityLog);
  await db.delete(agentWakeupRequests);
  await db.delete(issueExecutionCards);
  await db.delete(issueWorkProducts);
  await db.delete(workflowDelegations);
  await db.delete(workflowStepRuns);
  await db.delete(workflowRuns);
  await db.delete(workflowDefinitions);
  await db.delete(pluginEntities);
  await db.delete(plugins);
  await db.delete(issueComments);
  await db.delete(missionPlanArtifacts);
  await db.delete(issues);
  await db.delete(missions);
  await db.delete(toolDefinitions);
  await db.delete(plugins);
  await db.delete(pluginEntities);
}

export async function createFrozenRun(
  db: Db,
  input: { workflowId: string; companyId: string; missionId?: string; triggeredBy?: string },
) {
  return await createWorkflowRun(db, {
    workflowId: input.workflowId,
    companyId: input.companyId,
    ...(input.missionId ? { missionId: input.missionId } : {}),
    triggeredBy: input.triggeredBy ?? "task5a2a",
  } as Parameters<typeof createWorkflowRun>[1]);
}

export async function loadCapturedDefinition(db: Db, runId: string) {
  return await loadExecutionDefinition(db, runId, { requireHistorical: false });
}

export async function editLiveDefinition(
  db: Db,
  workflowId: string,
  patch: { name?: string; stepsJson?: unknown; executionMode?: string | null; dynamicPlanBootstrapOnly?: boolean },
): Promise<void> {
  await db.update(workflowDefinitions)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.stepsJson !== undefined ? { stepsJson: patch.stepsJson as never } : {}),
      ...(patch.executionMode !== undefined ? { executionMode: patch.executionMode } : {}),
      ...(patch.dynamicPlanBootstrapOnly !== undefined
        ? { dynamicPlanBootstrapOnly: patch.dynamicPlanBootstrapOnly }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(workflowDefinitions.id, workflowId));
}

export async function markRunStatus(db: Db, runId: string, status: string): Promise<void> {
  await db.update(workflowRuns).set({ status: status as never }).where(eq(workflowRuns.id, runId));
}

export async function seedToolDefinition(db: Db, companyId: string, name: string): Promise<void> {
  await db.insert(toolDefinitions).values({ companyId, name, adapterType: "builtin", adapterConfig: {} });
}

/** 큐 프로세서가 선택하는 issue-less tool stepRun 행(running + requestId, accepted/error null). */
export async function seedQueuedToolStepRun(
  db: Db,
  input: { runId: string; stepId: string; requestId: string; toolInvocation?: Record<string, unknown> },
) {
  const [row] = await db.insert(workflowStepRuns).values({
    workflowRunId: input.runId,
    stepId: input.stepId,
    status: "running",
    issueId: null,
    lastDispatchRequestId: input.requestId,
    lastDispatchAcceptedAt: null,
    lastDispatchErrorAt: null,
    metadata: {
      ...(input.toolInvocation ? { toolInvocation: input.toolInvocation } : {}),
      toolQueue: { status: "queued", queuedAt: new Date().toISOString() },
    },
  }).returning();
  return row!;
}

export async function stepRunsOf(db: Db, runId: string) {
  return await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
}

/** corrupt snapshot 유도: steps 만 tamper 해 definition_hash 대조를 깬다(422 fail-closed 경로). */
export async function corruptSnapshotSteps(sql: RawSql, runId: string): Promise<void> {
  await sql`UPDATE workflow_run_definitions
    SET steps = ${JSON.stringify([{ id: "tampered", name: "T", agentId: "", dependencies: [], graphWorkProductRequired: false }])}
    WHERE workflow_run_id = ${runId}`;
}
