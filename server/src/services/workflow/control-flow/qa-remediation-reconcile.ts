// server/src/services/workflow/control-flow/qa-remediation-reconcile.ts
// [purpose] Identifier-only workflow v2/Quality v3 root; Quality locks precede workflow locks, native ownership stays outside DB locks, exact completion reuses receipt/wakes, unknown legacy scope holds, rollback preserves preparation, and IO-time connection loss remains unknown.

import { and, eq, inArray, is } from "drizzle-orm";
import { isDeepStrictEqual as same } from "node:util";
import { PgTransaction } from "drizzle-orm/pg-core";
import { agentWakeupRequests, issues, missions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { hashQaCorrectionPayload } from "./qa-correction-contract.js";
import { loadLatestQaRemediations } from "../validation-verdict-ledger.js";
import { isLatestQaExecution } from "./qa-cap-acceptance.js";
import { loadProducerOwnReworkContext } from "./rework-producer-context.js";
import path from "node:path";
import {
  QA_REMEDIATION_PREPARATION_EVENT_TYPE, parseQaRemediationPreparation, qaRemediationPreparationKey,
  type QaRemediationPreparation,
} from "./qa-remediation-preparation-contract.js";
import {
  prepareQaRemediationReservation, type QaRemediationPreparationHeldReason, type QaRemediationPreparationRequest,
} from "./qa-remediation-prepare.js";
import {
  publishQaRemediationPreparation, type QaRemediationFilePublication, type QaRemediationPublicationHeldReason,
} from "./qa-remediation-publication.js";
import {
  completeQaRemediationReservation, legacyQaRemediationRefireWakeKey, readCommittedQaRemediationCompletion,
  type QaRemediationCompletion, type QaRemediationCompletionResult,
} from "./qa-remediation-completion.js";
import { prepareQaRemediationQualityReservation, verifyQaRemediationQualityRoot, verifyQaRemediationQualityUseLimit,
  forwardCommittedQualityNotifications } from "./qa-remediation-quality-root.js";
import {
  createReplacementRootNotifications, currentReplacementRootNotifications, withReplacementRootNotificationDb,
} from "../../issue-assignment-wakeup.js";
import type { QaFileOwnerRuntime } from "./qa-remediation-runtime.js";
import type { FileOwnerExit, QaRemediationFileOwner } from "./qa-remediation-file-owner.js";
import { readQaRemediationActualDrain } from "../../heartbeat-actual-drain.js";

export class QaRemediationReconcileError extends Error {
  constructor(readonly reason: string, options?: ErrorOptions) { super(`qa_remediation_reconcile_${reason}`, options); }
}

export type QaRemediationReconcileRequest = QaRemediationPreparationRequest;

export type QaRemediationReconcileHeldReason =
  | "invalid_reservation"         // 잠긴 예약 행이 파손/불일치 — unknown 홀드, 절대 fallback
  | "authority_changed"           // 발행 권한 버전이 예약 이후 변경 — 이전 권한으로 게시 금지
  | "fenced"                      // 취소/hidden — 시도된 효과 보존 홀드
  | "boundary_lost"               // 활성 산출물 경계가 예약 파일을 더 이상 덮지 않음
  | "legacy_wake_scope_unknown"  // 같은 키 legacy wake 흔적(terminal/payload-only 포함) — binding 불명, 재발행도 차용도 금지
  | "owner_required"
  | "owner_unavailable"
  | "owner_target_mismatch"
  | "owner_lost"
  | "actual_drain_unproven"
  | "transaction_outcome_unknown";

export type QaRemediationReconcileResult =
  | { readonly outcome: "completed"; readonly completionEventId: string; readonly completion: QaRemediationCompletion;
      readonly created: boolean; readonly publication: readonly QaRemediationFilePublication[];
      readonly notifications: QaRemediationCompletionResult["notifications"]; readonly detail: string }
  | { readonly outcome: "preparation_held"; readonly reason: QaRemediationPreparationHeldReason; readonly detail: string }
  | { readonly outcome: "not_applicable"; readonly detail: string }
  | { readonly outcome: "superseded"; readonly detail: string }
  | { readonly outcome: "publication_held"; readonly reason: QaRemediationPublicationHeldReason;
      readonly files: readonly QaRemediationFilePublication[]; readonly detail: string }
  | { readonly outcome: "publication_io_error"; readonly files: readonly QaRemediationFilePublication[]; readonly detail: string }
  | { readonly outcome: "held"; readonly reason: QaRemediationReconcileHeldReason; readonly detail: string;
      /** Internal diagnostic only; non-enumerable so generic serialization cannot expose raw causes. */
      readonly cause?: unknown };

function withFailureCause(result: Extract<QaRemediationReconcileResult, { readonly outcome: "held" }>, cause: unknown) {
  Object.defineProperty(result, "cause", { value: cause, enumerable: false });
  return result;
}

type StepRun = typeof workflowStepRuns.$inferSelect;
const attemptOf = (s: StepRun) => ({ stepRunId: s.id, stepId: s.stepId, issueId: s.issueId!,
  executionGeneration: s.executionGeneration, retryCount: s.retryCount, iterationIndex: s.iterationIndex });

/** 활성 생산 산출물 경로 → (정확 파일 허용집, 디렉터리 허용집) — qa-remediation-qualification 의
 *  module-private loadProducerArtifactBoundary 와 동일 유도(공개 계약 loadProducerOwnReworkContext 기반). */
async function currentArtifactBoundary(tx: Db, run: typeof workflowRuns.$inferSelect, producerRun: StepRun) {
  const context = await loadProducerOwnReworkContext({ db: tx, companyId: run.companyId,
    missionId: run.missionId ?? null, workflowRunId: run.id, producerStepId: producerRun.stepId,
    producerIssueId: producerRun.issueId });
  const allowedFiles = new Set<string>();
  const allowedDirs: string[] = [];
  for (const product of context.workProducts) {
    if (!path.isAbsolute(product.ref)) continue;
    const resolved = path.resolve(product.ref);
    allowedFiles.add(resolved);
    allowedDirs.push(path.dirname(resolved));
  }
  return { allowedFiles, allowedDirs };
}

/** pre-IO legacy ambiguity — 같은 회사+키의 legacy refire wake 행이 하나라도 있으면(어떤 status 든)
 *  그 목록을 돌려준다. 키가 run+qaStepRun 을 이미 묶고 있어 typed-columns 유무(과거 payload-only 행)와
 *  무관하게 이 scope 의 시도 흔적이다. 인식/차용/중복 발행 어느 쪽 근거도 될 수 없다. */
async function legacyRefireWakeRows(tx: Db, companyId: string, workflowRunId: string, qaStepRunIds: readonly string[]) {
  const rows = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId),
    inArray(agentWakeupRequests.idempotencyKey, qaStepRunIds.map((id) => legacyQaRemediationRefireWakeKey(workflowRunId, id)))));
  return rows.map((row) => ({ id: row.id, status: row.status, hasTypedBinding: row.workflowStepRunId !== null }));
}

