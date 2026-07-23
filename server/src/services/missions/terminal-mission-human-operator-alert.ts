// server/src/services/missions/terminal-mission-human-operator-alert.ts
// [파일 목적] mission 이 "정말 종단(truly terminal)" — 실행 가능한 continuation 이 하나도 남지 않아
//   유일한 전진 경로가 Human Operator 판단뿐일 때 — terminal evidence snapshot 마다 정확히 한 번의
//   Human Operator 요청을 발행한다. 기존 recordHumanOperatorRequestEvent channel(materialize + publish
//   primitive)을 그대로 재사용하고 병렬 channel/중복 구현을 만들지 않는다.
//
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
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues, workflowTransitionEvents } from "@paperclipai/db";
import {
  materializeHumanOperatorRequestPayload,
  publishHumanOperatorRequestEvent,
  type HumanOperatorRequestPayload,
} from "./human-operator-alert-events.js";
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
const TITLE_MAX = 120;
const TOKEN_MAX = 80;
const EVIDENCE_MAX = 240;
const FAILED_RUN_AGGREGATE_MAX = 8;

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
  issueId: string;
  issueIdentifier: string | null;
  missionTitle: string | null;
  sourceIssueIdentifier: string | null;
  failedRuns: readonly TerminalMissionFailedRun[];
  /** Bounded retry-exhaustion summary (attempts, maxRetries) surfaced in the
   *  report evidence when the terminal failure followed configured retries.
   *  Raw error payloads are never included — only counts. */
  retryAttempts?: number | null;
  retryMaxRetries?: number | null;
};


// system-authored structured owner-decision comment. owner 귀속 ❌, raw 출력 ❌.
export function buildTerminalMissionHumanOperatorComment(
  input: TerminalMissionHumanOperatorCommentInput,
): string {
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
  evidenceParts.push("continuation=none");
  const evidence = sanitizeToken(evidenceParts.join("; "), EVIDENCE_MAX);

  return [
    "### Mission owner decision",
    `Decision: ${TERMINAL_REPORT_DECISION}`,
    `Source issue: ${sourceToken}`,
    "Reason: Mission cannot continue automatically. The workflow or its owner-action recovery reached a terminal failure and no heartbeat, wakeup, tool recovery, source resume, or runnable workflow step remains.",
    "Next action: Human operator must choose a recovery path (retry with revised input, replan, reassign, or cancel). Automatic continuation is exhausted.",
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
};

export type EmitTerminalMissionHumanOperatorResult = { emitted: boolean; reason: string };

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
  });
  const sanitizedFailedRunsPayload = terminalFailedRuns
    .slice(0, FAILED_RUN_AGGREGATE_MAX)
    .map((run) => ({ id: run.id, status: run.status, errorCode: sanitizeToken(run.errorCode, TOKEN_MAX) || null }));

  const txResult = await db.transaction(async (tx) => {
    // [finding 6] scope enforcement: issue 행을 잠그고 companyId/missionId/originKind 검증. mismatch → fail-closed.
    const locked = await tx
      .select({ id: issues.id, companyId: issues.companyId, missionId: issues.missionId, originKind: issues.originKind })
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
          status: "reported",
        },
      })
      .onConflictDoNothing()
      .returning({ id: workflowTransitionEvents.id });
    if (claimed.length === 0) {
      return { emitted: false as const, reason: "snapshot-already-reported" };
    }

    // system-authored comment (owner 귀속 ❌). 같은 tx — rollback 시 함께 사라진다.
    const [comment] = await tx
      .insert(issueComments)
      .values({
        companyId: input.expectedCompanyId,
        issueId: input.issue.id,
        authorAgentId: null,
        authorUserId: null,
        body,
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
      actorType: "system",
      actorId: "system",
    };
    const materialized = await materializeHumanOperatorRequestPayload(tx as unknown as Db, terminalPayload, input.expectedCompanyId);

    return { emitted: true as const, reason: "terminal-mission human operator request recorded", payload: materialized.payload };
  });

  if (txResult.emitted) {
    // live-event 는 commit 후 발행(tx rollback 시 spurious event 방지).
    publishHumanOperatorRequestEvent(input.expectedCompanyId, txResult.payload);
  }
  return txResult;
}
