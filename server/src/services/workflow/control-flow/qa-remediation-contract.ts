// server/src/services/workflow/control-flow/qa-remediation-contract.ts

import { and, count, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowTransitionEvents, workflowStepRuns } from "@paperclipai/db";
import type { WorkflowQaRemediations, WorkflowVerdictFinding } from "@paperclipai/shared";
import type { EdgeBearingStep } from "./edge-condition.js";

type StepRun = typeof workflowStepRuns.$inferSelect;

/** loop-driver 가 보는 run 의 최소 구조(구조적 호환). */
interface RemediationLoopRun {
  readonly id: string;
  readonly companyId: string;
  readonly status: string;
  readonly missionId?: string | null;
}

export const QA_REMEDIATION_EVENT_TYPE = "qa_remediation_applied";
/** QA stepRun 당 최대 remediation 시도 수(성공/실패 무관, 이벤트 수 기준). */
export const QA_REMEDIATION_MAX_ATTEMPTS = 3;
/** 단일 대상 파일 크기 상한 — 거대 산출물 실수 기록 방지. */
export const QA_REMEDIATION_MAX_FILE_BYTES = 2 * 1024 * 1024;

export type QaRemediationOutcome = "applied" | "waiting" | "not_applicable";

export interface QaRemediationPassResult {
  readonly outcome: QaRemediationOutcome;
  readonly detail?: string;
}

/** loop-driver 의 fresh 반려 QA 항목(구조만 요구). */
export interface RemediationRejectedQa {
  readonly edge: { readonly stepId: string };
  readonly qaRun?: StepRun | null;
}

export interface TryQaRemediationInput {
  readonly db: Db;
  readonly run: RemediationLoopRun;
  readonly steps: ReadonlyArray<EdgeBearingStep>;
  readonly producerStep: EdgeBearingStep;
  readonly producerRun: StepRun;
  readonly rejectedQas: readonly RemediationRejectedQa[];
  /** QA stepId → 공식 findings(없음=null). source_data 계층이 하나라도 있으면 기계적 수정 불가. */
  readonly findingsByQaStepId: ReadonlyMap<string, readonly WorkflowVerdictFinding[] | null>;
  /** QA 재실행(dag-engine wakeExistingWorkflowStepIssue 래핑). 순환 import 회피를 위해 주입받는다. */
  readonly refireQaStep: (qa: { stepId: string; stepRunId: string; issueId: string }) => Promise<boolean>;
}

export type QualifiedQa = { readonly qaRun: StepRun; readonly remediations: WorkflowQaRemediations; readonly heartbeatRunId: string | null; readonly sourceVerdictEventId: string };

export type PreparedFile = { content: string; itemCount: number; beforeHash: string };

export type QualificationResult =
  | { status: "qualified"; qualified: QualifiedQa[]; fileBuffers: Map<string, PreparedFile> }
  | { status: "waiting" | "not_applicable"; detail: string };

export async function remediationAttemptCount(db: Db, companyId: string, qaStepRunId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.workflowStepRunId, qaStepRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_EVENT_TYPE),
    ));
  return Number(row?.n ?? 0);
}

export async function remediationAlreadyApplied(
  db: Db,
  companyId: string,
  qaStepRunId: string,
  sourceVerdictEventId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: workflowTransitionEvents.id })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.workflowStepRunId, qaStepRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_EVENT_TYPE),
      eq(workflowTransitionEvents.idempotencyKey, remediationIdempotencyKey(companyId, qaStepRunId, sourceVerdictEventId)),
    ))
    .limit(1);
  return Boolean(row);
}

/** 이벤트 idempotency 키 — Quality current_output 경로가 같은 계약으로 중복 적용을 막는다. */
export function remediationIdempotencyKey(companyId: string, qaStepRunId: string, sourceVerdictEventId: string): string {
  return `qa-remediation-applied:${companyId}:${qaStepRunId}:${sourceVerdictEventId}`;
}

