// server/src/services/missions/terminal-mission-human-operator-alert.ts
// Terminal reports use structured authority; localization changes only the comment wrapper.
// Contract: authoritative fail-closed classification plus one transaction for
// scoped idempotency claim, system comment, and Human Operator activity.
//   - snapshot idempotency: one report per (company,mission,workflowRun,sorted-failed-run-fingerprint-set).
//     later distinct generation(새 failed run) → 새 key → 재보고. 동시 다수 failed step 은 한 snapshot 으로 aggregate.
//     snapshot scope 는 caller 가 authoritative workflow run 단위로 전달(교정: cross-run 혼합 ❌).
//   - system-authored: comment authorAgentId/authorUserId=null → payload actorType=system. owner 귀속 ❌.
//   - scope enforcement: tx 안에서 issue 행을 잠그고 companyId/missionId/originKind 를 검증(mismatch → fail-closed throw→rollback).
//   - sanitize: human comment + workflowTransitionEvents payload 모두 한 줄 bounded. control char/JSON-fragment/raw stderr·error body 제거.
//   - terminal failure status: approved failed/timed_out 만(cancelled 제외).
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { type SystemLanguage } from "./system-language.js";
import { activityLog, issueComments, issues, missions, operatorDecisions, workflowRuns, workflowTransitionEvents, companies } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import {
  materializeHumanOperatorRequestPayload,
  publishHumanOperatorRequestEvent,
  type HumanOperatorRequestPayload,
} from "./human-operator-alert-events.js";
import {
  buildHumanInputDecisionCardRequestKey,
  createMissionOwnerHumanInputDecisionCard,
  MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
} from "./mission-owner-human-input-card.js";
import {
  missionWorkflowContinuationRemains,
  type ValidationVerdictObservation,
  type WorkflowContinuationStepRow,
} from "./terminal-mission-workflow-continuation.js";
export { summarizeWorkflowRetryExhaustion } from "./terminal-mission-retry-summary.js";

export const TERMINAL_FAILURE_RUN_STATUSES = new Set(["failed", "timed_out"]);
const TERMINAL_MISSION_STATUSES = new Set(["completed", "cancelled", "canceled"]);
const TERMINAL_REPORT_EVENT_TYPE = "terminal_mission_human_operator_report";
const TERMINAL_REPORT_LAYER = "workflow_validation";
const TERMINAL_REPORT_DECISION = "escalate";
const TERMINAL_HUMAN_INPUT_CARD_FAILURE_ACTION = "mission.owner.human_input_card_failed";
const TITLE_MAX = 120;
const TOKEN_MAX = 80;
const EVIDENCE_MAX = 240;
const FAILED_RUN_AGGREGATE_MAX = 8;

// 시스템 에스컬레이션 next-action 문구 — comment 텍스트와 사람 결정 카드/ payload 가 같은 원본을
// 공유한다(텍스트 변경 금지: 기존 발신 문구 그대로).
const TERMINAL_NEXT_ACTION_EN = "Human operator must choose a recovery path (retry with revised input, replan, reassign, or cancel). Automatic continuation is exhausted.";
const TERMINAL_NEXT_ACTION_KO = "운영자가 입력 수정 후 재시도, 계획 변경, 담당자 변경, 취소 중 복구 방법을 선택해 주세요. 자동 재개 경로는 소진됐습니다.";

export type TerminalMissionOwnerActionIssue = {
  id: string;
  companyId: string;
  missionId: string | null;
  originKind: string | null;
  originId: string | null;
  title: string | null;
  identifier: string | null;
};

export type TerminalMissionContinuationSignals = {
  missionStatus: string;
  missionHasActiveHeartbeat: boolean;
  missionIssueIds: string[];
  liveWakeupIssueIds: Set<string>;
  openOwnerActionRecoveryExists: boolean;
  workflowStepRows: readonly WorkflowContinuationStepRow[];
  validationVerdictsByIssueId: Map<string, ValidationVerdictObservation> | undefined;
};

export type TerminalContinuationVerdict =
  | { terminal: true }
  | { terminal: false; suppressReason: string };

