// server/src/services/workflow/workflow-step-issue-records.ts
//
// [purpose] T3 §2 정식 기록·감사 추출. workflow step run ↔ issue 연결의 DB 전용 코어.
//   Quality 대상 DAG 계약(이슈+step 연결 commit → 깨우기)과 정식 생성 트랜잭션이 같은
//   함수를 쓴다. CAS 바인딩은 0행이면 예외로 전체 트랜잭션을 롤백시킨다(부분 상태 금지).
//   외부 효과(깨우기·이벤트)는 없다.

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, missions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import type { NativeBinding } from "@paperclipai/shared";

export type WorkflowStepIssueDb = Pick<Db, "select" | "insert" | "update">;

export type WorkflowStepRunRecord = typeof workflowStepRuns.$inferSelect;

/** issue 상태 → step-run 상태 순수 매핑(dag-engine 동일 의미, T3 §2 추출). */
export function desiredStepRunStatusFromIssueStatus(issueStatus: string): "pending" | "running" | "completed" | "failed" {
  if (issueStatus === "done") return "completed";
  if (issueStatus === "blocked" || issueStatus === "cancelled") return "failed";
  if (issueStatus === "in_progress" || issueStatus === "in_review") return "running";
  return "pending";
}

/** issue 행을 issueId 기준 첫 등장 순으로 중복 제거(순수 함수, T3 §2 추출). */
export function uniqueIssueRowsByIssueId<T extends { issueId: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const row of rows) {
    if (seen.has(row.issueId)) continue;
    seen.add(row.issueId);
    unique.push(row);
  }
  return unique;
}

/** 첫 단계 step run 행 생성(pending). 정의 해시 재검증은 호출자 책임이다. */
export async function createWorkflowStepRunRecord(
  dbOrTx: WorkflowStepIssueDb,
  input: { workflowRunId: string; stepId: string; metadata?: Record<string, unknown> },
): Promise<WorkflowStepRunRecord> {
  const [row] = await dbOrTx
    .insert(workflowStepRuns)
    .values({
      id: randomUUID(),
      workflowRunId: input.workflowRunId,
      stepId: input.stepId,
      status: "pending",
      metadata: input.metadata ?? {},
    })
    .returning();
  return row!;
}

/**
 * step run ↔ issue CAS 바인딩. issueId 가 이미 있으면 0행 → conflict 로 전체 rollback.
 * (run, step) 유일 인덱스와 함께 같은 실행에 두 이슈가 붙는 것을 막는다.
 */
export async function bindWorkflowStepIssueRecord(
  dbOrTx: WorkflowStepIssueDb,
  input: { companyId: string; stepRunId: string; issueId: string },
): Promise<void> {
  const rows = await dbOrTx
    .update(workflowStepRuns)
    .set({ issueId: input.issueId })
    .where(and(
      eq(workflowStepRuns.id, input.stepRunId),
      isNull(workflowStepRuns.issueId),
    ))
    .returning({ id: workflowStepRuns.id });
  if (rows.length === 0) {
    throw conflict("quality_step_issue_binding_conflict");
  }
}

/**
 * 저장된 canonical binding 의 정확한 join 재조회. mission/run/step/issue 전부가 회사 스코프로
 * 실제 존재하고 서로 연결돼 있어야 통과. 하나라도 어긋나면 conflict(롤백).
 */
export async function verifyCanonicalBindingJoin(
  dbOrTx: WorkflowStepIssueDb,
  binding: NativeBinding,
): Promise<void> {
  const rows = await dbOrTx
    .select({ missionId: missions.id, workflowRunId: workflowRuns.id, stepRunId: workflowStepRuns.id, issueId: issues.id })
    .from(missions)
    .innerJoin(workflowRuns, and(eq(workflowRuns.missionId, missions.id), eq(workflowRuns.companyId, missions.companyId)))
    .innerJoin(workflowStepRuns, and(eq(workflowStepRuns.workflowRunId, workflowRuns.id), eq(workflowStepRuns.id, binding.stepRunId), eq(workflowStepRuns.issueId, binding.issueId)))
    .innerJoin(issues, and(eq(issues.companyId, missions.companyId), eq(issues.id, workflowStepRuns.issueId), eq(issues.missionId, missions.id)))
    .where(and(eq(missions.companyId, binding.companyId), eq(missions.id, binding.missionId), eq(workflowRuns.id, binding.workflowRunId), eq(issues.id, binding.issueId)))
    .limit(2);
  if (rows.length !== 1 || rows[0]!.issueId !== binding.issueId || rows[0]!.stepRunId !== binding.stepRunId) {
    throw conflict("quality_canonical_binding_join_mismatch");
  }
}
