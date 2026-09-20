// server/src/services/workflow/run-recovery-authority.ts
//
// [run-recovery-service v1 — stage-3 검토 계약 PR-2b] 종결 실행의 공식 복구 코어.
// 불변식: "종결된 실행은 기록된 결정 1건을 정확히 1회 소비하는 복구 권한으로만 되살아
// 나며, 복구는 새 권한버전을 부여한다."
// - 대상 검증: 실행의 현재 dispatchAuthorityVersion 이 지정 버전과 일치하고 그 버전에
//   종결 결정이 존재해야 한다. 어긋나면 stale_authority — 낡은 승인이 새 종결 상태를
//   되살리지 않는다(2026-09-20 전환기 웨지의 재발 방지 계약).
// - 1회 소비: (run, 대상 버전) 유니크. 같은 멱등 키(requestReference) 재시도는 쓰기 없이
//   기존 권한을 돌려준다.
// - 이 모듈은 플래그를 읽지 않는다. 게이팅은 호출자 책임이며 legacy 경로는 거치지 않는다.
// - 스텝 리셋 등 후속 조작은 호출자 몫 — 코어는 run 재개(상태 CAS + 버전 범프)까지만.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowRecoveryAuthorities,
  workflowRuns,
  workflowStepRuns,
  workflowTerminalDecisions,
} from "@paperclipai/db";
import { isTerminalRunStatus } from "./run-terminal-boundary-cause.js";

export type RunRecoveryKind =
  | "manual_resume"
  | "supervision_tool_retry"
  | "source_issue_unblock";

export interface RecoverTerminalRunInput {
  runId: string;
  companyId: string;
  /** 되살리려는 결정의 권한버전 — 실행의 현재 버전과 일치해야 한다. */
  expectedAuthorityVersion: number;
  /** 아는 경우 결정값(failed 등). 다르면 decision_mismatch — 승인 대상 오류 방지. */
  expectedDecision?: string | null;
  recoveryKind: RunRecoveryKind;
  /** 호출자 멱등 키(감독 재시도 키 등). 같은 키 재시도는 이중 소비가 아니다. */
  requestReference?: string | null;
  requestedBy: string;
  now: Date;
}

