// server/src/services/workflow/workflow-child-invocation-claim.ts
//
// [purpose] workflow→workflow 자식 dispatch 의 부모 잠금 클레임 트랜잭션 전용 모듈(fix4 §4,
//   cycle A §6). 잠금 순서: 부모 run 행 → 기존 invocation → 부모 step-run(전부 FOR UPDATE,
//   트랜잭션 시작 시 lock/statement timeout 설정). 실제 세대는 잠긴 s.retryCount+1 에서 유도하고
//   호출자 generation 은 expected 값으로만 취급한다 — 스테일 스냅숏 클레임은 부작용 없이 탈락한다.
//   대기 cap(admission)은 커밋된 wait:true 링크 요청 기준으로 이 트랜잭션 안에서 원자 판정한다.
// [authority] 모든 판정은 구조화 DB 레코드만 읽는다(규칙 7/8).
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import { createChildWorkflowRunRowInTx } from "./workflow-child-execution.js";
import { TERMINAL_WORKFLOW_STATUSES } from "../missions/mission-runtime-manager.js";
import { WORKFLOW_CHILD_MAX_CONCURRENT_WAITING } from "./workflow-child-guards.js";
import { hasMalformedWorkflowRetry, isWorkflowRetryDue, readWorkflowRetryMetadata } from "./retry-policy.js";
import {
  isChildStartAdmissionLost,
  isChildStartContention,
  ChildStartAdmissionLostError,
} from "./workflow-child-start-contention.js";

export type InvocationClaim =
  | { outcome: "created"; invocationId: string; childRunId: string; generation: number; wait: boolean }
  | { outcome: "reused"; invocationId: string; childRunId: string; generation: number; wait: boolean }
  | { outcome: "parent-cancelled" }
  | { outcome: "cap-exceeded" }
  | { outcome: "tombstone"; invocationId: string; generation: number }
  // [cycle A §6] additive — 기대 세대 불일치/자격 상실/경합. 부작용 없이 양보한다.
  | { outcome: "ineligible" }
  | { outcome: "busy" };

export type ClaimChildInvocationInput = {
  companyId: string;
  /** 잠금 하 새로 적재된 부모 run 이 자식 생성의 권위다(스테일 input.run 은 신원 확인용으로만 사용). */
  run: typeof workflowRuns.$inferSelect;
  parentStepRunId: string;
  /** 새 세대(신규 클레임/승인된 retry)만 정의의 요청 wait 를 읽는다. 재사용은 invocation.wait 가 권위. */
  incomingWait: boolean;
  /**
   * [cycle B F2] 네이티브 자식 retry admission 힌트 — DAG workflow-child dispatch 호출부만 채운다
   * (선택된 스텝이 유효한 due waiting retry 를 가질 때). DB 잠금 하 재검증되며 그 자체로 권위가 아니다.
   * 일반 dispatch/recovery/reuse 호출자는 생략한다.
   */
  nativeRetryAdmission?: {
    retryNumber: number;
    retryCount: number;
    metadata: Record<string, unknown>;
  };
  /** expected 값 — 실제 세대는 잠긴 부모 스텝의 retryCount+1 에서 유도한다(cycle A §6). */
  generation: number;
  targetWorkflowId: string;
  renderedInputs: Record<string, string>;
  now: Date;
};

/**
 * 원자적 클레임: 잠금 하 세대 유도/검증 → invocation 클레임(재사용/tombstone/세대 CAS) → 자식 run
 * 행 생성 → 링크를 하나의 트랜잭션으로 커밋한다. 커밋 승자만 이후 execute 진입(임대)에 도달할 수
 * 있다. 경합(lock_timeout/deadlock/serialization)은 부작용 없이 busy 다(cycle A §8).
 */
