// server/src/services/missions/plan-qa-addendum-gate.ts
//
// [파일 목적] T8 PLAN-QA 추가 검사 판정을 실제 계획 승인·완료에 연결하는 검증 게이트의
//   스코프·엄격 대상 판정·readRef 생산 파트. 고정 명세에서 bounded JSON Pointer 로 실제 선택값·
//   검사 버전을 영수증으로 저장한다(T6 의 같은 안전한 reader 재사용). 판정 검증(verifyPlanQaSubmission)과
//   verified gate 조회는 mission-plan-qa-verdicts.ts 가 담당한다.
// [수정시 주의] 댓글·자연어·refs 존재만으로는 gate 를 만들지 않는다. mutable refs 는 승인 근거가 아니다.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  activityLog, issues, missionPlanQaVerdicts, type Db,
} from "@paperclipai/db";
import {
  qualityAgentActorSchema,
  type ArtifactRef, type PlanQaResubmissionDispatch, type QualityAgentActor,
} from "@paperclipai/shared";
import {
  planQaScopeSchema, planQaVerdictStateSchema, type PlanQaScope, type PlanQaVerdictState,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../../errors.js";
import { getStorageService } from "../../storage/index.js";
import { hashContract, parseEvidence, type QualityDb, type QualityTx } from "../quality/contract.js";
import { attachEvidence, readVerifiedArtifact, uploadEvidence } from "../quality/evidence-store.js";
import { assertCurrentPlanQaScope, lockPlanQaAttempt } from "./plan-qa-current-attempt.js";
import { resolvePointer } from "../quality/evaluation-reader.js";
import { applies } from "./plan-qa-applicability.js";
import {
  MAX_PLAN_QA_MANIFEST_BYTES, blockedPlanQaTemplates, readPlanQaManifestForIssue,
  readPinnedPlanQaManifest, type PlanQaManifest,
} from "./plan-qa-addendum-manifest.js";
import { planQaReviewBindingMarkerSchema, type PlanQaReviewBindingMarker } from "./plan-qa-review-binding.js";

export { verifyPlanQaSubmission } from "./mission-plan-qa-verdicts.js";
export { readVerifiedPlanQaGate } from "./plan-qa-verified-gate.js";

export function gateError(code: string): never {
  throw unprocessable(code, { code });
}

/** [brief 계약] 기본 판정과 추가 검사를 결합한다. 누락/오류는 기술 차단이지 요구사항 위반이 아니다. */
export function combinePlanQa(basePass: boolean, checks: readonly import("@paperclipai/shared").CheckResult["status"][]) {
  if (checks.some((x) => x === "insufficient_evidence" || x === "execution_error"))
    return "missing_evidence" as const;
  return !basePass || checks.includes("defect") ? "request_changes" as const : "pass" as const;
}

export type VerifiedPlanQaGate = { verdict: "pass" | "request_changes"; evidenceRefId: string };
export type PlanQaGateMode =
  | { kind: "strict"; manifest: PlanQaManifest }
  | { kind: "legacy"; manifest: PlanQaManifest | null }
  | { kind: "fail_closed" };

export const planQaReadReceiptSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("plan_qa_read"),
  scope: planQaScopeSchema, checkId: z.string(),
  pointers: z.array(z.string()), values: z.array(z.unknown()),
  manifestSha256: z.string(),
}).strict();

export async function loadPlanQaMarker(db: QualityDb, companyId: string, issueId: string): Promise<PlanQaReviewBindingMarker | null> {
  const [row] = await db.select({ marker: issues.qualityPlanQaBinding }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).limit(1);
  if (!row?.marker) return null;
  const parsed = planQaReviewBindingMarkerSchema.safeParse(row.marker);
  return parsed.success ? parsed.data : null;
}

/** 서버가 이슈 표식+현재 실행 시도로 PlanQaScope 를 만든다(클라이언트가 scope 를 발명하지 않는다). */
export async function buildPlanQaScope(db: Db, input: {
  companyId: string; issueId: string; heartbeatRunId: string; executionEpoch: number;
}): Promise<PlanQaScope> {
  const marker = await loadPlanQaMarker(db, input.companyId, input.issueId);
  if (!marker) gateError("quality_plan_qa_binding_missing");
  if (marker.supersededAt) gateError("quality_plan_qa_binding_superseded");
  return parseEvidence(planQaScopeSchema, {
    kind: "plan_qa", companyId: marker.companyId, missionId: marker.missionId,
    planArtifactId: marker.planArtifactId, issueId: input.issueId, decisionHash: marker.decisionHash,
    manifestRef: marker.manifestRef, reviewGeneration: marker.reviewGeneration,
    heartbeatRunId: input.heartbeatRunId, executionEpoch: input.executionEpoch,
    workflow: { kind: "not_applicable", reason: "mission_plan_qa_issue" },
  });
}

