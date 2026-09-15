// server/src/services/quality/write-guard.ts
//
// [purpose] T5 일반·구형 쓰기 우회 차단. 일반 resolve/retry/cancel 서비스·구형 Quality
//   verdict/promote-anchor/request-evidence/evidence/replay/promote·self-improvement 채택이
//   Quality 소유 대상에 도달하면 409 quality_domain_action_required 로 전용 경로를 안내한다.
// [boundary] 판정 기준은 실제 DB 컬럼 연결(qualityActionId·occurrence 존재)뿐이다.
//   sourceType 문구·요청 본문 표기는 절대 근거로 쓰지 않는다(삭제·변경으로 우회 불가).
//   연결 없는 과거 행은 구형 동작·열람을 유지한다(새 자동 적용 권위로 받지 않는다).

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  evaluatorCandidateRuns,
  evaluatorVersions,
  operatorDecisions,
  qualityActions,
  qualityOccurrences,
} from "@paperclipai/db";
import { conflict, unprocessable } from "../../errors.js";

export type QualityWriteSubject = "decision" | "review" | "candidate_run" | "evaluator_version" | "adoption";

function qualityDomainActionRequired(detailPath: string, extra: Record<string, unknown> = {}): never {
  throw conflict("quality_domain_action_required", { code: "quality_domain_action_required", detailPath, ...extra });
}

export async function guardQualityWrite(db: Db, input: {
  companyId: string; subject: QualityWriteSubject; subjectId: string; operation: string;
}): Promise<void> {
  const { companyId, subject, subjectId } = input;
  if (subject === "decision") {
    const [row] = await db.select({ companyId: operatorDecisions.companyId, qualityActionId: operatorDecisions.qualityActionId })
      .from(operatorDecisions).where(eq(operatorDecisions.id, subjectId));
    if (row?.companyId === companyId && row.qualityActionId) {
      qualityDomainActionRequired(`/api/companies/${companyId}/quality-actions/${row.qualityActionId}`, { operatorDecisionId: subjectId });
    }
    return;
  }
  if (subject === "review") {
    const [occurrence] = await db.select({ id: qualityOccurrences.id }).from(qualityOccurrences)
      .where(and(eq(qualityOccurrences.companyId, companyId), eq(qualityOccurrences.reviewItemId, subjectId)));
    if (occurrence) qualityDomainActionRequired(`/api/companies/${companyId}/quality/review-items/${subjectId}`, { reviewItemId: subjectId });
    return;
  }
  if (subject === "candidate_run") {
    const [row] = await db.select({ qualityActionId: evaluatorCandidateRuns.qualityActionId, evaluatorVersionId: evaluatorCandidateRuns.evaluatorVersionId })
      .from(evaluatorCandidateRuns).where(and(eq(evaluatorCandidateRuns.companyId, companyId), eq(evaluatorCandidateRuns.id, subjectId)));
    // 실행 자체의 연결과 소속 evaluator version 의 연결을 모두 본다(어느 쪽이든 Quality 소유면 우회 불가).
    const linkedActionId = row?.qualityActionId ?? null;
    if (!linkedActionId && row?.evaluatorVersionId) {
      const [version] = await db.select({ qualityActionId: evaluatorVersions.qualityActionId })
        .from(evaluatorVersions).where(and(eq(evaluatorVersions.companyId, companyId), eq(evaluatorVersions.id, row.evaluatorVersionId)));
      if (version?.qualityActionId) qualityDomainActionRequired(`/api/companies/${companyId}/quality-actions/${version.qualityActionId}`, { candidateRunId: subjectId });
      return;
    }
    if (linkedActionId) {
      qualityDomainActionRequired(`/api/companies/${companyId}/quality-actions/${linkedActionId}`, { candidateRunId: subjectId });
    }
    return;
  }
  if (subject === "evaluator_version") {
    const [row] = await db.select({ qualityActionId: evaluatorVersions.qualityActionId })
      .from(evaluatorVersions).where(and(eq(evaluatorVersions.companyId, companyId), eq(evaluatorVersions.id, subjectId)));
    if (row?.qualityActionId) {
      qualityDomainActionRequired(`/api/companies/${companyId}/quality-actions/${row.qualityActionId}`, { evaluatorVersionId: subjectId });
    }
    return;
  }
  // adoption: 후보가 주장하는 Quality 생산 관계(evaluator_version)를 실제 행으로 확인한다.
  //   존재하지 않으면 실패 닫힘(가짜 관계), Quality 소유면 전용 채택 경로로 위임한다.
  const [row] = await db.select({ qualityActionId: evaluatorVersions.qualityActionId })
    .from(evaluatorVersions).where(and(eq(evaluatorVersions.companyId, companyId), eq(evaluatorVersions.id, subjectId)));
  if (!row) throw unprocessable("quality_adoption_reference_missing", { code: "quality_adoption_reference_missing", evaluatorVersionId: subjectId });
  if (row.qualityActionId) {
    qualityDomainActionRequired(`/api/companies/${companyId}/quality-actions/${row.qualityActionId}`, { evaluatorVersionId: subjectId });
  }
}

const QUALITY_ADOPTION_EVIDENCE_TYPES = new Set(["evaluator_version", "quality_action"]);

/**
 * self-improvement 채택 후보의 evidenceSource 가 Quality 생산 관계를 주장하면 실제 DB 관계로
 * 확인한다. board inline PASS 도 Quality 독립 평가가 아니므로 판정과 무관하게 전용 경로로
 * 위임하고, 관계없는 회사 스킬 채택(knowledge_pattern 등)은 그대로 둔다.
 */
export async function assertAdoptionCandidatesNotQualityLinked(db: Db, companyId: string, candidates: unknown[]): Promise<void> {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const evidenceSource = (candidate as { evidenceSource?: unknown }).evidenceSource;
    if (!Array.isArray(evidenceSource)) continue;
    for (const entry of evidenceSource) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const { type, id } = entry as { type?: unknown; id?: unknown };
      if (typeof type !== "string" || typeof id !== "string" || !QUALITY_ADOPTION_EVIDENCE_TYPES.has(type)) continue;
      if (type === "evaluator_version") {
        await guardQualityWrite(db, { companyId, subject: "adoption", subjectId: id, operation: "adoption_apply" });
        continue;
      }
      const [action] = await db.select({ id: qualityActions.id }).from(qualityActions)
        .where(and(eq(qualityActions.companyId, companyId), eq(qualityActions.id, id)));
      if (!action) throw unprocessable("quality_adoption_reference_missing", { code: "quality_adoption_reference_missing", qualityActionId: id });
      qualityDomainActionRequired(`/api/companies/${companyId}/quality-actions/${id}`, { qualityActionId: id });
    }
  }
}
