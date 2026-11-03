// Quality authority for the identifier-only C5 root. This module only reserves a
// strict v3 snapshot; file publication and settlement remain owned by reconcile.
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import {
  heartbeatRuns, qualityActionGroups, qualityActions, qualityEvidenceRefs, qualityOccurrences,
  qualityPolicyUsage, qualityPolicyVersions, qualityReviewItems, type Db,
} from "@paperclipai/db";
import { nativeBindingSchema, qualityEffectSchema, qualityPolicySchema, qualityTargetSchema, retryEnvelopeSchema } from "@paperclipai/shared";
import { getStorageService } from "../../../storage/index.js";
import { hashContract } from "../../quality/contract.js";
import { readVerifiedEvidenceUpload, uploadEvidence } from "../../quality/evidence-store.js";
import { withReplacementRootNotificationDb, createReplacementRootNotifications } from "../../issue-assignment-wakeup.js";
import { buildQaRemediationPreparationCandidate, type QaRemediationPreparationRequest, type QaRemediationPreparationCandidateResult } from "./qa-remediation-prepare.js";
import {
  QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3, parseQaRemediationPreparation, type QaRemediationPreparation,
} from "./qa-remediation-preparation-contract.js";
import { qaRemediationQualityBindingHash, type QaRemediationQualityBinding } from "./qa-remediation-quality-binding.js";
import { writeQaRemediationPreparation } from "./qa-remediation-preparation-writer.js";
import { readCommittedQaRemediationCompletion, type QaRemediationCompletionResult } from "./qa-remediation-completion.js";
import { classifyQualityActionHistory, verifyCurrentQualityAuthority, type QualityRootFacts } from "./qa-remediation-quality-history.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Facts = QualityRootFacts & { reviewItemId: string; fingerprint: string };
type FactResult = { ok: true; facts: Facts } | { ok: false; detail: string };
type QualityPreparationResult = Exclude<QaRemediationPreparationCandidateResult, { outcome: "prepared" | "candidate" }>
  | { outcome: "prepared"; preparationEventId: string; preparation: QaRemediationPreparation; detail: string }
  | { outcome: "completed"; result: QaRemediationCompletionResult };
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const failure = (detail: string): FactResult => ({ ok: false, detail });
const dbOf = (tx: Tx) => tx as unknown as Db;

