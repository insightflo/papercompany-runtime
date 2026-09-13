// server/src/services/quality/native-delivery.ts
//
// [purpose] T4 실제 실행 수락·취소. deliverQualityIntent 는 정식 binding(T3)을 얻어
//   기존 native 경로(dag-engine wakeExistingWorkflowStepIssue → queueIssueAssignmentWakeup
//   → heartbeat.wakeup → 기존 대기열 → adapter.execute)로 전달하고, admission tx 가
//   기록한 qualityAcceptance 원문만 수락 증거로 읽는다. 통신 재전송은 같은 attempt,
//   새 기술 시도는 기존 step retry tx 의 유한 예약 후 새 키다(이 파일은 새 기술 시도를
//   스스로 만들지 않는다). 취소는 intent 차단을 먼저 저장한 뒤 기존 cancelRun 정리를
//   호출하고 요청과 확인을 구분한다.
// [ordering] §3.3: 잠금은 usage → group → action. 취소 tx 안에서 감사 행까지 저장하고,
//   커밋 후에만 cancelRun 정리를 호출한다.

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  qualityActionGroups,
  qualityActions,
  qualityPolicyUsage,
  qualityPolicyVersions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { qualityKeySchema, qualityPolicySchema, retryEnvelopeSchema, type QualityKey } from "@paperclipai/shared";
import { parseEvidence } from "./contract.js";
import { HttpError, notFound } from "../../errors.js";
import { insertActivityRecord } from "../activity-log-records.js";
import { heartbeatService } from "../heartbeat.js";
import { buildWorkflowExecutionSteps, wakeExistingWorkflowStepIssue } from "../workflow/dag-engine.js";
import { ensureCanonicalQualityExecution } from "./native-records.js";
import { QUALITY_EXECUTE_STEP_ID } from "./native-definition.js";
import { isAddendumWithdrawnForTarget } from "./rollback.js";
import {
  findQualityWakeRowByExactKey,
  mapQualityWakeRow,
  parseQualityWakeKey,
  qualityAttemptRows,
  qualityWakeKey,
  type QualityDeliveryOutcome,
} from "./native-wake.js";

export type { QualityDeliveryOutcome };

const TERMINAL_HEARTBEAT_RUN = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

type ActionRow = typeof qualityActions.$inferSelect;

async function loadAction(db: Db, key: QualityKey): Promise<ActionRow> {
  const [action] = await db.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, key.companyId), eq(qualityActions.id, key.actionId)));
  if (!action) throw notFound("quality_action_not_found");
  return action;
}

/** 실행 직전 재검사: 정책 활성·기간·native ownership. 위반이면 전달 없이 blocked. */
async function assertNativeOwnershipActive(db: Db, action: ActionRow): Promise<void> {
  const [policyRow] = await db.select().from(qualityPolicyVersions)
    .where(and(eq(qualityPolicyVersions.companyId, action.companyId), eq(qualityPolicyVersions.id, action.policyVersionId)));
  if (!policyRow || !policyRow.approvedAt || !policyRow.enabledAt || policyRow.disabledAt) {
    throw new HttpError(409, "quality_policy_inactive");
  }
  const policy = parseEvidence(qualityPolicySchema, policyRow.definition);
  const now = new Date();
  if (now < new Date(policy.periodStart) || now >= new Date(policy.periodEnd)) {
    throw new HttpError(409, "quality_policy_outside_period");
  }
  if (policy.nativeOwnership !== "native-active-plugin-disabled") {
    throw new HttpError(409, "quality_native_ownership_unavailable");
  }
}

/**
 * quality intent 를 실제 native 경로로 전달한다.
 * - accepted: admission tx 가 기록한 수락 원문이 있는 경우(빠른 완료 후에도 동일 영수증).
 * - waiting: 대기열에 살아 있으나 아직 수락되지 않은 경우(deferred·paused 대기).
 * - blocked: 거절(정책·취소·한도·정의 불변 위반). 새 기술 시도는 retry 경로 소관이다.
 */
