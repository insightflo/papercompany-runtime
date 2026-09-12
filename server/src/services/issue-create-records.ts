// server/src/services/issue-create-records.ts
//
// [purpose] T3 §2 정식 기록·감사 추출. 이슈 생성의 DB 전용 코어(counter/identifier/labels/goal·
//   workspace 해석)를 담는다. 부작용(깨우기·live 이벤트)이 없어 정식 생성 트랜잭션 안에서
//   쓸 수 있다. 기존 issues.ts 생성 경로는 같은 함수를 재사용한다(의미 불변).
// [authority] counter 증가는 companies 행 UPDATE 가 직렬화한다. 회사 스코프 조건이 항상 붙는다.

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, issueLabels, issues, labels, projectWorkspaces, projects } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import {
  defaultIssueExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  parseProjectExecutionWorkspacePolicy,
} from "./execution-workspace-policy.js";
import { resolveIssueGoalId } from "./issue-goal-fallback.js";
import { getDefaultCompanyGoal } from "./goals.js";

export type IssueWriteDb = Pick<Db, "select" | "insert" | "update" | "delete">;
type ProjectGoalReader = Pick<Db, "select">;

export type IssueGroupPhase = "plan" | "action" | "qa" | "oversight";

const ISSUE_GROUP_PREFIX_RE = /^\s*\[(plan|action|qa|oversight)\]/iu;

export function classifyIssueGroupPhase(input: {
  originKind?: string | null;
  title?: string | null;
}): IssueGroupPhase | null {
  const prefix = ISSUE_GROUP_PREFIX_RE.exec(input.title ?? "");
  if (prefix) return prefix[1]!.toLowerCase() as IssueGroupPhase;

  const originKind = (input.originKind ?? "").toLowerCase();
  if (originKind.includes("oversight") || originKind.includes("unblock")) return "oversight";
  if (originKind.includes("qa") || originKind.includes("validation") || originKind.includes("validator")) return "qa";
  if (originKind.includes("action") || originKind.includes("source") || originKind.includes("worker")) return "action";
  if (originKind.includes("plan")) return "plan";
  return null;
}

function isMissionLevelGroupedIssue(data: {
  missionId?: string | null;
  parentId?: string | null;
  originKind?: string | null;
  title?: string | null;
}) {
  if (!data.missionId || data.parentId) return false;
  const group = classifyIssueGroupPhase(data);
  return group === "action" || group === "qa" || group === "oversight";
}

export { isMissionLevelGroupedIssue };

function assertAgentDoesNotCreateLooseMissionStructureIssue(data: Omit<typeof issues.$inferInsert, "companyId">) {
  if (!data.createdByAgentId) return;
  if (!isMissionLevelGroupedIssue(data)) return;

  const group = classifyIssueGroupPhase(data);
  throw unprocessable(
    `Agent-created mission-level ${group?.toUpperCase() ?? "work"} issues must be materialized through the mission structure layer and server-native DAG, not created as loose issues. Post a structured Mission owner plan decision instead.`,
  );
}

export async function getProjectDefaultGoalId(
  db: ProjectGoalReader,
  companyId: string,
  projectId: string | null | undefined,
) {
  if (!projectId) return null;
  const row = await db
    .select({ goalId: projects.goalId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return row?.goalId ?? null;
}

export async function assertValidLabelIds(companyId: string, labelIds: string[], dbOrTx: IssueWriteDb) {
  if (labelIds.length === 0) return;
  const existing = await dbOrTx
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.companyId, companyId), inArray(labels.id, labelIds)));
  if (existing.length !== new Set(labelIds).size) {
    throw unprocessable("One or more labels are invalid for this company");
  }
}

export async function syncIssueLabels(
  issueId: string,
  companyId: string,
  labelIds: string[],
  dbOrTx: IssueWriteDb,
) {
  const deduped = [...new Set(labelIds)];
  await assertValidLabelIds(companyId, deduped, dbOrTx);
  await dbOrTx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
  if (deduped.length === 0) return;
  await dbOrTx.insert(issueLabels).values(
    deduped.map((labelId) => ({
      issueId,
      labelId,
      companyId,
    })),
  );
}

