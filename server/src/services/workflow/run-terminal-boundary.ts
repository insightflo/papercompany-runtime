// server/src/services/workflow/run-terminal-boundary.ts
//
// [run-terminal-boundary v1 — stage-3 검토 계약 PR-1] 실행 종결 경계의 코어 모듈.
// 불변식: "종결된 권한은 관측 사실만으로 부활하지 않으며, 과거 종결의 부작용은 그때
// 철회한 실행에만 작용한다."
// - 종결 결정은 CAS(dispatchAuthorityVersion) 아래 원인 스탬프와 함께 (run, version) 단위로
//   1회만 기록된다(유니크). legacy 종결 행에는 결정을 위조하지 않는다.
// - failed 종결 전 좁은 회복 채널 게이트(run-terminal-recovery-gate.ts)를 평가해 열린
//   채널이 있으면 종결을 유예하고, 유예 시 그 외 어떤 행도 쓰지 않는다.
// - 종료 후 부작용(kill/cancel/supersede)은 같은 트랜잭션에서 인텐트(outbox)로 캡처되고
//   커밋 후 별도 실행 경로가 재처리한다(run-terminal-effect-executor.ts).
// - 이 모듈은 플래그를 읽지 않는다. 게이팅(run-terminal-boundary-flag.ts)은 호출자 책임이며
//   legacy 경로는 이 모듈을 전혀 거치지 않는다.

import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  missionAgentRuntimes,
  workflowRuns,
  workflowTerminalDecisions,
  workflowTerminalEffectIntents,
  type WorkflowTerminalStopTargets,
} from "@paperclipai/db";
import { ACTIVE_MISSION_RUNTIME_STATUSES } from "../missions/mission-runtime-manager.js";
import { logger } from "../../middleware/logger.js";
import {
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
  validateTerminalCause,
  type FinalizeRunTerminalInput,
  type TerminalDecisionValue,
  type TerminalFinalizeResult,
} from "./run-terminal-boundary-cause.js";
import { evaluateRecoveryChannels, uniqueIssueIds } from "./run-terminal-recovery-gate.js";

// 지정된 공개 API 표면 — 내부 분할과 무관하게 본 모듈이 단일 진입점이다.
export type {
  FinalizeRunTerminalInput,
  TerminalBoundaryDb,
  TerminalCauseInput,
  TerminalDecisionOrigin,
  TerminalDecisionValue,
  TerminalDiscoveryPath,
  TerminalPolicyCause,
  TerminalStepRunRef,
  TerminalFinalizeResult,
} from "./run-terminal-boundary-cause.js";
export {
  isTerminalRunStatus,
  TERMINAL_RUN_STATUSES,
  validateTerminalCause,
} from "./run-terminal-boundary-cause.js";
export type {
  RecoveryChannelEvidence,
  RecoveryGateInput,
  RecoveryGateResult,
} from "./run-terminal-recovery-gate.js";
export { evaluateRecoveryChannels } from "./run-terminal-recovery-gate.js";
export { executeTerminalEffectIntents, processPendingTerminalEffectIntents } from "./run-terminal-effect-executor.js";

