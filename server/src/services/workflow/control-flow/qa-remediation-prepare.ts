// server/src/services/workflow/control-flow/qa-remediation-prepare.ts
//
// [purpose] Reuse existing QA-remediation qualification inside a caller-owned transaction.
// The workflow root keeps mission→run locks and writes strict v2 through the small row writer; a Quality
// root can take its prefix first, then call this candidate builder with root-derived binding scope.
// Reservations preserve exact effect identity but grant no replay/publication authority and perform no
// file, upload, evidence-use, wake, or queue effects. Unknown and attempted history remains held.

import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { and, eq, inArray, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { issues, missions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { WorkflowVerdictFinding } from "@paperclipai/shared";
import { loadExecutionDefinition } from "../execution-definition.js";
import { loadLatestQaRemediations, loadWorkflowApiFindings, loadPriorRejectedFindings } from "../validation-verdict-ledger.js";
import { resolveEdges } from "./edge-condition.js";
import { readCapBoostAmount } from "./types.js";
import { applyRecurrencePromotion } from "./rework-contract.js";
import { hashQaCorrectionPayload, type QaCorrectionAttempt } from "./qa-correction-contract.js";
import { QA_REMEDIATION_EVENT_TYPE, QA_REMEDIATION_MAX_ATTEMPTS, type PreparedFile } from "./qa-remediation-contract.js";
import {
  QA_REMEDIATION_PREPARATION_EVENT_TYPE, QaRemediationPreparationError, parseQaRemediationPreparation,
  type QaRemediationFileIdentity, type QaRemediationPreparation, type QaRemediationPreparationScope,
  type QaRemediationVerdictRef,
} from "./qa-remediation-preparation-contract.js";
import { readQaRemediationPreparation } from "./qa-remediation-preparation-reader.js";
import { collectQualifiableQaRemediations } from "./qa-remediation-qualification.js";
import { writeQaRemediationPreparation, type QaRemediationPreparationTransaction } from "./qa-remediation-preparation-writer.js";

type StepRun = typeof workflowStepRuns.$inferSelect;
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const attemptOf = (s: StepRun): QaCorrectionAttempt => ({ stepRunId: s.id, stepId: s.stepId, issueId: s.issueId!,
  executionGeneration: s.executionGeneration, retryCount: s.retryCount, iterationIndex: s.iterationIndex });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Identifier-only request — every fact is re-derived under the root lock; nothing here confers authority. */
export interface QaRemediationPreparationRequest {
  readonly companyId: string;
  readonly missionId: string;
  readonly workflowRunId: string;
  readonly producerStepRunId: string;
  readonly qaStepRunIds: readonly string[];
  /** Lookup identifier only. The Quality root must rederive and bind current facts before storage. */
  readonly qualityActionId?: string;
}

export type QaRemediationPreparationHeldReason =
  | "invalid_history"     // scoped 손상/불일치 행 — unknown 이므로 입장 불가 홀드
  | "legacy_effect"       // 현재 verdict 에 부합하는 legacy applied/write_failed — 불확실 already-effected 홀드
  | "reservation_cap"     // 미완료 포함 내구 예약 상한 초과 — 재시도 무한 방지(C2), producer 폴백 아님
  | "unresolved_pending"  // 현재 원천 verdict 를 확정할 수 없는데 이미 시도 흔적이 있다 — 효과 불명 홀드(폴백 금지)
  | "unresolved_conflict"; // 동일 키 충돌 뒤 재독기가 정확 예약을 확인하지 못함 — fail-visible 홀드

export type QaRemediationPreparationPassResult =
  | { readonly outcome: "prepared"; readonly preparationEventId: string; readonly preparation: QaRemediationPreparation; readonly detail: string }
  | { readonly outcome: "existing"; readonly preparationEventId: string; readonly preparation: QaRemediationPreparation; readonly detail: string }
  | { readonly outcome: "held"; readonly reason: QaRemediationPreparationHeldReason; readonly detail: string }
  | { readonly outcome: "not_applicable"; readonly detail: string };

export type QaRemediationPreparationCandidateResult =
  | { readonly outcome: "candidate"; readonly preparation: QaRemediationPreparation; readonly scope: QaRemediationPreparationScope; readonly detail: string }
  | Exclude<QaRemediationPreparationPassResult, { readonly outcome: "prepared" }>;

/** Supplement verification only — canonical realpath/stat + raw-byte identities over the shared ordered replacement output. */
async function buildFileIdentities(fileBuffers: ReadonlyMap<string, PreparedFile>):
Promise<{ ok: true; files: QaRemediationFileIdentity[] } | { ok: false; detail: string }> {
  const files: QaRemediationFileIdentity[] = [];
  for (const file of [...fileBuffers.keys()].sort()) {
    const entry = fileBuffers.get(file)!;
    let st: Awaited<ReturnType<typeof stat>>;
    try { st = await stat(file); } catch { return { ok: false, detail: `remediation target missing: ${file}` }; }
    if (!st.isFile()) return { ok: false, detail: `remediation target not a regular file: ${file}` };
    try {
      if ((await realpath(file)) !== file) return { ok: false, detail: `remediation target is a symlink alias: ${file}` };
    } catch (error) { return { ok: false, detail: `remediation target realpath failed: ${message(error)}` }; }
    let raw: Buffer;
    try { raw = await readFile(file); } catch { return { ok: false, detail: `remediation target unreadable: ${file}` }; }
    if (raw.length !== st.size) return { ok: false, detail: `remediation target size changed during preparation: ${file}` };
    // 지금 읽은 bytes 가 공유 exactly-once 시뮬레이션이 소비한 before 상태인지 문자열 digest 로 확인한다.
    const beforeText = createHash("sha256").update(raw.toString("utf8"), "utf8").digest("hex");
    if (beforeText !== entry.beforeHash) return { ok: false, detail: `remediation target bytes changed during preparation: ${file}` };
    const after = Buffer.from(entry.content, "utf8");
    files.push({ path: file, beforeSha256: sha256(raw), afterSha256: sha256(after),
      beforeByteSize: raw.length, afterByteSize: after.length });
  }
  return { ok: true, files };
}

/** 원천 verdict 확정 실패 시에도 이미 시도된 흔적은 지울 수 없다 — 관련 행 존재만으로 홀드 사유가 된다(fail-visible). */
async function attemptedHistoryDetail(db: Pick<Db, "select">, companyId: string, workflowRunId: string,
  producerStepRunId: string, qaStepRunIds: readonly string[]): Promise<string | null> {
  const [preparations, legacy] = await Promise.all([
    db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.workflowRunId, workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, producerStepRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE))),
    db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.workflowRunId, workflowRunId),
      inArray(workflowTransitionEvents.workflowStepRunId, [...qaStepRunIds]),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_EVENT_TYPE))),
  ]);
  if (preparations.length === 0 && legacy.length === 0) return null;
  return `${preparations.length} preparation row(s) and ${legacy.length} legacy row(s) already exist for this producer/QA scope`;
}

