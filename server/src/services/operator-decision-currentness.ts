import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, operatorDecisions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import type { OperatorDecisionTargetSnapshot } from "@paperclipai/shared/types/operator-decision";
import { conflict } from "../errors.js";
import { lockOwnerHumanRequestCard } from "./missions/owner-human-request-card.js";
import type { OwnerHumanTx } from "./missions/owner-human-request-contract.js";
import { validateAndHashOperatorDecisionCreate } from "./operator-decision-result.js";
import { stripOperatorDecisionServerContext } from "./operator-decision-server-context.js";

// [moi currentness 완화 2026-10-17] 사람 응답 대기 중 이슈 상태 churn(todo↔in_progress↔blocked)은
//   정상 — moi 카드의 currentness는 이슈 종결 여부 기준이다(라이브 사고 2026-10-17 14:30Z: 사람이 볼
//   새 없이 생성 2분 만에 stale sweep 이 issueStatus 불일치로 정당한 요청을 취소). 값 원본은
//   missions/mission-owner-human-input-card.ts 가 스냅샷 생산자다(순환 import 회피로 여기 값 복제).
export const MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE = "mission_owner_human_input";
// [moi currentness] 종결 이슈 상태 — routes/execution-workspaces.ts TERMINAL_ISSUE_STATUSES 와 같은 기준.
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

type DecisionRow = typeof operatorDecisions.$inferSelect;
function createInputFromDecision(row: DecisionRow) {
  return validateAndHashOperatorDecisionCreate({ schemaVersion: row.schemaVersion,
    requestKey: row.requestKey, priority: row.priority,
    interactionType: row.interactionType, title: row.title, description: row.description,
    sourceType: row.sourceType, sourceId: row.sourceId,
    sourceContext: stripOperatorDecisionServerContext(row.sourceContext),
    definition: row.definition, issueId: row.issueId, continuationMode: row.continuationMode }).input;
}

// C08 resolve gate: lock mission/current lifetime before the pending card CAS. The stored card is
// rebuilt byte-for-byte and checked through the same binding authority as creation.
export async function assertOwnerHumanDecisionCurrent(tx: OwnerHumanTx, row: DecisionRow): Promise<void> {
  const [binding] = await tx.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, row.companyId),
    sql`${workflowTransitionEvents.payload}->>'operatorDecisionId' = ${row.id}`)).limit(1);
  if (row.sourceType !== MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE) {
    if (!binding) return;
    throw conflict("Owner human decision is not current", {
      operatorDecisionId: row.id, code: "owner_human_decision_stale",
    });
  }
  const input = createInputFromDecision(row);
  const lifetimeCard = input.requestKey.startsWith("moi2:");
  if (!lifetimeCard && !binding) return;
  if (!lifetimeCard || !row.requestedByAgentId) throw conflict("Owner human decision is not current", {
    operatorDecisionId: row.id, code: "owner_human_decision_stale",
  });
  const guard = await lockOwnerHumanRequestCard(tx, row.companyId, input,
    { type: "agent", id: row.requestedByAgentId });
  if (!guard) throw conflict("Owner human decision is not current", {
    operatorDecisionId: row.id, code: "owner_human_decision_stale",
  });
  if (!guard.card || guard.card.id !== row.id) throw conflict("Owner human decision is not current", {
    operatorDecisionId: row.id, code: "owner_human_decision_stale",
  });
}

// [moi currentness] issueStatus 비교 정책 — "exact" 는 기존 정확-스냅샷(qa rebind·source defect 등
//   전 유형 불변), "terminal_only" 는 moi 전용 완화(열린 상태 간 전환은 통과, 종결만 mismatch).
export type IssueStatusCurrentnessPolicy = "exact" | "terminal_only";

// [currentness gate] 저장된 sourceContext 에서 대상 스냅샷을 안전하게 꺼낸다. 스냅샷은 create 시점에
//   zod 검증을 통과해 저장되며, 이전 규약 행(스냅샷 키 없음)은 null 을 반환해 기존 동작을 그대로 둔다.
export function readTargetSnapshot(sourceContext: unknown): OperatorDecisionTargetSnapshot | null {
  if (sourceContext === null || typeof sourceContext !== "object") return null;
  const candidate = (sourceContext as Record<string, unknown>).targetSnapshot;
  if (candidate === null || typeof candidate !== "object") return null;
  return candidate as OperatorDecisionTargetSnapshot;
}