// design 8.1 의 모든 continuation guard 평가. 하나라도 남거나 불확실하면 terminal 아니다(fail-closed).
export function classifyTerminalMissionContinuation(
  signals: TerminalMissionContinuationSignals,
): TerminalContinuationVerdict {
  if (TERMINAL_MISSION_STATUSES.has(signals.missionStatus)) {
    return { terminal: false, suppressReason: "mission-already-terminal" };
  }
  if (signals.missionHasActiveHeartbeat) {
    return { terminal: false, suppressReason: "active-heartbeat-or-process-loss-or-fallback" };
  }
  if (signals.missionIssueIds.some((id) => signals.liveWakeupIssueIds.has(id))) {
    return { terminal: false, suppressReason: "live-wakeup-or-accepted-source-resume" };
  }
  if (signals.openOwnerActionRecoveryExists) {
    return { terminal: false, suppressReason: "open-owner-action-recovery" };
  }
  const workflow = missionWorkflowContinuationRemains(signals.workflowStepRows, {
    validationVerdictsByIssueId: signals.validationVerdictsByIssueId,
  });
  if (workflow.remains) {
    return { terminal: false, suppressReason: `workflow-continuation:${workflow.reason}` };
  }
  return { terminal: true };
}

// [finding 7] 한 줄 bounded token. control char / JSON-fragment / raw stderr·error body 제거.
function sanitizeToken(value: unknown, max: number): string {
  const cleaned = String(value ?? "")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/[{}\[\]"\\`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, max);
}

export type TerminalMissionFailedRun = {
  id: string;
  status: string;
  errorCode: string | null;
};

export type TerminalMissionHumanOperatorCommentInput = {
  language?: SystemLanguage; issueId: string;
  issueIdentifier: string | null;
  missionTitle: string | null;
  sourceIssueIdentifier: string | null;
  failedRuns: readonly TerminalMissionFailedRun[];
  /** Bounded retry-exhaustion summary (attempts, maxRetries) surfaced in the
   *  report evidence when the terminal failure followed configured retries.
   *  Raw error payloads are never included — only counts. */
  retryAttempts?: number | null;
  retryMaxRetries?: number | null;
  /** [provider 403 ladder] 소진된 scheduled 재시도 요약(구조화). 표시 텍스트는 이 값에서만 파생. */
  provider403Ladder?: { attempts: number; delaysMin: number[] } | null;
};


// [shared evidence] comment 와 사람 결정 카드/ payload 가 같은 bounded evidence 원본을 쓴다.
export function buildTerminalMissionEvidenceToken(input: TerminalMissionHumanOperatorCommentInput): string {
  const missionToken = sanitizeToken(input.missionTitle, TITLE_MAX) || "(untitled)";
  const ownerActionToken = sanitizeToken(input.issueIdentifier, TOKEN_MAX) || input.issueId;
  const sourceToken = sanitizeToken(input.sourceIssueIdentifier, TOKEN_MAX) || "(unknown)";
  const aggregated = input.failedRuns.slice(0, FAILED_RUN_AGGREGATE_MAX).map((run) => {
    const code = run.errorCode ? sanitizeToken(run.errorCode, TOKEN_MAX) : "";
    return `${sanitizeToken(run.status, TOKEN_MAX) || "failed"}${code ? `:${code}` : ""}`;
  });
  const failedRunsToken = aggregated.length > 0 ? aggregated.join("|") : "failed";
  const evidenceParts = [
    `mission=${missionToken}`,
    `owner-action=${ownerActionToken}`,
    `source=${sourceToken}`,
    `failed-runs=${failedRunsToken}`,
    `failed-run-count=${Math.min(input.failedRuns.length, 9999)}`,
  ];
  if (input.retryAttempts != null && input.retryAttempts > 0) {
    const max = input.retryMaxRetries ?? 0;
    evidenceParts.push(`retry-exhausted=${input.retryAttempts}/${max}`);
  }
  if (input.provider403Ladder && input.provider403Ladder.attempts > 0) {
    evidenceParts.push(`provider403-retries=${input.provider403Ladder.attempts}/${input.provider403Ladder.delaysMin.join("/")}`);
  }
  evidenceParts.push("continuation=none");
  return sanitizeToken(evidenceParts.join("; "), EVIDENCE_MAX);
}

// system-authored structured owner-decision comment. owner 귀속 ❌, raw 출력 ❌.
export function buildTerminalMissionHumanOperatorComment(
  input: TerminalMissionHumanOperatorCommentInput,
): string {
  const sourceToken = sanitizeToken(input.sourceIssueIdentifier, TOKEN_MAX) || "(unknown)";
  const evidence = buildTerminalMissionEvidenceToken(input);

  return [
    "### Mission owner decision",
    `Decision: ${TERMINAL_REPORT_DECISION}`,
    `Source issue: ${sourceToken}`,
    input.language === "ko" ? "Reason: 자동으로 계속할 수 없습니다. 작업 흐름 또는 복구 업무가 실패로 종결됐고, 실행 중인 작업이나 재개 요청, 실행 가능한 다음 단계가 남아 있지 않습니다." : "Reason: Mission cannot continue automatically. The workflow or its owner-action recovery reached a terminal failure and no heartbeat, wakeup, tool recovery, source resume, or runnable workflow step remains.",
    input.language === "ko" ? `Next action: ${TERMINAL_NEXT_ACTION_KO}` : `Next action: ${TERMINAL_NEXT_ACTION_EN}`,
    `Evidence: ${evidence}`,
  ].join("\n");
}

// snapshot idempotency key. (company,mission,workflowRun,sorted-failed-run-fingerprint) scope.
//   같은 snapshot = 같은 key(idempotent); later distinct generation(새 failed run) = 새 key → 재보고.
//   workflowRunId 가 null 이면 명시적 mission-level scope(다른 run ID 차용 ❌).
export function buildTerminalMissionSnapshotKey(input: {
  companyId: string;
  missionId: string;
  workflowRunId: string | null;
  failedRuns: readonly TerminalMissionFailedRun[];
}): string {
  const scope = input.workflowRunId ? `run:${input.workflowRunId}` : `mission:${input.missionId}`;
  const fingerprints = input.failedRuns
    .map((run) => `${run.id}:${run.status}:${sanitizeToken(run.errorCode, TOKEN_MAX) || ""}`)
    .sort();
  const fpHash = createHash("sha256").update(fingerprints.join("|") || "none").digest("hex").slice(0, 16);
  return `terminal-mission-report:${input.companyId}:${input.missionId}:${scope}:${fpHash}`;
}

export type EmitTerminalMissionHumanOperatorInput = {
  issue: TerminalMissionOwnerActionIssue;
  expectedCompanyId: string;
  expectedMissionId: string;
  missionTitle: string | null;
  sourceIssueIdentifier: string | null;
  workflowRunId: string | null;
  failedRuns: readonly TerminalMissionFailedRun[];
  retryAttempts?: number | null;
  retryMaxRetries?: number | null;
  provider403Ladder?: { attempts: number; delaysMin: number[] } | null;
};

export type EmitTerminalMissionHumanOperatorResult = {
  emitted: boolean;
  reason: string;
  /** 결정 이벤트(신규 claim 또는 이미 보고된 스냅샷의 기존 이벤트) — 카드 보증용. */
  decisionEventId?: string;
  /** 카드 보증 결과 — 표시·진단용(실패는 activity 에 기록되므로 결과를 바꾸지 않는다). */
  card?: { ensured: boolean; reason: string };
};

// 시스템 발신 에스컬레이션에 매핍할 카드 맥락 — tx 안에서 수집한 실제 값만 담는다.
type TerminalHumanInputCardContext = {
  companyId: string;
  missionId: string;
  decisionEventId: string;
  issue: { id: string; status: string; title: string | null; identifier: string | null; originId: string | null };
  ownerAgentId: string | null;
  reason: string;
  nextAction: string;
  evidence: string;
  workflowRunId: string | null;
};

// [fail-loud] 시스템 경로는 제출 응답이 없으므로 카드 매핑/생성 실패를 activity+로그 로 남긴다.
async function recordTerminalHumanInputCardFailure(
  db: Db,
  context: Pick<TerminalHumanInputCardContext, "companyId" | "issue" | "decisionEventId">,
  failure: { stage: "mapping" | "create"; error: string },
): Promise<void> {
  try {
    await db.insert(activityLog).values({
      companyId: context.companyId,
      actorType: "system",
      actorId: "system",
      action: TERMINAL_HUMAN_INPUT_CARD_FAILURE_ACTION,
      entityType: "issue",
      entityId: context.issue.id,
      details: {
        schemaVersion: 1,
        decisionEventId: context.decisionEventId,
        requestKey: buildHumanInputDecisionCardRequestKey(context.decisionEventId),
        sourceType: MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
        stage: failure.stage,
        error: failure.error.slice(0, 1_000),
      },
    });
  } catch (error) {
    logger.warn({ err: error, decisionEventId: context.decisionEventId }, "failed to record terminal-mission human input card failure");
  }
  logger.warn({ decisionEventId: context.decisionEventId, stage: failure.stage, error: failure.error }, "terminal-mission human input decision card not created");
}

// [시스템 경로 카드 보증] 결정 이벤트 1건 = 카드 1건(moi1:{decisionEventId} 멱등). 기존 카드가
//   있으면 재사용하고, 없으면 기존 카드 빌더(mission-owner-human-input-card)로 생성한다.
//   실패는 throw 하지 않고 activity 에 기록한다 — 발신(이슈·인박스·알림)은 이미 커밋된 상태다.
export async function ensureTerminalHumanInputDecisionCard(
  db: Db,
  context: TerminalHumanInputCardContext,
): Promise<{ ensured: boolean; reason: string }> {
  // [#390 스윕 정책 정합] 앵커 이슈가 이미 종결됐으면 moi 카드는 스윕 대상(죽은 카드) — 만들지 않고
  //   에러도 아니다(정책에 따른 스킵).
  if (context.issue.status === "done" || context.issue.status === "cancelled") {
    return { ensured: false, reason: "anchor-issue-terminal" };
  }
  if (!context.ownerAgentId) {
    await recordTerminalHumanInputCardFailure(db, context, { stage: "mapping", error: "mission owner agent is missing — card cannot be addressed" });
    return { ensured: false, reason: "owner-agent-missing" };
  }
  const requestKey = buildHumanInputDecisionCardRequestKey(context.decisionEventId);
  const existing = await db.select({ id: operatorDecisions.id }).from(operatorDecisions)
    .where(and(eq(operatorDecisions.companyId, context.companyId), eq(operatorDecisions.requestKey, requestKey)))
    .limit(1);
  if (existing.length > 0) return { ensured: true, reason: "card-exists" };
  try {
    await createMissionOwnerHumanInputDecisionCard(db, {
      companyId: context.companyId,
      missionId: context.missionId,
      decisionEventId: context.decisionEventId,
      decision: "escalate",
      ownerActionIssueId: context.issue.id,
      ownerActionIssueStatus: context.issue.status,
      requestedByAgentId: context.ownerAgentId,
      reason: context.reason,
      nextAction: context.nextAction,
      evidence: context.evidence,
      issueTitle: context.issue.title,
      issueIdentifier: context.issue.identifier,
      sourceIssueId: context.issue.originId,
      workflowRunId: context.workflowRunId,
      actorType: "system",
    });
    return { ensured: true, reason: "card-created" };
  } catch (error) {
    await recordTerminalHumanInputCardFailure(db, context, {
      stage: "create",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return { ensured: false, reason: "card-create-failed" };
  }
}

// 단일 tx atomic claim(workflowTransitionEvents unique index) + scope 검증 + system comment + activity.
//   concurrency-safe(claim conflict 로 한 명만 승), retry-safe(rollback → claim 도 제거).
export async function emitTerminalMissionHumanOperatorReport(
  db: Db,
  input: EmitTerminalMissionHumanOperatorInput,
): Promise<EmitTerminalMissionHumanOperatorResult> {
  if (input.issue.originKind !== "mission_main_executor_unblock") {
    return { emitted: false, reason: "issue is not a mission_main_executor_unblock owner-action" };
  }
  if (!input.issue.missionId) {
    return { emitted: false, reason: "owner-action issue has no mission scope" };
  }
  const terminalFailedRuns = input.failedRuns.filter((run) => TERMINAL_FAILURE_RUN_STATUSES.has(run.status));
  if (terminalFailedRuns.length === 0) {
    return { emitted: false, reason: "no terminal failed/timed_out run in snapshot" };
  }

  const snapshotKey = buildTerminalMissionSnapshotKey({
    companyId: input.expectedCompanyId,
    missionId: input.expectedMissionId,
    workflowRunId: input.workflowRunId,
    failedRuns: terminalFailedRuns,
  });
  const body = buildTerminalMissionHumanOperatorComment({
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    missionTitle: input.missionTitle,
    sourceIssueIdentifier: input.sourceIssueIdentifier,
    failedRuns: terminalFailedRuns,
    retryAttempts: input.retryAttempts,
    retryMaxRetries: input.retryMaxRetries,
    provider403Ladder: input.provider403Ladder ?? null,
  });
  const sanitizedFailedRunsPayload = terminalFailedRuns
    .slice(0, FAILED_RUN_AGGREGATE_MAX)
    .map((run) => ({ id: run.id, status: run.status, errorCode: sanitizeToken(run.errorCode, TOKEN_MAX) || null }));

  const txResult = await db.transaction(async (tx) => {
    // [finding 6] scope enforcement: issue 행을 잠그고 companyId/missionId/originKind 검증. mismatch → fail-closed.
    const locked = await tx
      .select({ id: issues.id, companyId: issues.companyId, missionId: issues.missionId, originKind: issues.originKind, status: issues.status, language: sql<string>`(select ${companies.defaultLanguage} from ${companies} where ${companies.id} = ${issues.companyId})` })
      .from(issues)
      .where(eq(issues.id, input.issue.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (
      !locked
      || locked.companyId !== input.expectedCompanyId
      || locked.missionId !== input.expectedMissionId
      || locked.originKind !== "mission_main_executor_unblock"
    ) {
      throw new Error("terminal-mission-human-operator-scope-mismatch");
    }

    // [카드 맥락 수집] 같은 tx 에서 실제 값만 — 미션 오너(requestedByAgentId), 이슈 상태(D5 앵커),
    //   실제 workflowRuns 행이 확인된 run id(엉큻은 값은 스냅샷에 넣지 않는다, D5).
    const [missionRow] = await tx.select({ ownerAgentId: missions.ownerAgentId }).from(missions)
      .where(and(eq(missions.id, input.expectedMissionId), eq(missions.companyId, input.expectedCompanyId)))
      .limit(1);
    let verifiedRunId: string | null = null;
    if (input.workflowRunId) {
      const [runRow] = await tx.select({ id: workflowRuns.id }).from(workflowRuns)
        .where(and(eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.expectedCompanyId)))
        .limit(1);
      verifiedRunId = runRow?.id ?? null;
    }
    const nextActionText = locked.language === "ko" ? TERMINAL_NEXT_ACTION_KO : TERMINAL_NEXT_ACTION_EN;
    const evidenceText = buildTerminalMissionEvidenceToken({
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      missionTitle: input.missionTitle,
      sourceIssueIdentifier: input.sourceIssueIdentifier,
      failedRuns: terminalFailedRuns,
      retryAttempts: input.retryAttempts,
      retryMaxRetries: input.retryMaxRetries,
      provider403Ladder: input.provider403Ladder ?? null,
      language: locked.language === "ko" ? "ko" : "en",
    });
    const cardBase = {
      companyId: input.expectedCompanyId,
      missionId: input.expectedMissionId,
      issue: {
        id: input.issue.id,
        status: locked.status,
        title: input.issue.title ?? null,
        identifier: input.issue.identifier ?? null,
        originId: input.issue.originId ?? null,
      },
      ownerAgentId: missionRow?.ownerAgentId ?? null,
      reason: body.slice(0, 2000),
      nextAction: nextActionText,
      evidence: evidenceText,
      workflowRunId: verifiedRunId,
    };

    // atomic claim: 동시/재시도 중 정확히 한 번만 통과(design section 9 unique-index 패턴).
    const claimed = await tx
      .insert(workflowTransitionEvents)
      .values({
        companyId: input.expectedCompanyId,
        missionId: input.expectedMissionId,
        workflowRunId: input.workflowRunId,
        issueId: input.issue.id,
        eventType: TERMINAL_REPORT_EVENT_TYPE,
        layer: TERMINAL_REPORT_LAYER,
        fromStatus: "failed",
        toStatus: "blocked",
        decision: TERMINAL_REPORT_DECISION,
        reason: "terminal_mission_no_continuation",
        reasonCode: TERMINAL_REPORT_EVENT_TYPE,
        correlationId: input.issue.id,
        idempotencyKey: snapshotKey,
        payload: {
          ownerActionIssueId: input.issue.id,
          workflowRunId: input.workflowRunId,
          failedRuns: sanitizedFailedRunsPayload,
          ...(input.provider403Ladder ? { provider403Ladder: input.provider403Ladder } : {}),
          status: "reported",
        },
      })
      .onConflictDoNothing()
      .returning({ id: workflowTransitionEvents.id });
    if (claimed.length === 0) {
      // [자가치유] 이미 보고된 스냅샷 — 기존 결정 이벤트 id 를 돌려줘 카드가 없으면 같은 requestKey
      //   로 재생성하게 한다(카드 브리지 없던 배포에서 발신된 라이브 스냅샷 복구).
      const [existingClaim] = await tx.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
        .where(and(eq(workflowTransitionEvents.companyId, input.expectedCompanyId), eq(workflowTransitionEvents.idempotencyKey, snapshotKey)))
        .limit(1);
      return {
        emitted: false as const,
        reason: "snapshot-already-reported",
        ...(existingClaim ? { cardContext: { ...cardBase, decisionEventId: existingClaim.id } } : {}),
      };
    }

    // system-authored comment (owner 귀속 ❌). 같은 tx — rollback 시 함께 사라진다.
    const [comment] = await tx
      .insert(issueComments)
      .values({
        companyId: input.expectedCompanyId,
        issueId: input.issue.id,
        authorAgentId: null,
        authorUserId: null,
        body: locked.language === "ko" ? buildTerminalMissionHumanOperatorComment({ ...input, issueId: input.issue.id, issueIdentifier: input.issue.identifier, failedRuns: terminalFailedRuns, language: "ko" }) : body,
      })
      .returning();
    void comment;
    // [structured system authority] comment 를 parse 하지 않는다. claimed terminal transition event 의
    //   id 를 decisionEventId 로 사용해 bounded system payload(escalate, actorType=system)를 구성하고,
    //   공통 materialize-by-payload primitive 로 같은 tx 에서 dedupe+activity insert 한다. owner-decision
    //   builder 는 agent 전용이라 terminal system 경로는 직접 payload 를 구성한다(fail-closed 회피).
    const terminalPayload: HumanOperatorRequestPayload = {
      missionId: input.expectedMissionId,
      issueId: input.issue.id,
      ...(input.issue.originId ? { sourceIssueId: input.issue.originId } : {}),
      decisionEventId: claimed[0]!.id,
      decision: "escalate",
      ...(input.issue.title ? { issueTitle: input.issue.title } : {}),
      ...(input.issue.identifier ? { issueIdentifier: input.issue.identifier } : {}),
      reason: body.slice(0, 2000),
      // 시스템 발신 문구에서 파생한 실제 값 — 인박스 표시·카드 humanReview 원본으로 쓰인다.
      nextAction: nextActionText,
      evidence: evidenceText,
      actorType: "system",
      actorId: "system",
    };
    const materialized = await materializeHumanOperatorRequestPayload(tx as unknown as Db, terminalPayload, input.expectedCompanyId);

    return {
      emitted: true as const,
      reason: "terminal-mission human operator request recorded",
      payload: materialized.payload,
      cardContext: { ...cardBase, decisionEventId: claimed[0]!.id },
    };
  });

  if (txResult.emitted) {
    // live-event 는 commit 후 발행(tx rollback 시 spurious event 방지).
    publishHumanOperatorRequestEvent(input.expectedCompanyId, txResult.payload);
  }
  // [시스템 경로 카드] 발신(신규/기존 스냅샷)마다 카드를 보증한다. 카드 생성은 write.create 자체
  //   트랜잭션을 쓰므로 발신 tx 밖에서 호출하고, 실패는 activity+로그 로 기록한다(fail-loud).
  const decisionEventId = txResult.cardContext?.decisionEventId;
  const card = decisionEventId
    ? await ensureTerminalHumanInputDecisionCard(db, { ...txResult.cardContext!, decisionEventId })
    : undefined;
  return {
    emitted: txResult.emitted,
    reason: txResult.reason,
    ...(decisionEventId ? { decisionEventId } : {}),
    ...(card ? { card } : {}),
  };
}