export interface RecoveredRunState {
  id: string;
  status: string;
  dispatchAuthorityVersion: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

export type WorkflowRecoveryAuthorityRow = typeof workflowRecoveryAuthorities.$inferSelect;

export type RecoverTerminalRunResult =
  | { kind: "recovered"; authority: WorkflowRecoveryAuthorityRow; run: RecoveredRunState }
  | { kind: "already_consumed"; authority: WorkflowRecoveryAuthorityRow }
  | { kind: "stale_authority"; currentAuthorityVersion: number }
  | { kind: "decision_mismatch"; existingDecision: string }
  | { kind: "missing_decision" }
  | { kind: "not_terminal"; currentStatus: string }
  | { kind: "not_found" };

function runStateOf(row: typeof workflowRuns.$inferSelect): RecoveredRunState {
  return {
    id: row.id,
    status: row.status,
    dispatchAuthorityVersion: row.dispatchAuthorityVersion,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

/** 종결 실행의 공식 복구 — 유일 진입점. 검증 → 1회 소비 → 상태 CAS + 버전 범프를 한 트랜잭션으로. */
export async function recoverTerminalRun(
  db: Db,
  input: RecoverTerminalRunInput,
): Promise<RecoverTerminalRunResult> {
  return await db.transaction(async (tx): Promise<RecoverTerminalRunResult> => {
    const [locked] = await tx
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.companyId, input.companyId)))
      .for("update");
    if (!locked) return { kind: "not_found" };
    // 멱등 키 선점검이 상태/버전 검증보다 앞선다 — 같은 명령의 재시도는 이미 적용됐다는
    // 사실(already_consumed)을 그대로 돌려줘야 하며, 그 후 상태가 어찌 됐는지와 무관하다.
    // [봇 지적 교정] 스코프에 대상 버전 포함 — 같은 키의 이전 버전 소비는 이번 명령과
    // 다른 발생이다(예: 같은 언블록 이슈가 재실패 후 새 결정을 다시 해결). 버전이 다르면
    // already_consumed 로 간주하지 않고 정상 검증으로 흘러 새 권한을 소비한다.
    if (input.requestReference != null) {
      const [byReference] = await tx
        .select()
        .from(workflowRecoveryAuthorities)
        .where(and(
          eq(workflowRecoveryAuthorities.companyId, input.companyId),
          eq(workflowRecoveryAuthorities.workflowRunId, input.runId),
          eq(workflowRecoveryAuthorities.recoveryKind, input.recoveryKind),
          eq(workflowRecoveryAuthorities.requestReference, input.requestReference),
          eq(workflowRecoveryAuthorities.targetAuthorityVersion, input.expectedAuthorityVersion),
        ))
        .limit(1);
      if (byReference) return { kind: "already_consumed", authority: byReference };
    }
    if (!isTerminalRunStatus(locked.status)) {
      return { kind: "not_terminal", currentStatus: locked.status };
    }
    if (locked.dispatchAuthorityVersion !== input.expectedAuthorityVersion) {
      return { kind: "stale_authority", currentAuthorityVersion: locked.dispatchAuthorityVersion };
    }

    const [decision] = await tx
      .select({ id: workflowTerminalDecisions.id, decision: workflowTerminalDecisions.decision })
      .from(workflowTerminalDecisions)
      .where(and(
        eq(workflowTerminalDecisions.companyId, input.companyId),
        eq(workflowTerminalDecisions.workflowRunId, input.runId),
        eq(workflowTerminalDecisions.decidedAuthorityVersion, input.expectedAuthorityVersion),
      ))
      .limit(1);
    if (!decision) return { kind: "missing_decision" };
    if (input.expectedDecision != null && input.expectedDecision !== decision.decision) {
      return { kind: "decision_mismatch", existingDecision: decision.decision };
    }

    // 1회 소비 검증 — 이 버전을 이미 소비한 다른 종류의 복구가 있으면 그 권한을 돌려준다.
    const [byVersion] = await tx
      .select()
      .from(workflowRecoveryAuthorities)
      .where(and(
        eq(workflowRecoveryAuthorities.companyId, input.companyId),
        eq(workflowRecoveryAuthorities.workflowRunId, input.runId),
        eq(workflowRecoveryAuthorities.targetAuthorityVersion, input.expectedAuthorityVersion),
      ))
      .limit(1);
    if (byVersion) return { kind: "already_consumed", authority: byVersion };

    const resultingVersion = input.expectedAuthorityVersion + 1;
    const [authority] = await tx
      .insert(workflowRecoveryAuthorities)
      .values({
        companyId: input.companyId,
        workflowRunId: input.runId,
        targetAuthorityVersion: input.expectedAuthorityVersion,
        targetDecisionId: decision.id,
        recoveryKind: input.recoveryKind,
        requestReference: input.requestReference ?? null,
        requestedBy: input.requestedBy,
        status: "consumed",
        consumedAt: input.now,
        resultingAuthorityVersion: resultingVersion,
      })
      .returning();
    if (!authority) throw new Error("workflow recovery authority insert returned no row");

    // 행 잠금을 쥔 상태라 경합 손실은 없다 — CAS 술어는 방어적 이중 확인이다.
    const [updatedRun] = await tx
      .update(workflowRuns)
      .set({
        status: "running",
        completedAt: null,
        startedAt: locked.startedAt ?? input.now,
        dispatchAuthorityVersion: resultingVersion,
      })
      .where(and(
        eq(workflowRuns.id, input.runId),
        eq(workflowRuns.companyId, input.companyId),
        eq(workflowRuns.status, locked.status),
        eq(workflowRuns.dispatchAuthorityVersion, input.expectedAuthorityVersion),
      ))
      .returning();
    if (!updatedRun) {
      // 잠금 하에 불일치는 동시 권한버전 변경 — 이 트랜잭션을 롤백시키고 예외로 실패닫는다.
      //   [봇 지적 교정] 결과 유니온의 stale_authority 가 아니라 예외로 전파됨을 주석 그대로
      //   명시한다(호출자는 kind 분기 밖에서 실패닫힘 처리).
      throw new Error("workflow recovery CAS lost after row lock — transaction aborted");
    }

    // 복구는 예전 세대를 되살리지 않는다. 공식 재개가 열릴 때 새 스텝 세대를 발급해
    // 종결 경계 이전의 늦은 결과가 복구된 실행을 오염하지 않게 한다.
    // (run 행을 이미 (id, companyId) 로 잠가 검증했으므로 eq(runId) 로 충분하다.)
    await tx
      .update(workflowStepRuns)
      .set({ executionGeneration: sql`${workflowStepRuns.executionGeneration} + 1` })
      .where(eq(workflowStepRuns.workflowRunId, input.runId));

    return { kind: "recovered", authority, run: runStateOf(updatedRun) };
  });
}

/** [호출자 편의] 실행의 최신 종결 결정 — 버전 일치 검증에 쓰는 현재 권한버전과 함께. */
export async function latestTerminalDecision(
  db: Db,
  runId: string,
  companyId: string,
): Promise<{ decidedAuthorityVersion: number; decision: string } | null> {
  const [latest] = await db
    .select({ decidedAuthorityVersion: workflowTerminalDecisions.decidedAuthorityVersion, decision: workflowTerminalDecisions.decision })
    .from(workflowTerminalDecisions)
    .where(and(
      eq(workflowTerminalDecisions.companyId, companyId),
      eq(workflowTerminalDecisions.workflowRunId, runId),
    ))
    .orderBy(desc(workflowTerminalDecisions.decidedAuthorityVersion))
    .limit(1);
  return latest ?? null;
}
