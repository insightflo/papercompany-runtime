import { and, desc, eq, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  issues,
  issueWorkProducts,
  workflowStepRuns,
} from "@paperclipai/db";

export type DelegatedChildIssue = {
  readonly id: string;
  readonly companyId: string;
  readonly missionId: string | null;
  readonly parentId: string | null;
  readonly identifier: string | null;
  readonly title: string;
};

export type DelegatedChildWorkProduct = {
  readonly id: string;
  readonly issueId: string;
  readonly companyId: string;
  readonly type: string;
  readonly provider: string;
  readonly externalId: string | null;
  readonly title: string;
  readonly url: string | null;
  readonly status: string;
};

export type DelegatedParentIssue = {
  readonly id: string;
  readonly companyId: string;
  readonly missionId: string | null;
  readonly parentId: string | null;
  readonly identifier: string | null;
  readonly title: string;
  readonly status: string;
  readonly originKind: string | null;
  readonly assigneeAgentId: string | null;
  readonly hiddenAt: Date | null;
};

export type DelegatedParentStepRun = {
  readonly id: string;
  readonly workflowRunId: string;
  readonly stepId: string;
  readonly status: string;
};

export async function loadDelegatedChildIssue(
  db: Db,
  childIssueId: string,
): Promise<DelegatedChildIssue | null> {
  return db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      missionId: issues.missionId,
      parentId: issues.parentId,
      identifier: issues.identifier,
      title: issues.title,
    })
    .from(issues)
    .where(eq(issues.id, childIssueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function loadActiveChildWorkProduct(
  db: Db,
  input: { readonly childIssue: DelegatedChildIssue; readonly childWorkProductId: string },
): Promise<DelegatedChildWorkProduct | null> {
  return db
    .select({
      id: issueWorkProducts.id,
      issueId: issueWorkProducts.issueId,
      companyId: issueWorkProducts.companyId,
      type: issueWorkProducts.type,
      provider: issueWorkProducts.provider,
      externalId: issueWorkProducts.externalId,
      title: issueWorkProducts.title,
      url: issueWorkProducts.url,
      status: issueWorkProducts.status,
    })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.id, input.childWorkProductId),
      eq(issueWorkProducts.issueId, input.childIssue.id),
      eq(issueWorkProducts.companyId, input.childIssue.companyId),
      eq(issueWorkProducts.status, "active"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function loadDelegatedParentIssue(
  db: Db,
  input: { readonly parentIssueId: string; readonly companyId: string },
): Promise<DelegatedParentIssue | null> {
  return db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      missionId: issues.missionId,
      parentId: issues.parentId,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      originKind: issues.originKind,
      assigneeAgentId: issues.assigneeAgentId,
      hiddenAt: issues.hiddenAt,
    })
    .from(issues)
    .where(and(eq(issues.id, input.parentIssueId), eq(issues.companyId, input.companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function parentHasActiveWorkProduct(
  db: Db,
  parentIssue: DelegatedParentIssue,
): Promise<boolean> {
  return db
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, parentIssue.companyId),
      eq(issueWorkProducts.issueId, parentIssue.id),
      eq(issueWorkProducts.status, "active"),
    ))
    .limit(1)
    .then((rows) => Boolean(rows[0]));
}

export async function loadDelegatedParentStepRun(
  db: Db,
  parentIssue: DelegatedParentIssue,
): Promise<DelegatedParentStepRun | null> {
  return db
    .select({
      id: workflowStepRuns.id,
      workflowRunId: workflowStepRuns.workflowRunId,
      stepId: workflowStepRuns.stepId,
      status: workflowStepRuns.status,
    })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.issueId, parentIssue.id))
    .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt), desc(workflowStepRuns.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function hasExistingHandbackDispatch(
  db: Db,
  input: {
    readonly parentIssue: DelegatedParentIssue;
    readonly childWorkProduct: DelegatedChildWorkProduct;
    readonly idempotencyKey: string;
  },
): Promise<boolean> {
  const assigneeAgentId = input.parentIssue.assigneeAgentId;
  if (!assigneeAgentId) return false;

  const existingHandback = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.parentIssue.companyId),
      eq(activityLog.action, "issue.delegated_artifact_handback_ready"),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.parentIssue.id),
      sql`${activityLog.details} ->> 'idempotencyKey' = ${input.idempotencyKey}`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existingHandback) return true;

  return db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.parentIssue.companyId),
      eq(agentWakeupRequests.agentId, assigneeAgentId),
      or(
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        and(
          eq(agentWakeupRequests.issueId, input.parentIssue.id),
          sql`${agentWakeupRequests.payload} ->> 'childWorkProductId' = ${input.childWorkProduct.id}`,
        ),
      ),
    ))
    .limit(1)
    .then((rows) => Boolean(rows[0]));
}
