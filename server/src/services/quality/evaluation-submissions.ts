// server/src/services/quality/evaluation-submissions.ts
//
// [purpose] T6 사례 제출·평가 판정·완료 게이트. submit 은 기록된 read receipt 와 저장 bytes 를 다시
//   읽어 scope/hash/coverage 를 확인하고 누락은 정확한 artifact/check/scope·제출 URL·schema·남은 횟수를 가진
//   MissingEvidence 로 돌려준다(유한 재시도). verify 는 서버가 고정 manifest 를 join 해 만든 Comparison 에만
//   순수 판정을 쓴다. generic workflow 완료는 전용 근거(후보/판정 영수증) 없이는 단계를 끝내지 못한다.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog, evaluatorCandidateRuns, evaluatorVersions, qualityActions, qualityOccurrences,
} from "@paperclipai/db";
import {
  checkResultSchema, evaluationScopeSchema, missingEvidenceSchema, qualityAgentActorSchema,
  qualityKeySchema, uuidSchema, type ArtifactRef, type CheckResult, type EvaluationScope,
  type MissingEvidence, type QualityAgentActor, type QualityKey,
} from "@paperclipai/shared";
import { z } from "zod";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { getStorageService } from "../../storage/index.js";
import { parseEvidence } from "./contract.js";
import { attachEvidence, linkEvidence, readVerifiedArtifact, uploadEvidence } from "./evidence-store.js";
import { loadQualityPolicy } from "./evaluation-candidates.js";
import {
  assertVerifierAccess, caseManifest, evaluationContract, loadEvaluation,
  loadEvaluationByInvocation, MAX_CASE_INPUT_BYTES, type EvaluationState,
} from "./evaluation-reader.js";
import { caseVerdict, scoreEvaluation, type Comparison } from "./evaluation-contract.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const submitInputSchema = z.object({
  invocationId: uuidSchema,
  schemaVersion: z.literal(1),
  results: z.array(checkResultSchema).refine(
    (results) => new Set(results.map((result) => result.checkId)).size === results.length, "quality_duplicate_entry"),
}).strict();
type Reason = MissingEvidence["reasons"][number];
type RunBinding = { heartbeatRunId: string; executionEpoch: number };

const resultsPath = (state: EvaluationState, evaluationId: string, invocationId: string) =>
  `/api/issues/${state.verifier.step.issueId}/quality/evaluations/${evaluationId}/v1/invocations/${invocationId}/results`;
const openPath = (state: EvaluationState, evaluationId: string, caseId: string, variant: string) =>
  `/api/issues/${state.verifier.step.issueId}/quality/evaluations/${evaluationId}/v1/cases/${caseId}/${variant}/open`;

/** EvaluationScope 은 검증자 실행 binding 이 원칙. B 체크인 전 단계 누락 안내에는 후보를 고정한 author 실행 binding 을 쓴다(기록된 실제 실행). */
function evaluationScopeFor(state: EvaluationState, companyId: string, evaluationId: string, missionId: string, run: RunBinding): EvaluationScope {
  return parseEvidence(evaluationScopeSchema, {
    kind: "evaluation", companyId, actionId: state.actionId, evaluationId, missionId,
    workflowRunId: state.verifier.step.workflowRunId, stepRunId: state.verifier.step.stepRunId,
    generation: state.verifier.step.generation, issueId: state.verifier.step.issueId,
    heartbeatRunId: run.heartbeatRunId, executionEpoch: run.executionEpoch,
  });
}

/** 재제출 가능 횟수: 이번 응답 직전까지의 누락 횟수(prior)를 기준으로 남은 횟수를 계산하고, 이번 누락을 기록한다. */
async function spendResubmission(db: Db, companyId: string, actionId: string, evaluationId: string, key: string, max: number): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.select({ id: qualityActions.id }).from(qualityActions)
      .where(and(eq(qualityActions.companyId, companyId), eq(qualityActions.id, actionId))).for("update");
    const [fresh] = await tx.select().from(evaluatorCandidateRuns)
      .where(and(eq(evaluatorCandidateRuns.companyId, companyId), eq(evaluatorCandidateRuns.id, evaluationId))).for("update");
    const freshState = evaluationContract(fresh!);
    const prior = freshState.resubmissions[key] ?? 0;
    freshState.resubmissions[key] = Math.min(prior + 1, Math.max(max, 1));
    await tx.update(evaluatorCandidateRuns).set({ qualityContract: freshState, updatedAt: new Date() })
      .where(and(eq(evaluatorCandidateRuns.companyId, companyId), eq(evaluatorCandidateRuns.id, evaluationId)));
    return Math.max(0, max - prior);
  });
}