/**
 * [root-only] identifier-only 재개: 예약(prepare) → 소유자 잠금 재독기 → 원자 게시 → 내구 완료.
 *   PgTransaction 호출 거부. notification mapping 미등록 루트에서도 fail-closed(완료 drain 소유 불명).
 *   after-commit drain 은 호출자(main wrapper) 소관 — 결과의 notifications 로 명시적으로 받는다.
 */
export async function reconcileQaRemediationReservation(db: Db,
  request: QaRemediationReconcileRequest,
  fileOwnerRuntime?: QaFileOwnerRuntime): Promise<QaRemediationReconcileResult> {
  if (is(db, PgTransaction)) throw new QaRemediationReconcileError("nested_caller");
  const notifications = currentReplacementRootNotifications(db);
  if (!notifications) throw new QaRemediationReconcileError("root_drain_unregistered");

  const preparation = request.qualityActionId
    ? await prepareQaRemediationQualityReservation(db, request)
    : await prepareQaRemediationReservation(db, request);
  if (preparation.outcome === "held") return { outcome: "preparation_held", reason: preparation.reason, detail: preparation.detail };
  if (preparation.outcome === "not_applicable") return { outcome: "not_applicable", detail: preparation.detail };
  if (preparation.outcome === "completed") {
    forwardCommittedQualityNotifications(notifications, preparation.result);
    return { outcome: "completed", completionEventId: preparation.result.completionEventId,
      completion: preparation.result.completion, created: false, publication: [], notifications: preparation.result.notifications,
      detail: "exact committed Quality completion recognized before latest QA qualification; original completion and pending wake identity reused" };
  }
  const reserved = preparation;
  if (!fileOwnerRuntime) return { outcome: "held", reason: "owner_required", detail: "an explicit native file-owner runtime is required" };

  // Prepare is already durable and committed. Acquire the native owner outside the
  // publication transaction so DB locks are never held while waiting for flock.
  const preparedTargets = [...new Set(reserved.preparation.files.map((file) => file.path))].sort();
  let owner: QaRemediationFileOwner;
  try {
    owner = await fileOwnerRuntime.begin(preparedTargets);
  } catch (error) {
    return withFailureCause({ outcome: "held", reason: "owner_unavailable",
      detail: `native file-owner acquisition failed: ${error instanceof Error ? error.message : String(error)}` }, error);
  }

  const ownerTargets = [...owner.targets()];
  const sameTargetSet = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  const sortedOwnerTargets = [...ownerTargets].sort();
  if (!sameTargetSet(ownerTargets, sortedOwnerTargets) || !sameTargetSet(sortedOwnerTargets, preparedTargets)) {
    let detail = "acquired owner targets do not match the exact sorted durable preparation targets";
    try {
      const stopped = await owner.abort();
      if (!stopped.exit) detail += "; owner exit was not observed";
    } catch (cleanupError) {
      detail += `; owner cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    }
    return { outcome: "held", reason: "owner_target_mismatch", detail };
  }

  const privateNotifications = createReplacementRootNotifications();
  type CallbackState = "never_entered" | "running" | "settled";
  let callbackState: CallbackState = "never_entered";
  const currentCallbackState = () => callbackState;
  let callbackResolve!: () => void;
  const callbackSettlement = new Promise<void>((resolve) => { callbackResolve = resolve; });
  let entrySealed = false;
  let stopped = false;
  let expectedClose = false;
  let unexpectedOwnerExit = false;
  let ownerExit: FileOwnerExit | null | undefined;
  let cleanupPromise: Promise<FileOwnerExit | null> | null = null;

  const markUnexpectedExit = (exit: FileOwnerExit | null) => {
    ownerExit = exit;
    if (!expectedClose) {
      unexpectedOwnerExit = true;
      stopped = true;
      entrySealed = true;
    }
  };
  // Start observing immediately after begin. This promise never rejects; the
  // original owner remains the only process this root is allowed to stop.
  const exitObservation = owner.awaitExit().then((exit) => {
    markUnexpectedExit(exit);
    return exit;
  }, () => {
    markUnexpectedExit(null);
    return null;
  });

  const stopAndAbortOwner = (): Promise<FileOwnerExit | null> => {
    entrySealed = true;
    stopped = true;
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        let abortExit: FileOwnerExit | null = null;
        let abortError: unknown;
        try { abortExit = (await owner.abort()).exit; }
        catch (error) { abortError = error; }
        const observedExit = await exitObservation;
        if (abortError) throw new AggregateError([abortError], "native owner abort failed");
        if (!observedExit && !abortExit) throw new Error("native owner exit was not observed after abort");
        return observedExit ?? abortExit;
      })();
    }
    return cleanupPromise;
  };

  const peekOwnerExit = async () => await Promise.race([
    owner.awaitExit().then((exit) => ({ settled: true as const, exit })),
    Promise.resolve({ settled: false as const }),
  ]);

  const assertOwnerActive = async (phase: string): Promise<void> => {
    if (entrySealed || stopped || unexpectedOwnerExit) {
      throw new QaRemediationReconcileError("owner_lost", { cause: `native owner stopped before ${phase}` });
    }
    // If exit already resolved, observe it before admitting the next effect.
    const current = await peekOwnerExit();
    if (current.settled) {
      markUnexpectedExit(current.exit);
      throw new QaRemediationReconcileError("owner_lost", { cause: `native owner exited before ${phase}` });
    }
    if (entrySealed || stopped || unexpectedOwnerExit) {
      throw new QaRemediationReconcileError("owner_lost", { cause: `native owner stopped before ${phase}` });
    }
  };

  let transactionPromise: Promise<QaRemediationReconcileResult>;
  try {
    transactionPromise = db.transaction(async rawTx => {
      callbackState = "running";
      try {
        if (entrySealed) throw new QaRemediationReconcileError("owner_lost", { cause: "transaction callback entered after its root was sealed" });
        await assertOwnerActive("transaction callback entry");
    const tx = rawTx as unknown as Db;
    let quality: Awaited<ReturnType<typeof verifyQaRemediationQualityRoot>> | null = null;
    if (request.qualityActionId) {
      quality = await verifyQaRemediationQualityRoot(rawTx, request, reserved.preparation);
      if (!quality.ok) return { outcome: "held", reason: "invalid_reservation" as const, detail: quality.detail };
    }
    // 관측된 기존 순서(acceptIssued/prepare): missions → workflowRuns, FOR NO KEY UPDATE.
    const [mission] = await rawTx.select().from(missions).where(and(
      eq(missions.id, request.missionId), eq(missions.companyId, request.companyId))).for("no key update");
    if (!mission) throw new QaRemediationReconcileError("scope");
    const [run] = await rawTx.select().from(workflowRuns).where(and(
      eq(workflowRuns.id, request.workflowRunId), eq(workflowRuns.companyId, request.companyId))).for("no key update");
    if (!run || run.missionId !== request.missionId) throw new QaRemediationReconcileError("scope");

    // 예약 행 소유자 잠금 — IO 와 completion 커밋까지 유지(C5 단일 기록자).
    const [reservation] = await rawTx.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.id, reserved.preparationEventId),
      eq(workflowTransitionEvents.companyId, request.companyId))).for("update");
    if (!reservation) throw new QaRemediationReconcileError("scope");

    let prepared: QaRemediationPreparation;
    try { prepared = parseQaRemediationPreparation(reservation.payload); }
    catch (error) {
      return { outcome: "held", reason: "invalid_reservation" as const,
        detail: `locked reservation row does not parse: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (reservation.eventType !== QA_REMEDIATION_PREPARATION_EVENT_TYPE
      || reservation.workflowRunId !== run.id || reservation.workflowStepRunId !== request.producerStepRunId
      || reservation.idempotencyKey !== qaRemediationPreparationKey(prepared)
      || prepared.preparationId !== reservation.id || prepared.companyId !== run.companyId
      || prepared.missionId !== run.missionId || prepared.workflowRunId !== run.id) {
      return { outcome: "held", reason: "invalid_reservation" as const, detail: "locked reservation row does not bind this run/scope/key" };
    }
    const lockedTargets = [...new Set(prepared.files.map((file) => file.path))].sort();
    if (!sameTargetSet(lockedTargets, preparedTargets) || !sameTargetSet(lockedTargets, sortedOwnerTargets)) {
      return { outcome: "held", reason: "owner_target_mismatch" as const,
        detail: "locked preparation target set changed after native owner acquisition; no in-transaction acquisition is allowed" };
    }
    if (!same(prepared, reserved.preparation)) {
      return { outcome: "held", reason: "invalid_reservation" as const,
        detail: "locked preparation payload differs from the exact durable snapshot used to acquire the native owner" };
    }
    // The exact action/source/receipt and reservation identity are bound above.
    // Reuse committed history before mutable publication authority or freshness fences.
    if (prepared.schemaVersion === "workflow.qa-remediation.prepare.v3") {
      const committed = await withReplacementRootNotificationDb(tx, privateNotifications, () =>
        readCommittedQaRemediationCompletion(tx, prepared));
      if (committed) return { outcome: "completed", completionEventId: committed.completionEventId,
        completion: committed.completion, created: false, publication: [], notifications: committed.notifications,
        detail: "exact committed completion recognized before latest QA qualification; original completion and pending wake identity reused" };
    }
    if (run.dispatchAuthorityVersion !== prepared.dispatchAuthorityVersion) {
      return { outcome: "held", reason: "authority_changed" as const,
        detail: `dispatch authority moved to ${run.dispatchAuthorityVersion} while reservation holds ${prepared.dispatchAuthorityVersion}; never publish under borrowed authority` };
    }
    if (run.status === "cancelled" || mission.status === "cancelled") {
      return { outcome: "held", reason: "fenced" as const, detail: "run or mission cancelled after reservation" };
    }

    // Pause-intent order: sorted issues then steps; fences use only locked rows.
    const issueIds = [...new Set([prepared.producer.issueId, ...prepared.verdicts.map((v) => v.qa.issueId)])].sort();
    const scopeIssues = await rawTx.select().from(issues).where(and(
      eq(issues.companyId, run.companyId), inArray(issues.id, issueIds))).orderBy(issues.id).for("no key update");
    const stepIds = [...new Set([prepared.producer.stepRunId, ...prepared.verdicts.map((v) => v.qa.stepRunId)])].sort();
    const scopeSteps = await rawTx.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.workflowRunId, run.id), inArray(workflowStepRuns.id, stepIds))).orderBy(workflowStepRuns.id).for("no key update");
    if (scopeIssues.length !== issueIds.length || scopeSteps.length !== stepIds.length) {
      return { outcome: "held", reason: "invalid_reservation" as const, detail: "reserved producer/QA issue or step rows missing" };
    }
    const stepOf = (id: string) => scopeSteps.find((s) => s.id === id)!;
    const producerRun = stepOf(prepared.producer.stepRunId);
    const qaRuns = prepared.verdicts.map((v) => stepOf(v.qa.stepRunId));
    if (producerRun.status === "cancelled" || qaRuns.some((qa) => qa.status === "cancelled")) {
      return { outcome: "held", reason: "fenced" as const, detail: "reserved producer/QA step run cancelled" };
    }
    for (const issue of scopeIssues) {
      if (issue.hiddenAt || issue.status === "cancelled") {
        return { outcome: "held", reason: "fenced" as const, detail: "producer/QA issue cancelled or hidden after reservation" };
      }
    }

    if (prepared.schemaVersion === "workflow.qa-remediation.prepare.v3") {
      const current = quality?.ok ? await quality.verifyCurrentAuthority() : null;
      if (current && !current.ok) return { outcome: "held", reason: "invalid_reservation" as const, detail: current.detail };
      if (quality?.ok && !(await verifyQaRemediationQualityUseLimit(rawTx, request, quality.maxExecutorAttempts))) {
        return { outcome: "held", reason: "invalid_reservation" as const, detail: "Quality action executor-attempt limit is exhausted" };
      }
    }

    // Committed history wins before attempt freshness; only uncompleted work is reclassified.
    if (!same(attemptOf(producerRun), prepared.producer)
      || prepared.verdicts.some((v, i) => !same(attemptOf(qaRuns[i]!), v.qa))) {
      return { outcome: "superseded", detail: "producer/QA attempt tuple drifted from the reservation; normal settlement owns the new cycle" };
    }

    // 원천 verdict 현재성(C4) — 변경/신규 QA 실행이면 정상 settlement 에 맡긴다(이전 사이클 미적용).
    for (const verdict of prepared.verdicts) {
      const loaded = await loadLatestQaRemediations({ db: tx, companyId: run.companyId, issueId: verdict.qa.issueId });
      if (!loaded || !loaded.workflowStepRunId || loaded.workflowStepRunId !== verdict.qa.stepRunId) {
        return { outcome: "superseded", detail: `qa ${verdict.qa.stepId} latest verdict is terminal or bound to a foreign step run; normal settlement closes this cycle` };
      }
      if (loaded.sourceVerdictEventId !== verdict.eventId || loaded.heartbeatRunId !== verdict.heartbeatRunId
        || hashQaCorrectionPayload(loaded.remediations.items) !== verdict.remediationsHash) {
        return { outcome: "superseded", detail: `qa ${verdict.qa.stepId} source verdict changed since reservation; the new verdict owns the next cycle` };
      }
      if (!(await isLatestQaExecution(tx as Db, verdict.qa.issueId, verdict.qa.stepRunId, verdict.heartbeatRunId))) {
        return { outcome: "superseded", detail: `qa ${verdict.qa.stepId} has a newer execution; normal settlement owns the fresh verdict` };
      }
    }

    // pre-IO legacy ambiguity hold — 같은 키 legacy wake 흔적(terminal·payload-only 포함)은 binding 이 불명하다.
    // 현재 verdict 로 인식하거나 미시작으로 보고 v2 를 발행하는 것 모두 근거 없다(unknown never unstarted).
    const legacyRows = await legacyRefireWakeRows(tx, run.companyId, run.id, prepared.verdicts.map((v) => v.qa.stepRunId));
    if (legacyRows.length > 0) {
      return { outcome: "held", reason: "legacy_wake_scope_unknown" as const,
        detail: `${legacyRows.length} legacy refire wake row(s) exist for this scope [${legacyRows.map((r) => `${r.status}${r.hasTypedBinding ? "" : ":payload-only"}`).join(", ")}] — verdict/attempt binding cannot be proven for legacy rows; hold is not mission completion and assumes no new cycle; actionable recovery owns the decision` };
    }

    // 활성 산출물 경계 재독기 — 경계 밖/상실이면 게시 없이 홀드.
    const boundary = await currentArtifactBoundary(tx, run, producerRun);
    const inside = (file: string) => boundary.allowedFiles.has(file) || boundary.allowedDirs.some((dir) => {
      const rel = path.relative(dir, file);
      return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
    });
    if (prepared.files.length === 0 || !prepared.files.every((f) => inside(f.path))) {
      return { outcome: "held", reason: "boundary_lost" as const, detail: "active producer artifact boundary no longer covers every reserved file" };
    }

    // Native owner remains alive through actual transaction settlement. Read-only
    // preflight runs under the exact locked reservation; the last checkpoint is
    // immediately before the native helper may perform any mutation.
    await assertOwnerActive("actual-drain preflight");
    const actualDrain = await readQaRemediationActualDrain(tx as unknown as Db, prepared, producerRun);
    if (actualDrain.kind !== "proven") {
      return { outcome: "held", reason: "actual_drain_unproven" as const,
        detail: `exact producer output is held until its own adapter actual and cleanup are durably observed: ${actualDrain.reason}` };
    }
    await assertOwnerActive("publication preflight");
    const publication = await publishQaRemediationPreparation(prepared, {
      reservationEventId: reserved.preparationEventId,
      dispatchAuthorityVersion: run.dispatchAuthorityVersion,
      allowedFiles: boundary.allowedFiles, allowedDirs: boundary.allowedDirs,
    }, owner, () => {
      if (entrySealed || stopped || unexpectedOwnerExit) throw new QaRemediationReconcileError("owner_lost", { cause: "native owner stopped before publication" });
    });
    if (publication.outcome === "held") {
      return { outcome: "publication_held", reason: publication.reason, files: publication.files, detail: publication.detail };
    }
    if (publication.outcome === "io_error") {
      return { outcome: "publication_io_error", files: publication.files, detail: publication.detail };
    }

    await assertOwnerActive("completion");
    // Notifications stay private until DB commit and clean child exit are both known.
    const completion = await withReplacementRootNotificationDb(tx as unknown as Db, privateNotifications, () =>
      completeQaRemediationReservation(tx as unknown as Db, { preparation: prepared, publication }));
    await assertOwnerActive("completion callback return");
    return { outcome: "completed", completionEventId: completion.completionEventId, completion: completion.completion,
      created: completion.created, publication: publication.files, notifications: completion.notifications,
      detail: `${publication.detail}; ${completion.created ? "completion persisted with wakes atomically" : "existing committed completion recognized (no duplicate effects)"} — after-commit drain owned by caller` };
      } catch (error) {
        entrySealed = true;
        stopped = true;
        try { await stopAndAbortOwner(); }
        catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "QA remediation callback failed and native owner cleanup failed");
        }
        throw error;
      } finally {
        callbackState = "settled";
        callbackResolve();
      }
    });
  } catch (error) {
    // A synchronous transaction setup failure has the same never-entered
    // semantics as a rejected BEGIN and still owns cleanup of this helper.
    entrySealed = true;
    stopped = true;
    let cleanupError: unknown;
    try { await stopAndAbortOwner(); } catch (failure) { cleanupError = failure; }
    if (currentCallbackState() !== "never_entered") await callbackSettlement;
    if (cleanupError) throw new AggregateError([error, cleanupError], "transaction setup and native owner cleanup failed");
    if (callbackState !== "never_entered") {
      return withFailureCause({ outcome: "held", reason: "transaction_outcome_unknown",
        detail: `transaction rejected after callback entry; durable DB/file outcome is unknown and notifications were withheld: ${error instanceof Error ? error.message : String(error)}` }, error);
    }
    throw error;
  }

  const transactionOutcome = await transactionPromise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    async (error) => {
      entrySealed = true;
      stopped = true;
      let cleanupError: unknown;
      try { await stopAndAbortOwner(); } catch (failure) { cleanupError = failure; }
      if (currentCallbackState() !== "never_entered") await callbackSettlement;
      if (cleanupError) return { status: "rejected" as const, error: new AggregateError([error, cleanupError], "transaction and native owner cleanup failed") };
      return { status: "rejected" as const, error };
    },
  );
  if (transactionOutcome.status === "rejected") {
    if (currentCallbackState() === "never_entered") throw transactionOutcome.error;
    return withFailureCause({ outcome: "held", reason: "transaction_outcome_unknown",
      detail: `transaction rejected after callback entry; durable DB/file outcome is unknown and notifications were withheld: ${transactionOutcome.error instanceof Error ? transactionOutcome.error.message : String(transactionOutcome.error)}` }, transactionOutcome.error);
  }
  if (currentCallbackState() !== "settled") {
    entrySealed = true;
    stopped = true;
    await stopAndAbortOwner();
    await callbackSettlement;
    return { outcome: "held", reason: "transaction_outcome_unknown", detail: "transaction fulfilled without a settled root callback receipt" };
  }

  // Check for a helper exit that raced callback return or COMMIT before making
  // intentional close the only accepted exit.
  const exitBeforeClose = await peekOwnerExit();
  if (exitBeforeClose.settled) markUnexpectedExit(exitBeforeClose.exit);
  if (exitBeforeClose.settled || unexpectedOwnerExit) {
    return { outcome: "held", reason: "owner_lost",
      detail: `native owner exited before intentional close (${ownerExit?.code ?? "unknown"}/${ownerExit?.signal ?? "unknown"}); transaction outcome is preserved as ${transactionOutcome.value.outcome}, notifications were withheld` };
  }

  let cleanExit: FileOwnerExit | null = null;
  let closeError: unknown;
  expectedClose = true;
  try { cleanExit = await owner.close(); }
  catch (error) { closeError = error; }
  if (closeError) {
    try { await stopAndAbortOwner(); } catch (cleanupError) { closeError = new AggregateError([closeError, cleanupError], "owner close and cleanup failed"); }
    return withFailureCause({ outcome: "held", reason: "owner_lost",
      detail: `native owner close was not clean; transaction outcome is preserved as ${transactionOutcome.value.outcome}: ${closeError instanceof Error ? closeError.message : String(closeError)}` }, closeError);
  }
  const observedClose = await exitObservation;
  if (!cleanExit || !observedClose || cleanExit.code !== 0 || cleanExit.signal !== null
    || observedClose.code !== cleanExit.code || observedClose.signal !== cleanExit.signal) {
    return { outcome: "held", reason: "owner_lost",
      detail: `native owner did not produce a matching clean exit receipt; transaction outcome is preserved as ${transactionOutcome.value.outcome}` };
  }

  const result = transactionOutcome.value;
  if (result.outcome === "completed") {
    for (const agentId of privateNotifications.agentIds) notifications.agentIds.add(agentId);
    for (const wakeId of privateNotifications.correctionWakeupRequestIds) notifications.correctionWakeupRequestIds.add(wakeId);
  }
  return result;
}