/** Takes the non-mutating Quality prefix in the shared usage→group→action→policy order. */
async function lockFacts(tx: Tx, request: QaRemediationPreparationRequest): Promise<FactResult> {
  const [pre] = await tx.select({ groupId: qualityActions.groupId, policyVersionId: qualityActions.policyVersionId })
    .from(qualityActions).where(and(eq(qualityActions.companyId, request.companyId), eq(qualityActions.id, request.qualityActionId!)));
  if (!pre) return failure("quality action is missing");
  await tx.select({ id: qualityPolicyUsage.id }).from(qualityPolicyUsage)
    .where(and(eq(qualityPolicyUsage.companyId, request.companyId), eq(qualityPolicyUsage.policyVersionId, pre.policyVersionId)))
    .orderBy(asc(qualityPolicyUsage.windowStart), asc(qualityPolicyUsage.id)).for("update");
  const [group] = await tx.select().from(qualityActionGroups)
    .where(and(eq(qualityActionGroups.companyId, request.companyId), eq(qualityActionGroups.id, pre.groupId))).for("update");
  const [action] = await tx.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, request.companyId), eq(qualityActions.id, request.qualityActionId!))).for("update");
  const [policyRow] = await tx.select().from(qualityPolicyVersions)
    .where(and(eq(qualityPolicyVersions.companyId, request.companyId), eq(qualityPolicyVersions.id, pre.policyVersionId))).for("share");
  if (!group || !action || !policyRow || action.groupId !== pre.groupId || action.policyVersionId !== pre.policyVersionId
    || group.policyVersionId !== action.policyVersionId) return failure("Quality group/action/policy scope changed");
  const target = qualityTargetSchema.safeParse(action.target), effect = qualityEffectSchema.safeParse(action.effect);
  const envelope = retryEnvelopeSchema.safeParse(action.retryEnvelope), policy = qualityPolicySchema.safeParse(policyRow.definition);
  const binding = nativeBindingSchema.safeParse(action.canonicalBinding);
  if (!target.success || target.data.kind !== "current_output" || !effect.success || effect.data.kind !== "repair_supported_output"
    || !envelope.success || !policy.success || !binding.success || action.kind !== "current_output") return failure("Quality action contract is unsupported or malformed");
  if (hashContract(target.data) !== action.targetHash || hashContract(effect.data) !== action.effectHash
    || !isDeepStrictEqual(target.data, effect.data.target)
    || envelope.data.targetHash !== action.targetHash || envelope.data.effectHash !== action.effectHash
    || envelope.data.intentKey !== action.intentKey || envelope.data.groupId !== action.groupId
    || envelope.data.policyVersionId !== action.policyVersionId) return failure("Quality action authority changed or effect target differs");
  const source = target.data.source, native = binding.data;
  if (source.workflow.kind !== "workflow_step" || source.mission.kind !== "mission"
    || source.companyId !== request.companyId || source.mission.id !== request.missionId
    || source.workflow.runId !== request.workflowRunId || source.workflow.stepRunId !== request.producerStepRunId
    || native.companyId !== request.companyId || native.actionId !== action.id || native.missionId !== request.missionId
    || native.workflowRunId !== request.workflowRunId || !request.qaStepRunIds.includes(native.stepRunId)) return failure("Quality source/canonical binding does not match the requested workflow scope");
  const occurrenceIds = [...action.occurrenceIds].sort();
  if (!occurrenceIds.length || new Set(occurrenceIds).size !== occurrenceIds.length
    || hashContract(occurrenceIds) !== action.occurrenceSetHash) return failure("Quality occurrence identity is malformed");
  const occurrences = await tx.select().from(qualityOccurrences).where(and(
    eq(qualityOccurrences.companyId, request.companyId), inArray(qualityOccurrences.id, occurrenceIds))).orderBy(asc(qualityOccurrences.id));
  if (occurrences.length !== occurrenceIds.length || occurrences.some(row => hashContract(row.sourceBinding) !== hashContract(source)
    || row.reviewItemId !== occurrences[0]?.reviewItemId)) return failure("Quality occurrence source/review binding changed");
  const reviewItemId = occurrences[0]!.reviewItemId;
  const [review] = await tx.select({ id: qualityReviewItems.id }).from(qualityReviewItems)
    .where(and(eq(qualityReviewItems.companyId, request.companyId), eq(qualityReviewItems.id, reviewItemId)));
  if (!review) return failure("Quality review item is missing");
  const fingerprint = hashContract({ actionId: action.id, revision: action.revision, cancelRequestedAt: action.cancelRequestedAt?.toISOString() ?? null,
    groupId: group.id, groupRevision: group.revision, groupDeadlineAt: group.deadlineAt?.toISOString() ?? null,
    policyVersionId: policyRow.id, policyState: [policyRow.approvedAt?.toISOString() ?? null,
      policyRow.enabledAt?.toISOString() ?? null, policyRow.disabledAt?.toISOString() ?? null], policy: policy.data,
    target: target.data, effect: effect.data, envelope: envelope.data, canonicalBinding: native, occurrenceIds, reviewItemId });
  return { ok: true, facts: { action, source, binding: native, reviewItemId, envelope: envelope.data, policy: policy.data,
    policyRow, groupDeadlineAt: group.deadlineAt, fingerprint } };
}

function sameCandidate(left: QaRemediationPreparation, right: QaRemediationPreparation): boolean {
  return left.companyId === right.companyId && left.missionId === right.missionId && left.workflowRunId === right.workflowRunId
    && left.dispatchAuthorityVersion === right.dispatchAuthorityVersion && isDeepStrictEqual(left.producer, right.producer)
    && isDeepStrictEqual(left.verdicts, right.verdicts) && isDeepStrictEqual(left.files, right.files);
}

type QualityFileHash = QaRemediationQualityBinding["fileHashes"][number];
function receiptBytes(actionId: string, source: Facts["source"], fileHashes: readonly QualityFileHash[]): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "quality_current_output_correction", qualityActionId: actionId,
    sourceAttemptHash: hashContract(source), fileHashes }));
}

