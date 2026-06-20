/**
 * [파일 목적] bounded back-edge loop 가 step 을 re-run 할 때 해당 step_run + issue 를 같이 리셋한다(P4).
 *   핵심 제약: step status 는 issue status 에서 파생된다(syncStepRunsFromIssueState 가 매 sync 덮어쓴다).
 *   그러므로 step 만 pending 으로 바꿔선 소용없고 — issue 도 "todo" 로 돌려야 다음 sync 에 step 가 pending
 *   으로 재유도되고 발화 루프가 재실행된다(PLAN ground-truth L17). 이 모듈은 그 "step+issue 같이 리셋"을
 *   한 단위로 캡슐화한다.
 * [주요 흐름] resetStepRunForRework(db, { stepRun, companyId, attempt?, increment? }):
 *   1. iteration_index += increment(기본 1) — loop 카운터. maxIterations cap 판정은 loop-driver 가, 증가는 여기서.
 *   2. metadata 에 attempt(verdict/결함) archive(verdict-store.appendAttempt) + controlFlowSkipped sentinel 제거.
 *      sentinel 제거는 P2 이월 항목: skip 된 step 이 back-edge 로 회복될 수 있게 한다.
 *   3. issue → status:"todo", 실행/시간 필드 clear(dag-engine validation-recheck L773-796 과 동일 패턴).
 *   4. step_run → status:"pending", startedAt/completedAt clear, iterationIndex/metadata 반영.
 *   5. logActivity(workflow.rework_reset).
 * [외부 연결] consumer: loop-driver.ts(back-edge 발화 시 호출). 의존: verdict-store(appendAttempt),
 *   types(StepIterationAttempt), @paperclipai/db, ../../activity-log(logActivity). **dag-engine 을 import 하지
 *   않는다(역참조/순환 방지 + 모듈 분해 원칙).**
 * [수정시 주의]
 *   - issue/step_run update 는 dag-engine 기존 패턴처럼 순차 수행(명시적 tx 없음). 원자성이 critical 하면
 *     호출부(loop-driver) 나 상위에서 db.transaction 으로 감쌀 것. reconciler(60min) 가 최후 안전망.
 *   - **가즈아 25h hang 회귀 금지**: 이 함수 자체는 cap 을 모른다(무조건 리셋). cap 은 loop-driver 가
 *     maxIterations 게이트로 판정한 뒤에만 이 함수를 호출한다. 호출 빈도가 곧 loop 안전성이다.
 *   - sentinel(controlFlowSkipped) 은 반드시 제거 — 남기면 resetUnlaunchedTerminalStepRuns 가 skipped→pending
 *     으로 부활시키지 못해 회복 불가(P2 이월).
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, workflowStepRuns } from "@paperclipai/db";
import { logActivity } from "../../activity-log.js";
import { appendAttempt } from "./verdict-store.js";
import type { StepIterationAttempt } from "./types.js";

type StepRun = typeof workflowStepRuns.$inferSelect;

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export interface ResetStepRunForReworkInput {
  db: Db;
  stepRun: StepRun;
  /** activity log 및 issue 동기화용. context.run.companyId 를 호출자(loop-driver) 가 전달. */
  companyId: string;
  /** 리셋 직전 iteration 의 verdict/결함 아카이브. 생략 시 attempts[] 변화 없음. */
  attempt?: StepIterationAttempt;
  /** iteration_index 증가량(기본 1). */
  increment?: number;
  /** activity log details.reason 용 human-readable 사유. */
  reason?: string;
}

export interface ResetStepRunForReworkResult {
  stepRunId: string;
  iterationIndex: number;
  resetIssue: boolean;
}

/**
 * [목적] step_run(+issue) 을 rework 가능 상태(pending) 로 리셋하고 iteration 카운터를 증가.
 * [입력] ResetStepRunForReworkInput. [출력] { iterationIndex, resetIssue }.
 * [주의] cap 미판정 — 호출자(loop-driver) 가 maxIterations 게이트를 통과한 뒤에만 호출할 것.
 */
export async function resetStepRunForRework(
  input: ResetStepRunForReworkInput,
): Promise<ResetStepRunForReworkResult> {
  const { db, stepRun, companyId, attempt, reason } = input;
  const increment = input.increment ?? 1;
  const now = new Date();
  const nextIterationIndex = (stepRun.iterationIndex ?? 0) + increment;

  // metadata: attempt archive + sentinel 제거. appendAttempt 는 기존 키(executionControls 등) 보존.
  let metadata = normalizeRecord(stepRun.metadata);
  if (attempt) {
    metadata = appendAttempt(metadata, attempt);
  }
  // P2 이월: skip sentinel 제거 — back-edge 로 회복되는 step 이 flap 없이 재실행되게.
  delete metadata.controlFlowSkipped;

  // 1) issue 리셋(step status 가 issue 에서 파생되므로 같이 돌려야 pending 으로 재유도됨).
  let resetIssue = false;
  if (stepRun.issueId) {
    const [updatedIssue] = await db
      .update(issues)
      .set({
        status: "todo",
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      })
      .where(eq(issues.id, stepRun.issueId))
      .returning({ id: issues.id });
    resetIssue = Boolean(updatedIssue);
  }

  // 2) step_run 리셋.
  await db
    .update(workflowStepRuns)
    .set({
      status: "pending",
      startedAt: null,
      completedAt: null,
      iterationIndex: nextIterationIndex,
      metadata,
    })
    .where(eq(workflowStepRuns.id, stepRun.id));

  await logActivity(db, {
    companyId,
    actorType: "system",
    actorId: "workflow:control-flow-rework",
    action: "workflow.rework_reset",
    entityType: "workflow_step_run",
    entityId: stepRun.id,
    details: {
      workflowRunId: stepRun.workflowRunId,
      stepId: stepRun.stepId,
      issueId: stepRun.issueId ?? null,
      iterationIndex: nextIterationIndex,
      verdict: attempt?.verdict ?? null,
      resetIssue,
      reason: reason ?? "back_edge_qa_request_changes",
    },
  });

  return { stepRunId: stepRun.id, iterationIndex: nextIterationIndex, resetIssue };
}