export async function deliverQualityIntent(db: Db, key: QualityKey): Promise<{ status: "accepted" | "waiting" | "blocked"; receiptId: string | null }> {
  const parsed = parseEvidence(qualityKeySchema, key);
  let action: ActionRow;
  try {
    action = await loadAction(db, parsed);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return { status: "blocked", receiptId: null };
    throw error;
  }
  if (action.cancelRequestedAt) return { status: "blocked", receiptId: null };
  // [T9] required 정책 대상의 추가 항목이 철회·비활성된 template/base 이면 새 실행 전달을 막는다.
  // 이미 고정된 진행 중 실행은 이 경로에서 바꾸지 않는다(재검증/취소는 기존 경로 소관).
  if (action.kind === "qa_addendum" && action.target.kind === "qa_addendum"
    && await isAddendumWithdrawnForTarget(db, {
      companyId: parsed.companyId, templateId: action.target.templateId, baseHash: action.target.baseHash,
    })) {
    return { status: "blocked", receiptId: null };
  }
  try {
    await assertNativeOwnershipActive(db, action);
    await ensureCanonicalQualityExecution(db, parsed); // 실행 직전 정의 해시 재검증 포함(T3)
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) return { status: "blocked", receiptId: null };
    throw error;
  }
  const [fresh] = await db.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, parsed.companyId), eq(qualityActions.id, parsed.actionId)));
  const binding = fresh!.canonicalBinding;
  if (!binding) return { status: "blocked", receiptId: null };
  if (fresh!.cancelRequestedAt) return { status: "blocked", receiptId: null };

  const [stepRun] = await db.select({ executionGeneration: workflowStepRuns.executionGeneration, stepId: workflowStepRuns.stepId })
    .from(workflowStepRuns).where(eq(workflowStepRuns.id, binding.stepRunId));
  const generation = stepRun?.executionGeneration ?? 0;
  const envelope = parseEvidence(retryEnvelopeSchema, fresh!.retryEnvelope);
  const rows = await qualityAttemptRows(db, { companyId: parsed.companyId, actionId: parsed.actionId, stepRunId: binding.stepRunId });
  if (rows.length >= envelope.maxExecutorAttempts) return { status: "blocked", receiptId: null };

  // 현재 generation 의 마지막 시도 — 살아 있으면 같은 키 재전송(멱등), 소진 상태면
  // 소진 사유에 따라 수락 원문 재응답 또는 차단(기술 재시도는 retry tx 소관).
  const currentRows = rows
    .map((row) => ({ row, parsed: parseQualityWakeKey(row.idempotencyKey) }))
    .filter((entry) => entry.parsed !== null && entry.parsed.generation === generation)
    .sort((a, b) => b.parsed!.attempt - a.parsed!.attempt);
  const last = currentRows[0];
  if (last) {
    const outcome = await resolveAttemptOutcome(db, last.row);
    if (outcome !== null) return outcome;
  }

  // 새 전송(첫 시도 또는 거절된 시도의 다음 유한 시도 — 같은 generation).
  const nextAttempt = (last?.parsed?.attempt ?? 0) + 1;
  const keyString = qualityWakeKey({ actionId: parsed.actionId, stepRunId: binding.stepRunId, generation, attempt: nextAttempt });
  const [run] = await db.select().from(workflowRuns)
    .where(and(eq(workflowRuns.companyId, parsed.companyId), eq(workflowRuns.id, binding.workflowRunId)));
  const [definition] = await db.select().from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.companyId, parsed.companyId), eq(workflowDefinitions.id, run!.workflowId)));
  // qa_addendum 은 불변 quality 정의의 quality-execute 단계만 깨운다. current_output 은
  // binding 이 가리키는 원본 실행의 실제 단계(bound stepRun 의 stepId — 원본 정의에는
  // quality-execute 가 없으므로 고정 조회는 항상 blocked 였다). 대상 단계가 정의에 없으면
  // fail-closed blocked 다.
  const wantedStepId = fresh!.kind === "qa_addendum" ? QUALITY_EXECUTE_STEP_ID : stepRun?.stepId ?? null;
  const step = wantedStepId === null
    ? undefined
    : buildWorkflowExecutionSteps(definition!).find((candidate) => candidate.id === wantedStepId);
  if (!run || !definition || !step) return { status: "blocked", receiptId: null };
  await wakeExistingWorkflowStepIssue({
    db, run, definition, step, stepRunId: binding.stepRunId, issueId: binding.issueId,
    forceFreshSession: true, idempotencyKey: keyString,
  });
  // 같은 의도 동시 전달에서 경합 패자의 깨우기는 삼켜질 수 있고 승자의 admission
  // 커밋이 아직 보이지 않을 수 있다 — 유계 재판독(40ms×3)으로 증거를 다시 읽는다.
  let row = await findQualityWakeRowByExactKey(db, { companyId: parsed.companyId, idempotencyKey: keyString });
  for (let probe = 0; !row && probe < 3; probe += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    row = await findQualityWakeRowByExactKey(db, { companyId: parsed.companyId, idempotencyKey: keyString });
  }
  if (!row) return { status: "blocked", receiptId: null };
  return mapQualityWakeRow(row);
}

