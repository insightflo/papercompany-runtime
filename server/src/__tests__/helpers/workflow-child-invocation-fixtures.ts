// server/src/__tests__/helpers/workflow-child-invocation-fixtures.ts
//
// [purpose] descope v1 법정 자식 상태(설계 §2) 전용 삽입 헬퍼. 커밋된 claimed 행은 deferred
//   트리거가 기계적으로 차단하므로 어떤 fixture 도 그것을 만들지 않는다 — linked+nonnull(정상),
//   linked+NULL(tombstone), receipt+step rows(materialized), token+lease 쌍(CHECK 준수)만 생성.
//   db 는 호출부가 인자로 넘긴다(은닉 모듈 상태 없음).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";

export type WorkflowChildIdentityFixture = {
  companyId: string;
  parentRunId: string;
  parentStepRunId: string;
  stepId: string;
  invocationId: string;
  childRunId: string;
  generation: 1;
};

/**
 * linked 자식 — 자식 run 행 + linked invocation 을 한 트랜잭션으로 삽입한다(법정 Linked 상태).
 * 커밋 시점 최종 상태가 linked 이므로 deferred 트리거를 통과한다(§2 Constructing 은 커밋 불가).
 */
export async function insertLinkedInvocation(
  db: Db,
  input: {
    companyId: string;
    parentRunId: string;
    parentStepRunId: string;
    childWorkflowId: string;
    stepId?: string;
    childStatus?: string;
    childInputs?: Record<string, string>;
  },
): Promise<WorkflowChildIdentityFixture> {
  const stepId = input.stepId ?? "run-child";
  const childRunId = randomUUID();
  const invocationId = randomUUID();
  await db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ rootRunId: workflowRuns.rootRunId })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, input.parentRunId))
      .limit(1);
    await tx.insert(workflowRuns).values({
      id: childRunId,
      workflowId: input.childWorkflowId,
      companyId: input.companyId,
      status: input.childStatus ?? "pending",
      triggeredBy: "workflow-step",
      triggerSource: "workflow",
      parentRunId: input.parentRunId,
      parentStepRunId: input.parentStepRunId,
      rootRunId: parent?.rootRunId ?? input.parentRunId,
      metadata: { workflowChildInputs: input.childInputs ?? {} },
    });
    await tx.insert(workflowStepInvocations).values({
      id: invocationId,
      companyId: input.companyId,
      parentStepRunId: input.parentStepRunId,
      childRunId,
      state: "linked",
      generation: 1,
      targetWorkflowId: input.childWorkflowId,
    });
  });
  return {
    companyId: input.companyId,
    parentRunId: input.parentRunId,
    parentStepRunId: input.parentStepRunId,
    stepId,
    invocationId,
    childRunId,
    generation: 1,
  };
}

/** [D4] 삭제 tombstone — linked+NULL, generation 1. 자식 행은 존재하지 않는다. */
export async function insertTombstoneInvocation(
  db: Db,
  input: { companyId: string; parentStepRunId: string; targetWorkflowId: string },
): Promise<{ invocationId: string; generation: 1 }> {
  const invocationId = randomUUID();
  await db.insert(workflowStepInvocations).values({
    id: invocationId,
    companyId: input.companyId,
    parentStepRunId: input.parentStepRunId,
    childRunId: null,
    state: "linked",
    generation: 1,
    targetWorkflowId: input.targetWorkflowId,
  });
  return { invocationId, generation: 1 };
}

/**
 * materialized 자식 — 자식 run + 초기 스텝 행 + child_start_materialized_at 영수증을 한
 * 트랜잭션으로 원자 삽입한다. 영수증은 초기 스텝 materialization 증명(provider 실행 증명 아님),
 * 임대 쌍은 소거. stepIds 기본 ["child-a"] — 빈 정의는 [] 로 영수증만 쓴다(법정 empty child).
 */
