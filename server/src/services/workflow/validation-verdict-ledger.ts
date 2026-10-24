import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueExecutionCards,
  issues,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { loadExecutionDefinition } from "./execution-definition.js";
import { workflowVerdictFindingsSchema } from "@paperclipai/shared";
import { recordWorkflowValidationVerdict as writeWorkflowValidationVerdict } from "./workflow-verdict-write.js";
import {
  asRecord,
  heartbeatRunScopedToIssue,
  hasWorkflowValidationCompletionLedger as readWorkflowValidationCompletionLedger,
} from "./workflow-verdict-current.js";
export {
  heartbeatRunScopedToIssue,
  loadLatestNonblockingAcceptance,
  loadLatestQaRemediations,
} from "./workflow-verdict-current.js";
import type {
  WorkflowNonblockingAcceptance,
  WorkflowQaRemediations,
  WorkflowValidationVerdictValue,
  WorkflowVerdictFinding,
} from "@paperclipai/shared";

type IssueRow = typeof issues.$inferSelect;
type WorkflowValidationDb = Pick<Db, "select" | "insert">;
type WorkflowValidationIssue = Pick<IssueRow, "id" | "companyId" | "missionId" | "originKind" | "title" | "startedAt">;

export type WorkflowValidationLedgerResult = {
  readonly isCandidate: boolean;
  readonly satisfied: boolean;
  readonly verdict: WorkflowValidationVerdictValue | null;
  readonly workflowRunId: string | null;
  readonly workflowStepRunId: string | null;
  readonly stepId: string | null;
  /** [verdict abstention] 최신 공식 판정이 insufficient_evidence 일 때 true. satisfied=false 와 함께
   *    미제출(missing) 과 구분되는 완료 차단 사유로 소비된다(heartbeat 완료 게이트). */
  readonly insufficientEvidence: boolean;
  /** [verdict abstention] insufficient_evidence 판정의 reason(payload, bounded). 없으면 null. */
  readonly insufficientEvidenceReason: string | null;
};

type StepLike = {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly title?: unknown;
  readonly type?: unknown;
};

type WorkflowValidationContext = {
  readonly isCandidate: boolean;
  readonly workflowRunId: string | null;
  readonly workflowStepRunId: string | null;
  readonly stepId: string | null;
};

type ResolveWorkflowValidationContextMode = "completion" | "record";

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isLegacyWorkflowValidationStep(issue: WorkflowValidationIssue, step: StepLike | null): boolean {
  if (issue.originKind !== "workflow_execution") return false;
  const title = trimmedString(issue.title) ?? "";
  const stepId = trimmedString(step?.id) ?? "";
  const stepType = trimmedString(step?.type)?.toLowerCase() ?? "";
  return /^\s*\[QA\]/iu.test(title) ||
    /^qa[-_]/iu.test(stepId) ||
    ["qa", "validation", "validator"].includes(stepType);
}

function cardRequiresWorkflowValidationVerdict(value: unknown): boolean | null {
  const card = asRecord(value);
  if (Object.keys(card).length === 0) return null;
  const requiredOutputs = asRecord(card.requiredOutputs);
  const verdict = asRecord(requiredOutputs.verdict);
  return typeof verdict.required === "boolean" ? verdict.required : null;
}

