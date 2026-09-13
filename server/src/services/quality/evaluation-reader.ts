// server/src/services/quality/evaluation-reader.ts
//
// [purpose] T6 open/read. open 은 고정 manifest(발생=실패 사례, 정책 oracle=정상 사례)의 저장 bytes 를
//   다시 읽어 고정 plan schema 로 해석한 입력·체크를 영수증으로 저장한다. read 는 그 입력에 대한
//   bounded JSON Pointer 만 허용하고 선택값/위치/hash 를 기록하며, 검증자 회사·run·checkout·세대·epoch
//   binding 은 매 호출마다 다시 확인한다. URL·경로·표현식 참조 금지, 변조 bytes 는 hash 불일치로 닫힌다.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog, evaluatorCandidateRuns, evaluatorVersions, heartbeatRuns, issues, qualityActions,
  qualityEvidenceRefs, qualityOccurrences,
} from "@paperclipai/db";
import {
  addendumCheckSchema, artifactRefSchema, checkResultSchema, qualityAgentActorSchema, uuidSchema,
  type AddendumCheck, type ArtifactRef, type QualityAgentActor, type QualityPolicy,
} from "@paperclipai/shared";
import { z } from "zod";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { getStorageService } from "../../storage/index.js";
import { hashContract, parseEvidence } from "./contract.js";
import { readSourceEvidence, readVerifiedArtifact, attachEvidence, uploadEvidence } from "./evidence-store.js";
import { comparisonSchema, planDocumentSchema } from "./evaluation-contract.js";
import { loadQualityPolicy } from "./evaluation-candidates.js";

export const MAX_CASE_INPUT_BYTES = 524_288;
const MAX_POINTERS = 16;
const POINTER_RE = /^\/[A-Za-z0-9_][A-Za-z0-9_-]{0,63}(\/[A-Za-z0-9_][A-Za-z0-9_-]{0,63}){0,11}$/;
const nonNegativeInteger = z.number().int().safe().min(0);
const caseKey = (caseId: string, variant: "baseline" | "candidate") => `${caseId}:${variant}`;

export const invocationStateSchema = z.object({
  invocationId: uuidSchema, inputRef: artifactRefSchema, sourceRef: artifactRefSchema,
  checks: z.array(z.string().min(1).max(200)).min(1), openedAt: z.string().datetime(),
}).strict();
export type InvocationState = z.infer<typeof invocationStateSchema>;

export const evaluationStateSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("evaluation"),
  actionId: uuidSchema,
  candidateVersionId: uuidSchema,
  checks: z.array(addendumCheckSchema),
  verifier: z.object({
    agentId: uuidSchema,
    step: z.object({ issueId: uuidSchema, stepRunId: uuidSchema, workflowRunId: uuidSchema, generation: nonNegativeInteger, dispatchAuthorityVersion: nonNegativeInteger }).strict(),
    run: z.object({ heartbeatRunId: uuidSchema, executionEpoch: nonNegativeInteger }).strict().nullable(),
  }).strict(),
  authorRun: z.object({ heartbeatRunId: uuidSchema, executionEpoch: nonNegativeInteger }).strict(),
  invocationIndex: z.record(z.string(), z.object({ caseId: z.string().min(1).max(200), variant: z.enum(["baseline", "candidate"]) }).strict()),
  invocations: z.record(z.string(), invocationStateSchema),
  reads: z.record(z.string(), z.record(z.string(), z.object({
    readRef: artifactRefSchema, pointers: z.array(z.string()), values: z.array(z.unknown()), inputSha256: z.string(),
  }).strict())),
  submissions: z.record(z.string(), z.object({
    submissionRef: artifactRefSchema, results: z.array(checkResultSchema), submittedAt: z.string().datetime(),
  }).strict()),
  resubmissions: z.record(z.string(), nonNegativeInteger),
  verdict: z.object({
    status: z.enum(["pass", "fail", "no_improvement"]), evidenceRefId: uuidSchema,
    rows: z.array(comparisonSchema), scoredAt: z.string().datetime(),
  }).strict().nullable(),
}).strict();
export type EvaluationState = z.infer<typeof evaluationStateSchema>;

export function evaluationContract(row: typeof evaluatorCandidateRuns.$inferSelect): EvaluationState {
  const parsed = evaluationStateSchema.safeParse(row.qualityContract);
  if (!parsed.success) throw conflict("quality_evaluation_contract_missing");
  return parsed.data;
}

export type EvaluationRow = typeof evaluatorCandidateRuns.$inferSelect;

export async function loadEvaluation(db: Db, companyId: string, evaluationId: string): Promise<EvaluationRow> {
  const rows = await db.select().from(evaluatorCandidateRuns)
    .where(and(eq(evaluatorCandidateRuns.companyId, companyId), eq(evaluatorCandidateRuns.id, evaluationId))).limit(2);
  if (!rows.length) throw notFound("quality_evaluation_not_found");
  if (rows.length !== 1) throw conflict("quality_evaluation_ambiguous");
  return rows[0]!;
}