// [currentness gate] 스냅샷과 현재 DB 상태를 비교해 mismatch 필드 목록만 반환한다(판정 순수 함수).
//   issueStatusPolicy="terminal_only" 는 moi 카드용 완화 — 사람 응답 대기 중 이슈 상태 churn 은
//   정상이므로 종결(done/cancelled) 도달만 mismatch 로 본다(2026-10-17 사고). 그 외 식별자
//   존재·회사 스코프·workflowRun/stepRun 비교는 죽은 대상 거부(CAS 개념)로 그대로 유지된다.
export async function collectTargetSnapshotMismatch(
  tx: Pick<Db, "select">,
  companyId: string,
  snapshot: OperatorDecisionTargetSnapshot,
  issueStatusPolicy: IssueStatusCurrentnessPolicy = "exact",
): Promise<string[]> {
  const mismatch: string[] = [];
  if (snapshot.issueId != null) {
    const issue = await tx.select({ companyId: issues.companyId, status: issues.status }).from(issues)
      .where(eq(issues.id, snapshot.issueId)).then((rows) => rows[0] ?? null);
    if (!issue || issue.companyId !== companyId) mismatch.push("issueId");
    else if (issueStatusPolicy === "terminal_only") {
      if (TERMINAL_ISSUE_STATUSES.has(issue.status)) mismatch.push("issueStatus");
    } else if (snapshot.issueStatus != null && issue.status !== snapshot.issueStatus) mismatch.push("issueStatus");
  }
  if (snapshot.workflowRunId != null) {
    const run = await tx.select({ companyId: workflowRuns.companyId, status: workflowRuns.status }).from(workflowRuns)
      .where(eq(workflowRuns.id, snapshot.workflowRunId)).then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== companyId) mismatch.push("workflowRunId");
    else if (snapshot.workflowRunStatus != null && run.status !== snapshot.workflowRunStatus) mismatch.push("workflowRunStatus");
  }
  if (snapshot.stepRunId != null) {
    const stepRun = await tx.select({
      status: workflowStepRuns.status,
      executionGeneration: workflowStepRuns.executionGeneration,
      runCompanyId: workflowRuns.companyId,
    }).from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
      .where(eq(workflowStepRuns.id, snapshot.stepRunId)).then((rows) => rows[0] ?? null);
    if (!stepRun || stepRun.runCompanyId !== companyId) mismatch.push("stepRunId");
    else {
      if (snapshot.stepRunStatus != null && stepRun.status !== snapshot.stepRunStatus) mismatch.push("stepRunStatus");
      if (snapshot.executionGeneration != null && stepRun.executionGeneration !== snapshot.executionGeneration) {
        mismatch.push("executionGeneration");
      }
    }
  }
  return mismatch;
}

// [currentness gate] 늦은 선택 보호 — 생성 시점 스냅샷과 현재 DB 상태를 CAS 트랜잭션 안에서 같은 tx로
//   재검증한다(검사-저장 창 최소화). 회사 스코프에서 행이 사라졌거나 지정한 상태·generation이 다르면
//   409 target_changed. throw 로 트랜잭션이 롤백되므로 결과 저장·continuation 생성이 모두 취소되고
//   카드는 pending 유지 — 상태가 원복되면 같은 카드로 다시 resolve 할 수 있다(거부는 영구적이지 않음).
export async function assertTargetSnapshotCurrent(
  tx: Pick<Db, "select">,
  operatorDecisionId: string,
  companyId: string,
  snapshot: OperatorDecisionTargetSnapshot,
  issueStatusPolicy: IssueStatusCurrentnessPolicy = "exact",
): Promise<void> {
  const mismatch = await collectTargetSnapshotMismatch(tx, companyId, snapshot, issueStatusPolicy);
  if (mismatch.length > 0) {
    throw conflict("Operator decision target changed since card creation", {
      code: "target_changed",
      mismatch,
      operatorDecisionId,
    });
  }
}

