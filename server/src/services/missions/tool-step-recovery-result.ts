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

async function findMissionScopedIssueByRef(
  db: Db,
  companyId: string,
  missionId: string,
  targetRef: string,
): Promise<RecoveryScopeIssue | null> {
  if (!targetRef) return null;
  const rows = await db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      eq(issues.missionId, missionId),
    ));
  return rows.find((row) =>
    targetRef === normalizedRef(row.id) || targetRef === normalizedRef(row.identifier),
  ) ?? null;
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
  // [스코프] owner action 이슈/원천 이슈 외에, 같은 미션(companyId+missionId) 내 이슈도 targetRef 로
  // 지정할 수 있다. 실제 운영에서 recover_artifact 판단은 산출물이 등록된 생산자 이슈(워크플로우 스텝
  // 이슈)를 reworkTargetRef 로 지정하며, 그 이슈는 recovery/source 이슈가 아닌 경우가 있다.
  // 스코프 확장 이후에도 동일한 fail-closed 검증이 그대로 따른다: 대상 이슈의 active workProduct +
  // issue.workflow_artifact_registered 공식 등록 활동 로그 매칭(+ workProduct 조인의 미션 스코프).
  const targetIssue = [
    input.ownerActionIssue,
    ...(input.sourceIssue ? [input.sourceIssue] : []),
  ].find((scope) =>
    targetRef === normalizedRef(scope.id) || targetRef === normalizedRef(scope.identifier),
  ) ?? await findMissionScopedIssueByRef(input.db, input.companyId, input.missionId, targetRef);
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