/** 캡처된 정지 대상 → 효과 인텐트 행 값(공통 조립 — 본 경로/자가치유 경로 동일 계약). */
function buildEffectIntentValues(
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

/** 이미 기록된 (run, version) 결정을 분류한다 — 같은 결정이면 멱등, 다르면 충돌(전체 롤백). */
async function classifyExistingDecision(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  input: FinalizeRunTerminalInput,
  run: typeof workflowRuns.$inferSelect,
): Promise<TerminalFinalizeResult> {
  const [existing] = await tx
    .select({ id: workflowTerminalDecisions.id, decision: workflowTerminalDecisions.decision })
    .from(workflowTerminalDecisions)
    .where(and(
      eq(workflowTerminalDecisions.companyId, input.companyId),
      eq(workflowTerminalDecisions.workflowRunId, input.runId),
      eq(workflowTerminalDecisions.decidedAuthorityVersion, input.expectedAuthorityVersion),
    ));
  if (!existing) {
    // legacy 종결 행(결정 기록 없음) — 이력을 위조하지 않고 그대로 보고한다.
    return { kind: "already_finalized", currentStatus: run.status, existingDecision: null, run };
  }
  if (existing.decision !== input.decision) throw new Error("terminal decision conflict");
  return {
    kind: "already_finalized",
    currentStatus: run.status,
    existingDecision: { id: existing.id, decision: existing.decision as TerminalDecisionValue },
    run,
  };
}

async function captureStopTargets(
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

/**
 * 종결 유일 진입점. run 행 잠금 하에서 CAS 검증 → (필요 시) 회복 게이트 → CAS 종결 쓰기 →
 * 결정/정지 대상 캡처/인텐트 기록을 한 트랜잭션으로 수행한다.
 */
export async function finalizeRunTerminal(db: Db, input: FinalizeRunTerminalInput): Promise<TerminalFinalizeResult> {
  validateTerminalCause(input.cause, input.decision);
  return await db.transaction(async (tx): Promise<TerminalFinalizeResult> => {
    const [locked] = await tx
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.companyId, input.companyId)))
      .for("update");
    if (!locked) throw new Error(`workflow run not found: ${input.runId}`);
    if (locked.dispatchAuthorityVersion !== input.expectedAuthorityVersion) {
      return {
        kind: "stale_authority",
        expectedAuthorityVersion: input.expectedAuthorityVersion,
        currentAuthorityVersion: locked.dispatchAuthorityVersion,
        run: locked,
      };
    }
    if (isTerminalRunStatus(locked.status)) {
      return await classifyExistingDecision(tx, input, locked);
    }

    // failed + defer 정책에서만 게이트가 종결을 막는다. 유예 시 그 외 어떤 행도 쓰지 않는다.
    let staleUnblockIssueIds: string[] = [];
    let recoveryGate: Record<string, unknown>;
    if (input.decision === "failed" && input.gatePolicy === "defer_on_open_recovery") {
      const gate = await evaluateRecoveryChannels(tx, {
        runId: input.runId,
        companyId: input.companyId,
        missionId: locked.missionId,
        stepRuns: input.stepRuns,
        triggerHeartbeatRunId: input.triggerHeartbeatRunId ?? null,
        now: input.now,
      });
      if (gate.kind === "open") return { kind: "deferred", gateKind: "open", evidence: gate.evidence, run: locked };
      if (gate.kind === "unknown") return { kind: "deferred", gateKind: "unknown", gateError: gate.error, run: locked };
      staleUnblockIssueIds = gate.staleUnblockIssueIds;
      recoveryGate = { kind: "clear", staleUnblockIssueIds, gatePolicy: input.gatePolicy };
    } else {
      recoveryGate = { kind: "not_evaluated", gatePolicy: input.gatePolicy };
    }

    // 행 잠금을 쥔 상태라 경합 손실은 없다 — CAS 술어는 방어적 이중 확인이다.
    const [updatedRun] = await tx
      .update(workflowRuns)
      .set({
        status: input.decision,
        completedAt: input.now,
        startedAt: locked.startedAt ?? input.now,
      })
      .where(and(
        eq(workflowRuns.id, input.runId),
        eq(workflowRuns.companyId, input.companyId),
        notInArray(workflowRuns.status, [...TERMINAL_RUN_STATUSES]),
        eq(workflowRuns.dispatchAuthorityVersion, input.expectedAuthorityVersion),
      ))
      .returning();
    if (!updatedRun) {
      const [current] = await tx
        .select()
        .from(workflowRuns)
        .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.companyId, input.companyId)))
        .for("update");
      if (!current) throw new Error(`workflow run not found: ${input.runId}`);
      if (current.dispatchAuthorityVersion !== input.expectedAuthorityVersion) {
        return {
          kind: "stale_authority",
          expectedAuthorityVersion: input.expectedAuthorityVersion,
          currentAuthorityVersion: current.dispatchAuthorityVersion,
          run: current,
        };
      }
      return await classifyExistingDecision(tx, input, current);
    }

    const stepIssueIds = uniqueIssueIds(input.stepRuns);
    const capturedStopTargets = await captureStopTargets(tx, input, locked, stepIssueIds, staleUnblockIssueIds);
    const [decisionRow] = await tx
      .insert(workflowTerminalDecisions)
      .values({
        companyId: input.companyId,
        workflowRunId: input.runId,
        decidedAuthorityVersion: input.expectedAuthorityVersion,
        decision: input.decision,
        policyCause: input.cause.policy,
        discoveryPath: input.cause.discovery,
        origin: input.cause.origin,
        reason: input.cause.reason ?? null,
        recoveryGate,
        capturedStopTargets,
      })
      .onConflictDoNothing()
      .returning({ id: workflowTerminalDecisions.id });
    if (!decisionRow) {
      // 유니크 충돌 = 동일 (run, version) 결정이 선행 존재. 같은 결정이면 멱등 재분류,
      //   다른 결정이면 버전 범프 없이 재오픈된 레거시 상태(재개 가드 이전 시대)이다 —
      //   권한 버전을 +1 해 새 (run, version) 키로 자가치유 기록한다(검수 계약 "복구 후
      //   재종결은 새 버전에서" 의 소급 이행). 종결 진입 시점부터 종결이었던 행은 위
      //   classifyExistingDecision 경로가 진짜 불변식 위반으로 롤백한다.
      const [existing] = await tx
        .select({ id: workflowTerminalDecisions.id, decision: workflowTerminalDecisions.decision })
        .from(workflowTerminalDecisions)
        .where(and(
          eq(workflowTerminalDecisions.companyId, input.companyId),
          eq(workflowTerminalDecisions.workflowRunId, input.runId),
          eq(workflowTerminalDecisions.decidedAuthorityVersion, input.expectedAuthorityVersion),
        ));
      if (existing && existing.decision === input.decision) {
        const [current] = await tx
          .select()
          .from(workflowRuns)
          .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.companyId, input.companyId)))
          .for("update");
        if (!current) throw new Error(`workflow run not found: ${input.runId}`);
        return await classifyExistingDecision(tx, input, current);
      }
      const healedVersion = input.expectedAuthorityVersion + 1;
      await tx
        .update(workflowRuns)
        .set({ dispatchAuthorityVersion: healedVersion })
        .where(and(
          eq(workflowRuns.id, input.runId),
          eq(workflowRuns.companyId, input.companyId),
          eq(workflowRuns.dispatchAuthorityVersion, input.expectedAuthorityVersion),
        ));
      const healedTargets = await captureStopTargets(tx, input, updatedRun, stepIssueIds, staleUnblockIssueIds);
      const [healedRow] = await tx
        .insert(workflowTerminalDecisions)
        .values({
          companyId: input.companyId,
          workflowRunId: input.runId,
          decidedAuthorityVersion: healedVersion,
          decision: input.decision,
          policyCause: input.cause.policy,
          discoveryPath: input.cause.discovery,
          origin: input.cause.origin,
          reason: input.cause.reason ?? null,
          recoveryGate,
          capturedStopTargets: healedTargets,
        })
        .onConflictDoNothing()
        .returning({ id: workflowTerminalDecisions.id });
      if (!healedRow) throw new Error("terminal decision conflict (self-heal reinsert failed)");
      logger.warn(
        {
          runId: input.runId,
          companyId: input.companyId,
          expectedAuthorityVersion: input.expectedAuthorityVersion,
          healedAuthorityVersion: healedVersion,
          existingDecision: existing?.decision ?? null,
          newDecision: input.decision,
        },
        "terminal decision self-healed after legacy un-bumped reopen",
      );
      const healedIntents = buildEffectIntentValues(
        { companyId: input.companyId, terminalDecisionId: healedRow.id, payload: { decisionId: healedRow.id } },
        healedTargets,
      );
      if (healedIntents.length > 0) {
        await tx.insert(workflowTerminalEffectIntents).values(healedIntents).onConflictDoNothing();
      }
      return {
        kind: "finalized",
        decisionId: healedRow.id,
        decision: input.decision,
        decidedAuthorityVersion: healedVersion,
        effectIntentCount: healedIntents.length,
        run: { ...updatedRun, dispatchAuthorityVersion: healedVersion },
      };
    }

    // 인텐트는 추가 사실일 뿐 권위가 아니다 — 중복 캡처는 onConflictDoNothing 로 무해화.
    const intentValues = buildEffectIntentValues(
      { companyId: input.companyId, terminalDecisionId: decisionRow.id, payload: { decisionId: decisionRow.id } },
      capturedStopTargets,
    );
    if (intentValues.length > 0) {
      await tx.insert(workflowTerminalEffectIntents).values(intentValues).onConflictDoNothing();
    }

    return {
      kind: "finalized",
      decisionId: decisionRow.id,
      decision: input.decision,
      decidedAuthorityVersion: input.expectedAuthorityVersion,
      effectIntentCount: intentValues.length,
      run: updatedRun,
    };
  });
}
