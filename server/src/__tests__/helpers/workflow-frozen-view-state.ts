import { randomUUID } from "node:crypto";
import {
  issueComments,
  issueWorkProducts,
  issues,
  pluginEntities,
  plugins,
  type Db,
} from "@paperclipai/db";
import type { RawSql } from "./workflow-execution-definition-fixture.js";

/**
 * [목적] Task5a2e mission run view/digest frozen 테스트 보조. 승인된 5a1/5a2a/5a2d fixture
 *   는 import 로만 재사용(수정 금지)하고, read-only 증명용 관련 테이블 전체 행 스냅샷과
 *   blocked issue/comment, workproduct(location 렌더 검증), plugin run entity 시딩만 추가한다.
 *   mock DB/loader 없음 — 실제 임베디드 PostgreSQL 대상이다.
 */

const VIEW_STATE_TABLES = [
  "workflow_runs",
  "workflow_definitions",
  "workflow_run_definitions",
  "workflow_step_runs",
  "issues",
  "issue_work_products",
  "issue_comments",
  "issue_execution_cards",
  "activity_log",
  "workflow_transition_events",
] as const;

export type WorkflowViewState = Record<(typeof VIEW_STATE_TABLES)[number], unknown[]>;

/** read-only 증명: view/digest read 전후의 관련 테이블 전체 행 스냅샷(깊은 비교 대상). */
export async function captureWorkflowViewState(sql: RawSql, missionId: string): Promise<WorkflowViewState> {
  const state = {} as WorkflowViewState;
  for (const table of VIEW_STATE_TABLES) {
    // 테이블명은 위 고정 상수 화이트리스트(외부 입력 없음)이므로 unsafe 보간이 안전하다.
    state[table] = await sql.unsafe(`SELECT * FROM ${table} ORDER BY 1`);
  }
  return state;
}

/** digest/view 테스트용 blocked source issue + 최신 signal comment(작성 주체는 시스템 test user). */
export async function seedBlockedIssueWithSignal(
  db: Db,
  input: {
    companyId: string;
    missionId?: string | null;
    identifier: string;
    title?: string;
    commentBody: string;
    commentAt: Date;
  },
) {
  const [issue] = await db.insert(issues).values({
    id: randomUUID(),
    companyId: input.companyId,
    ...(input.missionId ? { missionId: input.missionId } : {}),
    title: input.title ?? "Blocked source issue",
    status: "blocked",
    identifier: input.identifier,
    originKind: "workflow_execution",
  }).returning();
  await db.insert(issueComments).values({
    companyId: input.companyId,
    issueId: issue!.id,
    authorUserId: "frozen-view-test",
    body: input.commentBody,
    createdAt: input.commentAt,
  });
  return issue!;
}

/** digest workproduct 렌더(location=url 우선) 검증용 url + metadata.path 행. */
export async function seedFrozenWorkProductWithPath(
  db: Db,
  input: { companyId: string; issueId: string; title: string; url: string; path: string; updatedAt: Date },
): Promise<void> {
  await db.insert(issueWorkProducts).values({
    companyId: input.companyId,
    issueId: input.issueId,
    type: "artifact",
    provider: "frozen-view-test",
    title: input.title,
    url: input.url,
    status: "active",
    isPrimary: true,
    metadata: { path: input.path },
    updatedAt: input.updatedAt,
  });
}

/** plugin entity 기반 workflow run(정의/run/stepRun)을 같은 mission 에 붙인다 — plugin branch 회귀 가드용. */
export async function seedPluginWorkflowRunEntity(
  db: Db,
  input: {
    companyId: string;
    missionId: string;
    workflowName: string;
    stepId: string;
    stepName: string;
    issueId?: string;
  },
): Promise<{ pluginRunId: string }> {
  const pluginId = randomUUID();
  const workflowId = randomUUID();
  const runId = randomUUID();
  await db.insert(plugins).values({
    id: pluginId,
    pluginKey: `frozen-view-${pluginId}`,
    packageName: "@frozen/view-engine",
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    manifestJson: { id: pluginId, name: "Frozen View Engine", version: "1.0.0" },
    status: "ready",
  });
  await db.insert(pluginEntities).values([
    {
      id: workflowId,
      pluginId,
      entityType: "workflow-definition",
      scopeKind: "company",
      scopeId: input.companyId,
      externalId: `workflow-definition:${workflowId}`,
      title: input.workflowName,
      status: "active",
      data: {
        name: input.workflowName,
        companyId: input.companyId,
        status: "active",
        steps: [{ id: input.stepId, name: input.stepName, agentId: "", dependencies: [] }],
      },
    },
    {
      id: runId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: input.companyId,
      externalId: `workflow-run:${runId}`,
      title: `${input.workflowName} run`,
      status: "running",
      data: {
        workflowId,
        workflowName: input.workflowName,
        companyId: input.companyId,
        missionId: input.missionId,
        status: "running",
        triggerSource: "plugin",
      },
    },
    {
      id: randomUUID(),
      pluginId,
      entityType: "workflow-step-run",
      scopeKind: "company",
      scopeId: input.companyId,
      externalId: `${runId}:${input.stepId}`,
      title: input.stepId,
      status: "in_progress",
      data: {
        runId,
        stepId: input.stepId,
        ...(input.issueId ? { issueId: input.issueId } : {}),
        status: "in_progress",
      },
    },
  ]);
  return { pluginRunId: runId };
}
