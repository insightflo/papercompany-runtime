// server/src/services/quality/rollback.ts
//
// [purpose] T9 철회. 현재 활성 연결이 정확히 그 불량 버전·세대(canReplace: versionId+revision)일 때만
//   기준 호환·검증된 이전 버전으로 CAS 복구하거나, 이전 버전이 없으면 비활성화한다. 철회 영수증
//   (qualityEvidenceRefs kind=rollback)은 구조화된 독립 실패 근거(kind=observation) 원본과 연결되며
//   원본 bytes 는 resolveEvidence 로 다시 검증된다. 다른 회사·다른 action 의 근거는 거부된다.
// [boundary] 이미 고정된 진행 중 버전은 교체하지 않는다(재검증/취소는 기존 경로 소관). 원본 terminal
//   기록(이슈·미션·run)은 절대 다시 열지 않는다.

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  activityLog, evaluatorCandidateRuns, evaluatorVersions, qualityActions,
  qualityConsumerBindings,
} from "@paperclipai/db";
import { uuidSchema } from "@paperclipai/shared";
import { conflict, notFound } from "../../errors.js";
import { getStorageService } from "../../storage/index.js";
import { evidenceError, parseEvidence } from "./contract.js";
import { linkEvidence, uploadEvidence } from "./evidence-store.js";
import { canReplace } from "./adoption.js";
import { rollbackReceiptSchema, loadEvidenceReceipt } from "./evidence-verifier.js";

export type RollbackOutcome = { status: "restored" | "disabled" | "conflict"; evidenceRefId: string | null };

const rollbackInputSchema = z.object({
  companyId: uuidSchema, bindingId: uuidSchema, badVersionId: uuidSchema,
  expectedRevision: z.number().int().safe().min(1), failureEvidenceRefId: uuidSchema,
}).strict();

const candidateTargetSchema = z.object({
  kind: z.literal("candidate"), templateId: uuidSchema,
  baseHash: z.string().regex(/^[0-9a-f]{64}$/, "quality_invalid_sha256"),
}).passthrough();

function candidateTargetOf(row: typeof evaluatorVersions.$inferSelect): { templateId: string; baseHash: string } {
  const parsed = candidateTargetSchema.safeParse(row.qualityContract);
  if (!parsed.success) throw conflict("quality_candidate_contract_missing");
  return { templateId: parsed.data.templateId, baseHash: parsed.data.baseHash };
}

/** 기준 호환·검증된 이전 버전: 같은 template/base 의 candidate 이고 pass 판정 평가가 존재해야 한다. */
async function verifiedPreviousVersion(db: Parameters<Parameters<Db["transaction"]>[0]>[0],
  companyId: string, versionId: string, binding: typeof qualityConsumerBindings.$inferSelect): Promise<string | null> {
  const [row] = await db.select().from(evaluatorVersions)
    .where(and(eq(evaluatorVersions.companyId, companyId), eq(evaluatorVersions.id, versionId)));
  if (!row || row.qualityActionId === null) return null;
  const target = candidateTargetOf(row);
  if (target.templateId !== binding.templateId || target.baseHash !== binding.baseHash) return null;
  const [pass] = await db.select({ id: evaluatorCandidateRuns.id }).from(evaluatorCandidateRuns)
    .where(and(
      eq(evaluatorCandidateRuns.companyId, companyId),
      eq(evaluatorCandidateRuns.evaluatorVersionId, versionId),
      sql`${evaluatorCandidateRuns.qualityContract}->'verdict'->>'status' = 'pass'`,
    )).limit(1);
  return pass ? versionId : null;
}

/**
 * 철회: badVersionId+expectedRevision 이 현재 활성 연결과 정확히 일치할 때만 되돌린다.
 * 검증된 이전 버전이 있으면 복구(restored), 없으면 비활성화(disabled)한다. 경합 패자는 conflict 다.
 */