function bindingFor(facts: Facts, p: QaRemediationPreparation, verifierRunId: string, verifierEpoch: number,
  fileHashes: readonly QualityFileHash[], uploadedEvidence: QaRemediationQualityBinding["uploadedEvidence"]): QaRemediationQualityBinding {
  return { kind: "quality_current_output", actionId: facts.action.id, groupId: facts.action.groupId,
    policyVersionId: facts.action.policyVersionId, intentKey: facts.action.intentKey, targetHash: facts.action.targetHash,
    effectHash: facts.action.effectHash, retryEnvelopeHash: hashContract(facts.action.retryEnvelope), source: facts.source,
    sourceAttemptHash: hashContract(facts.source), canonicalBinding: facts.binding, reviewItemId: facts.reviewItemId,
    verifierRunId, verifierEpoch, fileHashes: [...fileHashes],
    uploadedEvidence, expiresAt: facts.envelope.deadlineAt };
}

function bindingMatchesFacts(binding: QaRemediationQualityBinding, facts: Facts): boolean {
  return binding.actionId === facts.action.id && binding.groupId === facts.action.groupId
    && binding.policyVersionId === facts.action.policyVersionId && binding.intentKey === facts.action.intentKey
    && binding.targetHash === facts.action.targetHash && binding.effectHash === facts.action.effectHash
    && binding.retryEnvelopeHash === hashContract(facts.action.retryEnvelope)
    && hashContract(binding.source) === hashContract(facts.source) && isDeepStrictEqual(binding.canonicalBinding, facts.binding)
    && binding.reviewItemId === facts.reviewItemId && binding.expiresAt === facts.envelope.deadlineAt;
}

async function validateFrozenUpload(companyId: string, p: QaRemediationPreparation): Promise<boolean> {
  if (p.schemaVersion !== QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3) return false;
  if (!qualityFileHashesMatch(p)) return false;
  const expected = receiptBytes(p.qualityBinding.actionId, p.qualityBinding.source, p.qualityBinding.fileHashes);
  const d = p.qualityBinding.uploadedEvidence;
  if (d.byteSize !== expected.length || d.sha256 !== digest(expected)) return false;
  return (await readVerifiedEvidenceUpload(companyId, d)).equals(expected);
}

function qualityFileHashesMatch(p: QaRemediationPreparation): boolean {
  if (p.schemaVersion !== QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3) return false;
  const files = [...p.files].sort((a, b) => a.path.localeCompare(b.path));
  const hashes = p.qualityBinding.fileHashes;
  return hashes.length === files.length && hashes.every((hash, index) => hash.file === files[index]!.path
    && hash.after === files[index]!.afterSha256);
}

function baseRequest(request: QaRemediationPreparationRequest): QaRemediationPreparationRequest {
  const { qualityActionId: _qualityActionId, ...base } = request;
  return base;
}

