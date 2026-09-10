import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { missions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { Express } from "express";
import type { ResumeRequestBody } from "@paperclipai/shared";
import { loadExecutionDefinition } from "../../services/workflow/execution-definition.js";
import type { ReviewedResumePolicy } from "../../services/workflow/resume/reviewed-policy.js";
import { createWorkflowRun } from "../../services/workflow/workflow-store.js";
import {
  captureHttpError,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./workflow-execution-definition-fixture.js";

/**
 * [목적] Task6a real atomic apply(applyResume) 실DB 테스트 픽스처. 승인된 기존 헬퍼를 import 로만
 *   재사용(수정 금지)하고, 실제 임베디드 PostgreSQL 위에 검토 정책 매니페스트 fixture 와
 *   eligible 시나리오(company/mission/run/steps/frozen definition) 조립만 추가한다.
 * [한계] TEST_REVIEWED_POLICIES 는 vi.mock(reviews-policy 모듈 경계)으로만 주입되는 테스트 전용
 *   fixture 다 — 프로덕션 검토 레지스트리가 아니며 policy hash 대조는 실제 모듈/실제 DB 로 실행된다.
 */

export { captureHttpError, startExecutionDefinitionFixture };
export type { ExecutionDefinitionFixture, RawSql };

/** vi.mock(reviews-policy) 팩토리가 그대로 노출하는 mutable manifest — 테스트 픽스처 전용. */
export const TEST_REVIEWED_POLICIES: ReviewedResumePolicy[] = [];

export function resetReviewedPolicies(): void {
  TEST_REVIEWED_POLICIES.length = 0;
}

export interface ResumeApplyScenario {
  companyId: string;
  agentId: string;
  missionId: string;
  workflowId: string;
  runId: string;
  definitionHash: string;
  stepRunIds: Record<string, string>;
}

const APPLY_STEPS_JSON = [
  {
    id: "gate",
    name: "Gate",
    agentId: "",
    type: "if",
    conditionGroup: { kind: "if", expression: "gate" },
    dependencies: [],
  },
  { id: "redo", name: "Redo", agentId: "agent-1", dependencies: ["gate"] },
  { id: "done", name: "Done", agentId: "", type: "complete", dependencies: ["redo"] },
  { id: "side", name: "Side branch", agentId: "agent-1", dependencies: [] },
];

/**
 * eligible resume 시나리오 시딩 — failed run(completed mission) + 무이력 affected steps +
 * gate 밖 분리 completed side step. frozen definition 은 실제 createWorkflowRun 캡처 경로로
 * 생성하고, 대응 reviewed policy fixture 를 TEST_REVIEWED_POLICIES 에 등록한다.
 */
export async function seedResumeApplyScenario(
  db: Db,
  sql: RawSql,
  prefix: string,
  opts: {
    missionStatus?: string;
    runStatus?: string;
    base?: { companyId: string; agentId: string };
  } = {},
): Promise<ResumeApplyScenario> {
  const base = opts.base ?? (await seedCompanyWithMission(sql, prefix));
  const { companyId, agentId } = base;
  let missionId = (base as { missionId?: string }).missionId;
  if (!missionId) {
    // 같은 company 의 별도 mission(cross-scope 시나리오용) — seedCompanyWithMission 의 mission INSERT 와 동일.
    missionId = randomUUID();
    await sql`INSERT INTO missions (id, company_id, owner_agent_id, title) VALUES (${missionId}, ${companyId}, ${agentId}, ${"ResumeApply Mission " + prefix})`;
  }
  const workflowId = await seedWorkflowDefinition(sql, {
    companyId,
    name: `resume-apply-${prefix}`,
    stepsJson: APPLY_STEPS_JSON,
  });
  const run = await createWorkflowRun(db, {
    workflowId,
    companyId,
    missionId,
    triggeredBy: "resume-apply-test",
  } as Parameters<typeof createWorkflowRun>[1]);
  await db.update(workflowRuns).set({
    status: opts.runStatus ?? "failed",
    startedAt: new Date("2026-09-07T09:00:00.000Z"),
    completedAt: new Date("2026-09-07T09:40:00.000Z"),
    dispatchAuthorityVersion: 5,
    metadata: { customKeeper: { nested: "value" }, staleFlag: true },
  }).where(eq(workflowRuns.id, run.id));
  const missionCompleted = (opts.missionStatus ?? "completed") === "completed";
  await db.update(missions).set({
    status: opts.missionStatus ?? "completed",
    startedAt: new Date("2026-09-07T08:00:00.000Z"),
    completedAt: missionCompleted ? new Date("2026-09-07T09:41:00.000Z") : null,
    updatedAt: new Date("2026-09-07T09:41:00.000Z"),
  }).where(eq(missions.id, missionId!));
  const gate = await db.insert(workflowStepRuns).values({
    workflowRunId: run.id,
    stepId: "gate",
    status: "pending",
    executionGeneration: 4,
    statusTransitionVersion: 6,
    retryCount: 2,
    iterationIndex: 3,
    metadata: { customNote: "preserve-me", controlNodeError: "stale" },
  }).returning();
  const redo = await db.insert(workflowStepRuns).values({
    workflowRunId: run.id,
    stepId: "redo",
    status: "failed",
    executionGeneration: 2,
    statusTransitionVersion: 9,
    retryCount: 5,
    iterationIndex: 1,
    originalStatus: "running",
    agentName: "agent-x",
    dispatchAuthorityKind: "wakeup",
    metadata: { customLevel: { deep: { value: 42 } } },
  }).returning();
  const done = await db.insert(workflowStepRuns).values({
    workflowRunId: run.id,
    stepId: "done",
    status: "skipped",
    executionGeneration: 0,
    statusTransitionVersion: 1,
    metadata: {},
  }).returning();
  const side = await db.insert(workflowStepRuns).values({
    workflowRunId: run.id,
    stepId: "side",
    status: "completed",
    executionGeneration: 7,
    statusTransitionVersion: 8,
    metadata: { sideNote: "outside" },
  }).returning();
  const definition = await loadExecutionDefinition(db, run.id, { requireHistorical: true });
  TEST_REVIEWED_POLICIES.push({
    schemaVersion: 1,
    companyId,
    definitionHash: definition.definitionHash,
    steps: {
      gate: { effect: "none", toolBindings: [] },
      redo: { effect: "none", toolBindings: [] },
      done: { effect: "none", toolBindings: [] },
      side: { effect: "none", toolBindings: [] },
    },
    requiredGateStepIds: [],
    publicationStepIds: [],
    generationStepIds: [],
  });
  return {
    companyId,
    agentId,
    missionId,
    workflowId,
    runId: run.id,
    definitionHash: definition.definitionHash,
    stepRunIds: { gate: gate[0]!.id, redo: redo[0]!.id, done: done[0]!.id, side: side[0]!.id },
  };
}

export function boardActor(companyId: string): Express.Request["actor"] {
  return { type: "board", source: "session", userId: "user-apply-1", companyIds: [companyId], isInstanceAdmin: false };
}

export function crossCompanyBoardActor(): Express.Request["actor"] {
  return { type: "board", source: "session", userId: "user-apply-1", companyIds: [randomUUID()], isInstanceAdmin: false };
}

export function agentActor(companyId: string): Express.Request["actor"] {
  return { type: "agent", companyId, source: "agent_key" };
}

export function noneActor(): Express.Request["actor"] {
  return { type: "none" };
}

export function applySigner(now: Date): { key: Buffer; now(): Date } {
  return { key: createHash("sha256").update("resume-apply-test-key").digest(), now: () => now };
}

export function resumeApplyBody(
  scenario: ResumeApplyScenario,
  input: { token: string; idempotencyKey?: string; reason?: string; startStepId?: string },
): ResumeRequestBody {
  return {
    schemaVersion: 1,
    mode: "resume_from_step",
    companyId: scenario.companyId,
    missionId: scenario.missionId,
    workflowRunId: scenario.runId,
    startStepId: input.startStepId ?? "gate",
    snapshotToken: input.token,
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    reason: input.reason ?? "resume after partial failure",
  };
}

type Row = Record<string, unknown>;

export async function loadApplyRunRow(sql: RawSql, runId: string): Promise<Row | undefined> {
  const rows = await sql`SELECT * FROM workflow_runs WHERE id = ${runId}`;
  return rows[0] as Row | undefined;
}

export async function loadApplyStepRun(sql: RawSql, id: string): Promise<Row | undefined> {
  const rows = await sql`SELECT * FROM workflow_step_runs WHERE id = ${id}`;
  return rows[0] as Row | undefined;
}

export async function loadApplyMissionRow(sql: RawSql, missionId: string): Promise<Row | undefined> {
  const rows = await sql`SELECT * FROM missions WHERE id = ${missionId}`;
  return rows[0] as Row | undefined;
}

export async function loadApplyRequestRows(sql: RawSql, runId: string): Promise<Row[]> {
  return await sql`SELECT * FROM workflow_resume_requests WHERE workflow_run_id = ${runId} ORDER BY id` as Row[];
}

export async function loadApplyActivityRows(sql: RawSql, runId: string): Promise<Row[]> {
  return await sql`SELECT * FROM activity_log WHERE entity_type = 'workflow_run' AND entity_id = ${runId} ORDER BY id` as Row[];
}

export async function loadApplyTransitionEvents(sql: RawSql, requestId: string): Promise<Row[]> {
  return await sql`SELECT * FROM workflow_transition_events WHERE idempotency_key LIKE ${`resume:${requestId}:%`} ORDER BY id` as Row[];
}

export async function countApplyResumeExecutions(sql: RawSql, requestId: string): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS count FROM workflow_resume_executions WHERE request_id = ${requestId}`;
  return (rows[0] as { count: number }).count;
}

export async function countApplyIssues(sql: RawSql, companyId: string): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS count FROM issues WHERE company_id = ${companyId}`;
  return (rows[0] as { count: number }).count;
}
