// server/src/services/missions/plan-qa-manifest-document.ts
//
// [파일 목적] PLAN-QA 고정 명세의 문서 계약(schema)과 읽기 경로. 고정 명세는 불변 StorageService 첨부로
//   저장되며 재조회는 항상 원본 bytes·해시 검증을 거친다. [T9] 명세 템플릿 상태에 addendum_withdrawn 이
//   추가됐다: required 정책 대상인데 추가 항목이 철회·비활성된 템플릿의 신규 검토 실행은 차단된다.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { issueAttachments, issues, type Db } from "@paperclipai/db";
import {
  addendumCheckSchema, artifactRefSchema, planQaScopeSchema, uuidSchema,
  type AddendumCheck, type ArtifactRef, type PlanQaScope,
} from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";
import { readVerifiedArtifact } from "../quality/evidence-store.js";
import { verifyEvidenceScope } from "../quality/evidence-verifier.js";
import { applies } from "./plan-qa-applicability.js";

export const MAX_PLAN_QA_MANIFEST_BYTES = 2_097_152;
const nonNegativeInteger = z.number().int().safe().min(0);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "quality_invalid_sha256");
export function planQaError(code: string): never {
  throw unprocessable(code, { code });
}

// [T9] addendum_withdrawn: 선택+정책 대상이지만 활성 추가 항목이 철회·비활성된 상태. 신규 실행 차단.
export const templateStatusSchema = z.enum(["applied", "base_changed", "not_targeted", "no_active_addendum", "addendum_withdrawn"]);

export const planQaManifestTemplateSchema = z.object({
  templateId: uuidSchema,
  key: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  bodyHash: sha256Hex,
  instructions: z.string().min(1).max(200_000),
  status: templateStatusSchema,
  policyBaseHash: sha256Hex.nullable(),
  checks: z.array(addendumCheckSchema),
  notAppliedReason: z.string().min(1).max(120).nullable(),
  // [T9] applied 템플릿에 고정된 활성 추가 항목 버전·불변 본문 해시(연결이 없으면 null).
  addendumVersionId: uuidSchema.nullish(),
  addendumBodySha256: sha256Hex.nullish(),
}).strict(); // [T7 원본 계약] 모르는 키는 거부한다(strict). 신규 필드는 nullish 여서 구형 고정 명세도 파싱된다.
export type PlanQaManifestTemplate = z.infer<typeof planQaManifestTemplateSchema>;

const manifestInputSchema = z.object({
  schemaVersion: z.literal(1), missionId: uuidSchema, missionPlanArtifactId: uuidSchema,
  revision: nonNegativeInteger, decisionHash: sha256Hex, missionGoal: z.string().nullable(),
  refs: z.record(z.string(), z.unknown()), steps: z.array(z.unknown()),
  requiredInputs: z.array(z.unknown()), successCriteria: z.array(z.unknown()), risks: z.array(z.unknown()),
}).strict();

export const planQaManifestSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("plan_qa_manifest"),
  companyId: uuidSchema, missionId: uuidSchema, planArtifactId: uuidSchema,
  planRevision: nonNegativeInteger, decisionHash: sha256Hex, reviewGeneration: nonNegativeInteger,
  pinnedAt: z.string().datetime(), inputHash: sha256Hex, input: manifestInputSchema,
  policy: z.object({ policyVersionId: uuidSchema, definitionSha256: sha256Hex }).nullable(),
  selectedTemplateIds: z.array(uuidSchema),
  templates: z.array(planQaManifestTemplateSchema).max(100),
  checks: z.array(addendumCheckSchema),
}).strict();
export type PlanQaManifest = z.infer<typeof planQaManifestSchema>;

export async function readPlanQaManifestDocument(db: Db, companyId: string, ref: ArtifactRef): Promise<PlanQaManifest> {
  const bytes = await readVerifiedArtifact(db, { companyId, ref, maxBytes: MAX_PLAN_QA_MANIFEST_BYTES });
  const parsed = planQaManifestSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  if (!parsed.success) planQaError("quality_plan_qa_invalid_manifest");
  if (parsed.data.companyId !== companyId) planQaError("quality_scope_company_mismatch");
  return parsed.data;
}

/** marker 검증 포함 내부 읽기: 첨부가 이슈에 연결됐고 세대가 살아있는지 확인한다. */
export async function readPlanQaManifestForIssue(db: Db, companyId: string, issueId: string, ref: ArtifactRef): Promise<PlanQaManifest> {
  const [attachment] = await db.select({ rowIssueId: issueAttachments.issueId })
    .from(issueAttachments)
    .where(and(eq(issueAttachments.companyId, companyId), eq(issueAttachments.id, ref.attachmentId)))
    .limit(1);
  if (!attachment || attachment.rowIssueId !== issueId) planQaError("quality_plan_qa_binding_mismatch");
  return readPlanQaManifestDocument(db, companyId, ref);
}

/** [brief 계약] 고정된 입력을 scope 로 읽는다. applies() 를 통과한 검사만 반환한다.
 *  이슈 marker 와 대조해 세대가 살아있는지 확인한다(신형 이슈를 구형으로 해석 불가). */
export async function readPinnedPlanQaManifest(db: Db, scope: PlanQaScope): Promise<{
  selectedTemplateIds: string[]; checks: AddendumCheck[]; inputRef: ArtifactRef;
}> {
  const parsedScope = planQaScopeSchema.safeParse(scope);
  if (!parsedScope.success) planQaError("quality_evidence_invalid_contract");
  await verifyEvidenceScope(db, scope.companyId, scope);
  const manifest = await readPlanQaManifestForIssue(db, scope.companyId, scope.issueId, scope.manifestRef);
  if (manifest.missionId !== scope.missionId || manifest.planArtifactId !== scope.planArtifactId
    || manifest.decisionHash !== scope.decisionHash || manifest.reviewGeneration !== scope.reviewGeneration) {
    planQaError("quality_plan_qa_binding_mismatch");
  }
  const markerRow = (await db.select({ marker: issues.qualityPlanQaBinding }).from(issues)
    .where(and(eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId))).limit(1))[0];
  const marker = (markerRow?.marker ?? null) as Record<string, unknown> | null;
  const markerRef = marker?.manifestRef as Record<string, unknown> | undefined;
  if (!marker || marker.kind !== "plan_qa_review_binding"
    || markerRef?.attachmentId !== scope.manifestRef.attachmentId || markerRef?.sha256 !== scope.manifestRef.sha256
    || marker.reviewGeneration !== scope.reviewGeneration) {
    planQaError("quality_plan_qa_binding_mismatch");
  }
  if (typeof marker.supersededAt === "string") planQaError("quality_plan_qa_binding_superseded");
  return {
    selectedTemplateIds: manifest.selectedTemplateIds,
    checks: manifest.checks.filter((checkEntry) => applies(checkEntry.applicability, manifest.selectedTemplateIds)),
    inputRef: scope.manifestRef,
  };
}
