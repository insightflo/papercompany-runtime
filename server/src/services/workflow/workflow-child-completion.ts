// server/src/services/workflow/workflow-child-completion.ts
//
// [purpose] workflow→workflow 자식 run 종말 마감 모듈(0101, fix round).
//   invocation 을 child_run_id 로 조회해 pending 부모 스텝을 기존 step-run 완료 경로
//   (completeWorkflowToolStepFromResult)로 마감한다. 세대 CAS fence(generation 일치 +
//   step-run pending + invocation 링크 일치, 단일 UPDATE WHERE)로 이중완료/구세대 stale
//   hook/retry-waiting 스텝 오마감을 차단하고, 자식 run 의 영속 종말 상태를 DB 에서 재조회해
//   판정한다(호출자 status 인자는 힌트일 뿐). 실패 스텝 마감은 기계 errorCode 만 실는다.
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8, 파싱 권위 없음).
import { asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import { TERMINAL_WORKFLOW_STATUSES } from "../missions/mission-runtime-manager.js";
import { completeWorkflowToolStepFromResult } from "./dag-engine.js";

export async function failChildStep(
  db: Db,
  input: {
    companyId: string;
    workflowRunId: string;
    stepRunId: string;
    stepId: string;
    errorCode: string;
    detail: string;
    /** 세대 CAS fence — invocation 이 존재하는 회복/재실패 경로에서만 사용한다.
     *  childDeleted: 링크됐던 자식이 삭제된(FK set null tombstone) 정산 모드. */
    fence?: { invocationId: string; generation: number; childRunId?: string; childDeleted?: boolean };
  },
): Promise<boolean> {
  const result = await completeWorkflowToolStepFromResult(db, {
    companyId: input.companyId,
    stepRunId: input.stepRunId,
    workflowRunId: input.workflowRunId,
    stepId: input.stepId,
    toolName: "workflow",
    success: false,
    data: { ok: false, errorCode: input.errorCode, detail: input.detail },
    error: input.errorCode,
    stderr: input.errorCode,
    exitCode: 1,
    ...(input.fence ? { fence: input.fence } : {}),
  });
  return result === null ? false : true;
}

export type WorkflowChildTerminalRun = {
  id: string;
  companyId: string;
  status: string;
};

/**
 * 자식 run 종말 훅 — invocation 을 child_run_id 로 조회해 pending 부모 스텝을
 * 기존 step-run 완료 경로로 마감한다.
 * - 자식 run 영속 상태를 DB 에서 재조회해 판정한다(호출자 status 는 무시).
 * - 세대 CAS fence: 단일 UPDATE WHERE (pending + workflowChild 세대/자식 일치 +
 *   retry 대기 아님 + invocation 링크 일치). 진 패자는 어떤 side-effect 도 없다.
 */
export async function runWorkflowChildCompletionHook(
  db: Db,
  terminalRun: WorkflowChildTerminalRun,
): Promise<boolean> {
  if (!TERMINAL_WORKFLOW_STATUSES.has(terminalRun.status)) return false;

  const [invocation] = await db
    .select()
    .from(workflowStepInvocations)
    .where(eq(workflowStepInvocations.childRunId, terminalRun.id))
    .orderBy(asc(workflowStepInvocations.createdAt))
    .limit(1);
  if (!invocation || invocation.companyId !== terminalRun.companyId) return false;
  if (invocation.childRunId !== terminalRun.id) return false;

  // 영속 종말 상태 재조회 — 호출자가 준 status 는 신뢰하지 않는다(fix round P1-2).
  const [childRun] = await db
    .select({ id: workflowRuns.id, companyId: workflowRuns.companyId, status: workflowRuns.status })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, terminalRun.id))
    .limit(1);
  if (!childRun || childRun.companyId !== invocation.companyId) return false;
  if (!TERMINAL_WORKFLOW_STATUSES.has(childRun.status)) return false;

  const [stepRun] = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, invocation.parentStepRunId))
    .limit(1);
  if (!stepRun || stepRun.status !== "pending") return false;

  const [parentRun] = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, stepRun.workflowRunId))
    .limit(1);
  if (!parentRun || parentRun.companyId !== invocation.companyId) return false;
  // [fix4 §3] 부모 가드 — 완료/중단/시간초과 부모는 자식 정산으로 재기록하지 않는다(스텝 최종).
  //   running(정상 대기), cancelled(라운드-1 확립 계약: 취소 캐스케이드가 자식 종말 훅으로 부모
  //   waiting 스텝을 child_run_cancelled 로 마감 — finalize 가 cancelled 를 고정해 되살아지지
  //   않는다), failed(정당한 신세대 정산 증거 — 기존 세대/자식/retry fence 가 stale 정산을
  //   차단한다)일 때는 정산을 허용한다. DEVIATION: 설명문의 "not running" 리터럴 가드는 기존
  //   취소/정산 계약과 충돌이 확인되어(coordinator ask 채널 장애로 질의 불가) 보호 의도
  //   (완료 부모 보호)를 유지하는 최소 가드로 축소했다. worker_done 에 편차 보고.
  if (parentRun.status === "completed" || parentRun.status === "aborted" || parentRun.status === "timed-out") {
    return false;
  }

  const childStatus = childRun.status;
  const success = childStatus === "completed";
  const errorCode = success
    ? null
    : childStatus === "cancelled"
      ? "child_run_cancelled"
      : "child_run_failed";

  const result = await completeWorkflowToolStepFromResult(db, {
    companyId: parentRun.companyId,
    stepRunId: stepRun.id,
    workflowRunId: parentRun.id,
    stepId: stepRun.stepId,
    toolName: "workflow",
    success,
    data: { ok: success, childRunId: childRun.id, childStatus },
    ...(success ? {} : { error: errorCode ?? "child_run_failed" }),
    ...(success ? { stdout: "" } : { stderr: errorCode ?? "child_run_failed" }),
    exitCode: success ? 0 : 1,
    fence: {
      invocationId: invocation.id,
      childRunId: childRun.id,
      generation: invocation.generation,
    },
  });
  return result !== null;
}