/** Quality identifier-only admission. Upload happens between two independently locked facts snapshots. */
export async function prepareQaRemediationQualityReservation(db: Db, request: QaRemediationPreparationRequest): Promise<QualityPreparationResult> {
  if (is(db, PgTransaction) || !request.qualityActionId) throw new Error("qa_remediation_quality_root_required");
  const early = createReplacementRootNotifications();
  const first = await db.transaction(async raw => {
    const tx = raw as unknown as Tx, facts = await lockFacts(tx, request);
    if (!facts.ok) return { kind: "hold", detail: facts.detail } as const;
    const history = await classifyQualityActionHistory(tx, request);
    if (history && "detail" in history) return { kind: "hold", detail: history.detail } as const;
    if (history) {
      if (!bindingMatchesFacts(history.preparation.qualityBinding, facts.facts)) return { kind: "hold", detail: "stored Quality source/action binding differs" } as const;
      const committed = await withReplacementRootNotificationDb(dbOf(tx), early, () => readCommittedQaRemediationCompletion(dbOf(tx), history.preparation));
      if (committed) return { kind: "completed", history, result: committed } as const;
    }
    const current = await verifyCurrentQualityAuthority(tx, request, facts.facts);
    if (!current.ok) return { kind: "hold", detail: current.detail } as const;
    if (history) {
      const scope = { actionId: request.qualityActionId!, bindingHash: qaRemediationQualityBindingHash(history.preparation.qualityBinding) };
      const exact = await buildQaRemediationPreparationCandidate(raw, request, scope);
      if (exact.outcome === "existing" && exact.preparationEventId === history.row.id) {
        const p = exact.preparation;
        if (p.schemaVersion === QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3
          && sameCandidate(history.preparation, p) && bindingMatchesFacts(p.qualityBinding, facts.facts)) {
          return { kind: "existing", history: exact } as const;
        }
      }
      return { kind: "hold", detail: "D2 did not confirm the exact frozen Quality reservation" } as const;
    }
    const [use] = await tx.select({ count: sql<number>`count(*)::int` }).from(qualityEvidenceRefs).where(and(
      eq(qualityEvidenceRefs.companyId, request.companyId), eq(qualityEvidenceRefs.qualityActionId, request.qualityActionId!),
      sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'use'`));
    if ((use?.count ?? 0) >= facts.facts.envelope.maxExecutorAttempts) return { kind: "hold", detail: "Quality action executor-attempt limit is exhausted" } as const;
    const candidate = await buildQaRemediationPreparationCandidate(raw, baseRequest(request));
    if (candidate.outcome === "existing") return { kind: "hold", detail: "base history exists without an exact Quality v3 reservation" } as const;
    return { kind: "candidate", facts: facts.facts, candidate } as const;
  });
  if (first.kind === "hold") return { outcome: "held", reason: "invalid_history", detail: first.detail };
  if (first.kind === "completed") {
    if (!(await validateFrozenUpload(request.companyId, first.history.preparation))) return { outcome: "held", reason: "invalid_history", detail: "committed Quality receipt bytes are missing or changed" };
    return { outcome: "completed", result: first.result };
  }
  if (first.kind === "existing") {
    const p = first.history.preparation;
    if (!(await validateFrozenUpload(request.companyId, p))) return { outcome: "held", reason: "invalid_history", detail: "incomplete Quality reservation has a missing or changed frozen upload" };
    return { outcome: "existing", preparationEventId: first.history.preparationEventId, preparation: p,
      detail: "exact strict v3 reservation retained with its original upload; no reupload" };
  }
  const provisional = first.candidate;
  if (provisional.outcome !== "candidate") return provisional;
  const p0 = provisional.preparation;
  const canonicalQa = p0.verdicts.filter(v => v.qa.stepRunId === first.facts.binding.stepRunId && v.qa.issueId === first.facts.binding.issueId);
  if (canonicalQa.length !== 1) return { outcome: "held", reason: "invalid_history", detail: "canonical QA is not one exact candidate verdict" };
  const [verifier] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, request.companyId), eq(heartbeatRuns.id, canonicalQa[0]!.heartbeatRunId)));
  if (!verifier || verifier.executionEpoch === null || verifier.workflowStepRunId !== first.facts.binding.stepRunId) {
    return { outcome: "held", reason: "invalid_history", detail: "canonical QA verifier run/epoch is not current" };
  }
  const fileHashes: QualityFileHash[] = [];
  for (const file of p0.files) {
    const st = await stat(file.path);
    if (!st.isFile() || (await realpath(file.path)) !== file.path) return { outcome: "held", reason: "invalid_history", detail: "candidate file identity is not a canonical regular file" };
    const bytes = await readFile(file.path);
    if (bytes.length !== file.beforeByteSize || digest(bytes) !== file.beforeSha256) return { outcome: "held", reason: "invalid_history", detail: "candidate file changed before Quality evidence upload" };
    fileHashes.push({ file: file.path, before: digest(bytes.toString("utf8")), after: file.afterSha256 });
  }
  fileHashes.sort((a, b) => a.file.localeCompare(b.file));
  const rawReceipt = receiptBytes(first.facts.action.id, first.facts.source, fileHashes);
  const uploaded = await uploadEvidence(getStorageService(), { companyId: request.companyId, body: rawReceipt,
    contentType: "application/json", originalFilename: "current-output-correction.json" });
  if (!(await readVerifiedEvidenceUpload(request.companyId, uploaded)).equals(rawReceipt)) throw new Error("qa_remediation_quality_upload_bytes_mismatch");
  if (typeof uploaded.originalFilename !== "string" || !uploaded.originalFilename) return { outcome: "held", reason: "invalid_history", detail: "verified Quality upload descriptor has no original filename" };
  const frozenUpload = { ...uploaded, originalFilename: uploaded.originalFilename };
  const qualityBinding = bindingFor(first.facts, p0, verifier.id, verifier.executionEpoch, fileHashes, frozenUpload);
  const scope = { actionId: request.qualityActionId!, bindingHash: qaRemediationQualityBindingHash(qualityBinding) };
  return db.transaction(async raw => {
    const tx = raw as unknown as Tx, facts = await lockFacts(tx, request);
    if (!facts.ok || facts.facts.fingerprint !== first.facts.fingerprint) return { outcome: "held", reason: "invalid_history", detail: facts.ok ? "Quality facts changed during evidence upload" : facts.detail };
    const current = await verifyCurrentQualityAuthority(tx, request, facts.facts);
    if (!current.ok) return { outcome: "held", reason: "invalid_history", detail: current.detail };
    const candidate = await buildQaRemediationPreparationCandidate(raw, request, scope);
    if (candidate.outcome === "existing") {
      const p = candidate.preparation;
      return p.schemaVersion === QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3 && bindingMatchesFacts(p.qualityBinding, facts.facts)
        && sameCandidate(p0, p) && qaRemediationQualityBindingHash(p.qualityBinding) === scope.bindingHash
        ? { ...candidate, outcome: "existing" as const } : { outcome: "held" as const, reason: "invalid_history" as const, detail: "concurrent Quality reservation differs" };
    }
    if (candidate.outcome !== "candidate" || !sameCandidate(p0, candidate.preparation)) return { outcome: "held", reason: "invalid_history", detail: "QA/file candidate changed during evidence upload" };
    const preparation = parseQaRemediationPreparation({ ...p0, schemaVersion: QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3, qualityBinding });
    const stored = await writeQaRemediationPreparation(raw, preparation, candidate.scope);
    return stored;
  });
}

/** Final publication transaction re-locks and revalidates Quality before mission/run/reservation rows. */
export async function verifyQaRemediationQualityRoot(tx: Tx, request: QaRemediationPreparationRequest,
  preparation: QaRemediationPreparation): Promise<{ ok: true; maxExecutorAttempts: number; verifyCurrentAuthority: () => Promise<{ ok: true } | { ok: false; detail: string }> } | { ok: false; detail: string }> {
  if (preparation.schemaVersion !== QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3) return { ok: false, detail: "Quality preparation is not strict v3" };
  const facts = await lockFacts(tx, request);
  if (!facts.ok) return facts;
  const b = preparation.qualityBinding;
  if (!bindingMatchesFacts(b, facts.facts) || !qualityFileHashesMatch(preparation)) {
    return { ok: false, detail: "current Quality source/action/review differs from the frozen reservation" };
  }
  const history = await classifyQualityActionHistory(tx, request);
  if (!history || "detail" in history || history.row.id !== preparation.preparationId
    || !sameCandidate(history.preparation, preparation)
    || qaRemediationQualityBindingHash(history.preparation.qualityBinding) !== qaRemediationQualityBindingHash(b)) {
    return { ok: false, detail: "D2 no longer classifies the exact frozen Quality reservation" };
  }
  const match = preparation.verdicts.filter(v => v.qa.stepRunId === facts.facts.binding.stepRunId && v.qa.issueId === facts.facts.binding.issueId);
  if (match.length !== 1 || match[0]!.heartbeatRunId !== b.verifierRunId) return { ok: false, detail: "frozen canonical QA verifier differs" };
  const [verifier] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, request.companyId), eq(heartbeatRuns.id, b.verifierRunId)));
  if (!verifier || verifier.executionEpoch !== b.verifierEpoch || verifier.workflowStepRunId !== facts.facts.binding.stepRunId) return { ok: false, detail: "frozen verifier epoch changed" };
  return { ok: true, maxExecutorAttempts: facts.facts.envelope.maxExecutorAttempts,
    verifyCurrentAuthority: () => verifyCurrentQualityAuthority(tx, request, facts.facts) };
}

export async function verifyQaRemediationQualityUseLimit(tx: Tx, request: QaRemediationPreparationRequest,
  maxExecutorAttempts: number): Promise<boolean> {
  const [use] = await tx.select({ count: sql<number>`count(*)::int` }).from(qualityEvidenceRefs).where(and(
    eq(qualityEvidenceRefs.companyId, request.companyId), eq(qualityEvidenceRefs.qualityActionId, request.qualityActionId!),
    sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'use'`));
  return (use?.count ?? 0) < maxExecutorAttempts;
}

export function forwardCommittedQualityNotifications(target: { agentIds: Set<string>; correctionWakeupRequestIds: Set<string> },
  result: QaRemediationCompletionResult): void {
  for (const id of result.notifications.agentIds) target.agentIds.add(id);
}
