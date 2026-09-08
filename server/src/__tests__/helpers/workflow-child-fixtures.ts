// server/src/__tests__/helpers/workflow-child-fixtures.ts
//
// [purpose] descope v1 workflow-child-* 테스트 공용 기반 fixture(0101). embedded PG 회사/정의/
//   run/step-run 생성기. db 는 호출부가 넘긴다(파일별 독립 인스턴스). 자식 상태 삽입(linked/
//   tombstone/materialized/임대/grandchild)은 workflow-child-invocation-fixtures.ts 전용.
import { randomUUID } from "node:crypto";
import type { createDb } from "@paperclipai/db";
import {
  agents,
  companies,
  workflowDefinitions,
  workflowRuns,
} from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";

type TestDb = ReturnType<typeof createDb>;

let testDb: TestDb;

/** 파일별 beforeAll 에서 한 번 설정한다. */
export function configureWorkflowChildFixtures(db: TestDb): void {
  testDb = db;
}

export async function createCompanyFixture(name: string): Promise<string> {
  const db = testDb;
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name,
    issuePrefix: name.slice(0, 2).toUpperCase() + companyId.replace(/-/g, "").slice(0, 4).toUpperCase(),
    requireBoardApprovalForNewAgents: false,
  });
  // ensureMissionForWorkflowRun (trigger 경로) 이 owner agent 를 요구한다.
  await db.insert(agents).values({
    companyId,
    name: `${name} Owner`,
  });
  return companyId;
}

export type ChildStepOverrides = {
  targetWorkflowId?: string;
  /** descope v1: true 또는 생략만 법정 — false 는 검증에서 거부된다(이 오버라이드는 true 전달용). */
  wait?: true;
  inputs?: Record<string, string>;
};

export function childStep(
  targetWorkflowId: string,
  overrides: ChildStepOverrides = {},
): Record<string, unknown> {
  return {
    id: "run-child",
    name: "Run child workflow",
    type: "workflow",
    dependencies: [],
    targetWorkflowId,
    ...(overrides.wait === undefined ? {} : { wait: overrides.wait }),
    ...(overrides.inputs === undefined ? {} : { inputs: overrides.inputs }),
  };
}

export async function insertDefinition(input: {
  companyId: string;
  name: string;
  steps: unknown[];
}): Promise<string> {
  const db = testDb;
  const id = randomUUID();
  await db.insert(workflowDefinitions).values({
    id,
    companyId: input.companyId,
    name: input.name,
    stepsJson: input.steps,
  });
  return id;
}

export type RunFixture = {
  runId: string;
  stepRunId: string;
};

export async function insertRunWithWorkflowStepRun(input: {
  companyId: string;
  workflowId: string;
  stepId?: string;
  stepStatus?: string;
  retryCount?: number;
  metadata?: Record<string, unknown>;
  parentRunId?: string;
  rootRunId?: string;
}): Promise<RunFixture> {
  const db = testDb;
  const runId = randomUUID();
  await db.insert(workflowRuns).values({
    id: runId,
    workflowId: input.workflowId,
    companyId: input.companyId,
    status: "running",
    triggeredBy: "board",
    startedAt: new Date(),
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    ...(input.rootRunId ? { rootRunId: input.rootRunId } : {}),
  });
  const stepRunId = await insertStepRunForRun({
    runId,
    stepId: input.stepId ?? "run-child",
    status: input.stepStatus ?? "pending",
    retryCount: input.retryCount,
    metadata: input.metadata,
  });
  return { runId, stepRunId };
}

/** 임의 run 의 스텝 행 — 중간 run(자식이 부모가 되는 grandchild 경로)에도 사용한다. */
export async function insertStepRunForRun(input: {
  runId: string;
  stepId: string;
  status?: string;
  retryCount?: number;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const db = testDb;
  const stepRunId = randomUUID();
  await db.insert(workflowStepRuns).values({
    id: stepRunId,
    workflowRunId: input.runId,
    stepId: input.stepId,
    status: input.status ?? "pending",
    retryCount: input.retryCount ?? 0,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  return stepRunId;
}
