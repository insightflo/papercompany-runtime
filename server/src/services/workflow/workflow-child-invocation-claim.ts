// server/src/services/workflow/workflow-child-invocation-claim.ts
//
// [purpose] descope v1 — workflow→workflow 자식 dispatch 의 부모 잠금 클레임 트랜잭션 전용 모듈.
//   단일 트랜잭션/단일 invocation: ID 사전 할당 → 정의 행 FOR SHARE(정렬 잠금, D6 직렬화) →
//   부모 run → 기존 invocation → 부모 step-run 순 FOR UPDATE. 세대는 항상 1(D2 — 교체/CAS/
//   재시도 admission 은 존재하지 않는다). 대기 cap(부모당 pending workflow 스텝 5개)은 커밋된
//   invocation 기준으로 부모 잠금 하 원자 판정하며, 재사용은 슬롯을 소모하지 않는다. 생성은
//   CREATE 형 최종 변이(workflow-child-create-forms)로만 이뤄진다 — 0행은 전체 롤백.
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8). 실패 닫힘: 인식 불가 상태는
//   invalid-state 로 반환하고 실행 행을 변경하지 않는다.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowDefinitions,
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  insertChildWorkflowRunRow,
  insertInvocationClaimRow,
  linkInvocationToCreatedChildRow,
} from "./workflow-child-create-forms.js";
import { WORKFLOW_CHILD_MAX_CONCURRENT_WAITING } from "./workflow-child-guards.js";
import {
  isChildStartContention,
} from "./workflow-child-start-contention.js";
import { TERMINAL_WORKFLOW_STATUSES } from "../missions/mission-runtime-manager.js";

export type InvocationClaim =
  | { outcome: "created"; invocationId: string; childRunId: string; generation: 1 }
  | { outcome: "reused"; invocationId: string; childRunId: string; generation: 1 }
  | { outcome: "parent-cancelled" }
  | { outcome: "cap-exceeded" }
  | { outcome: "tombstone"; invocationId: string; generation: 1 }
  /** 설계 §2 표 밖 상태(커밋된 claimed, 세대 !=1 등) — fail-closed, 실행 행 무변경. */
  | { outcome: "invalid-state"; reason: string }
  | { outcome: "ineligible" }
  | { outcome: "busy" };

export type ClaimChildInvocationInput = {
  companyId: string;
  /** 잠금 하 새로 적재된 부모 run 이 자식 생성의 권위다(스테일 input.run 은 신원 확인용으로만 사용). */
  run: typeof workflowRuns.$inferSelect;
  parentStepRunId: string;
  stepId: string;
  generation: 1;
  targetWorkflowId: string;
  renderedInputs: Record<string, string>;
  now: Date;
};

/**
 * 원자적 클레임: 정의 잠금 → 부모/invocation/스텝 잠금 하 검증 → invocation CREATE → 자식 run
 * 행 CREATE → construction 링크를 하나의 트랜잭션으로 커밋한다. 커밋 승자만 이후 임대 진입에
 * 도달할 수 있다. 경합(lock_timeout/deadlock/serialization)은 부작용 없이 busy 다.
 */
