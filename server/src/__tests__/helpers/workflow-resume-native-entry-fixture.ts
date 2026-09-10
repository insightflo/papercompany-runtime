import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, workflowRuns } from "@paperclipai/db";
import {
  seedCompanyWithMission,
  seedWorkflowDefinition,
  type RawSql,
} from "./workflow-execution-definition-fixture.js";
import { createWorkflowRunWithDefinition } from "../../services/workflow/workflow-run-create.js";
import {
  insertMutationCoreResumeExecution,
  insertMutationCoreResumeRequest,
  seedMutationCoreStepRun,
  startMutationCoreFixture,
  type MutationCoreFixture,
} from "./workflow-resume-mutation-core-fixture.js";

/**
 * [목적] Task6b native entry(resume 수락 가드 + 공유 readiness) 실DB 테스트 픽스처.
 *   승인된 헬퍼(execution-definition / mutation-core fixture)를 import 로만 재사용(수정 금지)하고
 *   resumed run 상태 조립과 run 스코프 레코드 캡처만 추가한다. mock DB/정규화/스케치 없음.
 */

export type NativeEntryFixture = MutationCoreFixture;
export const startNativeEntryFixture = startMutationCoreFixture;

export type NativeEntryGraph = {
  companyId: string;
  agentId: string;
  missionId: string;
  workflowId: string;
  runId: string;
  stepId: string;
};

/** company/agent/mission + agent 스텝 정의 + run(+불변 실행정의 스냅샷).
 *  resume 키/authority 는 호출자가 이후 주입. 실제 native entry 대상 run 처럼
 *  스냅샷이 캡처된 run 을 만든다(marked run 은 legacy fallback 이 없다). */
export async function seedNativeEntryGraph(
  sql: RawSql,
  db: Db,
  input: { prefix: string; runStatus?: string; stepId?: string },
): Promise<NativeEntryGraph> {
  const { companyId, agentId, missionId } = await seedCompanyWithMission(sql, input.prefix);
  // issue 발주 경로가 읽는 실행 필드를 채운다(미러: workflow-failure-cascade-skip-sticky 시딩).
  await db.update(agents).set({
    role: "engineer",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).where(eq(agents.id, agentId));
  const stepId = input.stepId ?? "resume-step";
  const workflowId = await seedWorkflowDefinition(sql, {
    companyId,
    name: `native-entry-${input.prefix}`,
    stepsJson: [{ id: stepId, name: "Resume step", type: "agent", agentId, dependencies: [] }],
  });
  const run = await createWorkflowRunWithDefinition(db, {
    workflowId,
    companyId,
    missionId,
    triggeredBy: "task6b-native-entry-test",
  });
  const runId = run.id;
  await db.update(workflowRuns).set({
    status: input.runStatus ?? "running",
    startedAt: new Date("2026-09-08T01:00:00.000Z"),
  }).where(eq(workflowRuns.id, runId));
  return { companyId, agentId, missionId, workflowId, runId, stepId };
}

const RESUME_METADATA_VERSION = 3;

/** run 에 own resumeRequestId 키(+일치 resumeAuthorityVersion)를 주입한다. */
export async function markRunAsResumed(
  db: Db,
  graph: NativeEntryGraph,
  input: { requestId: string; resumeAuthorityVersion?: number | null },
): Promise<void> {
  const metadata: Record<string, unknown> = { resumeRequestId: input.requestId };
  if (input.resumeAuthorityVersion !== null) {
    metadata.resumeAuthorityVersion = input.resumeAuthorityVersion ?? RESUME_METADATA_VERSION;
  }
  await db.update(workflowRuns).set({
    dispatchAuthorityVersion: RESUME_METADATA_VERSION,
    metadata,
  }).where(eq(workflowRuns.id, graph.runId));
}

/** malformed resumeRequestId 만 가진 run(요청/실행/step 행 없음). */
export async function seedMalformedResumedRun(
  db: Db,
  graph: NativeEntryGraph,
): Promise<void> {
  await db.update(workflowRuns).set({
    metadata: { resumeRequestId: "not-a-uuid" },
  }).where(eq(workflowRuns.id, graph.runId));
}

/** pending_delivery 요청만 있고 실행/step 행이 없는 resumed run(ensure 선절차 증명용). */
export async function seedPendingResumedRun(
  db: Db,
  graph: NativeEntryGraph,
): Promise<string> {
  const requestId = randomUUID();
  await markRunAsResumed(db, graph, { requestId });
  await insertMutationCoreResumeRequest(db, {
    id: requestId,
    companyId: graph.companyId,
    missionId: graph.missionId,
    workflowRunId: graph.runId,
  });
  return requestId;
}

/** accepted 요청 + execution 조립. withExecution=false 로 수락-무실행 거부를 만든다. */
export async function seedAcceptedResumedRun(
  db: Db,
  graph: NativeEntryGraph,
  input: {
    withExecution?: boolean;
    executionAuthorityVersion?: number;
    executionState?: string;
  } = {},
): Promise<string> {
  const requestId = randomUUID();
  const generations = { [graph.stepId]: RESUME_METADATA_VERSION };
  await markRunAsResumed(db, graph, { requestId });
  await seedMutationCoreStepRun(db, {
    runId: graph.runId,
    stepId: graph.stepId,
    values: {
      status: "pending",
      executionGeneration: RESUME_METADATA_VERSION,
      metadata: { resumeRequestId: requestId },
    },
  });
  await insertMutationCoreResumeRequest(db, {
    id: requestId,
    companyId: graph.companyId,
    missionId: graph.missionId,
    workflowRunId: graph.runId,
    state: "accepted",
    acceptedAt: new Date("2026-09-08T02:00:00.000Z"),
    appliedGenerations: generations,
  });
  if (input.withExecution !== false) {
    await insertMutationCoreResumeExecution(db, {
      requestId,
      companyId: graph.companyId,
      missionId: graph.missionId,
      workflowRunId: graph.runId,
      authorityVersion: input.executionAuthorityVersion ?? RESUME_METADATA_VERSION,
      generations,
      state: input.executionState ?? "queued",
    });
  }
  return requestId;
}

/** run 스코프 step/issue/transition/run 레코드를 JSON 안정형으로 캡처한다(무변이 증명용). */
export async function captureNativeScopedRecords(sql: RawSql, runId: string) {
  const run = await sql`SELECT * FROM workflow_runs WHERE id = ${runId}`;
  const steps = await sql`SELECT * FROM workflow_step_runs WHERE workflow_run_id = ${runId} ORDER BY id`;
  const linkedIssues = await sql`SELECT * FROM issues
    WHERE origin_run_id = ${runId}
      OR id IN (SELECT issue_id FROM workflow_step_runs WHERE workflow_run_id = ${runId})
    ORDER BY id`;
  const transitions = await sql`
    SELECT * FROM workflow_transition_events WHERE workflow_run_id = ${runId} ORDER BY id`;
  return JSON.parse(JSON.stringify({ run, steps, linkedIssues, transitions }));
}
