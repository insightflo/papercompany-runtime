// server/src/services/quality/current-output.ts
//
// [purpose] T3 current_output 조치의 지원된 구조화 수정 연결. 새 mission/issue 를 만들지
//   않고 원본 정식 실행·producer/QA binding 을 검증한 뒤, 기존 tryQaRemediationPass 의
//   자격검사/기록 코어(qa-remediation.ts export)로만 패치를 적용한다. 원본 terminal 상태는
//   바꾸지 않는다(완료·취소 원본 = 원본 유지/수정 미실행).
// [evidence] 승인된 source attempt 와 파일 이전/이후 hash 를 머신 생성 receipt(kind 'use')로
//   기록한다. 수정 확인은 재실행된 독립 QA(생산자 agent 아님)의 전용 검증 영수증(kind
//   'observation') + 그 PASS verdict 가 있을 때만 조치 상태를 'corrected' 로 올린다.
// [limits] 기존 QA 재실행에도 retryEnvelope 의 누적 한도(maxExecutorAttempts)를 적용한다.
//   기술 재시도가 source attempt 승인을 바꾸지 않는다(target/effect 는 불변).
// [boundary] 이 함수는 깨우지 않는다(깨우기 0회·요청 행 0개). 실행 전달은 T4다.

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  qualityActions,
  qualityEvidenceRefs,
  qualityOccurrences,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  outputCorrectionScopeSchema,
  qualityEffectSchema,
  qualityKeySchema,
  retryEnvelopeSchema,
  qualityTargetSchema,
  type QualityKey,
  type SourceAttempt,
} from "@paperclipai/shared";
import { HttpError, notFound } from "../../errors.js";
import { getStorageService } from "../../storage/index.js";
import { insertActivityRecord } from "../activity-log-records.js";
import { hashContract, parseEvidence, evidenceContractSchema } from "./contract.js";
import { linkEvidence, uploadEvidence } from "./evidence-store.js";
import { ensureCanonicalQualityExecution } from "./native-records.js";
import {
  collectQualifiableQaRemediations,
  writeQaRemediationPatches,
  type PreparedFile,
  type QualifiedQa,
} from "../workflow/control-flow/qa-remediation.js";
import { normalizeWorkflowStepsForExecution } from "../workflow/dag-engine.js";
import { loadWorkflowApiFindings } from "../workflow/validation-verdict-ledger.js";
import type { EdgeBearingStep } from "../workflow/control-flow/edge-condition.js";

export type CurrentOutputCorrectionStatus =
  | { status: "verification_pending"; evidenceRefId: string | null }
  | { status: "unsupported_target"; evidenceRefId: null }
  | { status: "source_preserved"; evidenceRefId: null };

const UNSUPPORTED: CurrentOutputCorrectionStatus = { status: "unsupported_target", evidenceRefId: null };
const PENDING: CurrentOutputCorrectionStatus = { status: "verification_pending", evidenceRefId: null };

type ActionRow = typeof qualityActions.$inferSelect;