/**
 * [caller-transaction only] The caller owns lock order; this function acquires mission→run after any
 * Quality prefix, then reuses the existing qualification body without opening or committing a transaction.
 * It returns an unstored candidate, exact existing row, typed hold, or not_applicable result.
 */
export async function buildQaRemediationPreparationCandidate(
  rawTx: QaRemediationPreparationTransaction,
  request: QaRemediationPreparationRequest,
  qualityScope?: NonNullable<QaRemediationPreparationScope["qualityBinding"]>,
): Promise<QaRemediationPreparationCandidateResult> {
  if (!is(rawTx, PgTransaction)) throw new QaRemediationPreparationError("caller_transaction_required");
  if (request.qaStepRunIds.length === 0 || new Set(request.qaStepRunIds).size !== request.qaStepRunIds.length) {
    throw new QaRemediationPreparationError("request");
  }
  if ((request.qualityActionId === undefined) !== (qualityScope === undefined)
    || (qualityScope && qualityScope.actionId !== request.qualityActionId)) {
    throw new QaRemediationPreparationError("quality_scope");
  }
  const tx = rawTx as unknown as Db;
  // Existing lock order: missions → workflowRuns, FOR NO KEY UPDATE.
  const [mission] = await rawTx.select().from(missions).where(and(
    eq(missions.id, request.missionId), eq(missions.companyId, request.companyId))).for("no key update");
  if (!mission) throw new QaRemediationPreparationError("scope");
  const [run] = await rawTx.select().from(workflowRuns).where(and(
    eq(workflowRuns.id, request.workflowRunId), eq(workflowRuns.companyId, request.companyId))).for("no key update");
  if (!run || run.missionId !== request.missionId) throw new QaRemediationPreparationError("scope");

  const steps = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
  const producerRun = steps.find(s => s.id === request.producerStepRunId);
  const qaRuns = request.qaStepRunIds.map(id => steps.find(s => s.id === id));
  if (!producerRun || qaRuns.some(q => !q)) throw new QaRemediationPreparationError("scope");
  const execution = await loadExecutionDefinition(tx, run.id, { requireHistorical: false });
  const producerStep = execution.steps.find(s => s.id === producerRun.stepId);
  if (!producerStep) throw new QaRemediationPreparationError("scope");

  // [history BEFORE cancellation/hidden fences — C02] 취소·결번·hidden 등 어떤 사유로 현재 scope 을 확정할
  //   수 없어도 이미 시도된 예약/legacy 흔적을 먼저 본다: 흔적이 있으면 효과 불명 홀드(unresolved_pending),
  //   흔적이 없을 때만 같은 not_applicable 로 거부한다. 새 예약·existing 승계·producer 폴백은 어느 쪽도 아니다.
  const unresolvable = async (detail: string): Promise<Extract<QaRemediationPreparationPassResult,
    { readonly outcome: "held" | "not_applicable" }>> => {
    const attempted = await attemptedHistoryDetail(tx, run.companyId, run.id, producerRun.id, qaRuns.map(q => q!.id));
    if (attempted) return { outcome: "held", reason: "unresolved_pending",
      detail: `${detail}; ${attempted} — scope unresolvable and attempted effects may exist; never not_applicable/producer fallback` };
    return { outcome: "not_applicable", detail };
  };
  // [cancellation fenced at discovery — C02 원칙] 취소된 scope 은 새 예약·기존 예약 이어받기 모두 거부한다.
  if (run.status === "cancelled") return await unresolvable("run cancelled");
  if (mission.status === "cancelled") return await unresolvable("mission cancelled");
  if (!producerRun.issueId) return await unresolvable("producer attempt missing issue binding");
  const scopeIssues = await tx.select().from(issues).where(and(eq(issues.companyId, run.companyId),
    inArray(issues.id, [producerRun.issueId, ...qaRuns.map(q => q!.issueId!)])));
  const issueOf = (id: string) => scopeIssues.find(i => i.id === id);
  const producerIssue = issueOf(producerRun.issueId);
  if (!producerIssue) return await unresolvable("producer issue missing");
  if (producerIssue.hiddenAt || producerIssue.status === "cancelled") {
    return await unresolvable("producer issue cancelled or hidden");
  }
  for (const qaRun of qaRuns) {
    const issue = qaRun!.issueId ? issueOf(qaRun!.issueId) : undefined;
    if (!issue || issue.hiddenAt || issue.status === "cancelled" || qaRun!.status === "cancelled") {
      return await unresolvable(`qa ${qaRun!.stepId} issue cancelled or hidden`);
    }
  }

  // [history BEFORE freshness/no-new-remediation fallback] 최신 verdict 원천을 참조로만 미리 읽어 refs 를 세운다.
  //   원천을 확정할 수 없으면 위 unresolvable 과 같은 시도 흔적 존재가 홀드다(not_applicable 아님).
  const refs: QaRemediationVerdictRef[] = [];
  for (const qaRun of qaRuns) {
    if (!qaRun!.issueId) return await unresolvable("rejected qa missing issue binding");
    const loaded = await loadLatestQaRemediations({ db: tx, companyId: run.companyId, issueId: qaRun!.issueId });
    if (!loaded) return await unresolvable(`qa ${qaRun!.stepId} has no applicable remediations`);
    if (!loaded.workflowStepRunId || loaded.workflowStepRunId !== qaRun!.id) {
      return await unresolvable(`qa ${qaRun!.stepId} remediation bound to foreign step run`);
    }
    if (!loaded.heartbeatRunId) return await unresolvable(`qa ${qaRun!.stepId} verdict missing heartbeat binding`);
    refs.push({ eventId: loaded.sourceVerdictEventId, heartbeatRunId: loaded.heartbeatRunId,
      remediationsHash: hashQaCorrectionPayload(loaded.remediations.items), qa: attemptOf(qaRun!) });
  }
  const rejectedQas = qaRuns.map(qaRun => ({ edge: { stepId: qaRun!.stepId }, qaRun: qaRun! }));
  const findingsByQaStepId = new Map<string, readonly WorkflowVerdictFinding[] | null>();
  for (const qaRun of qaRuns) {
    const ledgerScope = { db: tx, companyId: run.companyId, issueId: qaRun!.issueId!,
      workflowRunId: run.id, workflowStepRunId: qaRun!.id };
    const findings = await loadWorkflowApiFindings(ledgerScope);
    const prior = producerRun.completedAt
      ? await loadPriorRejectedFindings({ ...ledgerScope, notAfter: producerRun.completedAt }) : null;
    findingsByQaStepId.set(qaRun!.stepId, findings ? applyRecurrencePromotion(findings, prior).findings : null);
  }

  for (let pass = 0; ; pass++) {
    const scope: QaRemediationPreparationScope = { companyId: run.companyId, missionId: run.missionId!, workflowRunId: run.id,
      dispatchAuthorityVersion: run.dispatchAuthorityVersion, producer: attemptOf(producerRun), verdicts: refs,
      ...(qualityScope ? { qualityBinding: qualityScope } : {}),
    };
    const history = await readQaRemediationPreparation(tx, scope);
    if (history.status === "invalid") {
      return { outcome: "held", reason: "invalid_history",
        detail: `${history.detail}; ${history.invalidRows.map(r => `${r.eventId ?? "null"}:${r.detail}`).join("; ")}` };
    }
    if (history.status === "legacy_effect") {
      return { outcome: "held", reason: "legacy_effect",
        detail: `${history.detail} — uncertain already-effected legacy attempt(s): ${history.legacyEffects.map(e => `${e.eventId}:${e.outcome}`).join(", ")}; never re-applied and never producer fallback` };
    }
    if (history.status === "prepared") {
      return { outcome: "existing", preparationEventId: history.preparationEventId!, preparation: history.preparation!,
        detail: `exact preparation already reserved (reentry by source verdict id + attempt tuple + dispatch authority ${run.dispatchAuthorityVersion}); ${history.detail}; no bytes re-read for replacement and no new reservation` };
    }

    // 새 사이클만 아래 자격/차단을 통과한다 — 기존 hardblock/source_data/boundary/freshness 검증은 공유 코드 그대로.
    if (producerRun.status !== "completed" || !producerRun.completedAt) {
      return { outcome: "not_applicable", detail: "producer attempt not completed" };
    }
    const backEdges = resolveEdges(producerStep).filter(e => e.isBackEdge && (e.maxIterations ?? 0) >= 1);
    if (!backEdges.length) return { outcome: "not_applicable", detail: "producer step has no remediation back edge" };
    const iterationCap = Math.max(...backEdges.map(e => e.maxIterations!)) + readCapBoostAmount(producerRun.metadata);
    if ((producerRun.iterationIndex ?? 0) >= iterationCap) {
      return { outcome: "not_applicable", detail: `producer iteration ${producerRun.iterationIndex ?? 0} at back-edge cap ${iterationCap}` };
    }
    for (const qaRun of qaRuns) {
      if (!backEdges.some(e => e.stepId === qaRun!.stepId)) {
        return { outcome: "not_applicable", detail: `qa ${qaRun!.stepId} is not a producer back-edge target` };
      }
    }

    // [C2] 상한은 미완료 예약 포함 전부 센다 — 소진은 홀드지 producer 재작업이 아니다.
    for (const ref of refs) {
      const reserved = history.reservationCounts.get(ref.qa.stepRunId) ?? 0;
      if (reserved >= QA_REMEDIATION_MAX_ATTEMPTS) {
        return { outcome: "held", reason: "reservation_cap",
          detail: `qa ${ref.qa.stepId} reservation cap exhausted (${reserved}/${QA_REMEDIATION_MAX_ATTEMPTS} durable reservations incl. unfinished) — hold for actionable recovery, never silent producer rework` };
      }
    }

    const qualifiedRun = await collectQualifiableQaRemediations(
      { db: tx, run, steps: execution.steps, producerStep, producerRun, rejectedQas, findingsByQaStepId },
      { history: "prepare" });
    if (qualifiedRun.status !== "qualified") {
      if (qualifiedRun.status === "waiting") return { outcome: "not_applicable", detail: qualifiedRun.detail };
      return { outcome: "not_applicable", detail: qualifiedRun.detail };
    }
    // tx 내 원천 재적재 사이 verdict 가 바뀌면 그 verdict 로 scope 를 다시 세워 history 부터 재판정한다(유한 2패스).
    const drifted = qualifiedRun.qualified.some(q => {
      const ref = refs.find(r => r.qa.stepRunId === q.qaRun.id);
      return !ref || ref.eventId !== q.sourceVerdictEventId || ref.heartbeatRunId !== q.heartbeatRunId
        || ref.remediationsHash !== hashQaCorrectionPayload(q.remediations.items);
    });
    if (drifted) {
      if (pass >= 1) return { outcome: "not_applicable", detail: "qa verdict changed during preparation; retry on next pass" };
      refs.length = 0;
      for (const q of qualifiedRun.qualified) refs.push({ eventId: q.sourceVerdictEventId, heartbeatRunId: q.heartbeatRunId!,
        remediationsHash: hashQaCorrectionPayload(q.remediations.items), qa: attemptOf(q.qaRun) });
      continue;
    }

    if (qualifiedRun.fileBuffers.size === 0) return { outcome: "not_applicable", detail: "no remediation target files" };
    const identities = await buildFileIdentities(qualifiedRun.fileBuffers);
    if (!identities.ok) return { outcome: "not_applicable", detail: identities.detail };

    // Qualification creates only a base v2 candidate. A Quality root adds its current strict v3 binding
    // before using the transaction writer; this workflow entry never upgrades or publishes a v2 row.
    const preparation: QaRemediationPreparation = parseQaRemediationPreparation({
      schemaVersion: "workflow.qa-remediation.prepare.v2", preparationId: randomUUID(),
      companyId: run.companyId, missionId: run.missionId!, workflowRunId: run.id,
      dispatchAuthorityVersion: run.dispatchAuthorityVersion, producer: attemptOf(producerRun),
      verdicts: qualifiedRun.qualified.map(q => ({ eventId: q.sourceVerdictEventId, heartbeatRunId: q.heartbeatRunId!,
        qa: attemptOf(q.qaRun), items: q.remediations.items,
        remediationsHash: hashQaCorrectionPayload(q.remediations.items) })),
      files: identities.files, preparedAt: new Date().toISOString(),
    });
    return { outcome: "candidate", preparation, scope,
      detail: `qualification produced an unstored candidate (${preparation.verdicts.length} verdict(s), ${preparation.files.length} file(s)); caller transaction must bind and store before any publication` };
  }
}

/** Existing workflow-only root: mission→run lock, qualification, then the v2 transaction writer. */
export async function prepareQaRemediationReservation(db: Db,
  request: QaRemediationPreparationRequest): Promise<QaRemediationPreparationPassResult> {
  if (is(db, PgTransaction)) throw new QaRemediationPreparationError("nested_caller");
  if (request.qualityActionId !== undefined) throw new QaRemediationPreparationError("quality_root_required");
  return db.transaction(async tx => {
    const candidate = await buildQaRemediationPreparationCandidate(tx, request);
    if (candidate.outcome !== "candidate") return candidate;
    return writeQaRemediationPreparation(tx, candidate.preparation, candidate.scope);
  });
}
