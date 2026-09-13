// server/src/services/quality/adoption.ts
//
// [purpose] T9 적용. 현재 평가(currentEvaluationId)의 PASS 원본만 적용 근거다(과거 PASS·진행 중·실패 거절).
//   활성 소비 연결 CAS 교체와 adoption 영수증 연결이 같은 tx 로 확정될 때만 적용 완료고, 저장소 업로드만으론
//   적용이 아니다. 별도 readback 이 활성 연결·영수증 원문·해시를 재조회해야 완료로 본다. 재요청(응답 유실)은 원래 영수증을 돌려준다.
// [ordering] §3.3: policy usage → group → action → binding 잠금. 회사·정확한 template/base 조건만 쓴다.

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog, evaluatorVersions, qualityActionGroups, qualityActions, qualityConsumerBindings,
  qualityOccurrences, qualityPolicyUsage, qualityPolicyVersions,
} from "@paperclipai/db";
import {
  addendumCheckSchema, evaluationScopeSchema, qualityKeySchema, qualityPolicySchema, retryEnvelopeSchema,
  uuidSchema, type AddendumCheck, type QualityKey,
} from "@paperclipai/shared";
import { z } from "zod";
import { conflict, forbidden, notFound } from "../../errors.js";
import { getStorageService } from "../../storage/index.js";
import { evidenceError, hashContract, parseEvidence } from "./contract.js";
import { linkEvidence, readEvidence, readVerifiedArtifact, uploadEvidence } from "./evidence-store.js";
import { caseManifest, evaluationContract, loadEvaluation } from "./evaluation-reader.js";
import { MAX_QUALITY_RECEIPT_BYTES, adoptionReceiptSchema, findOriginalAdoptionReceipt, loadEvidenceReceipt } from "./evidence-verifier.js";
import { readPolicyUsageTotals } from "./policy-usage.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type AdoptedAddendum = { bindingId: string; revision: number; evidenceRefId: string };

export type ResolvedAddendum =
  | { kind: "active"; bindingId: string; versionId: string; bodySha256: string; checks: AddendumCheck[] }
  | { kind: "withdrawn"; bindingId: string };

const activeAddendumContractSchema = z.object({
  kind: z.literal("candidate"), templateId: uuidSchema,
  baseHash: z.string().regex(/^[0-9a-f]{64}$/, "quality_invalid_sha256"),
  bodyHash: z.string().regex(/^[0-9a-f]{64}$/, "quality_invalid_sha256"),
  checks: z.array(addendumCheckSchema),
}).passthrough();

/** PLAN-QA 명세 준비용 소비 연결 해석: target (templateId,baseHash) 의 활성 버전 또는 철회 상태를 회사 조건으로 읽는다. */
export async function resolveActiveAddenda(db: Db, input: {
  companyId: string; targets: Array<{ templateId: string; baseHash: string }>;
}): Promise<Map<string, ResolvedAddendum>> {
  const wanted = new Set(input.targets.map((target) => `${target.templateId}:${target.baseHash}`));
  const resolved = new Map<string, ResolvedAddendum>();
  if (!wanted.size) return resolved;
  const templateIds = [...new Set(input.targets.map((target) => target.templateId))];
  const rows = await db.select({ binding: qualityConsumerBindings, contract: evaluatorVersions.qualityContract })
    .from(qualityConsumerBindings)
    .leftJoin(evaluatorVersions, and(
      eq(evaluatorVersions.companyId, qualityConsumerBindings.companyId),
      eq(evaluatorVersions.id, qualityConsumerBindings.activeVersionId),
    ))
    .where(and(eq(qualityConsumerBindings.companyId, input.companyId), inArray(qualityConsumerBindings.templateId, templateIds)));
  for (const row of rows) {
    const key = `${row.binding.templateId}:${row.binding.baseHash}`;
    if (!wanted.has(key)) continue;
    if (row.binding.activeVersionId && row.contract) {
      const parsed = activeAddendumContractSchema.safeParse(row.contract);
      if (!parsed.success || parsed.data.templateId !== row.binding.templateId || parsed.data.baseHash !== row.binding.baseHash) {
        throw conflict("quality_addendum_binding_invalid");
      }
      resolved.set(key, { kind: "active", bindingId: row.binding.id, versionId: row.binding.activeVersionId, bodySha256: parsed.data.bodyHash, checks: parsed.data.checks });
    } else if (row.binding.activeVersionId === null && row.binding.withdrawalEvidenceRefId) {
      resolved.set(key, { kind: "withdrawn", bindingId: row.binding.id });
    }
  }
  return resolved;
}

