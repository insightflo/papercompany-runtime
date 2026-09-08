// server/src/services/workflow/workflow-child-completion.ts
//
// [purpose] descope v1 — workflow→workflow 자식 스텝 정산의 공개 진입 계층. 실제 최종 변이는
//   workflow-child-settlement-writers.ts 의 세 가지 엄격 형태(linked/tombstone/pre-admission)로
//   위임되며, 각 최종 UPDATE 문장이 전체 신원을 바인딩한다(D5). 이 계층은 형태 선택과 종말 훅의
//   신원 구성(child_run_id → linked invocation → 전체 B)만 담당한다. 호출자가 공급한 status/
//   wait/metadata 는 완료 권위가 절대 아니다(metadata.workflowChild 는 표시 전용). 0행은 typed
//   no-op/busy 다 — 성공으로 보고하지 않는다.
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8, 파싱 권위 없음).
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepInvocations, workflowStepRuns } from "@paperclipai/db";
import { TERMINAL_WORKFLOW_STATUSES } from "../missions/mission-runtime-manager.js";
import type { WorkflowChildIdentity, WorkflowChildTombstoneIdentity } from "./workflow-child-start-predicates.js";
import {
  failLinkedChildStep,
  failTombstoneChildStep,
  settleLinkedChildStepFromTerminal,
  type FailChildStepOutcome,
} from "./workflow-child-settlement-writers.js";
import { failPreAdmissionChildStep } from "./workflow-child-pre-admission-writer.js";

export type { FailChildStepOutcome } from "./workflow-child-settlement-writers.js";

export type FailChildStepInput = {
  companyId: string;
  workflowRunId: string;
  stepRunId: string;
  stepId: string;
  errorCode: string;
  detail: string;
  /** linked 형 — 존재하는 bound 자식의 종말 정산(전체 신원, generation 은 항상 1). */
  linked?: { invocationId: string; childRunId: string; generation: 1 };
  /** tombstone 형 — 링크됐던 자식이 삭제된 linked+NULL invocation 정산. */
  tombstone?: { invocationId: string; generation: 1 };
};

/**
 * 자식 스텝 실패 정산 공개 진입. linked/tombstone 지정이 없으면 pre-admission 형(클레임 이전
 * 실패 — invocation 부재 조건 포함)으로 정산한다. 0행은 no-op — 성공/실패 주장이 아니다.
 */
export async function failChildStep(db: Db, input: FailChildStepInput): Promise<FailChildStepOutcome> {
  if (input.linked) {
    return await failLinkedChildStep(db, {
      companyId: input.companyId,
      parentRunId: input.workflowRunId,
      parentStepRunId: input.stepRunId,
      stepId: input.stepId,
      invocationId: input.linked.invocationId,
      childRunId: input.linked.childRunId,
      generation: 1,
    }, { errorCode: input.errorCode, detail: input.detail });
  }
  if (input.tombstone) {
    const tombstone: WorkflowChildTombstoneIdentity = {
      companyId: input.companyId,
      parentRunId: input.workflowRunId,
      parentStepRunId: input.stepRunId,
      stepId: input.stepId,
      invocationId: input.tombstone.invocationId,
      generation: 1,
    };
    return await failTombstoneChildStep(db, tombstone);
  }
  return await failPreAdmissionChildStep(db, {
    companyId: input.companyId,
    parentRunId: input.workflowRunId,
    parentStepRunId: input.stepRunId,
    stepId: input.stepId,
    errorCode: input.errorCode,
    detail: input.detail,
  });
}

/** 자식 run 종말 훅 입력 — status 는 힌트일 뿐, 내구 재조회가 권위다(소스 호환 유지). */
export type WorkflowChildTerminalRun = {
  id: string;
  companyId: string;
  status: string;
};

/**
 * 자식 run 종말 훅 — child_run_id 로 linked invocation 을 발견해 전체 신원 B 를 구성하고,
 * linked 형 최종 문장 하나로 pending 부모 스텝을 정산한다. 성공은 C.status='completed' 뿐이고
 * 그 외 종말은 pending S 를 실패로 마감한다(취소 자식은 child_run_cancelled). 발견 실패/모호/
 * 비종말/세대 !=1 은 typed no-op(false)다 — plain authorization 이 없다.
 */
export async function runWorkflowChildCompletionHook(
  db: Db,
  terminalRun: WorkflowChildTerminalRun,
): Promise<boolean> {
  if (!TERMINAL_WORKFLOW_STATUSES.has(terminalRun.status)) return false;
  const invocations = await db
    .select({
      id: workflowStepInvocations.id,
      companyId: workflowStepInvocations.companyId,
      parentStepRunId: workflowStepInvocations.parentStepRunId,
      generation: workflowStepInvocations.generation,
    })
    .from(workflowStepInvocations)
    .where(and(
      eq(workflowStepInvocations.childRunId, terminalRun.id),
      eq(workflowStepInvocations.companyId, terminalRun.companyId),
      eq(workflowStepInvocations.state, "linked"),
    ))
    .limit(2);
  if (invocations.length !== 1) return false; // 없음/모호 — 정산 권위 없음.
  const invocation = invocations[0]!;
  if (invocation.generation !== 1) return false;
  // 내구 종말 재조회 — 호출자 status 는 신원 게이트일 뿐이다.
  const [childRun] = await db
    .select({ id: workflowRuns.id, companyId: workflowRuns.companyId, status: workflowRuns.status })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, terminalRun.id))
    .limit(1);
  if (!childRun || !TERMINAL_WORKFLOW_STATUSES.has(childRun.status)) return false;
  const [stepRun] = await db
    .select({ id: workflowStepRuns.id, workflowRunId: workflowStepRuns.workflowRunId, stepId: workflowStepRuns.stepId })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, invocation.parentStepRunId))
    .limit(1);
  if (!stepRun) return false;
  const identity: WorkflowChildIdentity = {
    companyId: childRun.companyId,
    parentRunId: stepRun.workflowRunId,
    parentStepRunId: stepRun.id,
    stepId: stepRun.stepId,
    invocationId: invocation.id,
    childRunId: childRun.id,
    generation: 1,
  };
  const settled = await settleLinkedChildStepFromTerminal(db, identity);
  return settled.outcome === "settled";
}
