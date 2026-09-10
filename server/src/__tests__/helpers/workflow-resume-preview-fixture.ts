import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRunFinalizationSteps,
  heartbeatRunFinalizations,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  missionAgentRuntimes,
  missions,
  toolDefinitions,
  workflowDelegations,
  workflowLateEvidenceSubmissions,
  workflowResumeExecutions,
  workflowResumeRequests,
  workflowRunDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowDefinitions,
  workspaceOperations,
  workspaceRuntimeServices,
  agentWakeupRequests,
  agents,
  type Db,
} from "@paperclipai/db";
import { expect } from "vitest";
import type { ResumeExecutionHistoryScope } from "../../services/workflow/resume/read-model.js";
import { previewResume, type ResumeSnapshotSigner } from "../../services/workflow/resume/preview.js";
import {
  captureHttpError,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./workflow-execution-definition-fixture.js";
import {
  createFrozenRun,
  loadCapturedDefinition,
  markRunStatus,
} from "./workflow-frozen-execution-fixture.js";
import {
  cleanupResourceTables,
  seedReadModelStepRun,
} from "./workflow-resume-resource-fixture.js";
import {
  seedReadModelHeartbeat,
  seedReadModelWakeup,
} from "./workflow-resume-read-model-fixture.js";

/**
 * [목적] Task6a preview 서비스/route 테스트 픽스처. 승인된 5a1/5a2a/5c3 fixture 를 import 로만
 *   재사용(수정 금지)하고, 실제 임베디드 PostgreSQL 위에 frozen run + pending step rows +
 *   active mission 으로 preview 대상 그래프를 시딩하는 최소 조립기와 전 도메인 canonical
 *   무변화 단언, resume 요청/실행/산출물 시더만 추가한다.
 *   실제 DB + 실제 capture + 실제 서명 — mock DB/loader/해시/토큰 없음.
 */

export {
  captureHttpError,
  createFrozenRun,
  loadCapturedDefinition,
  markRunStatus,
  previewResume,
  seedCompanyWithMission,
  seedReadModelHeartbeat,
  seedReadModelStepRun,
  seedReadModelWakeup,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
};
export type { ExecutionDefinitionFixture, RawSql, ResumeExecutionHistoryScope, ResumeSnapshotSigner };

export const PREVIEW_KEY_HEX = "ab".repeat(32);
export const PREVIEW_NOW = new Date("2024-06-01T12:00:00.000Z");

export function previewSigner(keyHex: string = PREVIEW_KEY_HEX): ResumeSnapshotSigner {
  return { key: Buffer.from(keyHex, "hex"), now: () => PREVIEW_NOW };
}

export interface PreviewGraph {
  companyId: string;
  agentId: string;
  missionId: string;
  runId: string;
  definitionStepIds: string[];
  definitionHash: string;
}

/** company/mission(active) + definition + 실제 frozen run 캡처 + step 1:1 pending rows. */
export async function seedPreviewGraph(
  sql: RawSql,
  db: Db,
  input: {
    stepsJson: unknown;
    executionMode?: string | null;
    runStatus?: string;
    runMetadata?: Record<string, unknown>;
  },
): Promise<PreviewGraph> {
  const { companyId, agentId, missionId } = await seedCompanyWithMission(
    sql,
    "PV" + randomUUID().slice(0, 8),
  );
  const workflowId = await seedWorkflowDefinition(sql, {
    companyId,
    name: "preview-workflow",
    stepsJson: input.stepsJson,
    executionMode: input.executionMode ?? null,
  });
  const run = await createFrozenRun(db, { workflowId, companyId, missionId });
  const captured = await loadCapturedDefinition(db, run.id);
  for (const stepId of captured.steps.map((step) => step.id)) {
    await seedReadModelStepRun(db, { runId: run.id, stepId });
  }
  await db.update(missions).set({ status: "active" }).where(eq(missions.id, missionId));
  await markRunStatus(db, run.id, input.runStatus ?? "completed");
  if (input.runMetadata !== undefined) {
    await db.update(workflowRuns).set({ metadata: input.runMetadata as never }).where(eq(workflowRuns.id, run.id));
  }
  return {
    companyId,
    agentId,
    missionId,
    runId: run.id,
    definitionStepIds: captured.steps.map((step) => step.id),
    definitionHash: captured.definitionHash,
  };
}

export function previewScope(graph: PreviewGraph, startStepId?: string): ResumeExecutionHistoryScope {
  return {
    companyId: graph.companyId,
    missionId: graph.missionId,
    workflowRunId: graph.runId,
    startStepId: startStepId ?? graph.definitionStepIds[0]!,
  };
}

/** [reader 전후 전체 도메인 증거] preview 가 읽는 모든 테이블 전체 행(PK 오름차순). */
export async function canonicalPreviewDomain(db: Db) {
  return {
    runs: await db.select().from(workflowRuns).orderBy(workflowRuns.id),
    stepRuns: await db.select().from(workflowStepRuns).orderBy(workflowStepRuns.id),
    missions: await db.select().from(missions).orderBy(missions.id),
    definitions: await db.select().from(workflowDefinitions).orderBy(workflowDefinitions.id),
    runDefinitions: await db.select().from(workflowRunDefinitions).orderBy(workflowRunDefinitions.workflowRunId),
    issues: await db.select().from(issues).orderBy(issues.id),
    wakeups: await db.select().from(agentWakeupRequests).orderBy(agentWakeupRequests.id),
    heartbeats: await db.select().from(heartbeatRuns).orderBy(heartbeatRuns.id),
    delegations: await db.select().from(workflowDelegations).orderBy(workflowDelegations.id),
    finalizations: await db.select().from(heartbeatRunFinalizations).orderBy(heartbeatRunFinalizations.id),
    finalizationSteps: await db.select().from(heartbeatRunFinalizationSteps).orderBy(heartbeatRunFinalizationSteps.id),
    workspaceOperations: await db.select().from(workspaceOperations).orderBy(workspaceOperations.id),
    workspaceRuntimeServices: await db.select().from(workspaceRuntimeServices).orderBy(workspaceRuntimeServices.id),
    missionAgentRuntimes: await db.select().from(missionAgentRuntimes).orderBy(missionAgentRuntimes.id),
    executionWorkspaces: await db.select().from(executionWorkspaces).orderBy(executionWorkspaces.id),
    companies: await db.select().from(companies).orderBy(companies.id),
    issueWorkProducts: await db.select().from(issueWorkProducts).orderBy(issueWorkProducts.id),
    resumeRequests: await db.select().from(workflowResumeRequests).orderBy(workflowResumeRequests.id),
    resumeExecutions: await db.select().from(workflowResumeExecutions).orderBy(workflowResumeExecutions.id),
    toolDefinitions: await db.select().from(toolDefinitions).orderBy(toolDefinitions.id),
  };
}

export type PreviewDomainSnapshot = Awaited<ReturnType<typeof canonicalPreviewDomain>>;

/** 공개 호출(성공/거부 모두) 전후 canonical 무변화 — finally 로 누락 막는다. */
export async function expectDomainUnchanged<T>(
  db: Db,
  before: PreviewDomainSnapshot,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } finally {
    expect(await canonicalPreviewDomain(db)).toEqual(before);
  }
}