export async function applyCurrentOutputCorrection(db: Db, key: QualityKey): Promise<CurrentOutputCorrectionStatus> {
  const parsed = parseEvidence(qualityKeySchema, key);
  const [action] = await db.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, parsed.companyId), eq(qualityActions.id, parsed.actionId)));
  if (!action) throw notFound("quality_action_not_found");
  if (action.kind !== "current_output") return UNSUPPORTED;
  const target = qualityTargetSchema.safeParse(action.target);
  const effect = qualityEffectSchema.safeParse(action.effect);
  const envelope = retryEnvelopeSchema.safeParse(action.retryEnvelope);
  if (!target.success || target.data.kind !== "current_output" || !effect.success || effect.data.kind !== "repair_supported_output" || !envelope.success) return UNSUPPORTED;
  if (hashContract(target.data) !== action.targetHash || hashContract(effect.data) !== action.effectHash
    || envelope.data.targetHash !== action.targetHash || envelope.data.effectHash !== action.effectHash) return UNSUPPORTED;
  if (action.cancelRequestedAt) return UNSUPPORTED;
  if (Date.now() >= Date.parse(envelope.data.deadlineAt)) return UNSUPPORTED;

  // 정식 실행·producer/QA binding 확인(원자 binding). terminal 원본은 원본 유지로 거절된다.
  let binding;
  try {
    binding = await ensureCanonicalQualityExecution(db, parsed);
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.message === "quality_source_preserved") return { status: "source_preserved", evidenceRefId: null };
      return UNSUPPORTED;
    }
    throw error;
  }

  const source = target.data.source;
  const reviewItemId = await findActionReviewItem(db, parsed.companyId, action.occurrenceIds);
  const [usedRow] = await db.select({ n: sql<number>`count(*)::int` }).from(qualityEvidenceRefs)
    .where(and(eq(qualityEvidenceRefs.companyId, parsed.companyId), eq(qualityEvidenceRefs.qualityActionId, action.id), sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'use'`));
  const appliedCount = usedRow?.n ?? 0;
  if (!reviewItemId && appliedCount === 0) return UNSUPPORTED;

  const prepared = await prepareQualification(db, { companyId: parsed.companyId, source, bindingStepRunId: binding.stepRunId });
  if (prepared instanceof CurrentOutputUnsupported && appliedCount === 0) return UNSUPPORTED;

  if (prepared instanceof CurrentOutputUnsupported || prepared.status === "waiting") {
    // 이미 적용된 수정(또는 적용 후 PASS 등 더 이상의 신규 반려 없음) — 재패치 없이 검증 상태만
    // 재평가한다. 신규 자격검사 실패이면서 적용 이력도 없으면 위에서 unsupported 로 처리했다.
    return await evaluateVerification(db, { key: parsed, actionId: action.id, binding, source });
  }

  // 누적 한도(T4 계약의 maxExecutorAttempts): 이 조치의 수정 실행 횟수 = application receipt 수.
  if (appliedCount >= envelope.data.maxExecutorAttempts) return UNSUPPORTED;
  if (!reviewItemId) return UNSUPPORTED;

  // 파일 이전/이후 hash + 승인된 source attempt 를 머신 생성 receipt 로 기록한다.
  const fileHashes = [...prepared.fileBuffers.entries()].map(([file, entry]) => ({
    file, before: entry.beforeHash, after: createHash("sha256").update(entry.content).digest("hex"),
  }));
  const receiptBody = Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: "quality_current_output_correction", qualityActionId: action.id,
    sourceAttemptHash: hashContract(source), fileHashes,
  }));
  let uploaded;
  try {
    uploaded = await uploadEvidence(getStorageService(), { companyId: parsed.companyId, body: receiptBody, contentType: "application/json", originalFilename: "current-output-correction.json" });
  } catch {
    return UNSUPPORTED;
  }
  const { writeError } = await writeQaRemediationPatches({
    db, run: prepared.run, producerStep: prepared.producerStep, producerRun: prepared.producerRun,
    qualified: prepared.qualified, fileBuffers: prepared.fileBuffers,
    extraEventPayload: () => ({
      qualityActionId: action.id,
      qualityFileHashes: fileHashes,
      qualitySourceAttemptHash: hashContract(source),
    }),
  });
  if (writeError) return UNSUPPORTED;
  const linked = await db.transaction(async (tx) => linkEvidence(tx, {
    companyId: parsed.companyId, reviewItemId, source,
    scope: { kind: "output_correction", companyId: parsed.companyId, actionId: action.id, source, verifierRunId: prepared.verifierHeartbeatId, verifierEpoch: prepared.verifierEpoch },
    kind: "use", uploaded, expiresAt: envelope.data.deadlineAt, issuedBy: "quality:current-output",
  }));
  return { status: "verification_pending", evidenceRefId: linked.evidenceRefId };
}

class CurrentOutputUnsupported extends Error {}

type PreparedQualified = {
  status: "qualified";
  run: { id: string; companyId: string; status: string; missionId: string | null };
  producerStep: EdgeBearingStep;
  producerRun: typeof workflowStepRuns.$inferSelect;
  qualified: readonly QualifiedQa[];
  fileBuffers: Map<string, PreparedFile>;
  verifierHeartbeatId: string;
  verifierEpoch: number;
};

type Prepared = PreparedQualified | { status: "waiting" } | CurrentOutputUnsupported;

/** 원본 실행 정의/step runs 에서 rejected QA 목록을 만들고 공용 자격검사를 돌린다. */
async function prepareQualification(db: Db, input: {
  companyId: string;
  source: SourceAttempt;
  bindingStepRunId: string;
}): Promise<Prepared> {
  const source = input.source;
  const sourceWorkflow = source.workflow;
  if (sourceWorkflow.kind !== "workflow_step") return new CurrentOutputUnsupported();
  const runId = sourceWorkflow.runId;
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.id, runId)));
  const [definition] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.companyId, input.companyId), eq(workflowDefinitions.id, run?.workflowId ?? "")));
  if (!run || !definition) return new CurrentOutputUnsupported();
  const steps = normalizeWorkflowStepsForExecution(definition.stepsJson) as unknown as EdgeBearingStep[];
  const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
  const producerStepRunId = sourceWorkflow.stepRunId;
  const producerRun = stepRuns.find((row) => row.id === producerStepRunId);
  const producerStep = steps.find((step) => step.id === producerRun?.stepId);
  if (!producerRun || !producerStep) return new CurrentOutputUnsupported();
  const verdictRows = await db.select({ stepRunId: workflowTransitionEvents.workflowStepRunId, issueId: workflowTransitionEvents.issueId })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId), eq(workflowTransitionEvents.workflowRunId, runId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"), eq(workflowTransitionEvents.verdict, "request_changes"),
    ));
  const rejectedQas = [];
  const findingsByQaStepId = new Map<string, Awaited<ReturnType<typeof loadWorkflowApiFindings>>>();
  for (const row of stepRuns) {
    if (row.id === producerRun.id || !row.issueId) continue;
    if (!verdictRows.some((v) => v.stepRunId === row.id && v.issueId === row.issueId)) continue;
    rejectedQas.push({ edge: { stepId: row.stepId }, qaRun: row });
    findingsByQaStepId.set(row.stepId, await loadWorkflowApiFindings({ db, companyId: input.companyId, issueId: row.issueId, workflowRunId: runId, workflowStepRunId: row.id }));
  }
  const prepared = await collectQualifiableQaRemediations({
    db, run: { id: runId, companyId: input.companyId, status: run.status ?? "running", missionId: run.missionId ?? null },
    steps, producerStep, producerRun, rejectedQas, findingsByQaStepId,
    refireQaStep: async () => false, // collect 은 깨우지 않는다 — 자격검사 전용 스텁(fail-closed)
  });
  if (prepared.status !== "qualified") {
    return prepared.status === "waiting" ? { status: "waiting" as const } : new CurrentOutputUnsupported();
  }
  const [verifierHeartbeat] = await db.select({ id: heartbeatRuns.id, epoch: heartbeatRuns.executionEpoch })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, prepared.qualified[0]!.heartbeatRunId ?? "")));
  if (!verifierHeartbeat || verifierHeartbeat.epoch === null) return new CurrentOutputUnsupported();
  return {
    status: "qualified", run: { id: runId, companyId: input.companyId, status: run.status ?? "running", missionId: run.missionId ?? null },
    producerStep, producerRun, qualified: prepared.qualified, fileBuffers: prepared.fileBuffers,
    verifierHeartbeatId: verifierHeartbeat.id, verifierEpoch: verifierHeartbeat.epoch,
  };
}

/** 조치의 occurrence 중 첫 유효 review item(회사 스코프 join). 없으면 null. */
async function findActionReviewItem(db: Db, companyId: string, occurrenceIds: string[]): Promise<string | null> {
  const ids = [...occurrenceIds].sort();
  if (!ids.length) return null;
  const [row] = await db.select({ reviewItemId: qualityOccurrences.reviewItemId }).from(qualityOccurrences)
    .where(and(eq(qualityOccurrences.companyId, companyId), eq(qualityOccurrences.id, ids[0]!)));
  return row?.reviewItemId ?? null;
}

/**
 * 검증 상태 평가(중복 수정 재호출·확인 승격). 전용 검증 영수증(kind 'observation')이
 * 재실행된 독립 QA(생산자 agent 아님)의 PASS verdict 를 정확히 가리킬 때만 상태를 올린다.
 */
async function evaluateVerification(db: Db, input: {
  key: QualityKey; actionId: string; binding: Awaited<ReturnType<typeof ensureCanonicalQualityExecution>>; source: { heartbeatRunId: string };
}): Promise<CurrentOutputCorrectionStatus> {
  const { key, binding } = input;
  const [appliedEvent] = await db.select({ createdAt: workflowTransitionEvents.createdAt }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.companyId, key.companyId), eq(workflowTransitionEvents.workflowStepRunId, binding.stepRunId), eq(workflowTransitionEvents.eventType, "qa_remediation_applied")))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(1);
  const [useReceipt] = await db.select({ id: qualityEvidenceRefs.id, contract: qualityEvidenceRefs.qualityContract }).from(qualityEvidenceRefs)
    .where(and(eq(qualityEvidenceRefs.companyId, key.companyId), eq(qualityEvidenceRefs.qualityActionId, input.actionId), sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'use'`))
    .orderBy(desc(qualityEvidenceRefs.id)).limit(1);
  const pending: CurrentOutputCorrectionStatus = { status: "verification_pending", evidenceRefId: useReceipt?.id ?? null };
  if (!appliedEvent) return pending;

  const observationReceipts = await db.select({ id: qualityEvidenceRefs.id, contract: qualityEvidenceRefs.qualityContract }).from(qualityEvidenceRefs)
    .where(and(eq(qualityEvidenceRefs.companyId, key.companyId), eq(qualityEvidenceRefs.qualityActionId, input.actionId), sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'observation'`))
    .orderBy(desc(qualityEvidenceRefs.id));
  const [producerHeartbeat] = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, key.companyId), eq(heartbeatRuns.id, input.source.heartbeatRunId)));
  for (const receipt of observationReceipts) {
    const contract = evidenceContractSchema.safeParse(receipt.contract);
    if (!contract.success || contract.data.kind !== "observation") continue;
    const scope = outputCorrectionScopeSchema.safeParse(contract.data.scope);
    if (!scope.success) continue;
    const [pass] = await db.select({ id: workflowTransitionEvents.id, heartbeatRunId: workflowTransitionEvents.heartbeatRunId, createdAt: workflowTransitionEvents.createdAt }).from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.companyId, key.companyId), eq(workflowTransitionEvents.workflowStepRunId, binding.stepRunId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"), eq(workflowTransitionEvents.verdict, "pass"),
        eq(workflowTransitionEvents.heartbeatRunId, scope.data.verifierRunId),
      )).limit(1);
    if (!pass || pass.createdAt < appliedEvent.createdAt) continue;
    const [verifier] = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, key.companyId), eq(heartbeatRuns.id, scope.data.verifierRunId)));
    if (!verifier || !producerHeartbeat || verifier.agentId === producerHeartbeat.agentId) continue;
    const rows = await db.update(qualityActions).set({ state: "corrected", updatedAt: new Date() })
      .where(and(eq(qualityActions.companyId, key.companyId), eq(qualityActions.id, input.actionId), sql`${qualityActions.state} <> 'corrected'`))
      .returning({ id: qualityActions.id });
    if (rows.length > 0) {
      await insertActivityRecord(db, {
        companyId: key.companyId, actorType: "system", actorId: "quality",
        action: "quality.correction_verified", entityType: "quality_action", entityId: input.actionId,
        details: { evidenceRefId: receipt.id, verifierRunId: scope.data.verifierRunId },
      });
    }
    return { status: "verification_pending", evidenceRefId: receipt.id };
  }
  return pending;
}
