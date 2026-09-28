// server/src/services/heartbeat-retry-enqueue.ts
//
// [파일 목적] heartbeat.ts 에서 기계적 추출된 재디스패치 enqueue 함수군 — 동작 무변경.
//   - enqueueProcessLossRetry: 프로세스 상실(또는 일시 adapter 실패) 확정 런의 후계 재시도 런 등록.
//   - enqueueAdapterFallbackRun: 1차 adapter 재시도 소진 후 폴백 명령으로 후계 런 등록.
//   heartbeat.ts 의 클로저(db/resolveSessionBeforeForWakeup/appendRunEvent)는 deps 로 주입받고,
//   나머지 의존성(parseObject/publishLiveEvent/withTxTimeout/resolveNextDispatchGeneration 등)은 직접 import.
//
// [불변식]
//   - 후계 런은 withTxTimeout 트랜잭션 안에서 wakeup 요청 → 런 등록 → wakeup 갱신 →
//     (V1 게이트 시) 자식 권한 이관 → 이슈 실행락 재지정까지 원자적으로 등록된다(부분 등록 금지).
//   - dispatchGeneration 은 같은 트랜잭션에서 resolveNextDispatchGeneration 으로 스탬프한다(세대 계약).
//   - 이 함수들은 새 런을 등록만 한다 — 실행 촉발(startNextQueuedRunForAgent)은 호출자 책임.
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { withTxTimeout } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns, issues, workflowStepRuns } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { publishLiveEvent } from "./live-events.js";
import { resolveNextDispatchGeneration } from "./effect-envelope.js";
import { maybeTransferHeartbeatAuthorityToChild } from "./heartbeat-finalization/authority-transfer.js";
import {
  deriveTaskKey,
  normalizeAgentNameKey,
  readNonEmptyString,
  resolveAdapterFallbackAttempt,
} from "./heartbeat-run-context.js";

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

