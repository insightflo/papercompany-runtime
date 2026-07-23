import { activityLog, issueWorkProducts, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";
import { loadLatestMissionOwnerDecision } from "./mission-owner-recovery-ledger.js";

// server/src/services/missions/tool-step-recovery-result.ts
//
// [목적] native tool step recovery result 의 구조적 권위. 자연어 success/comment 텍스트에서
// recovery 성공을 추론하던 parser 를 제거하고 fail-closed 한다. failed → success 전환은
// 오직 구조 owner-recovery decision 과 Workflow API 로 등록된 active workProduct 에서만 허용된다.
export type NativeToolStepRecoveryMarkerInput = {
  readonly ownerActionIssueId: string;
  readonly workflowRunId: string;
  readonly stepId: string;
};

export type NativeToolStepRecoveryResult = {
  readonly artifactPath: string;
};

export type AuthorizedNativeToolStepRecovery = NativeToolStepRecoveryResult & {
  readonly decisionEventId: string;
  readonly workProductId: string;
};

type RecoveryScopeIssue = {
  readonly id: string;
  readonly identifier: string | null;
};

function normalizedRef(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function workProductArtifactPath(workProduct: {
  readonly id: string;
  readonly externalId: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly url: string | null;
}): string {
  const metadataPath = typeof workProduct.metadata?.path === "string"
    ? workProduct.metadata.path.trim()
    : "";
  return metadataPath || workProduct.externalId || workProduct.url || `work-product:${workProduct.id}`;
}

function isWorkflowApiRegistration(details: Record<string, unknown> | null, workProductId: string): boolean {
  return details?.workProductId === workProductId;
}

export async function loadAuthorizedNativeToolStepRecovery(input: {
  readonly db: Db;
  readonly companyId: string;
  readonly missionId: string;
  readonly missionOwnerAgentId: string;
  readonly ownerActionIssue: RecoveryScopeIssue & { readonly originId: string | null };
  readonly sourceIssue: RecoveryScopeIssue | null;
}): Promise<AuthorizedNativeToolStepRecovery | null> {
  const decisionRecord = await loadLatestMissionOwnerDecision({
    db: input.db,
    companyId: input.companyId,
    ownerActionIssueId: input.ownerActionIssue.id,
  });
  if (
    !decisionRecord
    || decisionRecord.missionId !== input.missionId
    || decisionRecord.authorAgentId !== input.missionOwnerAgentId
    || decisionRecord.decision.decision !== "recover_artifact"
    || decisionRecord.sourceIssueId !== input.ownerActionIssue.originId
  ) {
    return null;
  }

  const targetRef = normalizedRef(
    decisionRecord.decision.reworkTargetRef ?? decisionRecord.decision.sourceIssueRef,
  );
  const scopes = [
    input.ownerActionIssue,
    ...(input.sourceIssue ? [input.sourceIssue] : []),
  ];
  const targetIssue = scopes.find((scope) =>
    targetRef === normalizedRef(scope.id) || targetRef === normalizedRef(scope.identifier),
  );
  if (!targetIssue) return null;

  const workProducts = await input.db
    .select({
      id: issueWorkProducts.id,
      externalId: issueWorkProducts.externalId,
      metadata: issueWorkProducts.metadata,
      url: issueWorkProducts.url,
    })
    .from(issueWorkProducts)
    .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
    .where(and(
      eq(issueWorkProducts.companyId, input.companyId),
      eq(issueWorkProducts.issueId, targetIssue.id),
      eq(issueWorkProducts.status, "active"),
      eq(issues.companyId, input.companyId),
      eq(issues.missionId, input.missionId),
    ))
    .orderBy(desc(issueWorkProducts.updatedAt), desc(issueWorkProducts.id))
    .limit(8);

  for (const workProduct of workProducts) {
    const registration = await input.db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.action, "issue.workflow_artifact_registered"),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, targetIssue.id),
      ))
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(16);
    if (!registration.some((row) => isWorkflowApiRegistration(row.details, workProduct.id))) continue;
    return {
      artifactPath: workProductArtifactPath(workProduct),
      decisionEventId: decisionRecord.eventId,
      workProductId: workProduct.id,
    };
  }

  return null;
}

// Display-only compatibility marker. Production supervision uses durable workflow state instead.
export function buildNativeToolStepRecoveryResultAppliedMarker(input: NativeToolStepRecoveryMarkerInput): string {
  return `<!-- native-tool-step-recovery-result-applied:${JSON.stringify(input)} -->`;
}

// Display-only compatibility helper. It must not be used as execution authority.
export function hasNativeToolStepRecoveryResultAppliedMarker(
  comments: readonly string[],
  input: NativeToolStepRecoveryMarkerInput,
): boolean {
  return comments.some((comment) => comment.includes(buildNativeToolStepRecoveryResultAppliedMarker(input)));
}

// [fail-closed] 자연어 success comment(### Native tool step recovery result / Status: success /
// [ARTIFACT]: <path>) 는 recovery 성공의 권위가 아니다.
export function resolveNativeToolStepRecoveryResult(_input: {
  readonly comments: readonly string[];
  readonly artifactExists?: (artifactPath: string) => boolean;
}): NativeToolStepRecoveryResult | null {
  return null;
}