/** 마지막 시도 행의 상태를 전달 결과로 확정한다. null 이면 새 전송이 필요하다. */
async function resolveAttemptOutcome(db: Db, row: { id: string; status: string; runId: string | null; qualityAcceptance: Record<string, unknown> | null }): Promise<QualityDeliveryOutcome | null> {
  if (row.qualityAcceptance) {
    // 수락 원문이 있으면 그 시도는 이미 admission 됐다. 실행이 실패로 끝난 경우에도
    // 전달 수준의 멱등 응답은 수락이다(다음 기술 시도는 retry tx 소관).
    if (!row.runId) return mapQualityWakeRow(row);
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, row.runId));
    if (!run || !TERMINAL_HEARTBEAT_RUN.has(run.status)) return mapQualityWakeRow(row);
    return run.status === "succeeded"
      ? mapQualityWakeRow(row)
      : { status: "blocked", receiptId: null };
  }
  const live = row.status === "queued" || row.status === "claimed" || row.status === "deferred_issue_execution";
  if (live) return mapQualityWakeRow(row); // waiting — 아직 수락 전인 같은 시도 재전송.
  if (row.status === "skipped" && !row.runId) return null; // 거절된 전송 — 유한 재시도 가능.
  return { status: "blocked", receiptId: null };
}

/**
 * 취소: 조치 intent 차단을 먼저 저장하고(감사 행 포함, 같은 tx), 커밋 후에만 기존
 * cancelRun 정리를 호출한다. 사용량/예약은 환원하지 않는다(지연 청구 한도 유지).
 */
