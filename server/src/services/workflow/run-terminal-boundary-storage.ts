// [run-terminal-boundary v1] 종결 저장용 내부 helper.
// 호출자가 전달한 트랜잭션으로 정지 대상을 캡처하고 효과 인텐트 값을 조립한다.

import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  missionAgentRuntimes,
  workflowRuns,
  workflowTerminalEffectIntents,
  type WorkflowTerminalStopTargets,
} from "@paperclipai/db";
import { ACTIVE_MISSION_RUNTIME_STATUSES } from "../missions/mission-runtime-manager.js";
import type { FinalizeRunTerminalInput } from "./run-terminal-boundary-cause.js";

/** 캡처된 정지 대상 → 효과 인텐트 행 값(공통 조립 — 본 경로/자가치유 경로 동일 계약). */
export function buildEffectIntentValues(
  base: { companyId: string; terminalDecisionId: string; payload: Record<string, unknown> },
  targets: WorkflowTerminalStopTargets,
): Array<typeof workflowTerminalEffectIntents.$inferInsert> {
  const values: Array<typeof workflowTerminalEffectIntents.$inferInsert> = [];
  for (const runtimeId of targets.runtimeIds) {
    values.push({ ...base, effectKind: "kill_runtime", targetId: runtimeId });
  }
  for (const heartbeatRunId of targets.heartbeatRunIds) {
    values.push({ ...base, effectKind: "cancel_heartbeat_run", targetId: heartbeatRunId });
  }
  for (const issueId of targets.supersededUnblockIssueIds) {
    values.push({ ...base, effectKind: "supersede_unblock_issue", targetId: issueId });
  }
  return values;
}

export async function captureStopTargets(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  input: FinalizeRunTerminalInput,
  run: typeof workflowRuns.$inferSelect,
  stepIssueIds: string[],
  staleUnblockIssueIds: string[],
): Promise<WorkflowTerminalStopTargets> {
  const targets: WorkflowTerminalStopTargets = {
    runtimeIds: [],
    heartbeatRunIds: [],
    supersededUnblockIssueIds: staleUnblockIssueIds,
  };
  // dynamicOwnerPlanCompleted 는 기존 제외 규칙을 그대로 따른다(런타임 캡처 생략).
  if (!input.dynamicOwnerPlanCompleted && run.missionId !== null && stepIssueIds.length > 0) {
    const runtimes = await tx
      .select({ id: missionAgentRuntimes.id })
      .from(missionAgentRuntimes)
      .where(and(
        eq(missionAgentRuntimes.companyId, input.companyId),
        eq(missionAgentRuntimes.missionId, run.missionId),
        inArray(missionAgentRuntimes.status, [...ACTIVE_MISSION_RUNTIME_STATUSES]),
        inArray(missionAgentRuntimes.currentIssueId, stepIssueIds),
      ));
    targets.runtimeIds = runtimes.map((runtime) => runtime.id);
  }
  // 게이트 제외 규칙을 그대로 미러링한다 — 정산된 heartbeat, 트리거 자기 자신은 대상이 아니다.
  if (stepIssueIds.length > 0) {
    const heartbeatFilters = [
      eq(heartbeatRuns.companyId, input.companyId),
      inArray(heartbeatRuns.issueId, stepIssueIds),
      inArray(heartbeatRuns.status, ["queued", "running"]),
      isNull(heartbeatRuns.terminalOutcome),
    ];
    if (input.triggerHeartbeatRunId) {
      heartbeatFilters.push(notInArray(heartbeatRuns.id, [input.triggerHeartbeatRunId]));
    }
    const heartbeats = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(...heartbeatFilters));
    targets.heartbeatRunIds = heartbeats.map((heartbeat) => heartbeat.id);
  }
  return targets;
}