export async function loadEvaluationByInvocation(db: Db, companyId: string, invocationId: string): Promise<EvaluationRow> {
  const rows = await db.select().from(evaluatorCandidateRuns).where(and(
    eq(evaluatorCandidateRuns.companyId, companyId),
    sql`${evaluatorCandidateRuns.qualityContract}->'invocationIndex'->>${invocationId} is not null`,
  )).limit(2);
  if (!rows.length) throw notFound("quality_invocation_not_found");
  if (rows.length !== 1) throw conflict("quality_evaluation_ambiguous");
  return rows[0]!;
}

/** B 는 후보 작성 참여자 전체(정책 author + 각 버전 작성자)에서 제외된다. */
export async function assertVerifierAccess(db: Db, actor: QualityAgentActor, state: EvaluationState, issueId: string | null): Promise<void> {
  if (issueId !== null && state.verifier.step.issueId !== issueId) throw notFound("quality_evaluation_not_found");
  const [action] = await db.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, actor.companyId), eq(qualityActions.id, state.actionId)));
  if (!action) throw notFound("quality_evaluation_not_found");
  const policy = await loadQualityPolicy(db, actor.companyId, action.policyVersionId);
  const excluded = new Set<string>(policy.authorAgentIds);
  const versions = await db.select({ qualityContract: evaluatorVersions.qualityContract }).from(evaluatorVersions)
    .where(and(eq(evaluatorVersions.companyId, actor.companyId), eq(evaluatorVersions.qualityActionId, state.actionId)));
  for (const version of versions) {
    for (const author of (version.qualityContract as { authors?: unknown } | null)?.authors as string[] | undefined ?? []) excluded.add(author);
  }
  if (!policy.verifierAgentIds.includes(actor.agentId) || excluded.has(actor.agentId)) {
    throw forbidden("quality_verifier_role_required");
  }
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, actor.companyId), eq(heartbeatRuns.id, actor.heartbeatRunId), eq(heartbeatRuns.agentId, actor.agentId),
  ));
  if (!run || run.executionEpoch !== actor.executionEpoch || run.issueId !== state.verifier.step.issueId
    || run.workflowStepRunId !== state.verifier.step.stepRunId
    || run.workflowExecutionGeneration !== state.verifier.step.generation
    || !["queued", "running"].includes(run.status)) throw unprocessable("quality_attempt_binding_mismatch");
  const [issue] = await db.select({ checkoutRunId: issues.checkoutRunId }).from(issues)
    .where(and(eq(issues.companyId, actor.companyId), eq(issues.id, state.verifier.step.issueId)));
  if (!issue || issue.checkoutRunId !== actor.heartbeatRunId) throw conflict("quality_verifier_checkout_required");
}

export type CaseManifestEntry = {
  caseId: string; group: "failure" | "normal"; sourceRef: ArtifactRef;
  read: (db: Db) => Promise<Buffer>;
};

/** 고정 manifest: 발생(실패 사례) f{序}-{발생id 앞 8자}, 정책 oracle(정상 사례) n{序}-{oracle index}. */
export async function caseManifest(db: Db, action: typeof qualityActions.$inferSelect, policy: QualityPolicy): Promise<CaseManifestEntry[]> {
  const entries: CaseManifestEntry[] = [];
  const occurrenceIds = action.occurrenceIds;
  const occurrences = occurrenceIds.length
    ? await db.select().from(qualityOccurrences)
        .where(and(eq(qualityOccurrences.companyId, action.companyId), inArray(qualityOccurrences.id, occurrenceIds)))
    : [];
  const byId = new Map(occurrences.map((row) => [row.id, row]));
  for (const [index, occurrenceId] of occurrenceIds.entries()) {
    const occurrence = byId.get(occurrenceId);
    if (!occurrence) throw conflict("quality_occurrence_missing");
    const [receiptId] = occurrence.evidenceRefIds;
    const [receipt] = receiptId
      ? await db.select().from(qualityEvidenceRefs)
          .where(and(eq(qualityEvidenceRefs.companyId, action.companyId), eq(qualityEvidenceRefs.id, receiptId)))
      : [];
    if (!receipt) throw conflict("quality_evidence_missing");
    const sourceRef = (receipt.qualityContract as { ref: ArtifactRef }).ref;
    entries.push({
      caseId: `f${index + 1}-${occurrence.id.slice(0, 8)}`,
      group: "failure",
      sourceRef,
      read: async (database) => readSourceEvidence(database, {
        companyId: action.companyId, ref: sourceRef, source: occurrence.sourceBinding, maxBytes: MAX_CASE_INPUT_BYTES,
      }),
    });
  }
  policy.caseOracleRefs.forEach((ref, index) => {
    entries.push({
      caseId: `n${index + 1}-${index}`,
      group: "normal",
      sourceRef: ref,
      read: async (database) => readVerifiedArtifact(database, { companyId: action.companyId, ref, maxBytes: MAX_CASE_INPUT_BYTES }),
    });
  });
  return entries;
}