/**
 * 이슈 DB 기록 생성. 부작용 없음(깨우기·이벤트 없음). counter/identifier 는 companies 행
 * UPDATE 로 원자적으로 발급한다. labels 는 명시된 경우에만 동기화한다(기본 라벨 없음).
 */
export async function createIssueRecord(
  dbOrTx: IssueWriteDb,
  companyId: string,
  data: Omit<typeof issues.$inferInsert, "companyId"> & { labelIds?: string[] },
  isolatedWorkspacesEnabled: boolean,
) {
  const { labelIds: inputLabelIds, ...issueData } = data;
  assertAgentDoesNotCreateLooseMissionStructureIssue(issueData);
  const defaultCompanyGoal = await getDefaultCompanyGoal(dbOrTx, companyId);
  const projectGoalId = await getProjectDefaultGoalId(dbOrTx, companyId, issueData.projectId);
  let executionWorkspaceSettings =
    (issueData.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null;
  if (executionWorkspaceSettings == null && issueData.projectId) {
    const project = await dbOrTx
      .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
      .from(projects)
      .where(and(eq(projects.id, issueData.projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    executionWorkspaceSettings =
      defaultIssueExecutionWorkspaceSettingsForProject(
        gateProjectExecutionWorkspacePolicy(
          parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy),
          isolatedWorkspacesEnabled,
        ),
      ) as Record<string, unknown> | null;
  }
  let projectWorkspaceId = issueData.projectWorkspaceId ?? null;
  if (!projectWorkspaceId && issueData.projectId) {
    const project = await dbOrTx
      .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
      .from(projects)
      .where(and(eq(projects.id, issueData.projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    const projectPolicy = parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy);
    projectWorkspaceId = projectPolicy?.defaultProjectWorkspaceId ?? null;
    if (!projectWorkspaceId) {
      projectWorkspaceId = await dbOrTx
        .select({ id: projectWorkspaces.id })
        .from(projectWorkspaces)
        .where(and(eq(projectWorkspaces.projectId, issueData.projectId), eq(projectWorkspaces.companyId, companyId)))
        .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
        .then((rows) => rows[0]?.id ?? null);
    }
  }
  // Self-heal against rows that bypassed the counter (imports/manual inserts):
  // align to the company's max existing issue_number before incrementing, so a
  // lagging counter can never mint a duplicate identifier (issues_identifier_idx)
  // and wedge every future issue creation behind a rolling-back 500.
  const [company] = await dbOrTx
    .update(companies)
    .set({
      issueCounter: sql`GREATEST(
        ${companies.issueCounter},
        (SELECT COALESCE(MAX(${issues.issueNumber}), 0) FROM ${issues} WHERE ${issues.companyId} = ${companies.id})
      ) + 1`,
    })
    .where(eq(companies.id, companyId))
    .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });

  const issueNumber = company.issueCounter;
  const identifier = `${company.issuePrefix}-${issueNumber}`;

  const values = {
    ...issueData,
    originKind: issueData.originKind ?? "manual",
    goalId: resolveIssueGoalId({
      projectId: issueData.projectId,
      goalId: issueData.goalId ?? projectGoalId,
      defaultGoalId: defaultCompanyGoal?.id ?? null,
    }),
    ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
    ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
    companyId,
    issueNumber,
    identifier,
  } as typeof issues.$inferInsert;
  if (values.status === "in_progress" && !values.startedAt) {
    values.startedAt = new Date();
  }
  if (values.status === "done") {
    values.completedAt = new Date();
  }
  if (values.status === "cancelled") {
    values.cancelledAt = new Date();
  }

  const [issue] = await dbOrTx.insert(issues).values(values).returning();
  if (inputLabelIds) {
    await syncIssueLabels(issue.id, companyId, inputLabelIds, dbOrTx);
  }
  return issue;
}