export async function claimChildInvocation(
  db: Db,
  input: ClaimChildInvocationInput,
): Promise<InvocationClaim> {
  const companyId = input.companyId;
  const parentStepRunId = input.parentStepRunId;
  // [D2] 세대는 항상 1 — 호출자가 다른 세대를 보내면 변이 전에 거부한다.
  if (input.generation !== 1) {
    return { outcome: "invalid-state", reason: "workflow child invocation generation must be 1" };
  }
  try {
    return await db.transaction(async (tx): Promise<InvocationClaim> => {
      // 트랜잭션 로컬 타임아웃을 첫 잠금 전에 설정한다(연결 전역 설정 아님).
      await tx.execute(sql`select set_config('lock_timeout', '500ms', true), set_config('statement_timeout', '5s', true)`);

      // (a) ID 사전 할당 — 첫 INSERT 이전에 invocation/자식 ID 를 확정한다(설계 §3).
      const invocationId = randomUUID();
      const childRunId = randomUUID();

      // (b) [r8 finding 1] 비잠금 P 예독 — 부모 정의 ID 발견 전용. 정의 행을 P 잠금 "이전에"
      //     정렬 잠금하기 위해 필요하다(claim vs archive/delete 역전 제거). 예독값은 아래 (d)
      //     에서 잠긴 P 행과 재비교된다(드리프트 시 ineligible — 다른 정의를 기회적으로 잠그지
      //     않는다). 스테일 예독은 신원 확인용일 뿐 권위가 없다.
      const [discovered] = await tx
        .select({
          id: workflowRuns.id,
          workflowId: workflowRuns.workflowId,
          companyId: workflowRuns.companyId,
        })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.id, input.run.id), eq(workflowRuns.companyId, companyId)))
        .limit(1);
      if (!discovered || discovered.workflowId === input.targetWorkflowId) {
        return { outcome: "ineligible" };
      }

      // (c) 정의 행 정렬 잠금 FOR SHARE — 발견된 부모 정의 + 대상 정의, ID 정렬 순(claim vs
      //     archive/delete 잠금 역전 방지, D6/r8). 같은 회사 + active 만 통과한다.
      const definitionIds = [discovered.workflowId, input.targetWorkflowId].sort();
      const definitionRows = await tx
        .select({ id: workflowDefinitions.id, companyId: workflowDefinitions.companyId, status: workflowDefinitions.status })
        .from(workflowDefinitions)
        .where(inArray(workflowDefinitions.id, definitionIds))
        .orderBy(workflowDefinitions.id)
        .for("share");
      if (definitionRows.length !== 2) return { outcome: "ineligible" };
      for (const definition of definitionRows) {
        if (definition.companyId !== companyId) return { outcome: "ineligible" };
        if (definition.status !== "active") return { outcome: "ineligible" };
      }

      // (d) 부모 run 행 잠금 — 같은 run 의 형제 클레임/cap 판정/취소를 직렬화하고, 예독 발견값과
      //     현재 정의/회사 신원을 비교한다(발견→잠금 사이 정의 변경/이전은 ineligible —
      //     다른 정의 행을 추가로 잠그지 않는다).
      const [parent] = await tx
        .select()
        .from(workflowRuns)
        .where(and(eq(workflowRuns.id, input.run.id), eq(workflowRuns.companyId, companyId)))
        .for("update")
        .limit(1);
      if (!parent) return { outcome: "ineligible" };
      if (
        parent.workflowId !== discovered.workflowId
        || parent.companyId !== discovered.companyId
      ) {
        return { outcome: "ineligible" };
      }
      if (TERMINAL_WORKFLOW_STATUSES.has(parent.status)) return { outcome: "parent-cancelled" };
      if (parent.status !== "running") return { outcome: "ineligible" };

      // (d) 기존 invocation 잠금. 회사 불일치는 fail-closed(ineligible).
      const [row] = await tx
        .select()
        .from(workflowStepInvocations)
        .where(eq(workflowStepInvocations.parentStepRunId, parentStepRunId))
        .for("update")
        .limit(1);
      if (row && row.companyId !== companyId) return { outcome: "ineligible" };

      // (e) 부모에 속한 부모 스텝을 잠그고 descope CURRENT(세대1/retryCount0/무 retry 메타데이터)를
      //     검증한다. 재시도 메타데이터/횟수가 있는 workflow 스텝은 클레임 자체를 거부한다(D2.3).
      const [step] = await tx
        .select()
        .from(workflowStepRuns)
        .where(and(
          eq(workflowStepRuns.id, parentStepRunId),
          eq(workflowStepRuns.workflowRunId, parent.id),
        ))
        .for("update")
        .limit(1);
      if (!step) return { outcome: "ineligible" };
      if (step.status !== "pending") return { outcome: "ineligible" };
      if (step.retryCount !== 0) {
        return { outcome: "invalid-state", reason: "workflow parent step has nonzero retryCount" };
      }
      if (hasWorkflowRetryKey(step.metadata)) {
        return { outcome: "invalid-state", reason: "workflow parent step carries workflowRetry metadata" };
      }

      // (f) 기존 invocation 판정 — linked 자식 재사용 / tombstone / 인식 불가 상태 fail-closed.
      if (row) {
        if (row.generation !== 1) {
          return { outcome: "invalid-state", reason: "workflow child invocation generation is not 1" };
        }
        if (row.state === "linked") {
          if (row.childRunId !== null) {
            // 동일 세대 + 이미 링크된 자식 → 엄격 검증 후 재사용(슬롯 미소모).
            return { outcome: "reused", invocationId: row.id, childRunId: row.childRunId, generation: 1 };
          }
          // [D4] tombstone — 링크됐던 자식이 삭제된 영수증. 재생성하지 않고 fenced 정산.
          return { outcome: "tombstone", invocationId: row.id, generation: 1 };
        }
        // 커밋된 claimed 행(및 기타 상태)은 설계 §2 표 밖 — 수리/재사용 없이 fail-closed.
        return { outcome: "invalid-state", reason: `committed invocation state ${row.state} is not a legal runtime state` };
      }

      // (g) CONCURRENCY cap — 커밋된 invocation 기준(입양/자식 상태 무관, 정산 전까지).
      //     tombstone 포함 pending 부모 스텝의 invocation 을 센다. 불량 데이터도 슬롯으로 센다.
      const [capRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(workflowStepInvocations)
        .innerJoin(workflowStepRuns, eq(workflowStepRuns.id, workflowStepInvocations.parentStepRunId))
        .where(and(
          eq(workflowStepRuns.workflowRunId, parent.id),
          eq(workflowStepRuns.status, "pending"),
        ));
      if ((capRow?.count ?? 0) >= WORKFLOW_CHILD_MAX_CONCURRENT_WAITING) {
        return { outcome: "cap-exceeded" };
      }

      // (h) invocation CREATE(설계 §4 row 2) — 회사/P/S/step ID, running 부모, CURRENT, 기존 I
      //     부재, generation 1, 양쪽 정의 active/동일 회사를 단일 문장에서 바인딩한다.
      const insertedInvocation = await insertInvocationClaimRow(tx as unknown as Db, {
        companyId,
        parentRunId: parent.id,
        parentStepRunId,
        stepId: step.stepId,
        invocationId,
        targetWorkflowId: input.targetWorkflowId,
        generation: 1,
      });
      if (insertedInvocation !== 1) {
        throw new Error("invocation claim CREATE lost under parent/definition lock — fail-closed");
      }

      // (i) 자식 run "행" CREATE(설계 §4 row 3) — 실행 없음. tx-local claimed/NULL invocation +
      //     P/S 연관 + CURRENT + 대상 정의를 같은 문장에서 바인딩한다. missionId NULL.
      const insertedChild = await insertChildWorkflowRunRow(tx as unknown as Db, {
        companyId,
        parentRunId: parent.id,
        parentStepRunId,
        stepId: step.stepId,
        invocationId,
        childRunId,
        targetWorkflowId: input.targetWorkflowId,
        renderedInputs: input.renderedInputs,
        now: input.now,
        generation: 1,
      });
      if (insertedChild !== 1) {
        throw new Error("child run CREATE lost under parent/definition lock — fail-closed");
      }

      // (j) construction 링크(설계 §4 row 5) — claimed/NULL → linked. 0행은 전체 클레임 롤백.
      const linked = await linkInvocationToCreatedChildRow(tx as unknown as Db, {
        companyId,
        parentRunId: parent.id,
        parentStepRunId,
        stepId: step.stepId,
        invocationId,
        childRunId,
        generation: 1,
      });
      if (linked !== 1) {
        throw new Error("invocation construction link lost — entire claim rolls back");
      }

      return { outcome: "created", invocationId, childRunId, generation: 1 };
    });
  } catch (error) {
    // 경합은 정산/생성 없이 busy — 호출자가 양보한다. 알 수 없는 오류는 그대로 전파(롤백 후).
    if (isChildStartContention(error)) return { outcome: "busy" };
    throw error;
  }
}

/** workflowRetry 키 존재(null/비정형 포함) — D2.3: 어떤 형태로든 공급되면 거부한다. */
function hasWorkflowRetryKey(metadata: unknown): boolean {
  return metadata !== null
    && typeof metadata === "object"
    && !Array.isArray(metadata)
    && Object.prototype.hasOwnProperty.call(metadata, "workflowRetry");
}