async function readWorkflowValidationCompletionRequirement(
  db: WorkflowValidationDb,
  issue: WorkflowValidationIssue,
): Promise<boolean | null> {
  const row = await db
    .select({ cardJson: issueExecutionCards.cardJson })
    .from(issueExecutionCards)
    .where(and(
      eq(issueExecutionCards.companyId, issue.companyId),
      eq(issueExecutionCards.issueId, issue.id),
    ))
    .orderBy(desc(issueExecutionCards.updatedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row ? cardRequiresWorkflowValidationVerdict(row.cardJson) : null;
}


export async function resolveWorkflowValidationContext(
  db: WorkflowValidationDb,
  issue: WorkflowValidationIssue,
  options: { readonly mode?: ResolveWorkflowValidationContextMode } = {},
): Promise<WorkflowValidationContext> {
  const stepRun = await db
    .select({
      id: workflowStepRuns.id,
      workflowRunId: workflowStepRuns.workflowRunId,
      stepId: workflowStepRuns.stepId,
    })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.issueId, issue.id))
    .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  // [task5a2b] linked run 이 있으면 항상 실행정의를 로더로 검증한다(record/completion·card 무관).
  //   WorkflowValidationDb 는 Pick<Db,"select"|"insert"> 지만 loader 는 SELECT-only 라서 select 표면만 요구한다
  //   (loader read 입력은 Pick<Db,"select"> 로 확장됨 — mutation 요구 신규 추가 없음). missing/corrupt 는 422.
  const steps = stepRun
    ? (await loadExecutionDefinition(db, stepRun.workflowRunId, { requireHistorical: false })).steps
    : [];
  const step = steps.find((candidate) => trimmedString(candidate.id) === stepRun?.stepId) ?? null;
  const hasStepRunContext = Boolean(stepRun?.workflowRunId && stepRun.id);
  const mode = options.mode ?? "completion";
  const recordableWorkflowStep = issue.originKind === "workflow_execution" && hasStepRunContext;
  const cardRequirement = mode === "completion" && recordableWorkflowStep
    ? await readWorkflowValidationCompletionRequirement(db, issue)
    : null;
  const completionRequired = mode === "record"
    ? recordableWorkflowStep
    : recordableWorkflowStep && (cardRequirement ?? isLegacyWorkflowValidationStep(issue, step));

  return {
    isCandidate: completionRequired,
    workflowRunId: stepRun?.workflowRunId ?? null,
    workflowStepRunId: stepRun?.id ?? null,
    stepId: stepRun?.stepId ?? null,
  };
}

export async function recordWorkflowValidationVerdict(input: {
  readonly db: WorkflowValidationDb;
  readonly issue: WorkflowValidationIssue;
  readonly verdict: WorkflowValidationVerdictValue;
  readonly source: "workflow_api";
  readonly actorAgentId?: string | null;
  readonly heartbeatRunId?: string | null;
  readonly sourceText?: string | null;
  readonly nonblockingAcceptance?: WorkflowNonblockingAcceptance | null;
  readonly findings?: readonly WorkflowVerdictFinding[] | null;
  readonly remediations?: WorkflowQaRemediations | null;
}): Promise<WorkflowValidationLedgerResult> {
  return writeWorkflowValidationVerdict(input, resolveWorkflowValidationContext);
}

/**
 * [rework feedback authority] reads the request-changes rationale from the LATEST official
 * workflow_api verdict event exactly bound to the QA issue's current run + step (and a checked-out
 * heartbeat run scoped to that issue). This is the only rework-feedback source; comments/stdout are
 * not parsed. Returns null when no authoritative reason is present.
 */
export async function loadWorkflowApiFeedback(input: {
  readonly db: Pick<Db, "select">;
  readonly companyId: string;
  readonly issueId: string;
  readonly workflowRunId: string;
  readonly workflowStepRunId: string;
}): Promise<string | null> {
  const [row] = await input.db
    .select({
      payload: workflowTransitionEvents.payload,
      heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
      createdAt: workflowTransitionEvents.createdAt,
    })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId),
      eq(workflowTransitionEvents.issueId, input.issueId),
      eq(workflowTransitionEvents.workflowRunId, input.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, input.workflowStepRunId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.reason, "workflow_api"),
      eq(workflowTransitionEvents.verdict, "request_changes"),
      isNotNull(workflowTransitionEvents.heartbeatRunId),
    ))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id))
    .limit(1);
  if (!row) return null;
  if (!(await heartbeatRunScopedToIssue(input.db, row.heartbeatRunId, { companyId: input.companyId, issueId: input.issueId }))) {
    return null;
  }
  const reason = asRecord(row.payload).reason;
  const observedAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : "unknown-time";
  return typeof reason === "string" && reason.trim().length > 0
    ? `### QA feedback at ${observedAt}\n${reason.trim().slice(0, 4000)}`
    : null;
}

/**
 * [qa defect layer] loads the STRUCTURED defect-layer findings from the LATEST official workflow_api
 *   request_changes verdict event exactly bound to the QA issue's current run + step (and a checked-out
 *   heartbeat run scoped to that issue). Mirrors loadWorkflowApiFeedback's authority rules — comments,
 *   stdout, and prose are never parsed. Returns null when the latest authoritative request_changes
 *   verdict carries no schema-valid findings (legacy verdicts stay on the existing rework path).
 */