export async function insertMaterializedChildRun(
  db: Db,
  input: {
    companyId: string;
    parentRunId: string;
    parentStepRunId: string;
    childWorkflowId: string;
    stepIds?: string[];
    childStatus?: string;
    stepId?: string;
  },
): Promise<WorkflowChildIdentityFixture> {
  const stepId = input.stepId ?? "run-child";
  const childRunId = randomUUID();
  const invocationId = randomUUID();
  await db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ rootRunId: workflowRuns.rootRunId })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, input.parentRunId))
      .limit(1);
    await tx.insert(workflowRuns).values({
      id: childRunId,
      workflowId: input.childWorkflowId,
      companyId: input.companyId,
      status: input.childStatus ?? "running",
      triggeredBy: "workflow-step",
      triggerSource: "workflow",
      parentRunId: input.parentRunId,
      parentStepRunId: input.parentStepRunId,
      rootRunId: parent?.rootRunId ?? input.parentRunId,
      childStartMaterializedAt: new Date(),
      metadata: {},
    });
    const stepIds = input.stepIds ?? ["child-a"];
    if (stepIds.length > 0) {
      await tx.insert(workflowStepRuns).values(
        stepIds.map((childStepId) => ({
          id: randomUUID(),
          workflowRunId: childRunId,
          stepId: childStepId,
          status: "pending",
          retryCount: 0,
        })),
      );
    }
    await tx.insert(workflowStepInvocations).values({
      id: invocationId,
      companyId: input.companyId,
      parentStepRunId: input.parentStepRunId,
      childRunId,
      state: "linked",
      generation: 1,
      targetWorkflowId: input.childWorkflowId,
    });
  });
  return {
    companyId: input.companyId,
    parentRunId: input.parentRunId,
    parentStepRunId: input.parentStepRunId,
    stepId,
    invocationId,
    childRunId,
    generation: 1,
  };
}

/**
 * 자식 시작 임대 쌍 — pair CHECK((token is null) = (lease is null)) 을 존중한다.
 * "active"(토큰+생존 임대+미래 마감) | "expired-lease"(임대 경과, 마감 미래 — 재취득 가능)
 * | "expired-deadline"(절대 마감 경과). 자식은 running 으로 맞춘다(초기화 시작된 법정 상태).
 */
export async function insertChildStartLease(
  db: Db,
  input: { childRunId: string; mode: "active" | "expired-lease" | "expired-deadline" },
): Promise<string> {
  const now = Date.now();
  const token = randomUUID();
  await db
    .update(workflowRuns)
    .set({
      childStartToken: token,
      childStartLeaseExpiresAt: input.mode === "active" ? new Date(now + 60_000) : new Date(now - 1_000),
      childStartDeadlineAt: input.mode === "expired-deadline" ? new Date(now - 1_000) : new Date(now + 300_000),
      status: "running",
      startedAt: new Date(now - 5_000),
    })
    .where(eq(workflowRuns.id, input.childRunId));
  return token;
}

/**
 * grandchild — 자식 run 을 부모로 하는 완전한 linked 신원. 중간 run 에 workflow 스텝 행을 만들고
 * 그 스텝에 linked 손자 run + invocation 을 붙인다(설계 §6: 손자도 완전한 linked identity).
 */
export async function insertGrandchildInvocation(
  db: Db,
  input: {
    companyId: string;
    parentRunId: string; // 자식 run(중간 부모)
    grandchildWorkflowId: string;
    grandchildStepId?: string;
    childStepStatus?: string;
    grandchildStatus?: string;
  },
): Promise<WorkflowChildIdentityFixture & { grandchildStepRunId: string }> {
  const grandchildStepRunId = randomUUID();
  await db.insert(workflowStepRuns).values({
    id: grandchildStepRunId,
    workflowRunId: input.parentRunId,
    stepId: input.grandchildStepId ?? "run-grandchild",
    status: input.childStepStatus ?? "pending",
    retryCount: 0,
  });
  const identity = await insertLinkedInvocation(db, {
    companyId: input.companyId,
    parentRunId: input.parentRunId,
    parentStepRunId: grandchildStepRunId,
    childWorkflowId: input.grandchildWorkflowId,
    childStatus: input.grandchildStatus,
  });
  return { ...identity, grandchildStepRunId };
}

/**
 * [비정합 fixture — fail-closed 거부 테스트 전용] 부모 표지는 있지만 invocation 링크가 없는
 * child-marked run. 설계 §2 표 밖 상태로, 이 삽입 자체가 테스트하는 fail-closed 경계의 입력이다
 * (discovery 가 invalid-child 로 분류해야 한다). 실행 경로는 이 상태를 절대 만들지 않는다.
 */
export async function insertOrphanChildMarkedRun(
  db: Db,
  input: {
    companyId: string;
    parentRunId: string;
    parentStepRunId: string;
    childWorkflowId: string;
  },
): Promise<string> {
  const childRunId = randomUUID();
  await db.insert(workflowRuns).values({
    id: childRunId,
    workflowId: input.childWorkflowId,
    companyId: input.companyId,
    status: "pending",
    triggeredBy: "workflow-step",
    triggerSource: "workflow",
    parentRunId: input.parentRunId,
    parentStepRunId: input.parentStepRunId,
    rootRunId: input.parentRunId,
  });
  return childRunId;
}
