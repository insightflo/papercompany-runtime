// server/src/services/missions/plan-qa-addendum-manifest.ts
//
// [파일 목적] T7 PLAN-QA 고정 명세 준비·고정. 검토 실행 시작 전에 전체 입력(선택 집합·원래 본문/해시·
//   plan 투영)과 추가 검사를 불변 StorageService 첨부로 고정한다. 재조회는 항상 고정 bytes(문서 계약과
//   읽기는 plan-qa-manifest-document.ts). [T9] 선택+정책 대상+base 일치 템플릿에는 활성 소비 연결
//   (quality_consumer_bindings)을 해석한다: 활성 버전이 있으면 그 불변 검사를 정책 required 위에 고정하고
//   철회·비활성이면(addendum_withdrawn) required 정책의 신규 검토 실행을 차단한다. 연결이 없으면 기존대로
//   정책 required 검사만 적용한다. 이미 고정된 진행 중 명세는 절대 바꾸지 않는다.
import { and, eq, isNotNull, isNull, desc } from "drizzle-orm";
import {
  activityLog, issues, missionPlanArtifacts, missionPlanTemplates, qualityPolicyVersions, type Db,
} from "@paperclipai/db";
import {
  qualityPolicySchema, type AddendumCheck, type ArtifactRef,
} from "@paperclipai/shared";
import { getStorageService, type PutFileResult } from "../../storage/index.js";
import { hashContract, type QualityTx } from "../quality/contract.js";
import { attachEvidence, uploadEvidence } from "../quality/evidence-store.js";
import { resolveActiveAddenda } from "../quality/adoption.js";
import { missionPlanTemplateContentHash } from "./mission-plan-template-selection.js";
import {
  MAX_PLAN_QA_MANIFEST_BYTES, planQaError, planQaManifestSchema,
  type PlanQaManifest, type PlanQaManifestTemplate,
} from "./plan-qa-manifest-document.js";

export { MAX_PLAN_QA_MANIFEST_BYTES };
export type { PlanQaManifest, PlanQaManifestTemplate } from "./plan-qa-manifest-document.js";
export { readPlanQaManifestDocument, readPlanQaManifestForIssue, readPinnedPlanQaManifest } from "./plan-qa-manifest-document.js";

type PlanRow = typeof missionPlanArtifacts.$inferSelect;

/** 검토 입력 투영: refs 는 review 입력 키(선택 단위·템플릿·의사결정·계획 보조) 허용 집합만 반영한다.
 *  planQa/paqoWorkflow/crossCompanyDelegations/workflowName/oversightIssueId 같은 실행·메타 출력은
 *  세대를 바꾸지 않는다. plan 내용/실행 단위가 바뀌면 hash 가 바뀐다. */
const PLAN_QA_INPUT_REF_KEYS = [
  "selectedExecutionUnits", "planTemplates", "ownerPlanDecision", "dynamicMissionPlanning",
  "selfImprovementCandidates", "ruleRefs", "kbRefs",
] as const;
export function buildPlanQaInput(plan: PlanRow, decisionHash: string) {
  const refs = (plan.refs && typeof plan.refs === "object" ? plan.refs : {}) as Record<string, unknown>;
  const contentRefs: Record<string, unknown> = {};
  for (const key of PLAN_QA_INPUT_REF_KEYS) {
    if (key in refs) contentRefs[key] = refs[key];
  }
  return {
    schemaVersion: 1 as const,
    missionId: plan.missionId,
    missionPlanArtifactId: plan.id,
    revision: plan.revision,
    decisionHash,
    missionGoal: plan.missionGoal ?? null,
    refs: contentRefs,
    steps: plan.steps ?? [],
    requiredInputs: plan.requiredInputs ?? [],
    successCriteria: plan.successCriteria ?? [],
    risks: plan.risks ?? [],
  };
}

export function planQaInputHashForPlan(plan: PlanRow, decisionHash: string): string {
  return hashContract(buildPlanQaInput(plan, decisionHash));
}
async function loadActivePolicy(db: Db, companyId: string) {
  const [row] = await db.select({ id: qualityPolicyVersions.id, definition: qualityPolicyVersions.definition })
    .from(qualityPolicyVersions)
    .where(and(eq(qualityPolicyVersions.companyId, companyId), isNotNull(qualityPolicyVersions.enabledAt), isNull(qualityPolicyVersions.disabledAt)))
    .orderBy(desc(qualityPolicyVersions.enabledAt))
    .limit(1);
  if (!row) return null;
  const parsed = qualityPolicySchema.safeParse(row.definition);
  if (!parsed.success) planQaError("quality_policy_inactive");
  return { policyVersionId: row.id, definition: parsed.data, definitionSha256: hashContract(row.definition) };
}

