import { and, desc, eq } from "drizzle-orm";
import { missionPlanArtifacts, missions, workflowDefinitions, workflowRuns, type Db } from "@paperclipai/db";
import { missionRevisionDeltaSchema } from "@paperclipai/shared/validators/mission-revision";
import { computePaqoDefinitionHash } from "../workflow/paqo-definition-identity.js";
import { readPlanQaVerdict } from "./mission-plan-qa-completion-gate.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Derived from scoped durable definition + current structured QA authority; display marker is ignored. */
export async function loadRevisionBoardWait(db: Db, companyId: string, missionId: string) {
  const [mission] = await db.select().from(missions).where(and(eq(missions.id, missionId), eq(missions.companyId, companyId)));
  if (!mission?.sourceMissionId) return null;
  const [plan] = await db.select().from(missionPlanArtifacts).where(and(eq(missionPlanArtifacts.companyId, companyId),
    eq(missionPlanArtifacts.missionId, missionId), eq(missionPlanArtifacts.status, "active")))
    .orderBy(desc(missionPlanArtifacts.revision)).limit(1);
  const refs = record(plan?.refs), paqo = record(refs.paqoWorkflow), qa = record(refs.planQa);
  const hash = record(refs.ownerPlanDecision).decisionHash;
  if (!plan || typeof paqo.workflowDefinitionId !== "string" || typeof hash !== "string"
    || paqo.decisionHash !== hash || qa.decisionHash !== hash || typeof qa.issueId !== "string") return null;
  const [definition] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.id, paqo.workflowDefinitionId),
    eq(workflowDefinitions.companyId, companyId), eq(workflowDefinitions.missionId, missionId), eq(workflowDefinitions.sourceKind, "paqo")));
  if (!definition?.definitionHash) return null;
  const [run] = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId),
    eq(workflowRuns.missionId, missionId), eq(workflowRuns.workflowId, definition.id))).limit(1);
  if (run || (await readPlanQaVerdict({ db, companyId, missionId, missionPlanArtifactId: plan.id,
    planQaIssueId: qa.issueId, decisionHash: hash }))?.verdict !== "pass") return null;
  return { workflowDefinitionId: definition.id, sourceMissionId: mission.sourceMissionId,
    sourceWorkflowRunId: mission.sourceWorkflowRunId, planArtifactId: plan.id, decisionHash: hash };
}

/** [Q7 시작시점 재확인] 활성 계획 refs 에 보존된 revisionDelta.base 의 현재 기준 정의 대조 결과. */
export type RevisionBaseDefinitionCheck =
  | { ok: true }
  | { ok: false; code: "workflow_revision_base_definition_changed";
    workflowDefinitionId: string | null; approvedSnapshotHash: string | null; currentSnapshotHash: string | null };

// [Q7 시작시점 기준 재확인] 제출 단계(revision-plan-delta.ts 의 기준 스냅샷 검사)에만 존재하던
//   revisionDelta.base 검사를 시작 경로에서 다시 실행한다. 활성 계획 refs 에 보존된 검증 통과 변경안의
//   base.workflowDefinitionId 를 같은 회사 스코프로 다시 읽어 제출 시와 동일한 동결 규칙 해시
//   (computePaqoDefinitionHash)로 현재 stepsJson 과 대조한다. 승인 뒤 기준 정의가 변경·삭제됐거나 저장된
//   변경안이 계약 형태와 더 이상 일치하지 않으면 확인 불능으로 거절 결과를 돌려주고(조용히 통과하지
//   않는다), 변경안이 없는 기존 수정 미션·일반 미션 경로는 그대로 통과한다(회귀 없음).
export async function verifyRevisionDeltaBaseAtStart(db: Db, companyId: string, missionId: string): Promise<RevisionBaseDefinitionCheck> {
  const [plan] = await db.select().from(missionPlanArtifacts).where(and(eq(missionPlanArtifacts.companyId, companyId),
    eq(missionPlanArtifacts.missionId, missionId), eq(missionPlanArtifacts.status, "active")))
    .orderBy(desc(missionPlanArtifacts.revision)).limit(1);
  const storedDelta = record(plan?.refs).revisionDelta;
  if (storedDelta === undefined || storedDelta === null) return { ok: true };
  const parsed = missionRevisionDeltaSchema.safeParse(storedDelta);
  if (!parsed.success) {
    return { ok: false, code: "workflow_revision_base_definition_changed", workflowDefinitionId: null,
      approvedSnapshotHash: null, currentSnapshotHash: null };
  }
  const [baseDefinition] = await db.select({ stepsJson: workflowDefinitions.stepsJson }).from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.companyId, companyId), eq(workflowDefinitions.id, parsed.data.base.workflowDefinitionId)))
    .limit(1);
  const currentSnapshotHash = baseDefinition
    ? computePaqoDefinitionHash(baseDefinition.stepsJson as Parameters<typeof computePaqoDefinitionHash>[0])
    : null;
  if (currentSnapshotHash !== parsed.data.base.snapshotHash) {
    return { ok: false, code: "workflow_revision_base_definition_changed",
      workflowDefinitionId: parsed.data.base.workflowDefinitionId,
      approvedSnapshotHash: parsed.data.base.snapshotHash, currentSnapshotHash };
  }
  return { ok: true };
}

export async function revisionBoardWaitingMissionIds(db: Db, companyId: string, missionIds: string[]) {
  const waiting = await Promise.all(missionIds.map(async id => await loadRevisionBoardWait(db, companyId, id) ? id : null));
  return new Set(waiting.filter((id): id is string => id !== null));
}