/** 각 테스트 격리 — preview 확장 테이블 포함 FK 역순 전체 비움. */
export async function cleanupPreviewTables(db: Db): Promise<void> {
  await db.delete(workflowResumeExecutions);
  await db.delete(workflowResumeRequests);
  await db.delete(workflowLateEvidenceSubmissions);
  await cleanupResourceTables(db);
  await db.delete(executionWorkspaces);
  await db.delete(agents);
  await db.delete(companies);
}

/** 외부 predecessor 용 pending issue(checkout/execution 흔적 없음, in_progress 아님). */
export async function seedPreviewIssue(
  db: Db,
  input: { companyId: string; missionId: string | null; status?: string },
): Promise<string> {
  const [row] = await db.insert(issues).values({
    id: randomUUID(),
    companyId: input.companyId,
    ...(input.missionId ? { missionId: input.missionId } : {}),
    title: "Preview outside issue",
    status: input.status ?? "pending",
    originKind: "workflow_execution",
  }).returning();
  return row!.id;
}

/** company+issue 스코프 canonical 산출물 행 — metadata 해시 주장 포함 가능. */
export async function seedPreviewWorkProduct(
  db: Db,
  input: { companyId: string; issueId: string; metadata?: Record<string, unknown> },
): Promise<string> {
  const [row] = await db.insert(issueWorkProducts).values({
    companyId: input.companyId,
    issueId: input.issueId,
    type: "file",
    provider: "preview-fixture",
    title: "Preview work product",
    status: "registered",
    ...(input.metadata ? { metadata: input.metadata as never } : {}),
  }).returning();
  return row!.id;
}

/** resume 요청 row(+옵션 실행 row) — readback/active_work 테스트용. */
export async function seedPreviewResumeRequest(
  db: Db,
  input: {
    companyId: string;
    missionId: string;
    workflowRunId: string;
    state?: string;
    withExecution?: { state?: string };
  },
): Promise<{ requestId: string; executionId: string | null }> {
  const [request] = await db.insert(workflowResumeRequests).values({
    companyId: input.companyId,
    missionId: input.missionId,
    workflowRunId: input.workflowRunId,
    idempotencyKey: randomUUID(),
    requestHash: "cf".repeat(32),
    snapshotHash: "ab".repeat(32),
    definitionHash: "12".repeat(32),
    requestBody: { snapshotToken: "tok", reason: "preview-fixture" },
    beforeState: { scope: { startStepId: "s" } },
    appliedGenerations: { "step-1": 1 },
    state: input.state ?? "pending_delivery",
  }).returning();
  let executionId: string | null = null;
  if (input.withExecution) {
    const [execution] = await db.insert(workflowResumeExecutions).values({
      requestId: request!.id,
      companyId: input.companyId,
      missionId: input.missionId,
      workflowRunId: input.workflowRunId,
      authorityVersion: 3,
      generations: { "step-1": 2 },
      state: input.withExecution.state ?? "queued",
    }).returning();
    executionId = execution!.id;
  }
  return { requestId: request!.id, executionId };
}