export async function assertLivePlanQaAttempt(db: QualityDb, actor: QualityAgentActor, scope: PlanQaScope): Promise<void> {
  await assertCurrentPlanQaScope(db, scope, actor);
}

/** 엄격 대상 판정: 표식이 없으면 구형, 표식이 있는데 명세를 읽을 수 없으면 fail-closed(구형 해석 금지). */
export async function planQaGateMode(db: Db, input: { companyId: string; planQaIssueId: string }): Promise<PlanQaGateMode> {
  const [issue] = await db.select({ marker: issues.qualityPlanQaBinding }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.planQaIssueId))).limit(1);
  if (!issue) return { kind: "fail_closed" };
  if (issue.marker === null) return { kind: "legacy", manifest: null };
  const marker = await loadPlanQaMarker(db, input.companyId, input.planQaIssueId);
  if (!marker || marker.supersededAt) return { kind: "fail_closed" };
  try {
    const manifest = await readPlanQaManifestForIssue(db, input.companyId, input.planQaIssueId, marker.manifestRef);
    if (blockedPlanQaTemplates(manifest).length) return { kind: "fail_closed" };
    return manifest.checks.length > 0 ? { kind: "strict", manifest } : { kind: "legacy", manifest };
  } catch {
    return { kind: "fail_closed" };
  }
}

/** [brief 계약] GET /mission-plan-qa/input: 현재 인증된 검토 시도의 저장 명세를 반환한다.
 *  소명 누락으로 예약된 재제출 원문(필요 read/submit 조치)이 있으면 함께 전달한다. */
export async function readPlanQaInputForIssue(db: Db, actorInput: unknown, input: { issueId: string }): Promise<{
  manifest: PlanQaManifest; scope: PlanQaScope; pendingResubmission?: PlanQaResubmissionDispatch;
}> {
  const actor = parseEvidence(qualityAgentActorSchema, actorInput);
  const [issue] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, input.issueId)).limit(1);
  if (!issue || issue.companyId !== actor.companyId) gateError("quality_plan_qa_issue_not_found");
  const scope = await buildPlanQaScope(db, {
    companyId: actor.companyId, issueId: input.issueId, heartbeatRunId: actor.heartbeatRunId, executionEpoch: actor.executionEpoch,
  });
  await assertLivePlanQaAttempt(db, actor, scope);
  const manifest = await readPlanQaManifestForIssue(db, actor.companyId, input.issueId, scope.manifestRef);
  if (manifest.companyId !== actor.companyId || manifest.missionId !== scope.missionId
    || manifest.planArtifactId !== scope.planArtifactId || manifest.decisionHash !== scope.decisionHash
    || manifest.reviewGeneration !== scope.reviewGeneration) gateError("quality_plan_qa_binding_mismatch");
  const [row] = await db.select({ qualityContract: missionPlanQaVerdicts.qualityContract }).from(missionPlanQaVerdicts)
    .where(and(
      eq(missionPlanQaVerdicts.companyId, scope.companyId),
      eq(missionPlanQaVerdicts.planQaIssueId, scope.issueId),
      eq(missionPlanQaVerdicts.decisionHash, scope.decisionHash),
    )).limit(1);
  const state = planQaVerdictStateSchema.safeParse(row?.qualityContract);
  const pendingResubmission = state.success
    ? state.data.dispatches[state.data.dispatches.length - 1]
    : undefined;
  return { manifest, scope, ...(pendingResubmission ? { pendingResubmission } : {}) };
}

export async function loadPlanQaVerdictRow(tx: QualityTx | Db, scope: PlanQaScope, actor: QualityAgentActor) {
  const where = and(
    eq(missionPlanQaVerdicts.companyId, scope.companyId),
    eq(missionPlanQaVerdicts.planQaIssueId, scope.issueId),
    eq(missionPlanQaVerdicts.decisionHash, scope.decisionHash),
  );
  const [row] = await tx.select().from(missionPlanQaVerdicts).where(where).limit(1);
  if (row) return { row, state: planQaVerdictStateSchema.safeParse(row.qualityContract).data ?? null };
  const fresh: PlanQaVerdictState = {
    schemaVersion: 1, kind: "plan_qa_verdict_v2", scope, reads: {}, resubmissions: 0, dispatches: [], verdict: null,
  };
  const inserted = await tx.insert(missionPlanQaVerdicts).values({
    companyId: scope.companyId, missionId: scope.missionId, missionPlanArtifactId: scope.planArtifactId,
    planQaIssueId: scope.issueId, reviewerAgentId: actor.agentId, sourceRunId: actor.heartbeatRunId,
    decisionHash: scope.decisionHash, verdict: "pending", diagnostics: [], qualityContract: fresh,
  }).onConflictDoNothing().returning();
  if (inserted.length) return { row: inserted[0]!, state: fresh };
  const [again] = await tx.select().from(missionPlanQaVerdicts).where(where).limit(1);
  return { row: again!, state: planQaVerdictStateSchema.safeParse(again?.qualityContract).data ?? null };
}

