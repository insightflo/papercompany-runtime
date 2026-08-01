/**
 * [파일 목적] bounded back-edge loop 가 step 을 re-run 할 때 해당 step_run 을 rework pending 상태로
 *   리셋한다(P4). Issue lifecycle 은 queue/runner 가 workflow_resume 요청을 시작할 때 처리한다.
 * [주요 흐름] resetStepRunForRework(db, { stepRun, companyId, attempt?, increment? }):
 *   1. iteration_index += increment(기본 1) — loop 카운터. maxIterations cap 판정은 loop-driver 가, 증가는 여기서.
 *   2. metadata 에 attempt(verdict/결함) archive(verdict-store.appendAttempt) + controlFlowSkipped sentinel 제거.
 *      sentinel 제거는 P2 이월 항목: skip 된 step 이 back-edge 로 회복될 수 있게 한다.
 *   3. step_run → status:"pending", startedAt/completedAt clear, iterationIndex/metadata 반영.
 *   4. logActivity(workflow.rework_reset). issue 재시작은 launch pass 의 workflow_resume queue 로 위임.
 * [외부 연결] consumer: loop-driver.ts(back-edge 발화 시 호출). 의존: verdict-store(appendAttempt),
 *   types(StepIterationAttempt), @paperclipai/db, ../../activity-log(logActivity). **dag-engine 을 import 하지
 *   않는다(역참조/순환 방지 + 모듈 분해 원칙).**
 * [수정시 주의]
 *   - 이 모듈은 issue.status 를 직접 바꾸지 않는다. step_run reset 과 issue 실행 시작을 섞으면
 *     DAG engine 이 runner 책임을 침범하고, done/blocked 재실행 예외가 늘어난다.
 *   - **가즈아 25h hang 회귀 금지**: 이 함수 자체는 cap 을 모른다(무조건 리셋). cap 은 loop-driver 가
 *     maxIterations 게이트로 판정한 뒤에만 이 함수를 호출한다. 호출 빈도가 곧 loop 안전성이다.
 *   - sentinel(controlFlowSkipped) 은 반드시 제거 — 남기면 resetUnlaunchedTerminalStepRuns 가 skipped→pending
 *     으로 부활시키지 못해 회복 불가(P2 이월).
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { logActivity } from "../../activity-log.js";
import { appendAttempt } from "./verdict-store.js";
import type { StepIterationAttempt } from "./types.js";
import { isHeartbeatFinalizationV1Enabled } from "../../heartbeat-finalization/flag.js";
import {
  appendWorkflowAuthorityTransition,
  supersedeWorkflowDelegationsForGeneration,
} from "../authority/transitions.js";

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
  reworkContract?: Record<string, unknown>;
}

export interface ResetStepRunForReworkResult {
  stepRunId: string;
  iterationIndex: number;
  issueResumeRequired: boolean;
}

/**
 * [목적] step_run 을 rework 가능 상태(pending) 로 리셋하고 iteration 카운터를 증가.
 * [입력] ResetStepRunForReworkInput. [출력] { iterationIndex, issueResumeRequired }.
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
  if (input.reworkContract) {
    metadata.workflowReworkContract = input.reworkContract;
  }
  // P2 이월: skip sentinel 제거 — back-edge 로 회복되는 step 이 flap 없이 재실행되게.
  delete metadata.controlFlowSkipped;

  const finalizationV1Enabled = await isHeartbeatFinalizationV1Enabled(db);
  if (finalizationV1Enabled) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(workflowStepRuns)
        .set({
          status: "pending",
          startedAt: null,
          completedAt: null,
          iterationIndex: nextIterationIndex,
          metadata,
          executionGeneration: sql`${workflowStepRuns.executionGeneration} + 1`,
          dispatchOwnerWakeupRequestId: null,
          dispatchOwnerHeartbeatRunId: null,
          evidenceReadyAt: null,
          dispatchReadyAt: null,
        })
        .where(and(
          eq(workflowStepRuns.id, stepRun.id),
          eq(workflowStepRuns.executionGeneration, stepRun.executionGeneration),
        ))
        .returning({ id: workflowStepRuns.id });
      if (updated.length === 0) throw new Error("workflow rework generation CAS lost");
      await supersedeWorkflowDelegationsForGeneration(tx, {
        workflowRunId: stepRun.workflowRunId,
        workflowStepRunId: stepRun.id,
        executionGeneration: stepRun.executionGeneration,
        now,
      });
      await appendWorkflowAuthorityTransition(tx, {
        companyId,
        workflowRunId: stepRun.workflowRunId,
        workflowStepRunId: stepRun.id,
        issueId: stepRun.issueId,
        executionGeneration: stepRun.executionGeneration + 1,
        reason: reason ?? "back_edge_qa_request_changes",
        idempotencyKey: `authority-generation-rework:${stepRun.id}:${stepRun.executionGeneration}:${stepRun.executionGeneration + 1}`,
        payload: {
          version: 1,
          transition: "generation_advanced",
          oldGeneration: stepRun.executionGeneration,
          newGeneration: stepRun.executionGeneration + 1,
          iterationIndex: nextIterationIndex,
        },
      });
    });
  } else {
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
  }

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
      issueResumeRequired: Boolean(stepRun.issueId),
      reason: reason ?? "back_edge_qa_request_changes",
    },
  });

  return { stepRunId: stepRun.id, iterationIndex: nextIterationIndex, issueResumeRequired: Boolean(stepRun.issueId) };
}