export async function cancelQualityIntent(db: Db, key: QualityKey, input?: { now?: Date }): Promise<{
  cancelRequestedAt: string; heartbeatRunId: string | null; runCancellationRequested: boolean;
}> {
  const parsed = parseEvidence(qualityKeySchema, key);
  const now = input?.now ?? new Date();
  let liveRunId: string | null = null;
  let cancelRequestedAt: Date | null = null;
  await db.transaction(async (tx) => {
    const [pre] = await tx.select({ groupId: qualityActions.groupId, policyVersionId: qualityActions.policyVersionId })
      .from(qualityActions).where(and(eq(qualityActions.companyId, parsed.companyId), eq(qualityActions.id, parsed.actionId)));
    if (!pre) throw notFound("quality_action_not_found");
    await tx.select({ id: qualityPolicyUsage.id }).from(qualityPolicyUsage)
      .where(and(eq(qualityPolicyUsage.companyId, parsed.companyId), eq(qualityPolicyUsage.policyVersionId, pre.policyVersionId)))
      .orderBy(asc(qualityPolicyUsage.windowStart)).for("update");
    await tx.select({ id: qualityActionGroups.id }).from(qualityActionGroups)
      .where(and(eq(qualityActionGroups.companyId, parsed.companyId), eq(qualityActionGroups.id, pre.groupId))).for("update");
    const [action] = await tx.select().from(qualityActions)
      .where(and(eq(qualityActions.companyId, parsed.companyId), eq(qualityActions.id, parsed.actionId))).for("update");
    if (!action) throw notFound("quality_action_not_found");
    cancelRequestedAt = action.cancelRequestedAt ?? now;
    if (!action.cancelRequestedAt) {
      await tx.update(qualityActions).set({ cancelRequestedAt: cancelRequestedAt, updatedAt: now })
        .where(and(eq(qualityActions.companyId, parsed.companyId), eq(qualityActions.id, parsed.actionId)));
      await insertActivityRecord(tx as unknown as Db, {
        companyId: parsed.companyId, actorType: "system", actorId: "quality",
        action: "quality.cancel_requested", entityType: "quality_action", entityId: parsed.actionId,
        details: { at: cancelRequestedAt.toISOString() },
      });
    }
    // 현재 살아 있는 수용 실행(수락 원문이 있고 run 이 queued/running 인 시도).
    if (action.canonicalBinding) {
      const attemptRows = await qualityAttemptRows(tx as unknown as Db, {
        companyId: parsed.companyId, actionId: parsed.actionId, stepRunId: action.canonicalBinding.stepRunId,
      });
      const acceptedRows = attemptRows.filter((row) => row.qualityAcceptance && row.runId);
      if (acceptedRows.length > 0) {
        const runs = await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, parsed.companyId), inArray(heartbeatRuns.id, acceptedRows.map((row) => row.runId!))));
        liveRunId = runs.find((run) => run.status === "queued" || run.status === "running")?.id ?? null;
      }
    }
  });
  // 커밋 후 정리: 기존 cancelRun cleanup. 요청 저장과 실제 취소 확인은 구분된다.
  let runCancellationRequested = false;
  if (liveRunId) {
    const cancelled = await heartbeatService(db).cancelRun(liveRunId);
    runCancellationRequested = Boolean(cancelled);
  }
  return { cancelRequestedAt: cancelRequestedAt!.toISOString(), heartbeatRunId: liveRunId, runCancellationRequested };
}

/** 취소 요청 저장 여부와 실제 취소 확인(run 종말 상태)을 분리해 읽는다. */
export async function readQualityCancellation(db: Db, key: QualityKey): Promise<{
  requested: boolean; cancelRequestedAt: string | null; runStatus: string | null; cancelledConfirmed: boolean;
}> {
  const parsed = parseEvidence(qualityKeySchema, key);
  const [action] = await db.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, parsed.companyId), eq(qualityActions.id, parsed.actionId)));
  if (!action) throw notFound("quality_action_not_found");
  let runStatus: string | null = null;
  if (action.canonicalBinding) {
    const attemptRows = await qualityAttemptRows(db, {
      companyId: parsed.companyId, actionId: parsed.actionId, stepRunId: action.canonicalBinding.stepRunId,
    });
    const acceptedRunIds = attemptRows.filter((row) => row.qualityAcceptance && row.runId).map((row) => row.runId!);
    if (acceptedRunIds.length > 0) {
      const runs = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, parsed.companyId), inArray(heartbeatRuns.id, acceptedRunIds)))
        .orderBy(desc(heartbeatRuns.createdAt));
      runStatus = runs[0]?.status ?? null;
    }
  }
  const requested = action.cancelRequestedAt !== null;
  const cancelledConfirmed = requested && runStatus === "cancelled";
  return { requested, cancelRequestedAt: action.cancelRequestedAt?.toISOString() ?? null, runStatus, cancelledConfirmed };
}