export async function baseChecksOf(policy: QualityPolicy, action: typeof qualityActions.$inferSelect): Promise<AddendumCheck[]> {
  const target = action.target;
  if (target.kind !== "qa_addendum") throw conflict("quality_action_kind_mismatch");
  const policyTarget = policy.targets.find((t) => t.templateId === target.templateId && t.baseHash === target.baseHash);
  if (!policyTarget) throw conflict("quality_policy_target_unavailable");
  return policyTarget.required;
}

const openInputSchema = z.object({
  issueId: uuidSchema, evaluationId: uuidSchema, caseId: z.string().min(1).max(200),
  variant: z.enum(["baseline", "candidate"]),
}).strict();

export async function openQualityCase(db: Db, actorInput: unknown, input: unknown): Promise<{ invocationId: string; inputRef: ArtifactRef }> {
  const actor = parseEvidence(qualityAgentActorSchema, actorInput);
  const value = parseEvidence(openInputSchema, input);
  const row = await loadEvaluation(db, actor.companyId, value.evaluationId);
  const state = evaluationContract(row);
  await assertVerifierAccess(db, actor, state, value.issueId);
  const existing = state.invocations[caseKey(value.caseId, value.variant)];
  if (existing) return { invocationId: existing.invocationId, inputRef: existing.inputRef };
  const [action] = await db.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, actor.companyId), eq(qualityActions.id, state.actionId)));
  if (!action) throw notFound("quality_evaluation_not_found");
  const policy = await loadQualityPolicy(db, actor.companyId, action.policyVersionId);
  const manifest = await caseManifest(db, action, policy);
  const entry = manifest.find((candidate) => candidate.caseId === value.caseId);
  if (!entry) throw notFound("quality_case_not_found");
  const bytes = await entry.read(db);
  const plan = parseEvidence(planDocumentSchema, JSON.parse(bytes.toString("utf8")));
  const base = await baseChecksOf(policy, action);
  const checks = value.variant === "baseline" ? base : [...base, ...state.checks];
  if (!checks.length) throw conflict("quality_evaluation_contract_missing");
  const inputDoc = {
    schemaVersion: 1 as const,
    evaluation: { evaluationId: value.evaluationId, caseId: value.caseId, variant: value.variant, group: entry.group },
    plan,
    checks: checks.map((check) => ({ checkId: check.checkId, instructions: check.instructions, expectedEvidenceKinds: check.expectedEvidenceKinds, applicability: check.applicability })),
  };
  const uploaded = await uploadEvidence(getStorageService(), { companyId: actor.companyId,
    body: Buffer.from(JSON.stringify(inputDoc)), contentType: "application/json", originalFilename: null });
  const invocationId = randomUUID();
  const openedAt = new Date().toISOString();
  return db.transaction(async (tx) => {
    await tx.select({ id: qualityActions.id }).from(qualityActions)
      .where(and(eq(qualityActions.companyId, actor.companyId), eq(qualityActions.id, state.actionId))).for("update");
    const [fresh] = await tx.select().from(evaluatorCandidateRuns)
      .where(and(eq(evaluatorCandidateRuns.companyId, actor.companyId), eq(evaluatorCandidateRuns.id, value.evaluationId))).for("update");
    const freshState = evaluationContract(fresh!);
    const prior = freshState.invocations[caseKey(value.caseId, value.variant)];
    if (prior) return { invocationId: prior.invocationId, inputRef: prior.inputRef };
    // 검증자 실행 binding 을 최초 확인 시점의 실제 run 으로 기록한다(판정 영수증 source).
    freshState.verifier.run ??= { heartbeatRunId: actor.heartbeatRunId, executionEpoch: actor.executionEpoch };
    const inputRef = await attachEvidence(tx, { companyId: actor.companyId, issueId: state.verifier.step.issueId, uploaded });
    freshState.invocations[caseKey(value.caseId, value.variant)] = {
      invocationId, inputRef, sourceRef: entry.sourceRef, checks: checks.map((check) => check.checkId), openedAt,
    };
    freshState.invocationIndex[invocationId] = { caseId: value.caseId, variant: value.variant };
    await tx.update(evaluatorCandidateRuns).set({ qualityContract: freshState, updatedAt: new Date() })
      .where(and(eq(evaluatorCandidateRuns.companyId, actor.companyId), eq(evaluatorCandidateRuns.id, value.evaluationId)));
    await tx.insert(activityLog).values({
      companyId: actor.companyId, actorType: "system", actorId: "quality", action: "quality.case_opened",
      entityType: "evaluator_candidate_run", entityId: value.evaluationId,
      details: { invocationId, caseId: value.caseId, variant: value.variant, inputHash: hashContract(inputDoc.evaluation) },
    });
    return { invocationId, inputRef };
  });
}