type GroupUsage = { reservedCostCents?: number; chargedCostCents?: number };

/** 후보 버전 계약 중 적용 재검증에 필요한 불변 식별부(kind·template·base). */
const candidateTargetSchema = z.object({
  kind: z.literal("candidate"), templateId: uuidSchema,
  baseHash: z.string().regex(/^[0-9a-f]{64}$/, "quality_invalid_sha256"),
}).passthrough();

/** [brief 계약] 버전과 세대가 모두 같을 때만 교체 자격이 있다. */
export function canReplace(
  current: { versionId: string | null; revision: number },
  expected: { versionId: string | null; revision: number },
): boolean {
  return current.versionId === expected.versionId && current.revision === expected.revision;
}

function qaAddendumTarget(action: typeof qualityActions.$inferSelect) {
  if (action.kind !== "qa_addendum" || action.target.kind !== "qa_addendum") throw conflict("quality_action_kind_mismatch");
  if (hashContract(action.target) !== action.targetHash) evidenceError("quality_action_target_hash_mismatch");
  return action.target;
}

async function occurrenceReviewItemId(db: Tx, companyId: string, occurrenceIds: string[]): Promise<string> {
  const [occurrence] = await db.select({ reviewItemId: qualityOccurrences.reviewItemId }).from(qualityOccurrences)
    .where(and(eq(qualityOccurrences.companyId, companyId), eq(qualityOccurrences.id, occurrenceIds[0]!)));
  if (!occurrence) throw conflict("quality_occurrence_missing");
  return occurrence.reviewItemId;
}

/** 적용 직전 예산 재검증: 회사 기간 총량과 group 누적이 정책 한도 안에 있어야 한다. */
async function assertAdoptionBudget(tx: Tx, input: {
  companyId: string; action: typeof qualityActions.$inferSelect;
}): Promise<void> {
  const envelope = parseEvidence(retryEnvelopeSchema, input.action.retryEnvelope);
  const [policyRow] = await tx.select({ definition: qualityPolicyVersions.definition }).from(qualityPolicyVersions)
    .where(and(eq(qualityPolicyVersions.companyId, input.companyId), eq(qualityPolicyVersions.id, input.action.policyVersionId)));
  if (!policyRow) throw conflict("quality_policy_inactive");
  const policy = parseEvidence(qualityPolicySchema, policyRow.definition);
  const totals = await readPolicyUsageTotals(tx as unknown as Db, {
    companyId: input.companyId, policyVersionId: input.action.policyVersionId,
    windowStart: new Date(policy.periodStart), windowEnd: new Date(policy.periodEnd),
  });
  if (totals.reservedCostCents + totals.chargedCostCents > policy.maxCostCentsPerPeriod) throw conflict("quality_period_cost_exhausted");
  const [group] = await tx.select().from(qualityActionGroups)
    .where(and(eq(qualityActionGroups.companyId, input.companyId), eq(qualityActionGroups.id, envelope.groupId)));
  const usage = (group?.usage ?? {}) as GroupUsage;
  if (Number(usage.reservedCostCents ?? 0) + Number(usage.chargedCostCents ?? 0) > envelope.maxCumulativeCostCents) {
    throw conflict("quality_group_cost_exhausted");
  }
}

/**
 * 현재 평가 PASS 로 활성 소비 연결을 교체한다. 같은 tx 에서 adoption 영수증을 연결하고 감사 행을 남긴다.
 * 동일 적용의 재요청은 원래 영수증을 그대로 돌려준다(응답 유실 멱등).
 */
