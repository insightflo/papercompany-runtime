// server/src/services/workflow/run-terminal-recovery-gate.ts
//
// [run-terminal-boundary v1] failed 종결 전 좁은 회복 채널 게이트.
// 세 채널(unblock owner-action · 유효한 재시도 예약 · 활성 heartbeat) 중 하나라도 열려
// 있으면 open(fail-closed). 평가 오류는 unknown 으로 유예한다. stale unblock 은 채널이
// 아니라 종결 시 철회 대상이다.

import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import {
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { RECOVERY_UNBLOCK_ORIGIN_KIND } from "../missions/recovery-ownership-guard.js";
import {
  ACTIVE_HEARTBEAT_STATUSES,
  TERMINAL_ISSUE_STATUSES,
  type TerminalBoundaryDb,
  type TerminalStepRunRef,
} from "./run-terminal-boundary-cause.js";
import { readWorkflowRetryMetadata } from "./retry-metadata.js";

export interface RecoveryChannelEvidence {
  channel: "unblock_owner_action" | "retry_reservation" | "active_heartbeat";
  targetId: string;
  detail: Record<string, unknown>;
}

export type RecoveryGateResult =
  | { kind: "clear"; staleUnblockIssueIds: string[] }
  | { kind: "open"; evidence: RecoveryChannelEvidence[] }
  | { kind: "unknown"; error: string };

export interface RecoveryGateInput {
  runId: string;
  companyId: string;
  missionId: string | null;
  stepRuns: readonly TerminalStepRunRef[];
  /** 이 결정을 만든 실패 실행(알면 게이트/캡처에서 자기 자신을 제외). */
  triggerHeartbeatRunId?: string | null;
  now: Date;
}

/** 관측만으로 버려질 수 있는 재시도 예약의 최대 연령 — 이보다 오래된 waiting 은 방기된 것으로 본다. */
const RETRY_RESERVATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function uniqueIssueIds(stepRuns: readonly TerminalStepRunRef[]): string[] {
  return Array.from(new Set(
    stepRuns.map((stepRun) => stepRun.issueId).filter((issueId): issueId is string => issueId !== null && issueId.length > 0),
  ));
}

export async function evaluateRecoveryChannels(
  db: TerminalBoundaryDb,
  input: RecoveryGateInput,
): Promise<RecoveryGateResult> {
  try {
    const stepIssueIds = uniqueIssueIds(input.stepRuns);
    if (stepIssueIds.length === 0) return { kind: "clear", staleUnblockIssueIds: [] };

    const evidence: RecoveryChannelEvidence[] = [];
    const staleUnblockIssueIds: string[] = [];

    // (a) unblock owner-action — 원 source 이슈가 아직 비종결일 때만 열린 채널이다.
    const openUnblocks = await db
      .select({ id: issues.id, originId: issues.originId, status: issues.status })
      .from(issues)
      .where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.originKind, RECOVERY_UNBLOCK_ORIGIN_KIND),
        inArray(issues.originId, stepIssueIds),
        isNull(issues.hiddenAt),
        notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES]),
      ));
    const sourceIds = Array.from(new Set(
      openUnblocks.map((unblock) => unblock.originId).filter((v): v is string => v !== null),
    ));
    const sourceStatuses = new Map<string, string>();
    if (sourceIds.length > 0) {
      const sources = await db
        .select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, sourceIds)));
      for (const source of sources) sourceStatuses.set(source.id, source.status);
    }
    for (const unblock of openUnblocks) {
      if (!unblock.originId) continue;
      const sourceStatus = sourceStatuses.get(unblock.originId);
      if (sourceStatus !== undefined && (TERMINAL_ISSUE_STATUSES as readonly string[]).includes(sourceStatus)) {
        staleUnblockIssueIds.push(unblock.id);
        continue;
      }
      evidence.push({
        channel: "unblock_owner_action",
        targetId: unblock.id,
        detail: { sourceIssueId: unblock.originId, status: unblock.status },
      });
    }

    // (b) 유효한 재시도 예약 — readWorkflowRetryMetadata 가 모양을 검증하며 소진
    //   (retryNumber > maxRetries) 예약은 파싱 자체가 null 이 된다.
    const retryCutoffMs = input.now.getTime() - RETRY_RESERVATION_MAX_AGE_MS;
    for (const stepRun of input.stepRuns) {
      const metadata = (stepRun.metadata ?? null) as Record<string, unknown> | null;
      const retry = readWorkflowRetryMetadata(metadata?.workflowRetry);
      if (!retry) continue;
      if (retry.state === "waiting" && new Date(retry.nextEligibleAt).getTime() < retryCutoffMs) continue;
      evidence.push({
        channel: "retry_reservation",
        targetId: stepRun.id,
        detail: {
          retryNumber: retry.retryNumber,
          maxRetries: retry.maxRetries,
          state: retry.state,
          nextEligibleAt: retry.nextEligibleAt,
        },
      });
    }

    // (c) 활성 heartbeat — 정산된 outcome 이 있으면 절대 열린 채널이 아니다.
    const heartbeatFilters = [
      eq(heartbeatRuns.companyId, input.companyId),
      inArray(heartbeatRuns.issueId, stepIssueIds),
      inArray(heartbeatRuns.status, [...ACTIVE_HEARTBEAT_STATUSES]),
      isNull(heartbeatRuns.terminalOutcome),
    ];
    if (input.triggerHeartbeatRunId) {
      heartbeatFilters.push(notInArray(heartbeatRuns.id, [input.triggerHeartbeatRunId]));
    }
    const activeHeartbeats = await db
      .select({ id: heartbeatRuns.id, issueId: heartbeatRuns.issueId, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(...heartbeatFilters));
    for (const heartbeat of activeHeartbeats) {
      evidence.push({
        channel: "active_heartbeat",
        targetId: heartbeat.id,
        detail: { issueId: heartbeat.issueId, status: heartbeat.status },
      });
    }

    if (evidence.length > 0) return { kind: "open", evidence };
    return { kind: "clear", staleUnblockIssueIds };
  } catch (error) {
    return { kind: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
}