export type HeartbeatRetryEnqueueDeps = {
  readonly db: Db;
  readonly resolveSessionBeforeForWakeup: (
    agent: AgentRow,
    taskKey: string | null,
    opts?: { missionId?: string | null },
  ) => Promise<string | null>;
  readonly appendRunEvent: (
    run: HeartbeatRunRow,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
};

export async function enqueueProcessLossRetry(
  deps: HeartbeatRetryEnqueueDeps,
  run: HeartbeatRunRow,
  agent: AgentRow,
  now: Date,
  opts?: { kind?: "process_lost" | "adapter_failed_transient" },
) {
  const kind = opts?.kind ?? "process_lost";
  const retryWakeReason = kind === "adapter_failed_transient" ? "adapter_failed_retry" : "process_lost_retry";
  const retryReasonValue = kind === "adapter_failed_transient" ? "adapter_failed" : "process_lost";
  const contextSnapshot = parseObject(run.contextSnapshot);
  const issueId = run.issueId ?? readNonEmptyString(contextSnapshot.issueId);
  let retryMissionId = readNonEmptyString(contextSnapshot.missionId);
  let retryWorkflowRunId = readNonEmptyString(contextSnapshot.workflowRunId);
  let retryStepId = readNonEmptyString(contextSnapshot.workflowStepId) ?? readNonEmptyString(contextSnapshot.stepId);
  if (issueId && (!retryMissionId || !retryWorkflowRunId || !retryStepId)) {
    const issueContext = await deps.db
      .select({
        missionId: issues.missionId,
        workflowRunId: workflowStepRuns.workflowRunId,
        stepId: workflowStepRuns.stepId,
      })
      .from(issues)
      .leftJoin(workflowStepRuns, eq(workflowStepRuns.issueId, issues.id))
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
      .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    retryMissionId = retryMissionId ?? issueContext?.missionId ?? null;
    retryWorkflowRunId = retryWorkflowRunId ?? issueContext?.workflowRunId ?? null;
    retryStepId = retryStepId ?? issueContext?.stepId ?? null;
  }
  const taskKey = deriveTaskKey(contextSnapshot, null);
  const sessionBefore = await deps.resolveSessionBeforeForWakeup(agent, taskKey, {
    missionId: retryMissionId,
  });
  const retryContextSnapshot = {
    ...contextSnapshot,
    ...(issueId ? { issueId } : {}),
    ...(retryMissionId ? { missionId: retryMissionId } : {}),
    ...(retryWorkflowRunId ? { workflowRunId: retryWorkflowRunId } : {}),
    ...(retryStepId ? { workflowStepId: retryStepId, stepId: retryStepId } : {}),
    retryOfRunId: run.id,
    wakeReason: retryWakeReason,
    retryReason: retryReasonValue,
  };

  const queued = await withTxTimeout(deps.db, async (tx) => {
    const wakeupRequest = await tx
      .insert(agentWakeupRequests)
      .values({
        companyId: run.companyId,
        agentId: run.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: retryWakeReason,
        payload: {
          ...(issueId ? { issueId } : {}),
          retryOfRunId: run.id,
        },
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: null,
        requestKind: retryWakeReason,
        issueId: issueId ?? null,
        missionId: retryMissionId ?? null,
        workflowRunId: retryWorkflowRunId ?? null,
        // retryStepId 는 stepId(text) 이지 workflow_step_runs.id(UUID)가 아님 → null.
        workflowStepRunId: null,
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0]);

      const retryRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          issueId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: {
          ...retryContextSnapshot,
          dispatchGeneration: await resolveNextDispatchGeneration(tx as unknown as Db, {
            agentId: run.agentId,
            issueId,
            taskKey,
          }),
        },
        sessionIdBefore: sessionBefore,
        retryOfRunId: run.id,
        processLossRetryCount: (run.processLossRetryCount ?? 0) + 1,
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0]);

    await tx
      .update(agentWakeupRequests)
      .set({
        runId: retryRun.id,
        updatedAt: now,
      })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));
    await maybeTransferHeartbeatAuthorityToChild(tx, {
      parent: run,
      childRunId: retryRun.id,
      childWakeupRequestId: wakeupRequest.id,
      now,
      reason: retryWakeReason,
    });

    if (issueId) {
      await tx
        .update(issues)
        .set({
          executionRunId: retryRun.id,
          executionAgentNameKey: normalizeAgentNameKey(agent.name),
          executionLockedAt: now,
          updatedAt: now,
        })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
    }

    return retryRun;
  });

  publishLiveEvent({
    companyId: queued.companyId,
    type: "heartbeat.run.queued",
    payload: {
      runId: queued.id,
      agentId: queued.agentId,
      invocationSource: queued.invocationSource,
      triggerDetail: queued.triggerDetail,
      wakeupRequestId: queued.wakeupRequestId,
    },
  });

  await deps.appendRunEvent(queued, 1, {
    eventType: "lifecycle",
    stream: "system",
    level: "warn",
    message: kind === "adapter_failed_transient"
      ? "Queued automatic retry after transient adapter failure"
      : "Queued automatic retry after orphaned child process was confirmed dead",
    payload: {
      retryOfRunId: run.id,
    },
  });

  return queued;
}