const readInputSchema = z.object({
  invocationId: uuidSchema, checkId: z.string().min(1).max(200),
  pointers: z.array(z.string().min(1).max(512)).min(1).max(64),
}).strict();

export async function readQualityCheck(db: Db, actorInput: unknown, input: unknown): Promise<{ readRef: ArtifactRef; values: unknown[] }> {
  const actor = parseEvidence(qualityAgentActorSchema, actorInput);
  const value = parseEvidence(readInputSchema, input);
  const row = await loadEvaluationByInvocation(db, actor.companyId, value.invocationId);
  const state = evaluationContract(row);
  await assertVerifierAccess(db, actor, state, null);
  const indexed = state.invocationIndex[value.invocationId];
  const invocation = state.invocations[caseKey(indexed.caseId, indexed.variant)];
  if (!invocation) throw notFound("quality_invocation_not_found");
  if (!invocation.checks.includes(value.checkId)) throw unprocessable("quality_check_not_applicable");
  const prior = state.reads[value.invocationId]?.[value.checkId];
  if (prior) return { readRef: prior.readRef, values: prior.values };
  for (const pointer of value.pointers) {
    if (!POINTER_RE.test(pointer) || value.pointers.length > MAX_POINTERS) throw unprocessable("quality_pointer_invalid");
  }
  const bytes = await readVerifiedArtifact(db, { companyId: actor.companyId, ref: invocation.inputRef, maxBytes: MAX_CASE_INPUT_BYTES });
  const document = JSON.parse(bytes.toString("utf8"));
  const values: unknown[] = [];
  for (const pointer of value.pointers) {
    const resolved = resolvePointer(document, pointer);
    if (!resolved.found) throw unprocessable("quality_pointer_missing");
    values.push(resolved.value);
  }
  const receipt = { schemaVersion: 1 as const, invocationId: value.invocationId, checkId: value.checkId, pointers: value.pointers, values, inputSha256: invocation.inputRef.sha256 };
  const uploaded = await uploadEvidence(getStorageService(), { companyId: actor.companyId,
    body: Buffer.from(JSON.stringify(receipt)), contentType: "application/json", originalFilename: null });
  return db.transaction(async (tx) => {
    await tx.select({ id: qualityActions.id }).from(qualityActions)
      .where(and(eq(qualityActions.companyId, actor.companyId), eq(qualityActions.id, state.actionId))).for("update");
    const [fresh] = await tx.select().from(evaluatorCandidateRuns)
      .where(and(eq(evaluatorCandidateRuns.companyId, actor.companyId), eq(evaluatorCandidateRuns.id, row.id))).for("update");
    const freshState = evaluationContract(fresh!);
    const stored = freshState.reads[value.invocationId]?.[value.checkId];
    if (stored) return { readRef: stored.readRef, values: stored.values };
    freshState.verifier.run ??= { heartbeatRunId: actor.heartbeatRunId, executionEpoch: actor.executionEpoch };
    const readRef = await attachEvidence(tx, { companyId: actor.companyId, issueId: state.verifier.step.issueId, uploaded });
    freshState.reads[value.invocationId] = { ...(freshState.reads[value.invocationId] ?? {}), [value.checkId]: { readRef, pointers: value.pointers, values, inputSha256: invocation.inputRef.sha256 } };
    await tx.update(evaluatorCandidateRuns).set({ qualityContract: freshState, updatedAt: new Date() })
      .where(and(eq(evaluatorCandidateRuns.companyId, actor.companyId), eq(evaluatorCandidateRuns.id, row.id)));
    await tx.insert(activityLog).values({
      companyId: actor.companyId, actorType: "system", actorId: "quality", action: "quality.case_read",
      entityType: "evaluator_candidate_run", entityId: row.id,
      details: { invocationId: value.invocationId, checkId: value.checkId, pointers: value.pointers },
    });
    return { readRef, values };
  });
}

/** 배열 인덱스는 10진 정수만, 객체 키는 자체 소유 문자열 키만. 그 외는 없음(missing). */
export function resolvePointer(document: unknown, pointer: string): { found: boolean; value: unknown } {
  let current: unknown = document;
  for (const token of pointer.slice(1).split("/")) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]{0,5})$/.test(token) || Number(token) >= current.length) return { found: false, value: undefined };
      current = current[Number(token)]!;
      continue;
    }
    if (typeof current !== "object" || current === null || !Object.prototype.hasOwnProperty.call(current, token)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[token]!;
  }
  return { found: true, value: current };
}