function selectedTemplateIdsFromRefs(refs: unknown): string[] {
  const items = (refs && typeof refs === "object" ? (refs as Record<string, unknown>).planTemplates : null);
  const list = (items && typeof items === "object" ? (items as Record<string, unknown>).items : null);
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is { id: string } => Boolean(item) && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string")
    .map((item) => item.id);
}

/** 정책이 같은 templateId 를 여러 base 로 target 하면 정의 순서에서 정확 hash 일치를 우선한다. */
function pickTarget(targets: { templateId: string; baseHash: string; required: AddendumCheck[] }[], templateId: string, bodyHash: string) {
  const matches = targets.filter((target) => target.templateId === templateId);
  return matches.find((target) => target.baseHash === bodyHash) ?? matches[0] ?? null;
}
export async function preparePlanQaManifest(db: Db, input: {
  companyId: string; missionId: string; planArtifactId: string; decisionHash: string; reviewGeneration: number;
}): Promise<{ manifest: PlanQaManifest; uploaded: PutFileResult; bytes: Buffer }> {
  const [plan] = await db.select().from(missionPlanArtifacts).where(and(
    eq(missionPlanArtifacts.companyId, input.companyId),
    eq(missionPlanArtifacts.missionId, input.missionId),
    eq(missionPlanArtifacts.id, input.planArtifactId),
  )).limit(1);
  if (!plan) planQaError("quality_plan_qa_plan_not_found");
  const refs = (plan.refs && typeof plan.refs === "object" ? plan.refs : {}) as Record<string, unknown>;
  const ownerHash = (refs.ownerPlanDecision as Record<string, unknown> | undefined)?.decisionHash;
  if (ownerHash !== input.decisionHash) planQaError("quality_plan_qa_decision_mismatch");

  const companyTemplates = await db.select().from(missionPlanTemplates).where(eq(missionPlanTemplates.companyId, input.companyId));
  const byId = new Map(companyTemplates.map((template) => [template.id, template]));
  const selectedIds = selectedTemplateIdsFromRefs(refs);
  if (new Set(selectedIds).size !== selectedIds.length) planQaError("quality_plan_qa_template_unavailable");
  for (const id of selectedIds) if (!byId.has(id)) planQaError("quality_plan_qa_template_unavailable");

  const policy = await loadActivePolicy(db, input.companyId);
  const targets = policy?.definition.targets ?? [];
  const allowedIds = new Set(companyTemplates.map((template) => template.id));
  for (const target of targets) {
    for (const checkEntry of target.required) {
      if (checkEntry.applicability.op === "selected_templates_all"
        && checkEntry.applicability.templateIds.some((id) => !allowedIds.has(id))) {
        planQaError("quality_plan_qa_applicability_out_of_set");
      }
    }
  }
  // [T9] 명시적 소비 연결 지점: 활성 적용 버전·철회 상태를 검토 생성 전에 함께 고정한다.
  const addenda = await resolveActiveAddenda(db, {
    companyId: input.companyId,
    targets: targets.map((target) => ({ templateId: target.templateId, baseHash: target.baseHash })),
  });

  const templates: PlanQaManifestTemplate[] = [];
  const seen = new Set<string>();
  const pushTemplate = (templateId: string, selected: boolean) => {
    if (seen.has(templateId)) return;
    const row = byId.get(templateId);
    if (!row) return;
    seen.add(templateId);
    const bodyHash = missionPlanTemplateContentHash(row.instructions);
    const target = pickTarget(targets, templateId, bodyHash);
    // 선택+정책 대상+base 일치 → applied / 선택+대상+base 불일치 → base_changed(신규 실행 차단)
    // 미선택+대상 → not_targeted, 선택+비대상 → no_active_addendum, 철회·비활성 → addendum_withdrawn(차단).
    const matched = target ? (selected ? (target.baseHash === bodyHash ? "applied" : "base_changed") : "not_targeted") : "no_active_addendum";
    const addendum = matched === "applied" ? addenda.get(`${templateId}:${bodyHash}`) : undefined;
    const status = addendum?.kind === "withdrawn" ? "addendum_withdrawn" as const : matched;
    templates.push({
      templateId, key: row.key, name: row.name, bodyHash,
      instructions: row.instructions, status,
      policyBaseHash: target?.baseHash ?? null,
      checks: status === "applied"
        ? (addendum?.kind === "active" ? [...target!.required, ...addendum.checks] : target!.required)
        : [],
      notAppliedReason: status === "applied" ? null : status === "not_targeted" ? "template_not_selected" : status,
      addendumVersionId: addendum?.kind === "active" ? addendum.versionId : null,
      addendumBodySha256: addendum?.kind === "active" ? addendum.bodySha256 : null,
    });
  };
  for (const id of selectedIds) pushTemplate(id, true);
  for (const target of targets) pushTemplate(target.templateId, selectedIds.includes(target.templateId));

  const manifest: PlanQaManifest = {
    schemaVersion: 1,
    kind: "plan_qa_manifest",
    companyId: input.companyId, missionId: input.missionId,
    planArtifactId: plan.id, planRevision: plan.revision,
    decisionHash: input.decisionHash, reviewGeneration: input.reviewGeneration,
    pinnedAt: new Date().toISOString(),
    inputHash: planQaInputHashForPlan(plan, input.decisionHash),
    input: buildPlanQaInput(plan, input.decisionHash),
    policy: policy ? { policyVersionId: policy.policyVersionId, definitionSha256: policy.definitionSha256 } : null,
    selectedTemplateIds: selectedIds,
    templates,
    checks: templates.filter((template) => template.status === "applied").flatMap((template) => template.checks),
  };
  const parsed = planQaManifestSchema.safeParse(manifest);
  if (!parsed.success) planQaError("quality_plan_qa_invalid_manifest");
  const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const uploaded = await uploadEvidence(getStorageService(), {
    companyId: input.companyId, body: bytes, contentType: "application/json", originalFilename: null,
  });
  return { manifest, uploaded, bytes };
}

