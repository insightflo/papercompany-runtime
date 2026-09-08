import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  missions,
  workflowResumeExecutions,
  workflowResumeRequests,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  seedCompanyWithMission,
  seedWorkflowDefinition,
  type RawSql,
} from "./workflow-execution-definition-fixture.js";
import { createWorkflowRunWithDefinition } from "../../services/workflow/workflow-run-create.js";
import {
  insertMutationCoreResumeRequest,
  seedMutationCoreStepRun,
} from "./workflow-resume-mutation-core-fixture.js";

/**
 * [목적] Task6b-2 durable resume delivery(execution-queue/dispatcher) 실DB 테스트 픽스처.
 *   승인된 헬퍼(execution-definition / mutation-core fixture)를 import 로만 재사용(수정 금지)하고
 *   apply 직후 pending_delivery 상태(resumed run + reset step + pending 요청) 조립과 요청/실행
 *   행 readback, 회사 run 카운트만 추가한다. mock DB/트랜잭션/정규화 없음 — 실제 임베디드 PG.
 */

export type ResumeDeliveryGraph = {
  companyId: string;
  agentId: string;
  missionId: string;
  workflowId: string;
  runId: string;
  stepId: string;
};

export const DELIVERY_AUTHORITY_VERSION = 3;

let deliveryGraphCounter = 0;

/**
 * company/agent/mission(active) + 정의 + running run(+불변 실행정의 스냅샷).
 * stepType "tool" 은 issue-less 툴 스텝(큐 경로/ready 실패 크래시 시뮬레이션), 기본 agent 스텝.
 */
export async function seedResumeDeliveryGraph(
  sql: RawSql,
  db: Db,
  input: { prefix: string; stepType?: "agent" | "tool" },
): Promise<ResumeDeliveryGraph> {
  deliveryGraphCounter += 1;
  const uniquePrefix = `${input.prefix}-${deliveryGraphCounter.toString(36)}-${randomUUID().slice(0, 8)}`;
  const { companyId, agentId, missionId } = await seedCompanyWithMission(sql, uniquePrefix);
  await db.update(agents).set({
    role: "engineer",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).where(eq(agents.id, agentId));
  const stepId = "resume-delivery-step";
  const stepsJson = input.stepType === "tool"
    ? [{
      id: stepId,
      name: "Resume delivery tool",
      type: "tool",
      agentId: "",
      toolNames: ["sync-tool"],
      toolArgs: {},
      dependencies: [],
    }]
    : [{ id: stepId, name: "Resume delivery step", type: "agent", agentId, dependencies: [] }];
  const workflowId = await seedWorkflowDefinition(sql, {
    companyId,
    name: `resume-delivery-${uniquePrefix}`,
    stepsJson,
  });
  const run = await createWorkflowRunWithDefinition(db, {
    workflowId,
    companyId,
    missionId,
    triggeredBy: "task6b-delivery-test",
  });
  await db.update(workflowRuns).set({
    status: "running",
    startedAt: new Date("2026-09-08T01:00:00.000Z"),
  }).where(eq(workflowRuns.id, run.id));
  await db.update(missions).set({ status: "active" }).where(eq(missions.id, missionId));
  return { companyId, agentId, missionId, workflowId, runId: run.id, stepId };
}

/**
 * apply 가 남긴 직후 상태를 조립한다: run resume 마킹(authority 3) + step reset
 * (pending, executionGeneration 3, metadata.resumeRequestId) + pending_delivery 요청.
 * stepRunRow=false 면 step 행 없이 요청/마킹만 만든다(claim 단위 테스트용).
 */
export async function markRunPendingDelivery(
  db: Db,
  graph: ResumeDeliveryGraph,
  input: { appliedGeneration?: number; withStepRow?: boolean } = {},
): Promise<string> {
  const requestId = randomUUID();
  const generation = input.appliedGeneration ?? DELIVERY_AUTHORITY_VERSION;
  await db.update(workflowRuns).set({
    dispatchAuthorityVersion: DELIVERY_AUTHORITY_VERSION,
    metadata: { resumeRequestId: requestId, resumeAuthorityVersion: DELIVERY_AUTHORITY_VERSION },
  }).where(eq(workflowRuns.id, graph.runId));
  if (input.withStepRow !== false) {
    await seedMutationCoreStepRun(db, {
      runId: graph.runId,
      stepId: graph.stepId,
      values: {
        status: "pending",
        executionGeneration: generation,
        statusTransitionVersion: 1,
        metadata: { resumeRequestId: requestId },
      },
    });
  }
  await insertMutationCoreResumeRequest(db, {
    id: requestId,
    companyId: graph.companyId,
    missionId: graph.missionId,
    workflowRunId: graph.runId,
    state: "pending_delivery",
    appliedGenerations: { [graph.stepId]: generation },
  });
  return requestId;
}

export async function loadDeliveryRequest(sql: RawSql, requestId: string) {
  const rows = await sql`SELECT * FROM workflow_resume_requests WHERE id = ${requestId}`;
  return rows[0] as Record<string, unknown> | undefined;
}

export async function loadDeliveryExecution(sql: RawSql, requestId: string) {
  const rows = await sql`SELECT * FROM workflow_resume_executions WHERE request_id = ${requestId}`;
  return rows[0] as Record<string, unknown> | undefined;
}

export async function countCompanyRuns(sql: RawSql, companyId: string): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS c FROM workflow_runs WHERE company_id = ${companyId}`;
  return (rows[0] as { c: number }).c;
}

/** 표준 큐 SELECT 가 걷는 issue-less 툴 스텝 queued 행(accepted/error null + requestId). */
export async function seedQueuedToolStepRun(
  db: Db,
  input: { runId: string; stepId: string; requestId: string; now: Date },
): Promise<void> {
  await seedMutationCoreStepRun(db, {
    runId: input.runId,
    stepId: input.stepId,
    values: {
      status: "running",
      issueId: null,
      startedAt: input.now,
      lastDispatchRequestId: input.requestId,
      lastDispatchAcceptedAt: null,
      lastDispatchErrorAt: null,
      metadata: {
        toolInvocation: {
          requestId: input.requestId,
          toolName: "sync-tool",
          args: {},
          queuedAt: input.now.toISOString(),
        },
        toolQueue: { status: "queued", queuedAt: input.now.toISOString() },
      },
    },
  });
}

/** [격리] 공유 PG 인스턴스에서 이전 테스트의 미종결 resume 행/queued 툴 행을 무력화한다. */
export async function resetResumeDeliveryIsolation(db: Db, now: Date): Promise<void> {
  await db.update(workflowResumeExecutions).set({
    state: "cancelled",
    code: "mission_cancelled",
    leaseOwner: null,
    leaseUntil: null,
  }).where(inArray(workflowResumeExecutions.state, ["queued", "running"]));
  await db.update(workflowResumeRequests).set({
    state: "blocked",
    code: "scope_changed",
    leaseOwner: null,
    leaseUntil: null,
  }).where(eq(workflowResumeRequests.state, "pending_delivery"));
  await db.update(workflowStepRuns).set({ lastDispatchAcceptedAt: now }).where(and(
    eq(workflowStepRuns.status, "running"),
    isNull(workflowStepRuns.lastDispatchAcceptedAt),
    isNull(workflowStepRuns.lastDispatchErrorAt),
    isNotNull(workflowStepRuns.lastDispatchRequestId),
  ));
}