export type OfficialFindingsQueryInput = {
  readonly db: Pick<Db, "select">;
  readonly companyId: string;
  readonly issueId: string;
  readonly workflowRunId: string;
  readonly workflowStepRunId: string;
};

/**
 * [internal] loadWorkflowApiFindings / loadPriorRejectedFindings 공통 조회 — 같은
 *   (companyId, issueId, workflowRunId, workflowStepRunId) 의 공식 workflow_api request_changes
 *   판정 이벤트를 createdAt desc, id desc 로 읽고 `skipLatest` 번째(0=이번 세대, 1=직전 세대)
 *   이벤트의 findings 를 파싱한다. 파싱/스코프 검증 규칙은 양쪽이 완전히 동일하다.
 */
async function loadOfficialRequestChangesFindingsRow(
  input: OfficialFindingsQueryInput,
  skipLatest: 0 | 1,
): Promise<{ findings: WorkflowVerdictFinding[]; observedAt: Date | null } | null> {
  const rows = await input.db
    .select({
      payload: workflowTransitionEvents.payload,
      heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
      createdAt: workflowTransitionEvents.createdAt,
    })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId),
      eq(workflowTransitionEvents.issueId, input.issueId),
      eq(workflowTransitionEvents.workflowRunId, input.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, input.workflowStepRunId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.reason, "workflow_api"),
      eq(workflowTransitionEvents.verdict, "request_changes"),
      isNotNull(workflowTransitionEvents.heartbeatRunId),
    ))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id))
    .limit(skipLatest + 1);
  const row = rows[skipLatest];
  if (!row) return null;
  if (!(await heartbeatRunScopedToIssue(input.db, row.heartbeatRunId, { companyId: input.companyId, issueId: input.issueId }))) {
    return null;
  }
  const raw = asRecord(row.payload).findings;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parsed = workflowVerdictFindingsSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { findings: parsed.data, observedAt: row.createdAt instanceof Date ? row.createdAt : null };
}

export async function loadWorkflowApiFindings(input: OfficialFindingsQueryInput): Promise<WorkflowVerdictFinding[] | null> {
  const row = await loadOfficialRequestChangesFindingsRow(input, 0);
  return row?.findings ?? null;
}

/**
 * [qa layer feedback loop — 재발 감지] 직전 세대 반려 findings — 최신(=이번 세대) 판정 이벤트를
 *   제외한 바로 1건 이전 공식 request_changes 이벤트의 findings 를 반환한다(없으면 null).
 *   v1 은 직전 1건만 대조한다(any-prior 확장은 운영 데이터 확보 후 재검토 — 설계 §4.1).
 *   `notAfter`(=이번 생산자 세대 완료 시각) 를 주면 세대 경계 가드가 적용된다: 직전 이벤트가 그
 *   시각 이후에 관측됐다면 생산자 재작업 없이 같은 세대 산출물이 재판정된 것이므로 재발 근거로
 *   인정하지 않는다(null) — filterFreshRejectedQas 와 같은 관측시각 보수 원리(설계 §4.4).
 */
export async function loadPriorRejectedFindings(
  input: OfficialFindingsQueryInput & { readonly notAfter?: Date },
): Promise<WorkflowVerdictFinding[] | null> {
  const prior = await loadOfficialRequestChangesFindingsRow(input, 1);
  if (!prior) return null;
  // 관측시각 보수 판정(설계 §4.4): 가드 시각을 알 수 없거나(null) 직전 판정이 이번 생산자 세대
  //   완료 이후에 관측됐다면 재발 근거로 인정하지 않는다.
  if (input.notAfter && (prior.observedAt === null || prior.observedAt.getTime() > input.notAfter.getTime())) {
    return null;
  }
  return prior.findings;
}


export async function hasWorkflowValidationCompletionLedger(input: {
  readonly db: WorkflowValidationDb;
  readonly issue: WorkflowValidationIssue;
}): Promise<WorkflowValidationLedgerResult> {
  return readWorkflowValidationCompletionLedger(input, resolveWorkflowValidationContext);
}
