// Structured base verdict ledger plus evidence-bound PLAN-QA addendum submissions.
// Comments are display/audit only. A strict base verdict alone is never a final PASS.
import { and, eq, sql } from "drizzle-orm";
import { activityLog, missionPlanQaVerdicts, qualityPolicyVersions, type Db } from "@paperclipai/db";
import {
  checkResultSchema, missingEvidenceSchema, qualityAgentActorSchema, planQaScopeSchema,
  type CheckResult, type MissingEvidence, type PlanQaScope, type PlanQaVerdictState,
} from "@paperclipai/shared";
import { conflict } from "../../errors.js";
import { getStorageService } from "../../storage/index.js";
import { hashContract, parseEvidence } from "../quality/contract.js";
import { readVerifiedArtifact, uploadEvidence } from "../quality/evidence-store.js";
import { linkPlanQaGateEvidence } from "./plan-qa-evidence-registry.js";
import { assertLivePlanQaAttempt, combinePlanQa, loadPlanQaMarker, loadPlanQaVerdictRow, stateForAttempt } from "./plan-qa-addendum-gate.js";
import {
  appendResubmissionDispatch, planResubmissionDispatchDecision,
} from "./plan-qa-resubmission.js";
import { blockedPlanQaTemplates, readPlanQaManifestForIssue, readPinnedPlanQaManifest } from "./plan-qa-addendum-manifest.js";
import { recordPinnedPlanQaBase } from "./plan-qa-base-verdict.js";
import { inspectPlanQaChecks } from "./plan-qa-check-evidence.js";
import { lockPlanQaAttempt } from "./plan-qa-current-attempt.js";
import { planQaSubmissionDocumentSchema, readVerifiedPlanQaGate } from "./plan-qa-verified-gate.js";
import { issueService } from "../issues.js";
import type { ValidationVerdict } from "../validation-verdict.js";

export type PlanQaVerdictActor =
  | { actorType: "agent"; actorId: string }
  | { actorType: "user"; actorId: string }
  | { actorType: "system"; actorId: string };

export async function recordMissionPlanQaVerdict(input: {
  db: Db; companyId: string; missionId: string; planQaIssueId: string; decisionHash: string;
  verdict: ValidationVerdict; diagnostics?: Array<Record<string, unknown>>; reviewedBy: PlanQaVerdictActor;
  sourceRunId?: string | null; sourceCommentId?: string | null;
}): Promise<{ status: "recorded"; planQaIssueId: string; verdict: ValidationVerdict }> {
  const pinned = await recordPinnedPlanQaBase(input);
  if (!pinned) {
    // 직접 삽입(v1/사용자 판정) 행에서도 이슈 마커가 가리키는 계획 아티팩트를 함께 기록한다.
    // 마커 조회 실패가 판정 기록을 막지 않게 실패 시 null 로 내려간다.
    let markerPlanArtifactId: string | null = null;
    try {
      markerPlanArtifactId = (await loadPlanQaMarker(input.db, input.companyId, input.planQaIssueId))?.planArtifactId ?? null;
    } catch { markerPlanArtifactId = null; }
    const fields = {
      reviewerAgentId: input.reviewedBy.actorType === "agent" ? input.reviewedBy.actorId : null,
      reviewerUserId: input.reviewedBy.actorType === "user" ? input.reviewedBy.actorId : null,
      sourceRunId: input.sourceRunId ?? null, sourceCommentId: input.sourceCommentId ?? null,
      verdict: input.verdict, diagnostics: input.diagnostics ?? [], updatedAt: new Date(),
    };
    await input.db.insert(missionPlanQaVerdicts).values({
      ...fields, companyId: input.companyId, missionId: input.missionId,
      missionPlanArtifactId: markerPlanArtifactId,
      planQaIssueId: input.planQaIssueId, decisionHash: input.decisionHash,
    }).onConflictDoUpdate({
      target: [missionPlanQaVerdicts.companyId, missionPlanQaVerdicts.planQaIssueId, missionPlanQaVerdicts.decisionHash],
      // 기존 행에 이미 계획 아티팩트 연결이 있으면 마커가 달라도 덮어쓰지 않는다(null 만 채운다).
      set: { ...fields, missionPlanArtifactId: sql`coalesce(${missionPlanQaVerdicts.missionPlanArtifactId}, excluded."mission_plan_artifact_id")` },
    });
  }
  const body = input.verdict === "pass" ? "Plan is sound.\nPASS"
    : `Plan has gaps.\nREQUEST_CHANGES: ${input.diagnostics?.map((d) => d.message ?? d.code ?? "").filter(Boolean).join("; ") || "needs work"}`;
  try {
    await issueService(input.db).addComment(input.planQaIssueId, body, {
      ...(input.reviewedBy.actorType === "agent" ? { agentId: input.reviewedBy.actorId } : {}),
    });
  } catch { /* Display failure does not change structured authority. */ }
  return { status: "recorded", planQaIssueId: input.planQaIssueId, verdict: input.verdict };
}