export async function submitQualityCase(db: Db, actorInput: unknown, input: unknown): Promise<{ submissionRef: ArtifactRef } | MissingEvidence> {
  const actor = parseEvidence(qualityAgentActorSchema, actorInput);
  const value = parseEvidence(submitInputSchema, input);
  const row = await loadEvaluationByInvocation(db, actor.companyId, value.invocationId);
  const state = evaluationContract(row);
  await assertVerifierAccess(db, actor, state, null);
  const indexed = state.invocationIndex[value.invocationId];
  const invocation = state.invocations[`${indexed.caseId}:${indexed.variant}`];
  if (!invocation) throw notFound("quality_invocation_not_found");
  const stored = state.submissions[value.invocationId];
  if (stored) return { submissionRef: stored.submissionRef };
  for (const result of value.results) {
    if (!invocation.checks.includes(result.checkId)) throw unprocessable("quality_check_not_applicable");
  }
  const [action] = await db.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, actor.companyId), eq(qualityActions.id, state.actionId)));
  if (!action || !action.canonicalBinding) throw notFound("quality_evaluation_not_found");
  const policy = await loadQualityPolicy(db, actor.companyId, action.policyVersionId);

  const reasons: Reason[] = [];
  const covered = new Set(value.results.map((result) => result.checkId));
  for (const checkId of invocation.checks) {
    if (!covered.has(checkId)) reasons.push({ code: "quality_check_uncovered", checkId, requiredKind: "read", expectedHash: null });
  }
  for (const result of value.results) {
    const recorded = state.reads[value.invocationId]?.[result.checkId];
    if (!recorded) {
      reasons.push({ code: "quality_read_receipt_missing", checkId: result.checkId, requiredKind: "read", expectedHash: null });
      continue;
    }
    if (recorded.readRef.attachmentId !== result.readRef.attachmentId || recorded.readRef.sha256 !== result.readRef.sha256) {
      reasons.push({ code: "quality_read_receipt_mismatch", checkId: result.checkId, requiredKind: "read", expectedHash: recorded.readRef.sha256 });
      continue;
    }
    try {
      await readVerifiedArtifact(db, { companyId: actor.companyId, ref: recorded.readRef, maxBytes: MAX_CASE_INPUT_BYTES });
    } catch {
      reasons.push({ code: "quality_read_receipt_unreadable", checkId: result.checkId, requiredKind: "read", expectedHash: recorded.readRef.sha256 });
    }
    for (const ref of result.evidence) {
      try {
        await readVerifiedArtifact(db, { companyId: actor.companyId, ref, maxBytes: MAX_CASE_INPUT_BYTES });
      } catch {
        reasons.push({ code: "quality_evidence_unresolvable", checkId: result.checkId, requiredKind: "evidence", expectedHash: ref.sha256 });
      }
    }
  }
  if (reasons.length) {
    const remaining = await spendResubmission(db, actor.companyId, state.actionId, row.id, value.invocationId, policy.maxEvidenceResubmissions);
    return parseEvidence(missingEvidenceSchema, {
      status: "missing_evidence" as const,
      scope: evaluationScopeFor(state, actor.companyId, row.id, action.canonicalBinding.missionId, actor),
      reasons,
      submission: { method: "POST" as const, path: resultsPath(state, row.id, value.invocationId), schemaVersion: 1 },
      remainingResubmissions: remaining,
    });
  }

  const receipt = { schemaVersion: 1 as const, invocationId: value.invocationId, caseId: indexed.caseId, variant: indexed.variant, results: value.results };
  const uploaded = await uploadEvidence(getStorageService(), { companyId: actor.companyId,
    body: Buffer.from(JSON.stringify(receipt)), contentType: "application/json", originalFilename: null });
  const submittedAt = new Date().toISOString();
  return db.transaction(async (tx) => {
    await tx.select({ id: qualityActions.id }).from(qualityActions)
      .where(and(eq(qualityActions.companyId, actor.companyId), eq(qualityActions.id, state.actionId))).for("update");
    const [fresh] = await tx.select().from(evaluatorCandidateRuns)
      .where(and(eq(evaluatorCandidateRuns.companyId, actor.companyId), eq(evaluatorCandidateRuns.id, row.id))).for("update");
    const freshState = evaluationContract(fresh!);
    const prior = freshState.submissions[value.invocationId];
    if (prior) return { submissionRef: prior.submissionRef };
    const submissionRef = await attachEvidence(tx, { companyId: actor.companyId, issueId: state.verifier.step.issueId, uploaded });
    freshState.submissions[value.invocationId] = { submissionRef, results: value.results, submittedAt };
    await tx.update(evaluatorCandidateRuns).set({ qualityContract: freshState, updatedAt: new Date() })
      .where(and(eq(evaluatorCandidateRuns.companyId, actor.companyId), eq(evaluatorCandidateRuns.id, row.id)));
    await tx.insert(activityLog).values({
      companyId: actor.companyId, actorType: "system", actorId: "quality", action: "quality.case_submitted",
      entityType: "evaluator_candidate_run", entityId: row.id,
      details: { invocationId: value.invocationId, caseId: indexed.caseId, variant: indexed.variant },
    });
    return { submissionRef };
  });
}