export async function applyVerifiedAddendum(db: Db, key: QualityKey): Promise<AdoptedAddendum> {
  const parsed = parseEvidence(qualityKeySchema, key);
  const [action] = await db.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, parsed.companyId), eq(qualityActions.id, parsed.actionId)));
  if (!action) throw notFound("quality_action_not_found");
  if (action.cancelRequestedAt) throw conflict("quality_action_cancelled");
  const target = qaAddendumTarget(action);

  // 권한: 현재 정책이 승인·활성 상태이고 기간 안이며, 정확한 template/base 를 여전히 target 해야 한다.
  const [policyRow] = await db.select().from(qualityPolicyVersions)
    .where(and(eq(qualityPolicyVersions.companyId, parsed.companyId), eq(qualityPolicyVersions.id, action.policyVersionId)));
  if (!policyRow || !policyRow.approvedAt || !policyRow.enabledAt || policyRow.disabledAt) throw conflict("quality_policy_inactive");
  const policy = parseEvidence(qualityPolicySchema, policyRow.definition);
  const now = new Date();
  if (now < new Date(policy.periodStart) || now >= new Date(policy.periodEnd)) throw conflict("quality_policy_outside_period");
  if (!policy.targets.some((entry) => entry.templateId === target.templateId && entry.baseHash === target.baseHash)) throw conflict("quality_policy_target_unavailable");

  // 현재 평가만 적용 근거다. 진행 중·실패 판정과 과거 PASS 는 거절된다.
  if (!action.currentEvaluationId) throw conflict("quality_evaluation_not_current");
  if (!action.canonicalBinding) throw conflict("quality_execution_not_bound");
  const evaluation = await loadEvaluation(db, parsed.companyId, action.currentEvaluationId);
  if (evaluation.qualityActionId !== action.id) throw conflict("quality_evaluation_not_current");
  const state = evaluationContract(evaluation);
  if (!state.verdict) throw conflict("quality_evaluation_pending");
  if (state.verdict.status !== "pass") throw conflict("quality_evaluation_not_passed");

  // 모든 필수 사례(발생+oracle)가 판정 행으로 덮였는지 재검증한다.
  const manifest = await caseManifest(db, action, policy);
  const caseIds = new Set(manifest.map((entry) => entry.caseId));
  if (state.verdict.rows.length !== caseIds.size || !state.verdict.rows.every((row) => caseIds.has(row.id))) throw conflict("quality_evaluation_cases_incomplete");

  // 독립 검증자 재검증: 후보 작성 참여자 전원(정책 author+버전 authors)은 검증자일 수 없다.
  const versionRows = await db.select({ qualityContract: evaluatorVersions.qualityContract }).from(evaluatorVersions)
    .where(and(eq(evaluatorVersions.companyId, parsed.companyId), eq(evaluatorVersions.qualityActionId, action.id)));
  const authors = new Set<string>(policy.authorAgentIds);
  for (const row of versionRows) {
    for (const author of (row.qualityContract as { authors?: unknown } | null)?.authors as string[] | undefined ?? []) authors.add(author);
  }
  if (!policy.verifierAgentIds.includes(state.verifier.agentId) || authors.has(state.verifier.agentId)) throw forbidden("quality_verifier_role_required");

  // 후보 버전과 exact base/target 재검증.
  const [version] = await db.select().from(evaluatorVersions)
    .where(and(eq(evaluatorVersions.companyId, parsed.companyId), eq(evaluatorVersions.id, evaluation.evaluatorVersionId)));
  if (!version || version.qualityActionId !== action.id) throw conflict("quality_candidate_contract_missing");
  const candidateTarget = candidateTargetSchema.safeParse(version.qualityContract);
  if (!candidateTarget.success) throw conflict("quality_candidate_contract_missing");
  if (candidateTarget.data.templateId !== target.templateId || candidateTarget.data.baseHash !== target.baseHash) {
    throw conflict("quality_candidate_base_mismatch");
  }

  // 판정 영수증 원문 재독해 — 다른 회사·다른 action 의 영수증은 scope 검증으로 거부된다.
  const runBinding = state.verifier.run ?? state.authorRun;
  const scope = parseEvidence(evaluationScopeSchema, {
    kind: "evaluation", companyId: parsed.companyId, actionId: action.id, evaluationId: evaluation.id,
    missionId: action.canonicalBinding.missionId, workflowRunId: state.verifier.step.workflowRunId,
    stepRunId: state.verifier.step.stepRunId, generation: state.verifier.step.generation,
    issueId: state.verifier.step.issueId, heartbeatRunId: runBinding.heartbeatRunId, executionEpoch: runBinding.executionEpoch,
  });
  const verdict = await loadEvidenceReceipt(db, parsed.companyId, state.verdict.evidenceRefId, "evaluation");
  if (!verdict.contract.scope) evidenceError("quality_evidence_scope_mismatch");
  await readEvidence(db, { companyId: parsed.companyId, ref: verdict.contract.ref, scope, maxBytes: MAX_QUALITY_RECEIPT_BYTES });

  // 영수증 bytes 를 미리 업로드한다. 활성 CAS+연결은 아래 tx 가 담당한다(업로드만으로 적용 아님).
  const appliedAt = new Date();
  const uploaded = await uploadEvidence(getStorageService(), {
    companyId: parsed.companyId,
    body: Buffer.from(JSON.stringify({
      schemaVersion: 1, kind: "adoption", actionId: action.id, intentKey: action.intentKey,
      templateId: target.templateId, baseHash: target.baseHash, newVersionId: version.id,
      evaluationId: evaluation.id, evaluationEvidenceRefId: state.verdict.evidenceRefId,
      policyVersionId: action.policyVersionId, scopeVersion: action.scopeVersion, appliedAt: appliedAt.toISOString(),
    } satisfies z.infer<typeof adoptionReceiptSchema>)),
    contentType: "application/json", originalFilename: null,
  });

  return db.transaction(async (tx) => {
    // §3.3 잠금 순서: policy usage → group(+예산) → action → binding.
    await tx.select({ id: qualityPolicyUsage.id }).from(qualityPolicyUsage)
      .where(and(eq(qualityPolicyUsage.companyId, parsed.companyId), eq(qualityPolicyUsage.policyVersionId, action.policyVersionId)))
      .orderBy(asc(qualityPolicyUsage.windowStart)).for("update");
    await assertAdoptionBudget(tx, { companyId: parsed.companyId, action });
    const [locked] = await tx.select().from(qualityActions)
      .where(and(eq(qualityActions.companyId, parsed.companyId), eq(qualityActions.id, action.id))).for("update");
    if (!locked || locked.cancelRequestedAt || locked.currentEvaluationId !== action.currentEvaluationId) {
      throw conflict("quality_evaluation_not_current");
    }
    const [binding] = await tx.select().from(qualityConsumerBindings).where(and(
      eq(qualityConsumerBindings.companyId, parsed.companyId),
      eq(qualityConsumerBindings.templateId, target.templateId),
      eq(qualityConsumerBindings.baseHash, target.baseHash),
    )).for("update");
    // 응답 유실 재요청: 활성이 바뀌거나 철회돼도 현재 평가로 커밋한 원래 영수증을 그대로 돌려준다(재활성화·되돌림 없음).
    const replay = binding ? await findOriginalAdoptionReceipt(tx, { companyId: parsed.companyId, actionId: action.id, bindingId: binding.id, evaluationId: evaluation.id }) : null;
    if (replay) return replay;
    const receipt = await linkEvidence(tx, {
      companyId: parsed.companyId,
      reviewItemId: await occurrenceReviewItemId(tx, parsed.companyId, action.occurrenceIds),
      source: verdict.contract.source, scope, kind: "adoption", uploaded, expiresAt: null,
      issuedBy: "quality-adoption", originalRef: verdict.contract.ref,
    });
    let bindingId: string;
    let revision: number;
    if (binding) {
      const replaced = await tx.update(qualityConsumerBindings).set({
        activeVersionId: version.id,
        previousVerifiedVersionId: binding.activeVersionId,
        revision: binding.revision + 1,
        adoptionEvidenceRefId: receipt.evidenceRefId,
      }).where(and(
        eq(qualityConsumerBindings.companyId, parsed.companyId),
        eq(qualityConsumerBindings.id, binding.id),
        eq(qualityConsumerBindings.revision, binding.revision),
        binding.activeVersionId === null
          ? isNull(qualityConsumerBindings.activeVersionId)
          : eq(qualityConsumerBindings.activeVersionId, binding.activeVersionId),
      )).returning({ id: qualityConsumerBindings.id, revision: qualityConsumerBindings.revision });
      if (!replaced.length) throw conflict("quality_binding_conflict");
      bindingId = replaced[0]!.id;
      revision = replaced[0]!.revision;
    } else {
      const inserted = await tx.insert(qualityConsumerBindings).values({
        companyId: parsed.companyId, templateId: target.templateId, baseHash: target.baseHash,
        activeVersionId: version.id, previousVerifiedVersionId: null, revision: 1,
        adoptionEvidenceRefId: receipt.evidenceRefId,
      }).onConflictDoNothing().returning({ id: qualityConsumerBindings.id, revision: qualityConsumerBindings.revision });
      if (!inserted.length) throw conflict("quality_binding_conflict");
      bindingId = inserted[0]!.id;
      revision = inserted[0]!.revision;
    }
    await tx.insert(activityLog).values({
      companyId: parsed.companyId, actorType: "system", actorId: "quality-adoption",
      action: "quality.addendum_applied", entityType: "quality_consumer_binding", entityId: bindingId,
      details: { actionId: action.id, evaluationId: evaluation.id, newVersionId: version.id, previousVersionId: binding?.activeVersionId ?? null, revision },
    });
    return { bindingId, revision, evidenceRefId: receipt.evidenceRefId };
  });
}