export function stateForAttempt(state: PlanQaVerdictState | null, scope: PlanQaScope): PlanQaVerdictState {
  return state && hashContract(state.scope) === hashContract(scope) ? state : {
    schemaVersion: 1, kind: "plan_qa_verdict_v2", scope, reads: {},
    resubmissions: state?.resubmissions ?? 0,
    // [T8] 예약 원장은 검토 시도·scope 변경과 무관하게 누적된다(유한 한도의 근거).
    dispatches: state?.dispatches ?? [], verdict: null,
  };
}

const POINTER_RE = /^\/[A-Za-z0-9_][A-Za-z0-9_-]{0,63}(\/[A-Za-z0-9_][A-Za-z0-9_-]{0,63}){0,11}$/;

/** [brief 계약] 고정 명세에서 실제 선택값을 읽어 readRef 영수증을 생산한다(평가 scope/타 시도 재사용 금지). */
export async function readPlanQaCheck(db: Db, actorInput: unknown, input: { issueId: string; checkId: string; pointers: string[] }): Promise<{ readRef: ArtifactRef; values: unknown[] }> {
  const actor = parseEvidence(qualityAgentActorSchema, actorInput);
  if (input.pointers.length < 1 || input.pointers.length > 16 || input.pointers.some((pointer) => !POINTER_RE.test(pointer))) {
    gateError("quality_pointer_invalid");
  }
  const scope = await buildPlanQaScope(db, {
    companyId: actor.companyId, issueId: input.issueId, heartbeatRunId: actor.heartbeatRunId, executionEpoch: actor.executionEpoch,
  });
  await assertLivePlanQaAttempt(db, actor, scope);
  const manifest = await readPlanQaManifestForIssue(db, actor.companyId, input.issueId, scope.manifestRef);
  if (blockedPlanQaTemplates(manifest).length) {
    throw conflict("quality_plan_qa_base_changed_required", { code: "quality_plan_qa_base_changed_required" });
  }
  await readPinnedPlanQaManifest(db, scope);
  if (!manifest.checks.some((check) => check.checkId === input.checkId)) gateError("quality_check_not_applicable");
  const bytes = await readVerifiedArtifact(db, { companyId: actor.companyId, ref: scope.manifestRef, maxBytes: MAX_PLAN_QA_MANIFEST_BYTES });
  const document = JSON.parse(bytes.toString("utf8"));
  const values: unknown[] = [];
  for (const pointer of input.pointers) {
    const resolved = resolvePointer(document, pointer);
    if (!resolved.found) gateError("quality_pointer_missing");
    values.push(resolved.value);
  }
  const receipt = { schemaVersion: 1 as const, kind: "plan_qa_read" as const, scope, checkId: input.checkId, pointers: input.pointers, values, manifestSha256: scope.manifestRef.sha256 };
  const uploaded = await uploadEvidence(getStorageService(), { companyId: actor.companyId, body: Buffer.from(JSON.stringify(receipt)), contentType: "application/json", originalFilename: null });
  return db.transaction(async (tx) => {
    await lockPlanQaAttempt(tx, scope, actor);
    const loaded = await loadPlanQaVerdictRow(tx, scope, actor);
    const state = stateForAttempt(loaded.state, scope);
    const prior = state.reads[input.checkId];
    if (prior) {
      if (hashContract(prior.pointers) !== hashContract(input.pointers)) throw conflict("quality_read_request_conflict");
      return { readRef: prior.readRef, values: prior.values };
    }
    const readRef = await attachEvidence(tx, { companyId: actor.companyId, issueId: scope.issueId, uploaded });
    state.reads[input.checkId] = { readRef, pointers: input.pointers, values, manifestSha256: scope.manifestRef.sha256 };
    await tx.update(missionPlanQaVerdicts).set({ qualityContract: state, updatedAt: new Date() })
      .where(eq(missionPlanQaVerdicts.id, loaded.row.id));
    await tx.insert(activityLog).values({
      companyId: actor.companyId, actorType: "system", actorId: "mission-plan-qa",
      action: "mission.plan_qa.check_read", entityType: "issue", entityId: scope.issueId,
      details: { checkId: input.checkId, reviewGeneration: scope.reviewGeneration },
    });
    return { readRef, values };
  });
}