export function planQaOriginId(missionId: string, decisionHash: string): string {
  return `plan-qa:${missionId}:${decisionHash}`;
}

export const attachPlanQaManifest = (tx: QualityTx, input: {
  companyId: string; issueId: string; uploaded: PutFileResult;
}): Promise<ArtifactRef> => attachEvidence(tx, input);

/** [brief 계약] 고정 명세를 기존 검토 이슈에 연결하고 서버 표식(marker)을 같은 tx 로 확정한다.
 *  완료(done/cancelled) 이슈에는 덧붙이지 않고, 진행 중 명세는 절대 바꾸지 않는다. */
export async function pinPlanQaManifest(db: Db, input: {
  companyId: string; missionId: string; planArtifactId: string; decisionHash: string; reviewGeneration: number;
}): Promise<ArtifactRef> {
  const prepared = await preparePlanQaManifest(db, input);
  return db.transaction(async (tx) => {
    const [issue] = await tx.select({ id: issues.id, status: issues.status, marker: issues.qualityPlanQaBinding })
      .from(issues).where(and(
        eq(issues.companyId, input.companyId), eq(issues.originKind, "mission_plan_qa"),
        eq(issues.originId, planQaOriginId(input.missionId, input.decisionHash)), isNull(issues.hiddenAt),
      )).limit(1);
    if (!issue) planQaError("quality_plan_qa_issue_not_found");
    if (issue.status === "done" || issue.status === "cancelled") planQaError("quality_plan_qa_review_completed");
    const ref = await attachPlanQaManifest(tx, { companyId: input.companyId, issueId: issue.id, uploaded: prepared.uploaded });
    const pinnedAt = new Date().toISOString();
    const marker = {
      schemaVersion: 1, kind: "plan_qa_review_binding",
      companyId: input.companyId, missionId: input.missionId, planArtifactId: input.planArtifactId,
      decisionHash: input.decisionHash, reviewGeneration: input.reviewGeneration,
      manifestRef: ref, inputHash: prepared.manifest.inputHash, pinnedAt, supersededAt: null,
    };
    const updated = await tx.update(issues).set({ qualityPlanQaBinding: marker })
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, issue.id), isNull(issues.qualityPlanQaBinding)))
      .returning({ id: issues.id });
    if (!updated.length && issue.marker) {
      const existingRef = (issue.marker as Record<string, unknown>).manifestRef as Record<string, unknown> | undefined;
      if (existingRef?.attachmentId === ref.attachmentId && existingRef.sha256 === ref.sha256) return ref;
      planQaError("quality_plan_qa_binding_exists");
    }
    await tx.insert(activityLog).values({
      companyId: input.companyId, actorType: "system", actorId: "mission-plan-qa",
      action: "mission.plan_qa.manifest_pinned", entityType: "issue", entityId: issue.id,
      details: { manifestRef: ref, reviewGeneration: input.reviewGeneration, decisionHash: input.decisionHash, planArtifactId: input.planArtifactId },
    });
    return ref;
  });
}

/** base_changed(선택+정책 대상) 와 addendum_withdrawn(required 대상 철회) 은 신규 검토 실행 차단이다.
 *  not_targeted/no_active_addendum 은 기본 검사(템플릿 자체 checklist)+미적용 사유로 진행한다. */
export function blockedPlanQaTemplates(manifest: PlanQaManifest): string[] {
  return manifest.templates
    .filter((template) => template.status === "base_changed" || template.status === "addendum_withdrawn")
    .map((template) => template.templateId);
}