export async function enqueueAdapterFallbackRun(
  deps: HeartbeatRetryEnqueueDeps,
  run: HeartbeatRunRow,
  agent: AgentRow,
  now: Date,
  input: {
    fallbackCommand: string;
    fallbackProvider?: string;
    fallbackModel?: string;
    fallbackThinking?: string;
    fallbackReason: string;
  },
) {
  const contextSnapshot = parseObject(run.contextSnapshot);
  const issueId = run.issueId ?? readNonEmptyString(contextSnapshot.issueId);
  let fallbackMissionId = readNonEmptyString(contextSnapshot.missionId);
  let fallbackWorkflowRunId = readNonEmptyString(contextSnapshot.workflowRunId);
  let fallbackStepId = readNonEmptyString(contextSnapshot.workflowStepId) ?? readNonEmptyString(contextSnapshot.stepId);
  if (issueId && (!fallbackMissionId || !fallbackWorkflowRunId || !fallbackStepId)) {
    const issueContext = await deps.db
      .select({
        missionId: issues.missionId,
        workflowRunId: workflowStepRuns.workflowRunId,
        stepId: workflowStepRuns.stepId,
      })
      .from(issues)
      .leftJoin(workflowStepRuns, eq(workflowStepRuns.issueId, issues.id))
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
      .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    fallbackMissionId = fallbackMissionId ?? issueContext?.missionId ?? null;
    fallbackWorkflowRunId = fallbackWorkflowRunId ?? issueContext?.workflowRunId ?? null;
    fallbackStepId = fallbackStepId ?? issueContext?.stepId ?? null;
  }

  const fallbackAttempt = resolveAdapterFallbackAttempt(contextSnapshot) + 1;
  const fallbackContextSnapshot = {
    ...contextSnapshot,
    ...(issueId ? { issueId } : {}),
    ...(fallbackMissionId ? { missionId: fallbackMissionId } : {}),
    ...(fallbackWorkflowRunId ? { workflowRunId: fallbackWorkflowRunId } : {}),
    ...(fallbackStepId ? { workflowStepId: fallbackStepId, stepId: fallbackStepId } : {}),
    retryOfRunId: run.id,
    fallbackOfRunId: run.id,
    fallbackReason: input.fallbackReason,
    fallbackAttempt,
    fallbackCommand: input.fallbackCommand,
    ...(input.fallbackProvider ? { fallbackProvider: input.fallbackProvider } : {}),
    ...(input.fallbackModel ? { fallbackModel: input.fallbackModel } : {}),
    ...(input.fallbackThinking ? { fallbackThinking: input.fallbackThinking } : {}),
    wakeReason: "adapter_fallback",
  };
  const taskKey = deriveTaskKey(fallbackContextSnapshot, null);
  const sessionBefore = await deps.resolveSessionBeforeForWakeup(agent, taskKey, {
    missionId: fallbackMissionId,
  });

  const queued = await withTxTimeout(deps.db, async (tx) => {
    const wakeupRequest = await tx
      .insert(agentWakeupRequests)
      .values({
        companyId: run.companyId,
        agentId: run.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "adapter_fallback",
        payload: {
          ...(issueId ? { issueId } : {}),
          fallbackOfRunId: run.id,
          fallbackReason: input.fallbackReason,
        },
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: null,
        requestKind: "adapter_fallback",
        issueId: issueId ?? null,
        missionId: fallbackMissionId ?? null,
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0]);

    const fallbackRun = await tx
      .insert(heartbeatRuns)
      .values({
        companyId: run.companyId,
        agentId: run.agentId,
        issueId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: {
          ...fallbackContextSnapshot,
          dispatchGeneration: await resolveNextDispatchGeneration(tx as unknown as Db, {
            agentId: run.agentId,
            issueId,
            taskKey,
          }),
        },
        sessionIdBefore: sessionBefore,
        retryOfRunId: run.id,
        processLossRetryCount: run.processLossRetryCount ?? 0,
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0]);

    await tx
      .update(agentWakeupRequests)
      .set({
        runId: fallbackRun.id,
        updatedAt: now,
      })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));
    await maybeTransferHeartbeatAuthorityToChild(tx, {
      parent: run,
      childRunId: fallbackRun.id,
      childWakeupRequestId: wakeupRequest.id,
      now,
      reason: "adapter_fallback",
    });

    if (issueId) {
      await tx
        .update(issues)
        .set({
          executionRunId: fallbackRun.id,
          executionAgentNameKey: normalizeAgentNameKey(agent.name),
          executionLockedAt: now,
          updatedAt: now,
        })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
    }

    return fallbackRun;
  });

  publishLiveEvent({
    companyId: queued.companyId,
    type: "heartbeat.run.queued",
    payload: {
      runId: queued.id,
      agentId: queued.agentId,
      invocationSource: queued.invocationSource,
      triggerDetail: queued.triggerDetail,
      wakeupRequestId: queued.wakeupRequestId,
    },
  });

  await deps.appendRunEvent(queued, 1, {
    eventType: "lifecycle",
    stream: "system",
    level: "warn",
    message: "Queued adapter fallback after primary adapter retry was exhausted",
    payload: {
      fallbackOfRunId: run.id,
      fallbackReason: input.fallbackReason,
      fallbackAttempt,
    },
  });

  return queued;
}