/**
 * 적용 완료의 별도 확인 경로: 활성 연결이 가리키는 adoption 영수증 원문을 회사·scope·해시 조건으로
 * 다시 읽고, 연결·계약 내용·현재 action 이 일치할 때만 verified 다.
 */
export async function verifyAdoptionReadback(db: Db, key: QualityKey): Promise<{ verified: boolean; evidenceRefId: string | null }> {
  const parsed = parseEvidence(qualityKeySchema, key);
  const [action] = await db.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, parsed.companyId), eq(qualityActions.id, parsed.actionId)));
  if (!action || action.kind !== "qa_addendum" || action.target.kind !== "qa_addendum") return { verified: false, evidenceRefId: null };
  const target = action.target;
  const [binding] = await db.select().from(qualityConsumerBindings).where(and(
    eq(qualityConsumerBindings.companyId, parsed.companyId),
    eq(qualityConsumerBindings.templateId, target.templateId),
    eq(qualityConsumerBindings.baseHash, target.baseHash),
  ));
  if (!binding || !binding.activeVersionId || !binding.adoptionEvidenceRefId) {
    return { verified: false, evidenceRefId: binding?.adoptionEvidenceRefId ?? null };
  }
  try {
    const { receipt, contract } = await loadEvidenceReceipt(db, parsed.companyId, binding.adoptionEvidenceRefId, "adoption");
    // 영수증 원문·해시 재조회는 저장 계약(readVerifiedArtifact)으로 충분하다. 실행 scope 재검증은 현재
    // 평가 통관성을 요구하므로(재평가 시작 시 과거 scope 는 의도적으로 막힘) 여기서 반복하지 않는다.
    const bytes = await readVerifiedArtifact(db, { companyId: parsed.companyId, ref: contract.ref, maxBytes: MAX_QUALITY_RECEIPT_BYTES });
    const document = parseEvidence(adoptionReceiptSchema, JSON.parse(bytes.toString("utf8")));
    // 활성 연결·계약 내용·현재 action 이 모두 일치할 때만 적용 완료다.
    const consistent = document.actionId === action.id && document.newVersionId === binding.activeVersionId
      && document.templateId === binding.templateId && document.baseHash === binding.baseHash
      && receipt.qualityActionId === action.id;
    return { verified: consistent, evidenceRefId: binding.adoptionEvidenceRefId };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("quality_")) return { verified: false, evidenceRefId: binding.adoptionEvidenceRefId };
    throw error;
  }
}