export async function verifyQualityEvaluation(db: Db, actorInput: unknown, key: QualityKey): Promise<{ status: "pass" | "fail" | "no_improvement"; evidenceRefId: string } | MissingEvidence> {
  const actor = parseEvidence(qualityAgentActorSchema, actorInput);
  const parsedKey = parseEvidence(qualityKeySchema, key);
  const [action] = await db.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, parsedKey.companyId), eq(qualityActions.id, parsedKey.actionId)));
  if (!action) throw notFound("quality_action_not_found");
  if (!action.currentEvaluationId || !action.canonicalBinding) throw notFound("quality_evaluation_not_found");
  const row = await loadEvaluation(db, parsedKey.companyId, action.currentEvaluationId);
  const state = evaluationContract(row);
  // [리뷰 중요1] verify 도 매 요청 검증자 binding 을 확인한다(후보 작성자 A 포함 전원 거부, board 대체 불가).
  await assertVerifierAccess(db, actor, state, null);
  if (state.verdict) return { status: state.verdict.status, evidenceRefId: state.verdict.evidenceRefId };
  const policy = await loadQualityPolicy(db, parsedKey.companyId, action.policyVersionId);
  const manifest = await caseManifest(db, action, policy);
  const reasons: Reason[] = [];
  const rows: Comparison[] = [];
  let fallbackPath: string | null = null;
  for (const entry of manifest) {
    const collected = { baseline: null as CheckResult[] | null, candidate: null as CheckResult[] | null };
    for (const variant of ["baseline", "candidate"] as const) {
      const invocation = state.invocations[`${entry.caseId}:${variant}`];
      if (!invocation) {
        reasons.push({ code: "quality_invocation_missing", checkId: null, requiredKind: "invocation", expectedHash: null });
        fallbackPath ??= openPath(state, row.id, entry.caseId, variant);
        continue;
      }
      fallbackPath ??= resultsPath(state, row.id, invocation.invocationId);
      const submission = state.submissions[invocation.invocationId];
      if (!submission) {
        reasons.push({ code: "quality_submission_missing", checkId: null, requiredKind: "submission", expectedHash: null });
        continue;
      }
      let readable = true;
      for (const checkId of invocation.checks) {
        const recorded = state.reads[invocation.invocationId]?.[checkId];
        if (!recorded) {
          reasons.push({ code: "quality_read_receipt_missing", checkId, requiredKind: "read", expectedHash: null });
          readable = false;
          continue;
        }
        try {
          await readVerifiedArtifact(db, { companyId: parsedKey.companyId, ref: recorded.readRef, maxBytes: MAX_CASE_INPUT_BYTES });
        } catch {
          reasons.push({ code: "quality_read_receipt_unreadable", checkId, requiredKind: "read", expectedHash: recorded.readRef.sha256 });
          readable = false;
        }
      }
      try {
        await readVerifiedArtifact(db, { companyId: parsedKey.companyId, ref: submission.submissionRef, maxBytes: MAX_CASE_INPUT_BYTES });
      } catch {
        reasons.push({ code: "quality_submission_unreadable", checkId: null, requiredKind: "submission", expectedHash: submission.submissionRef.sha256 });
        readable = false;
      }
      if (readable) collected[variant] = submission.results;
    }
    rows.push({
      id: entry.caseId,
      group: entry.group,
      expected: entry.group === "failure" ? "request_changes" : "pass",
      baseline: collected.baseline ? caseVerdict(collected.baseline) : null,
      candidate: collected.candidate ? caseVerdict(collected.candidate) : null,
      // 독립 B 의 의미 검증: B 의 제출(read receipt + status)이 사례·변형 전체를 덮을 때만 verified.
      semantic: collected.baseline && collected.candidate ? "verified" : "missing",
    });
  }
  const missingFor = (reasons: Reason[], path: string) => parseEvidence(missingEvidenceSchema, {
    status: "missing_evidence" as const,
    scope: evaluationScopeFor(state, parsedKey.companyId, row.id, action.canonicalBinding!.missionId, state.verifier.run ?? state.authorRun),
    reasons,
    submission: { method: "POST" as const, path, schemaVersion: 1 },
    remainingResubmissions: policy.maxEvidenceResubmissions,
  });
  const fallback = fallbackPath ?? resultsPath(state, row.id, valueOrFirstInvocation(state));
  if (reasons.length) return missingFor(reasons, fallback);
  const status = scoreEvaluation(rows);
  if (status === "missing_evidence") {
    return missingFor([{ code: "quality_case_incomplete", checkId: null, requiredKind: "invocation", expectedHash: null }], fallback);
  }
  const scoredAt = new Date().toISOString();
  const uploaded = await uploadEvidence(getStorageService(), { companyId: parsedKey.companyId,
    body: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "evaluation", evaluationId: row.id, status, rows, scoredAt })),
    contentType: "application/json", originalFilename: null });
  const runBinding = state.verifier.run ?? state.authorRun;
  const evidenceRefId = await db.transaction(async (tx) => {
    await tx.select({ id: qualityActions.id }).from(qualityActions)
      .where(and(eq(qualityActions.companyId, parsedKey.companyId), eq(qualityActions.id, action.id))).for("update");
    const [fresh] = await tx.select().from(evaluatorCandidateRuns)
      .where(and(eq(evaluatorCandidateRuns.companyId, parsedKey.companyId), eq(evaluatorCandidateRuns.id, row.id))).for("update");
    const freshState = evaluationContract(fresh!);
    if (freshState.verdict) return freshState.verdict.evidenceRefId;
    const linked = await linkEvidence(tx, {
      companyId: parsedKey.companyId,
      reviewItemId: await occurrenceReviewItemId(tx, parsedKey.companyId, action),
      source: {
        companyId: parsedKey.companyId, issueId: state.verifier.step.issueId,
        heartbeatRunId: runBinding.heartbeatRunId, executionEpoch: runBinding.executionEpoch,
        inputHash: uploaded.sha256,
        mission: { kind: "mission" as const, id: action.canonicalBinding!.missionId },
        workflow: { kind: "workflow_step" as const, runId: state.verifier.step.workflowRunId,
          stepRunId: state.verifier.step.stepRunId, generation: state.verifier.step.generation,
          // [리뷰 중요3] B 단계 실행을 만든 run 의 실제 dispatch 권한 버전(생성 시점 고정값) — 검증기가 DB 와 교차검증한다.
          dispatchAuthorityVersion: state.verifier.step.dispatchAuthorityVersion },
      },
      scope: evaluationScopeFor(state, parsedKey.companyId, row.id, action.canonicalBinding!.missionId, runBinding),
      kind: "evaluation", uploaded, expiresAt: null, issuedBy: "quality-verify",
    });
    freshState.verdict = { status, evidenceRefId: linked.evidenceRefId, rows, scoredAt };
    await tx.update(evaluatorCandidateRuns).set({
      qualityContract: freshState, updatedAt: new Date(),
      status: status === "pass" ? "passed" : status === "fail" ? "failed" : "no_improvement",
      replayResult: { verdict: { status, rows }, evidenceRefId: linked.evidenceRefId },
    }).where(and(eq(evaluatorCandidateRuns.companyId, parsedKey.companyId), eq(evaluatorCandidateRuns.id, row.id)));
    await tx.insert(activityLog).values({
      companyId: parsedKey.companyId, actorType: "system", actorId: "quality", action: "quality.evaluation_verified",
      entityType: "evaluator_candidate_run", entityId: row.id, details: { status, evidenceRefId: linked.evidenceRefId },
    });
    return linked.evidenceRefId;
  });
  return { status, evidenceRefId };
}

function valueOrFirstInvocation(state: EvaluationState): string {
  const first = Object.keys(state.invocationIndex)[0];
  if (first) return first;
  throw conflict("quality_evaluation_contract_missing");
}

async function occurrenceReviewItemId(tx: Tx, companyId: string, action: typeof qualityActions.$inferSelect): Promise<string> {
  const [occurrence] = await tx.select({ reviewItemId: qualityOccurrences.reviewItemId }).from(qualityOccurrences)
    .where(and(eq(qualityOccurrences.companyId, companyId), eq(qualityOccurrences.id, action.occurrenceIds[0]!)));
  if (!occurrence) throw conflict("quality_occurrence_missing");
  return occurrence.reviewItemId;
}