function defectDiagnostics(defects: Array<{ checkId: string; requirementRefs: unknown[]; templateId: string }>): Array<Record<string, unknown>> {
  return defects.map((defect) => ({
    code: "quality_plan_qa_addendum_defect", ...defect,
    message: `Addendum check ${defect.checkId} reported a verified defect (target template ${defect.templateId}).`,
  }));
}

async function maxResubmissions(db: Db, companyId: string, policy: { policyVersionId: string; definitionSha256: string } | null) {
  if (!policy) return 0;
  const [row] = await db.select({ definition: qualityPolicyVersions.definition }).from(qualityPolicyVersions).where(and(
    eq(qualityPolicyVersions.companyId, companyId), eq(qualityPolicyVersions.id, policy.policyVersionId),
  )).limit(1);
  if (!row || hashContract(row.definition) !== policy.definitionSha256) throw conflict("quality_policy_binding_mismatch");
  const value = (row.definition as { maxEvidenceResubmissions?: unknown }).maxEvidenceResubmissions;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw conflict("quality_policy_invalid");
  return value;
}

/** Complete manifest coverage, machine applicability, original bytes, and current-attempt base are mandatory. */
export async function verifyPlanQaSubmission(db: Db, actorInput: unknown, input: {
  scope: PlanQaScope; schemaVersion: 2; checks: CheckResult[];
}): Promise<{ status: "pass" | "request_changes"; evidenceRefId: string } | MissingEvidence> {
  const actor = parseEvidence(qualityAgentActorSchema, actorInput);
  const scope = parseEvidence(planQaScopeSchema, input.scope);
  parseEvidence(checkResultSchema.array(), input.checks);
  if (input.schemaVersion !== 2 || new Set(input.checks.map((check) => check.checkId)).size !== input.checks.length) {
    throw conflict("quality_evidence_invalid_contract");
  }
  await assertLivePlanQaAttempt(db, actor, scope);
  const manifest = await readPlanQaManifestForIssue(db, scope.companyId, scope.issueId, scope.manifestRef);
  await readPinnedPlanQaManifest(db, scope);
  if (blockedPlanQaTemplates(manifest).length) throw conflict("quality_plan_qa_base_changed_required");
  const max = await maxResubmissions(db, scope.companyId, manifest.policy);

  const snapshot = await db.transaction(async (tx) => {
    await lockPlanQaAttempt(tx, scope, actor);
    return loadPlanQaVerdictRow(tx, scope, actor);
  });
  const expected = stateForAttempt(snapshot.state, scope);
  const baseVerdict = expected.baseVerdict?.scopeHash === hashContract(scope)
    && snapshot.row.sourceRunId === actor.heartbeatRunId && snapshot.row.reviewerAgentId === actor.agentId
    && snapshot.row.sourceCommentId === null ? expected.baseVerdict.status : null;
  const { reasons, defects } = await inspectPlanQaChecks(db, scope, manifest, expected, input.checks);
  if (!baseVerdict) reasons.unshift({ code: "quality_plan_qa_base_verdict_missing", checkId: null, requiredKind: "base_verdict", expectedHash: null });
  const combined = combinePlanQa(baseVerdict === "pass", input.checks.map((check) => check.status));
  const canFinalize = !expected.verdict && !reasons.length && combined !== "missing_evidence" && baseVerdict !== null;
  // Upload bytes before the final transaction; no successful DB receipt exists until it commits.
  const original = canFinalize ? await uploadEvidence(getStorageService(), {
    companyId: scope.companyId, body: Buffer.from(JSON.stringify({ schemaVersion: 2, kind: "plan_qa_submission", scope, baseVerdict, checks: input.checks })),
    contentType: "application/json", originalFilename: null,
  }) : null;
  const receiptUpload = original ? await uploadEvidence(getStorageService(), {
    companyId: scope.companyId, body: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "plan_qa_gate",
      scopeHash: hashContract(scope), status: combined, baseVerdict, submissionSha256: original.sha256 })),
    contentType: "application/json", originalFilename: null,
  }) : null;
  return db.transaction(async (tx) => {
    await lockPlanQaAttempt(tx, scope, actor);
    const loaded = await loadPlanQaVerdictRow(tx, scope, actor);
    const state = stateForAttempt(loaded.state, scope);
    if (state.verdict) {
      const original = planQaSubmissionDocumentSchema.parse(JSON.parse((await readVerifiedArtifact(tx, {
        companyId: scope.companyId, ref: state.verdict.submissionRef, maxBytes: 2_097_152,
      })).toString("utf8")));
      if (hashContract(original.checks) !== hashContract(input.checks)) throw conflict("quality_plan_qa_submission_conflict");
      const gate = await readVerifiedPlanQaGate(tx, scope);
      if (!gate) throw conflict("quality_plan_qa_gate_unverifiable");
      return { status: gate.verdict, evidenceRefId: gate.evidenceRefId };
    }
    if (hashContract(state) !== hashContract(expected) || loaded.row.sourceRunId !== snapshot.row.sourceRunId
      || loaded.row.reviewerAgentId !== snapshot.row.reviewerAgentId || loaded.row.sourceCommentId !== snapshot.row.sourceCommentId) {
      throw conflict("quality_plan_qa_submission_raced");
    }
    if (reasons.length) {
      // [T8 bounded resubmission] 반환되는 정확한 MissingEvidence 문서를 예약 전에 원장에 함께 저장한다.
      //   남은 횟수는 제출 카운트가 아니라 예약 원장 기준(유한 정책 한도)이다.
      const missing = parseEvidence(missingEvidenceSchema, { status: "missing_evidence", scope, reasons,
        submission: { method: "POST", path: `/api/issues/${scope.issueId}/mission-plan-qa/verdict`, schemaVersion: 2 },
        remainingResubmissions: Math.max(0, max - (state.dispatches?.length ?? 0)) });
      const dispatch = planResubmissionDispatchDecision({ state, scope, max, policy: manifest.policy, missing });
      const withDispatch = dispatch ? appendResubmissionDispatch(state, dispatch) : state;
      const bounded: PlanQaVerdictState = {
        ...withDispatch, verdict: null, resubmissions: Math.min(state.resubmissions + 1, max + 1),
      };
      await tx.update(missionPlanQaVerdicts).set({
        qualityContract: bounded, verdict: "pending", diagnostics: defectDiagnostics(defects), updatedAt: new Date(),
      }).where(and(eq(missionPlanQaVerdicts.companyId, scope.companyId), eq(missionPlanQaVerdicts.id, loaded.row.id)));
      await tx.insert(activityLog).values({ companyId: scope.companyId, actorType: "system", actorId: "mission-plan-qa",
        action: "mission.plan_qa.evidence_missing", entityType: "issue", entityId: scope.issueId,
        details: { reasons, resubmissions: bounded.resubmissions, reviewGeneration: scope.reviewGeneration,
          remainingResubmissions: missing.remainingResubmissions } });
      if (dispatch) {
        await tx.insert(activityLog).values({ companyId: scope.companyId, actorType: "system", actorId: "mission-plan-qa",
          action: "mission.plan_qa.resubmission_scheduled", entityType: "issue", entityId: scope.issueId,
          details: { intentKey: dispatch.intentKey, attempt: dispatch.attempt,
            reviewGeneration: scope.reviewGeneration, maxResubmissions: dispatch.maxResubmissions,
            remainingResubmissions: missing.remainingResubmissions } });
      }
      return missing;
    }
    if (combined === "missing_evidence" || !baseVerdict || !original || !receiptUpload) throw conflict("quality_evidence_invalid_contract");
    const { submissionRef, receiptRef, evidenceRefId } = await linkPlanQaGateEvidence(tx, {
      scope, submission: original, receipt: receiptUpload,
    });
    state.verdict = { status: combined, baseVerdict, scope,
      checkStatuses: input.checks.map(({ checkId, status }) => ({ checkId, status })),
      defects, submissionRef, receiptRef, evidenceRefId, verifiedAt: new Date().toISOString() };
    await tx.update(missionPlanQaVerdicts).set({ qualityContract: state, verdict: combined,
      diagnostics: defectDiagnostics(defects), updatedAt: new Date(),
    }).where(and(eq(missionPlanQaVerdicts.companyId, scope.companyId), eq(missionPlanQaVerdicts.id, loaded.row.id)));
    await tx.insert(activityLog).values({ companyId: scope.companyId, actorType: "system", actorId: "mission-plan-qa",
      action: "mission.plan_qa.gate_verified", entityType: "issue", entityId: scope.issueId,
      details: { status: combined, reviewGeneration: scope.reviewGeneration, submissionRef, receiptRef, evidenceRefId } });
    return { status: combined, evidenceRefId };
  });
}