export async function claimChildInvocation(
  db: Db,
  input: ClaimChildInvocationInput,
): Promise<InvocationClaim> {
  const companyId = input.companyId;
  const parentStepRunId = input.parentStepRunId;
  const incomingWait = input.incomingWait;
  const expectedGeneration = input.generation;
  try {
    return await db.transaction(async (tx): Promise<InvocationClaim> => {
      // 트랜잭션 로컬 타임아웃을 첫 잠금 전에 설정한다(cycle A §6/§8 — 연결 전역 설정 아님).
      await tx.execute(sql`select set_config('lock_timeout', '500ms', true), set_config('statement_timeout', '5s', true)`);

      // (a) 부모 run 행 잠금 — 같은 run 의 형제 클레임/cap 판정/취소를 직렬화한다.
      const [parent] = await tx
        .select()
        .from(workflowRuns)
        .where(and(eq(workflowRuns.id, input.run.id), eq(workflowRuns.companyId, companyId)))
        .for("update")
        .limit(1);
      if (!parent) return { outcome: "ineligible" };
      if (TERMINAL_WORKFLOW_STATUSES.has(parent.status)) return { outcome: "parent-cancelled" };
      // [cycle A §6] 자동 클레임은 running 부모 + pending 스텝에서만 성립한다.
      if (parent.status !== "running") return { outcome: "ineligible" };

      // (b) 기존 invocation(잠금). 세대 판정은 아래 (c) 의 잠긴 스텝 유도값으로 한다.
      let [row] = await tx
        .select()
        .from(workflowStepInvocations)
        .where(eq(workflowStepInvocations.parentStepRunId, parentStepRunId))
        .for("update")
        .limit(1);
      if (row && row.companyId !== companyId) return { outcome: "ineligible" };

      // (c) 부모에 속한 "신선한" 부모 스텝을 잠그고 실제 세대를 유도한다.
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
      const generation = step.retryCount + 1;
      if (expectedGeneration !== generation) return { outcome: "ineligible" };

      if (row) {
        if (row.generation > generation) {
          // 더 새 세대가 이미 커밋됐다 — 다른 세대의 자식을 대신 돌려주지 않고 양보한다(cycle A §6).
          return { outcome: "ineligible" };
        }
        if (row.generation === generation && row.childRunId !== null) {
          // 동일 세대 + 이미 링크된 자식 → 재사용(커밋된 wait 가 권위). 멱등 재사용은 retry 표식을
          //   소비하지 않으므로 대기/dispatching 상태와 무관하게 허용된다. claimed+nonnull 은
          //   판별자 수리 전까지 재사용하지 않는다(cycle A §10 — dispatch 경로가 먼저 수리한다).
          if (row.state !== "linked") return { outcome: "ineligible" };
          return { outcome: "reused", invocationId: row.id, childRunId: row.childRunId, generation: row.generation, wait: row.wait };
        }
      }

      // [cycle B F2] nested retry 계약을 모든 분기 "이전에" 파싱한다. 없음=레거시 무retry;
      //   오작성=ineligible; waiting=future/due 무관 일반 클레임 전부 ineligible(재사용/tombstone/
      //   널클레임/구세대 교체 포함) — 해제는 nativeRetryAdmission 힌트 + 원자 admission 뿐이다.
      //   dispatching 은 retryNumber 가 잠금 retryCount 와 일치할 때 커밋된 릴리즈의 재개로만 통과.
      const metaRecord = step.metadata && typeof step.metadata === "object" && !Array.isArray(step.metadata)
        ? step.metadata as Record<string, unknown>
        : {};
      if (hasMalformedWorkflowRetry(metaRecord)) return { outcome: "ineligible" };
      const retryMeta = readWorkflowRetryMetadata(metaRecord.workflowRetry);
      if (retryMeta && retryMeta.retryNumber !== step.retryCount) return { outcome: "ineligible" };
      const retryWaiting = retryMeta?.state === "waiting";
      const sameGenerationRow = row !== undefined && row.generation === generation;
      if (retryWaiting) {
        // waiting 은 기존 링크 자식(재사용/tombstone)을 재해제하지 못한다 — admission 대상 아님.
        const admission = input.nativeRetryAdmission;
        const admissionValid = !!admission
          && admission.retryNumber === retryMeta!.retryNumber
          && admission.retryCount === step.retryCount
          && isWorkflowRetryDue(metaRecord.workflowRetry, input.now)
          && !sameGenerationRow;
        if (!admissionValid) return { outcome: "ineligible" };
      }

      if (row && row.generation === generation) {
        if (row.state === "linked") {
          // [fix3 P1-4] tombstone — 링크됐던 자식이 삭제된 영수증. 재생성하지 않고 fenced 정산.
          return { outcome: "tombstone", invocationId: row.id, generation: row.generation };
        }
        if (row.state !== "claimed") return { outcome: "ineligible" };
        // 동일 세대 + child NULL(state='claimed') → 크래시된 클레임의 회복 승자로 계속 진행.
      } else if (row) {
        // [cycle B F2] cap 은 구세대 변경/admission 메타데이터 수정 "이전에" 판정한다 —
        //     cap-exceeded 반환 후 부분 변이가 커밋되어서는 안 된다.
        if (incomingWait) {
          const [capRow] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(workflowStepInvocations)
            .innerJoin(workflowStepRuns, eq(workflowStepRuns.id, workflowStepInvocations.parentStepRunId))
            .where(and(
              eq(workflowStepRuns.workflowRunId, parent.id),
              eq(workflowStepRuns.status, "pending"),
              eq(workflowStepInvocations.wait, true),
              sql`${workflowStepInvocations.childRunId} is not null`,
            ));
          if ((capRow?.count ?? 0) >= WORKFLOW_CHILD_MAX_CONCURRENT_WAITING) {
            return { outcome: "cap-exceeded" };
          }
        }
        const cas = await tx
          .update(workflowStepInvocations)
          .set({ childRunId: null, generation, state: "claimed", wait: incomingWait })
          .where(and(
            eq(workflowStepInvocations.id, row.id),
            eq(workflowStepInvocations.generation, row.generation),
          ))
          .returning({ id: workflowStepInvocations.id });
        if (cas.length === 0) throw new Error("invocation generation CAS lost unexpectedly");
        row = { ...row, generation, childRunId: null, state: "claimed", wait: incomingWait };
      }

      // (e) CONCURRENCY cap — [fix3 P2-5] 커밋된 wait:true 링크 요청 기준(입양 메타데이터 무관).
      if (incomingWait) {
        const [capRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(workflowStepInvocations)
          .innerJoin(workflowStepRuns, eq(workflowStepRuns.id, workflowStepInvocations.parentStepRunId))
          .where(and(
            eq(workflowStepRuns.workflowRunId, parent.id),
            eq(workflowStepRuns.status, "pending"),
            eq(workflowStepInvocations.wait, true),
            sql`${workflowStepInvocations.childRunId} is not null`,
          ));
        if ((capRow?.count ?? 0) >= WORKFLOW_CHILD_MAX_CONCURRENT_WAITING) {
          return { outcome: "cap-exceeded" };
        }
      }
      if (!row) {
        // 부모 잠금이 삽입을 직렬화한다 — 충돌 시 fail-closed(cycle A §6).
        const inserted = await tx
          .insert(workflowStepInvocations)
          .values({ companyId, parentStepRunId, childRunId: null, generation, state: "claimed", wait: incomingWait })
          .onConflictDoNothing({ target: workflowStepInvocations.parentStepRunId })
          .returning();
        if (inserted.length === 0) throw new Error("invocation claim conflict under run lock — fail-closed");
        row = inserted[0];
      }
      // [cycle B F2] 네이티브 admission — waiting→dispatching 원자 전이. 자식/링크 INSERT "이전"에
      //   수행하며 관측 메타데이터 스냅숏/잠금 세대/due 시간을 한 문장으로 재검증한다. 0행은
      //   전송된 AdmissionLost 센티널로 롤백되고(부분 변이 커밋 금지) 외부에서 busy 로 변환된다.
      if (retryWaiting) {
        const admitted = await tx
          .update(workflowStepRuns)
          .set({
            metadata: sql`jsonb_set(coalesce(${workflowStepRuns.metadata}, '{}'::jsonb), '{workflowRetry,state}', '"dispatching"'::jsonb)`,
          })
          .where(and(
            eq(workflowStepRuns.id, step.id),
            eq(workflowStepRuns.workflowRunId, parent.id),
            eq(workflowStepRuns.status, "pending"),
            eq(workflowStepRuns.retryCount, step.retryCount),
            sql`(${workflowStepRuns.retryCount} + 1) = ${generation}`,
            // [cycle B F2 수정] jsonb 파라미터는 텍스트로 직렬화해 ::jsonb 캐스트한다 — 원시 JS 객체
            //   바인딩은 postgres.js 직렬화 TypeError 로 트랜잭션 전체를 깨뜨린다.
            sql`${workflowStepRuns.metadata} is not distinct from ${JSON.stringify(step.metadata ?? {})}::jsonb`,
            sql`(${workflowStepRuns.metadata}->'workflowRetry'->>'state') = 'waiting'`,
            sql`(${workflowStepRuns.metadata}->'workflowRetry'->>'nextEligibleAt')::timestamptz <= clock_timestamp()`,
          ))
          .returning({ id: workflowStepRuns.id });
        if (admitted.length === 0) throw new ChildStartAdmissionLostError();
      }

      // (f) 자식 run "행"을 같은 트랜잭션에서 생성(실행 없음). 잠금 하 새로 적재한 부모 행이
      //     권위다(스테일 input.run 금지 — cycle A §6). missionId null — 미션 런타임 격리.
      const childRunId = randomUUID();
      await createChildWorkflowRunRowInTx(tx as unknown as Db, {
        parentRun: parent,
        parentStepRunId,
        childRunId,
        targetWorkflowId: input.targetWorkflowId,
        companyId,
        renderedInputs: input.renderedInputs,
        now: input.now,
      });

      // (g) 클레임 링크 — claimed/NULL → 실제 자식(state=linked).
      const linked = await tx
        .update(workflowStepInvocations)
        .set({ childRunId, state: "linked" })
        .where(and(
          eq(workflowStepInvocations.id, row.id),
          sql`${workflowStepInvocations.childRunId} is null`,
        ))
        .returning({ id: workflowStepInvocations.id });
      if (linked.length === 0) throw new Error("invocation pending-claim link lost unexpectedly");

      return { outcome: "created", invocationId: row.id, childRunId, generation, wait: incomingWait };
    });
  } catch (error) {
    // [cycle A §8] 경합은 정산/생성 없이 busy — 호출자가 양보한다. 알 수 없는 오류는 그대로 전파.
    if (isChildStartContention(error)) return { outcome: "busy" };
    // [cycle B F2] admission CAS 소실도 롤백 후 busy — 실패 정산/무관 세대 반환 없음.
    if (isChildStartAdmissionLost(error)) return { outcome: "busy" };
    throw error;
  }
}