export async function rollbackAddendum(db: Db, input: unknown): Promise<RollbackOutcome> {
  const value = parseEvidence(rollbackInputSchema, input);
  const [binding] = await db.select().from(qualityConsumerBindings)
    .where(and(eq(qualityConsumerBindings.companyId, value.companyId), eq(qualityConsumerBindings.id, value.bindingId)));
  if (!binding) throw notFound("quality_binding_not_found");
  // 실패 근거는 구조화 observation 영수증 원본만이다. 다른 action 의 근거는 아래 연결 검증으로 거부된다.
  const failure = await loadEvidenceReceipt(db, value.companyId, value.failureEvidenceRefId, "observation");
  const [badVersion] = await db.select().from(evaluatorVersions)
    .where(and(eq(evaluatorVersions.companyId, value.companyId), eq(evaluatorVersions.id, value.badVersionId)));
  if (!badVersion || badVersion.qualityActionId === null) throw notFound("quality_candidate_version_not_found");
  const badTarget = candidateTargetOf(badVersion);
  if (badTarget.templateId !== binding.templateId || badTarget.baseHash !== binding.baseHash) {
    throw conflict("quality_candidate_base_mismatch");
  }
  if (failure.receipt.qualityActionId !== badVersion.qualityActionId) evidenceError("quality_evidence_scope_mismatch");

  const restored = binding.previousVerifiedVersionId === null
    ? null
    : await db.transaction(async (tx) => verifiedPreviousVersion(tx, value.companyId, binding.previousVerifiedVersionId!, binding));
  const withdrawnAt = new Date();
  const uploaded = await uploadEvidence(getStorageService(), {
    companyId: value.companyId,
    body: Buffer.from(JSON.stringify({
      schemaVersion: 1, kind: "rollback", bindingId: binding.id,
      templateId: binding.templateId, baseHash: binding.baseHash,
      badVersionId: value.badVersionId, restoredVersionId: restored,
      failureEvidenceRefId: value.failureEvidenceRefId, withdrawnAt: withdrawnAt.toISOString(),
    } satisfies z.infer<typeof rollbackReceiptSchema>)),
    contentType: "application/json", originalFilename: null,
  });

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(qualityConsumerBindings)
      .where(and(eq(qualityConsumerBindings.companyId, value.companyId), eq(qualityConsumerBindings.id, value.bindingId)))
      .for("update");
    if (!row) throw notFound("quality_binding_not_found");
    // helper(canReplace)와 동일 조건의 DB UPDATE 로 CAS 증거(row count)를 남긴다.
    if (!canReplace({ versionId: row.activeVersionId, revision: row.revision },
      { versionId: value.badVersionId, revision: value.expectedRevision })) {
      return { status: "conflict" as const, evidenceRefId: null };
    }
    const receipt = await linkEvidence(tx, {
      companyId: value.companyId, reviewItemId: failure.receipt.reviewItemId,
      source: failure.contract.source, scope: failure.contract.scope, kind: "rollback",
      uploaded, expiresAt: null, issuedBy: "quality-rollback", originalRef: failure.contract.ref,
    });
    const withdrawn = await tx.update(qualityConsumerBindings).set({
      activeVersionId: restored, previousVerifiedVersionId: null,
      revision: row.revision + 1, withdrawalEvidenceRefId: receipt.evidenceRefId,
    }).where(and(
      eq(qualityConsumerBindings.companyId, value.companyId),
      eq(qualityConsumerBindings.id, row.id),
      eq(qualityConsumerBindings.activeVersionId, value.badVersionId),
      eq(qualityConsumerBindings.revision, value.expectedRevision),
    )).returning({ id: qualityConsumerBindings.id, revision: qualityConsumerBindings.revision });
    if (!withdrawn.length) return { status: "conflict" as const, evidenceRefId: null };
    await tx.insert(activityLog).values({
      companyId: value.companyId, actorType: "system", actorId: "quality-rollback",
      action: "quality.addendum_withdrawn", entityType: "quality_consumer_binding", entityId: row.id,
      details: {
        badVersionId: value.badVersionId, restoredVersionId: restored, revision: withdrawn[0]!.revision,
        failureEvidenceRefId: value.failureEvidenceRefId,
      },
    });
    return { status: restored ? ("restored" as const) : ("disabled" as const), evidenceRefId: receipt.evidenceRefId };
  });
}

/** 철회·비활성 상태(활성 버전 없음+철회 영수증 존재)의 target 인지 회사 조건으로 읽는다. */
export async function isAddendumWithdrawnForTarget(db: Db, input: {
  companyId: string; templateId: string; baseHash: string;
}): Promise<boolean> {
  const [row] = await db.select({
    activeVersionId: qualityConsumerBindings.activeVersionId,
    withdrawalEvidenceRefId: qualityConsumerBindings.withdrawalEvidenceRefId,
  }).from(qualityConsumerBindings).where(and(
    eq(qualityConsumerBindings.companyId, input.companyId),
    eq(qualityConsumerBindings.templateId, input.templateId),
    eq(qualityConsumerBindings.baseHash, input.baseHash),
  ));
  return Boolean(row && row.activeVersionId === null && row.withdrawalEvidenceRefId);
}
