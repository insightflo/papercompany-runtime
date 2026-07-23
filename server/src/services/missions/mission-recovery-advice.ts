// server/src/services/missions/mission-recovery-advice.ts
//
// [파일 목적] 운영자/Hermes에게 "왜 멈췄고, 누구를 깨우고 뭐라고 해야 하는지"를 구조화된
//   처방(MissionRecoveryAdvice)으로 반환하는 read-only 진단 서비스.
// [주요 흐름]
//   1) getMissionRecoveryAdvice(db, ...) — 이슈/댓글/런을 로드(직접 drizzle 쿼리).
//   2) resolveMissionRecoveryAdvice(순수 함수) — 휴리스틱으로 decision/target/leafCause/comment 산출.
// [외부 연결]
//   - official workflow_validation_verdict (reason=workflow_api) bound to current run+step + same-issue heartbeat.
//   - official mission_plan_qa_verdicts (sourceCommentId null; optional active decisionHash).
//   - plan QA producer 링크는 QA 이슈의 originId(issues.origin_id)로 해석한다.
//   - workflow QA producer 링크는 workflow graph의 qa_request_changes back-edge로 해석한다.
// [수정시 주의]
//   - producer 판정은 "공식 계획/실행표 장부"에서만 읽는다. 텍스트 제목 예외를 늘리지 말 것.
//   - comments are display/audit only and never decide recovery action.
//   - operatorComment는 한국어 paste-ready. plan 회수 시 템플릿만 교체.
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issues,
  heartbeatRuns,
  issueWorkProducts,
  missionPlanArtifacts,
  missionPlanQaVerdicts,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";

export type RecoveryDecision =
  | "producer_rework"
  | "qa_recheck"
  | "workflow_sync"
  | "supervision_run"
  | "human_operator"
  | "no_action";

export type RecoveryAction =
  | "comment"
  | "reopen"
  | "rework"
  | "qa_recheck"
  | "supervision_run"
  | "human_operator"
  | "none";

export type RecoveryIssueRole = "producer" | "qa" | "oversight" | "planning" | "unknown";

export interface RecoveryEvidence {
  kind: "issue" | "comment" | "heartbeat_run" | "wakeup" | "workflow_step" | "work_product";
  label: string;
  value: string;
}

export interface MissionRecoveryAdvice {
  missionId: string;
  selectedIssueId: string | null;
  decision: RecoveryDecision;
  targetIssue: {
    id: string;
    identifier: string | null;
    title: string;
    role: RecoveryIssueRole;
    assigneeAgentId: string | null;
  } | null;
  targetAction: RecoveryAction;
  leafCause: string;
  evidence: RecoveryEvidence[];
  operatorComment: string | null;
  executionInstruction?: string | null;
  successEvidence?: string[];
  doNot: string[];
  missingEvidence: string[];
}

// ---------------------------------------------------------------------------
// Pure decision function — DB 없이 fixture로 단위 테스트 가능하도록 분리.
// ---------------------------------------------------------------------------

export interface IssueForAdvice {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  originKind: string;
  originId: string | null;
  assigneeAgentId: string | null;
  updatedAt: Date;
}

/** Official workflow_validation_verdict facts only — never derived from prose comments. */
export interface ValidationVerdictForAdvice {
  issueId: string;
  verdict: "pass" | "request_changes";
  reason?: string | null;
  observedAt: Date;
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  heartbeatRunId?: string | null;
}

/**
 * Official mission_plan_qa_verdicts facts only.
 * sourceCommentId must be null (legacy comment-derived rows are display/audit only).
 */
export interface PlanQaVerdictForAdvice {
  issueId: string;
  verdict: "pass" | "request_changes";
  reason?: string | null;
  observedAt: Date;
  decisionHash?: string | null;
  /** Authoritative only when null/undefined; non-null is ignored by the resolver. */
  sourceCommentId?: string | null;
}

export interface RunForAdvice {
  id: string;
  issueId: string | null;
  status: string;
}

export interface WorkProductForAdvice {
  id: string;
  issueId: string;
  title: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowConditionalDependencyForAdvice {
  stepId: string;
  when: string | null;
  isBackEdge: boolean | null;
}

export interface WorkflowStepForAdvice {
  workflowRunId: string;
  /** Step-run id when known; used to bind workflow_validation_verdict to the current attempt. */
  workflowStepRunId?: string | null;
  stepId: string;
  issueId: string | null;
  status: string;
  dependencies: string[];
  conditionalDependencies: WorkflowConditionalDependencyForAdvice[];
}

export function classifyRecoveryRole(originKind: string): RecoveryIssueRole {
  switch (originKind) {
    case "mission_plan_qa":
      return "qa";
    case "mission_main_executor_oversight":
    case "mission_main_executor_unblock":
      return "oversight";
    case "mission_main_executor_plan":
      return "planning";
    default:
      // workflow_execution / routine_execution / manual = 생산자 계열로 간주(행위적 판단은 REQUEST_CHANGES가 보강).
      return "producer";
  }
}

const DEFAULT_DO_NOT: string[] = [
  "QA 이슈를 억지로 PASS/done 처리하지 마세요.",
  "직접 workProduct 등록·workflow complete·issue 상태 PATCH는 Hermes Ops denylist로 차단됩니다(HTTP 403 hermes_ops_mutation_forbidden).",
  "감독 증상(dispatch_missing_step 등)에서 멈추지 말고 leaf cause까지 추적하세요.",
];

interface QaSignal {
  issue: IssueForAdvice;
  summary: string;
  requestAt: Date;
  producerIssueId: string | null;
}

/** Current workflow run+step binding per issue (latest attempt only). */
function currentWorkflowBindings(
  workflowSteps: WorkflowStepForAdvice[],
): Map<string, { workflowRunId: string; workflowStepRunId: string }> {
  const bindings = new Map<string, { workflowRunId: string; workflowStepRunId: string }>();
  for (const step of workflowSteps) {
    if (!step.issueId || !step.workflowStepRunId) continue;
    // Loader should pass current steps only; first occurrence wins if duplicates appear.
    if (!bindings.has(step.issueId)) {
      bindings.set(step.issueId, {
        workflowRunId: step.workflowRunId,
        workflowStepRunId: step.workflowStepRunId,
      });
    }
  }
  return bindings;
}

function isWorkflowVerdictCurrent(
  entry: ValidationVerdictForAdvice,
  binding: { workflowRunId: string; workflowStepRunId: string } | undefined,
): boolean {
  // When the issue has a current step-run context, only that run+step is authoritative.
  if (binding) {
    return entry.workflowRunId === binding.workflowRunId
      && entry.workflowStepRunId === binding.workflowStepRunId;
  }
  // No workflow step context for this issue — do not treat free-floating workflow verdicts as current.
  // Plan-QA uses planQaVerdicts instead.
  return false;
}

/**
 * Latest official workflow verdict for the current run+step among pass and request_changes.
 * Never prefilter request_changes: a later pass suppresses earlier request_changes.
 * Only returns a rework signal when the latest verdict is request_changes.
 */
function findLatestWorkflowRequestChangesSignal(
  issueId: string,
  verdicts: ValidationVerdictForAdvice[],
  bindings: Map<string, { workflowRunId: string; workflowStepRunId: string }>,
): { summary: string; requestAt: Date } | null {
  const binding = bindings.get(issueId);
  const candidates = verdicts
    .filter((entry) => (
      entry.issueId === issueId
      && (entry.verdict === "pass" || entry.verdict === "request_changes")
      && isWorkflowVerdictCurrent(entry, binding)
    ))
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const latest = candidates[0];
  if (!latest || latest.verdict !== "request_changes") return null;
  const summary = (latest.reason && latest.reason.trim()) || "request_changes";
  return { summary, requestAt: latest.observedAt };
}

/**
 * Latest official PLAN-QA verdict among pass and request_changes for the issue.
 * sourceCommentId-non-null rows are display-only and excluded.
 * A later pass suppresses earlier request_changes for the same eligible generation set.
 */
function findLatestPlanQaRequestChangesSignal(
  issueId: string,
  verdicts: PlanQaVerdictForAdvice[],
): { summary: string; requestAt: Date } | null {
  const candidates = verdicts
    .filter((entry) => (
      entry.issueId === issueId
      && (entry.verdict === "pass" || entry.verdict === "request_changes")
      // Legacy comment-derived ledger rows are display/audit only.
      && (entry.sourceCommentId == null)
    ))
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const latest = candidates[0];
  if (!latest || latest.verdict !== "request_changes") return null;
  const summary = (latest.reason && latest.reason.trim()) || "request_changes";
  return { summary, requestAt: latest.observedAt };
}

function issueLabel(issue: IssueForAdvice): string {
  return issue.identifier ?? issue.id;
}

function buildIssueActivationInstruction(input: {
  issue: IssueForAdvice;
  actionLabel: string;
}): string {
  const targetLabel = issueLabel(input.issue);
  const assigneeLabel = input.issue.assigneeAgentId ?? "unassigned";
  if (input.issue.status === "done") {
    return [
      `Target issue ${targetLabel} is done. A plain comment on a done issue is not execution and will not wake the assignee.`,
      `To actually execute ${input.actionLabel}, call POST /api/issues/${input.issue.id}/comments with the operator comment as body and reopen:true.`,
      `After acting, verify a new issue comment, agent_wakeup_requests reason=issue_reopened_via_comment, and a queued/running heartbeat run for assignee ${assigneeLabel}.`,
    ].join(" ");
  }
  if (input.issue.status === "cancelled") {
    return `Target issue ${targetLabel} is cancelled. Do not try to reopen it; escalate to human_operator with the QA verdict and target issue evidence.`;
  }
  return [
    `Target issue ${targetLabel} is ${input.issue.status}. To request ${input.actionLabel}, call POST /api/issues/${input.issue.id}/comments with the operator comment as body.`,
    `After acting, verify a new issue comment, agent_wakeup_requests reason=issue_commented or a queued/running heartbeat run for assignee ${assigneeLabel}.`,
  ].join(" ");
}

function buildIssueActivationSuccessEvidence(issue: IssueForAdvice): string[] {
  const targetLabel = issueLabel(issue);
  const assigneeLabel = issue.assigneeAgentId ?? "unassigned";
  if (issue.status === "done") {
    return [
      `new issue comment on ${targetLabel} created by this turn`,
      `agent_wakeup_requests row for ${assigneeLabel} with reason=issue_reopened_via_comment`,
      `new queued/running/completed heartbeat run for ${assigneeLabel} tied to ${targetLabel}`,
    ];
  }
  return [
    `new issue comment on ${targetLabel} created by this turn`,
    `agent_wakeup_requests row for ${assigneeLabel} with reason=issue_commented or a new heartbeat run tied to ${targetLabel}`,
  ];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function normalizeConditionalDependencies(value: unknown): WorkflowConditionalDependencyForAdvice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const stepId = asString(record?.stepId);
    if (!stepId) return [];
    return [{
      stepId,
      when: asString(record?.when),
      isBackEdge: typeof record?.isBackEdge === "boolean" ? record.isBackEdge : null,
    }];
  });
}

/**
 * [목적] 이슈/구조화 verdict/런으로부터 recovery 처방을 산출. 순수 함수.
 * [입력] missionId, issues, validationVerdicts, planQaVerdicts, runs.
 * [출력] MissionRecoveryAdvice.
 * [주의] producer 판정이 originId direct lookup으로 안 되면 supervision_run으로 위임(duplicate 금지).
 *   comments 입력 없음 — 구조화 verdict 만 권위.
 *   workflow_validation_verdict 는 current run+step 에 바인딩된 것만 권위.
 *   plan QA 는 mission_plan_qa_verdicts(sourceCommentId null) 만 권위(active scope 는 loader 가 필터).
 */
export function resolveMissionRecoveryAdvice(input: {
  missionId: string;
  issues: IssueForAdvice[];
  validationVerdicts?: ValidationVerdictForAdvice[];
  planQaVerdicts?: PlanQaVerdictForAdvice[];
  runs: RunForAdvice[];
  workProducts?: WorkProductForAdvice[];
  workflowSteps?: WorkflowStepForAdvice[];
  selectedIssueId?: string | null;
}): MissionRecoveryAdvice {
  const evidence: RecoveryEvidence[] = [];
  const missingEvidence: string[] = [];

  const issueById = new Map(input.issues.map((i) => [i.id, i]));
  const validationVerdicts = input.validationVerdicts ?? [];
  const planQaVerdicts = input.planQaVerdicts ?? [];
  const workflowSteps = input.workflowSteps ?? [];
  const workProducts = input.workProducts ?? [];
  const workflowBindings = currentWorkflowBindings(workflowSteps);

  const workflowProducerForQa = (issueId: string) => {
    const qaSteps = workflowSteps.filter((step) => step.issueId === issueId);
    for (const qaStep of qaSteps) {
      const producerIssueIds = new Set<string>();
      for (const candidate of workflowSteps) {
        if (candidate.workflowRunId !== qaStep.workflowRunId || !candidate.issueId) continue;
        if (
          candidate.conditionalDependencies.some(
            (edge) => edge.stepId === qaStep.stepId && edge.when === "qa_request_changes",
          )
        ) {
          producerIssueIds.add(candidate.issueId);
        }
      }
      if (producerIssueIds.size === 1) {
        const [producerIssueId] = [...producerIssueIds];
        return {
          producerIssueId,
          qaStep,
          reason: `workflow QA step ${qaStep.stepId} resolves to producer through a qa_request_changes back-edge`,
          ambiguous: false,
        };
      }
      if (producerIssueIds.size > 1) {
        return {
          producerIssueId: null,
          qaStep,
          reason: `workflow QA step ${qaStep.stepId} has multiple qa_request_changes producer targets`,
          ambiguous: true,
        };
      }
    }
    return null;
  };

  let qaSignal: QaSignal | null = null;
  for (const issue of input.issues) {
    const role = classifyRecoveryRole(issue.originKind);
    // Plan-QA uses mission_plan_qa_verdicts; workflow QA uses current-run workflow_validation_verdict.
    const requestChanges = role === "qa"
      ? findLatestPlanQaRequestChangesSignal(issue.id, planQaVerdicts)
      : findLatestWorkflowRequestChangesSignal(issue.id, validationVerdicts, workflowBindings);
    if (!requestChanges) continue;
    const workflowProducer = role === "qa" ? null : workflowProducerForQa(issue.id);
    if (role !== "qa" && !workflowProducer?.producerIssueId) {
      if (workflowProducer?.ambiguous) missingEvidence.push(workflowProducer.reason);
      continue;
    }
    const { summary, requestAt } = requestChanges;
    if (!qaSignal || requestAt > qaSignal.requestAt) {
      qaSignal = {
        issue,
        summary,
        requestAt,
        producerIssueId: role === "qa" ? issue.originId : workflowProducer?.producerIssueId ?? null,
      };
      if (workflowProducer?.qaStep) {
        evidence.push({
          kind: "workflow_step",
          label: `workflow QA step ${workflowProducer.qaStep.stepId}`,
          value: `status=${workflowProducer.qaStep.status}; producer resolved by qa_request_changes back-edge`,
        });
      }
    }
  }

  const baseDoNot = DEFAULT_DO_NOT;

  // 케이스 1: official structured request_changes → producer rework 또는 qa recheck.
  if (qaSignal) {
    evidence.push({
      kind: "workflow_step",
      label: `official QA request_changes on ${qaSignal.issue.identifier ?? qaSignal.issue.id}`,
      value: qaSignal.summary,
    });
    const producerId = qaSignal.producerIssueId;
    const producer = producerId ? (issueById.get(producerId) ?? null) : null;
    if (!producer) {
      missingEvidence.push(
        `QA 이슈 ${qaSignal.issue.identifier ?? qaSignal.issue.id}의 originId(${producerId ?? "null"})로 producer 이슈를 직접 해석할 수 없습니다. native loop / owner 결정이 관여하면 supervision/run이 필요합니다.`,
      );
      return {
        missionId: input.missionId,
        selectedIssueId: input.selectedIssueId ?? null,
        decision: "supervision_run",
        targetIssue: {
          id: qaSignal.issue.id,
          identifier: qaSignal.issue.identifier,
          title: qaSignal.issue.title,
          role: "qa",
          assigneeAgentId: qaSignal.issue.assigneeAgentId,
        },
        targetAction: "supervision_run",
        leafCause: qaSignal.summary,
        evidence,
        operatorComment: null,
        doNot: baseDoNot,
        missingEvidence,
      };
    }
    evidence.push({
      kind: "issue",
      label: `producer ${producer.identifier ?? producer.id} (status=${producer.status})`,
      value: producer.title,
    });
    const producerWorkProducts = workProducts.filter((wp) => wp.issueId === producer.id && wp.status === "active");
    const producerReworkWorkProduct = producerWorkProducts.find(
      (wp) => Math.max(wp.createdAt.getTime(), wp.updatedAt.getTime()) > qaSignal.requestAt.getTime(),
    );
    if (producerReworkWorkProduct) {
      evidence.push({
        kind: "work_product",
        label: `producer workProduct ${producerReworkWorkProduct.title}`,
        value: `status=${producerReworkWorkProduct.status}; updatedAt=${producerReworkWorkProduct.updatedAt.toISOString()}`,
      });
      return {
        missionId: input.missionId,
        selectedIssueId: input.selectedIssueId ?? null,
        decision: "qa_recheck",
        targetIssue: {
          id: qaSignal.issue.id,
          identifier: qaSignal.issue.identifier,
          title: qaSignal.issue.title,
          role: "qa",
          assigneeAgentId: qaSignal.issue.assigneeAgentId,
        },
        targetAction: "qa_recheck",
        leafCause: `producer(${producer.identifier ?? producer.id})가 QA REQUEST_CHANGES 이후 workProduct를 수정했습니다. QA 재검이 필요합니다.`,
        evidence,
        operatorComment: buildQaRecheckComment({ qa: qaSignal.issue, producer }),
        executionInstruction: buildIssueActivationInstruction({
          issue: qaSignal.issue,
          actionLabel: "QA recheck",
        }),
        successEvidence: buildIssueActivationSuccessEvidence(qaSignal.issue),
        doNot: baseDoNot,
        missingEvidence,
      };
    }
    // 기본: producer가 아직 rework 안 함 → producer 재작업.
    return {
      missionId: input.missionId,
      selectedIssueId: input.selectedIssueId ?? null,
      decision: "producer_rework",
      targetIssue: {
        id: producer.id,
        identifier: producer.identifier,
        title: producer.title,
        role: classifyRecoveryRole(producer.originKind),
        assigneeAgentId: producer.assigneeAgentId,
      },
      targetAction: "rework",
      leafCause: qaSignal.summary,
      evidence,
      operatorComment: buildProducerReworkComment({ producer, qa: qaSignal.issue, leafCause: qaSignal.summary }),
      executionInstruction: buildIssueActivationInstruction({
        issue: producer,
        actionLabel: "producer rework",
      }),
      successEvidence: buildIssueActivationSuccessEvidence(producer),
      doNot: baseDoNot,
      missingEvidence,
    };
  }

  // 케이스 2: REQUEST_CHANGES 없이 in_progress/todo 이슈에 활성 런이 없으면 supervision/wake.
  const activeStatuses = new Set(["todo", "in_progress", "in_review", "blocked"]);
  const stuckIssue = input.issues.find((i) => activeStatuses.has(i.status)) ?? null;
  const activeRunStatuses = new Set(["running", "queued", "pending", "in_progress"]);
  const hasActiveRun = (issueId: string) =>
    input.runs.some((r) => r.issueId === issueId && activeRunStatuses.has(r.status));
  if (stuckIssue && !hasActiveRun(stuckIssue.id)) {
    evidence.push({
      kind: "issue",
      label: `no active run for ${stuckIssue.identifier ?? stuckIssue.id} (status=${stuckIssue.status})`,
      value: stuckIssue.title,
    });
    return {
      missionId: input.missionId,
      selectedIssueId: input.selectedIssueId ?? null,
      decision: "supervision_run",
      targetIssue: {
        id: stuckIssue.id,
        identifier: stuckIssue.identifier,
        title: stuckIssue.title,
        role: classifyRecoveryRole(stuckIssue.originKind),
        assigneeAgentId: stuckIssue.assigneeAgentId,
      },
      targetAction: "supervision_run",
      leafCause: `${stuckIssue.identifier ?? stuckIssue.id} 이슈가 ${stuckIssue.status} 상태이나 활성 heartbeat 런이 없습니다. mission-owner supervision으로 안전한 recovery를 판단하세요.`,
      evidence,
      operatorComment: null,
      doNot: baseDoNot,
      missingEvidence,
    };
  }

  // 케이스 3: 뚜렷한 leaf cause를 기계적으로 산정할 수 없으면 human operator.
  missingEvidence.push("official workflow_validation_verdict=request_changes 가 없고 no-active-run 상위 이슈도 없습니다. 수동 판단이 필요합니다.");
  return {
    missionId: input.missionId,
    selectedIssueId: input.selectedIssueId ?? null,
    decision: "human_operator",
    targetIssue: null,
    targetAction: "human_operator",
    leafCause: "자동 진단으로 leaf cause를 특정하지 못했습니다. 운영자가 mission runtime-snapshot과 supervision/run 결과를 직접 확인하세요.",
    evidence,
    operatorComment: null,
    doNot: baseDoNot,
    missingEvidence,
  };
}

function buildProducerReworkComment(input: {
  producer: IssueForAdvice;
  qa: IssueForAdvice;
  leafCause: string;
}): string {
  const producerLabel = input.producer.identifier ?? input.producer.id;
  const qaLabel = input.qa.identifier ?? input.qa.id;
  return [
    "재작업 요청입니다.",
    "",
    `QA가 verdict를 통과시키지 못했습니다. QA 이슈(${qaLabel})를 억지로 PASS 처리하지 말고, ${producerLabel}의 산출물을 다시 고쳐주세요.`,
    "",
    `QA가 지적한 사유: ${input.leafCause}`,
    "",
    "수정 후 workProduct를 다시 등록하고 workflow complete를 호출한 뒤, 그 다음에만 QA를 다시 실행하세요.",
  ].join("\n");
}

function buildQaRecheckComment(input: { qa: IssueForAdvice; producer: IssueForAdvice }): string {
  const qaLabel = input.qa.identifier ?? input.qa.id;
  const producerLabel = input.producer.identifier ?? input.producer.id;
  return [
    "QA 재검 요청입니다.",
    "",
    `producer(${producerLabel})가 산출물을 수정한 뒤 workflow complete를 호출했습니다. QA 이슈(${qaLabel})를 다시 실행해 재검해 주세요.`,
    "",
    "producer가 추가로 손대기 전에 QA가 먼저 verdict를 내려야 합니다.",
  ].join("\n");
}

function normalizeWorkflowDefinitionSteps(value: unknown) {
  const steps = Array.isArray(value) ? value : [];
  const normalized = new Map<string, {
    dependencies: string[];
    conditionalDependencies: WorkflowConditionalDependencyForAdvice[];
  }>();
  for (const entry of steps) {
    const step = asRecord(entry);
    const id = asString(step?.id);
    if (!id) continue;
    const dependencies = asStringArray(step?.dependencies).length > 0
      ? asStringArray(step?.dependencies)
      : asStringArray(step?.dependsOn);
    normalized.set(id, {
      dependencies,
      conditionalDependencies: normalizeConditionalDependencies(step?.conditionalDependencies),
    });
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// DB loader — pure 함수에 데이터를 공급.
// ---------------------------------------------------------------------------

export async function getMissionRecoveryAdvice(
  db: Db,
  input: { companyId: string; missionId: string; issueId?: string | null },
): Promise<MissionRecoveryAdvice> {
  const { companyId, missionId } = input;
  const issueRows = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.missionId, missionId)));
  const issueIds = issueRows.map((r) => r.id);

  const runRows = issueIds.length > 0
    ? await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.issueId, issueIds)))
    : [];

  const workProductRows = issueIds.length > 0
    ? await db
      .select()
      .from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.companyId, companyId), inArray(issueWorkProducts.issueId, issueIds)))
    : [];

  const workflowRows = await db
    .select({
      workflowRunId: workflowRuns.id,
      stepRun: workflowStepRuns,
      stepsJson: workflowDefinitions.stepsJson,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, missionId)));

  // Official workflow_api validation verdicts only, scoped to issue + same-issue heartbeat.
  // Current run+step binding is applied after resolving the latest step run per issue.
  const verdictRows = issueIds.length > 0
    ? await db
      .select({
        issueId: workflowTransitionEvents.issueId,
        verdict: workflowTransitionEvents.verdict,
        payload: workflowTransitionEvents.payload,
        createdAt: workflowTransitionEvents.createdAt,
        workflowRunId: workflowTransitionEvents.workflowRunId,
        workflowStepRunId: workflowTransitionEvents.workflowStepRunId,
        heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
        heartbeatIssueId: heartbeatRuns.issueId,
        heartbeatCompanyId: heartbeatRuns.companyId,
      })
      .from(workflowTransitionEvents)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, workflowTransitionEvents.heartbeatRunId))
      .where(and(
        eq(workflowTransitionEvents.companyId, companyId),
        inArray(workflowTransitionEvents.issueId, issueIds),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
        eq(workflowTransitionEvents.reason, "workflow_api"),
        isNotNull(workflowTransitionEvents.heartbeatRunId),
        eq(heartbeatRuns.companyId, companyId),
      ))
      .orderBy(desc(workflowTransitionEvents.createdAt))
      .limit(100)
    : [];

  // Latest step-run attempt per issue (current generation) — mirrors resolveWorkflowValidationContext.
  const latestStepByIssue = new Map<string, typeof workflowStepRuns.$inferSelect>();
  for (const row of workflowRows) {
    const issueId = row.stepRun.issueId;
    if (!issueId) continue;
    const existing = latestStepByIssue.get(issueId);
    if (!existing) {
      latestStepByIssue.set(issueId, row.stepRun);
      continue;
    }
    const existingTs = Math.max(
      existing.startedAt?.getTime() ?? 0,
      existing.completedAt?.getTime() ?? 0,
    );
    const candidateTs = Math.max(
      row.stepRun.startedAt?.getTime() ?? 0,
      row.stepRun.completedAt?.getTime() ?? 0,
    );
    if (candidateTs >= existingTs) latestStepByIssue.set(issueId, row.stepRun);
  }

  const definitionStepsByRunId = new Map<string, ReturnType<typeof normalizeWorkflowDefinitionSteps>>();
  const workflowSteps: WorkflowStepForAdvice[] = [];
  for (const row of workflowRows) {
    const issueId = row.stepRun.issueId;
    const latest = issueId ? latestStepByIssue.get(issueId) : null;
    // Only expose current step-run context for recovery binding (stale attempts stay out of pure input).
    if (latest && row.stepRun.id !== latest.id) continue;
    let definitionSteps = definitionStepsByRunId.get(row.workflowRunId);
    if (!definitionSteps) {
      definitionSteps = normalizeWorkflowDefinitionSteps(row.stepsJson);
      definitionStepsByRunId.set(row.workflowRunId, definitionSteps);
    }
    const definitionStep = definitionSteps.get(row.stepRun.stepId);
    workflowSteps.push({
      workflowRunId: row.workflowRunId,
      workflowStepRunId: row.stepRun.id,
      stepId: row.stepRun.stepId,
      issueId: row.stepRun.issueId,
      status: row.stepRun.status,
      dependencies: definitionStep?.dependencies ?? [],
      conditionalDependencies: definitionStep?.conditionalDependencies ?? [],
    });
  }

  const toIssue = (r: typeof issueRows[number]): IssueForAdvice => ({
    id: r.id,
    identifier: r.identifier,
    title: r.title,
    status: r.status,
    originKind: r.originKind,
    originId: r.originId,
    assigneeAgentId: r.assigneeAgentId,
    updatedAt: r.updatedAt,
  });

  const currentBindings = currentWorkflowBindings(workflowSteps);
  const validationVerdicts: ValidationVerdictForAdvice[] = [];
  for (const row of verdictRows) {
    if (!row.issueId) continue;
    if (row.heartbeatCompanyId !== companyId || row.heartbeatIssueId !== row.issueId) continue;
    if (row.verdict !== "pass" && row.verdict !== "request_changes") continue;
    const binding = currentBindings.get(row.issueId);
    if (!binding) continue;
    if (row.workflowRunId !== binding.workflowRunId || row.workflowStepRunId !== binding.workflowStepRunId) continue;
    const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? row.payload as Record<string, unknown>
      : {};
    const reason = typeof payload.reason === "string" ? payload.reason : null;
    validationVerdicts.push({
      issueId: row.issueId,
      verdict: row.verdict,
      reason,
      observedAt: row.createdAt,
      workflowRunId: row.workflowRunId,
      workflowStepRunId: row.workflowStepRunId,
      heartbeatRunId: row.heartbeatRunId,
    });
  }

  // Official PLAN-QA verdicts: fail closed unless active plan refs.planQa has exact {issueId, decisionHash}.
  // Never fall back to all mission PLAN-QA verdicts when the binding is missing/malformed.
  const activePlan = await db
    .select({ refs: missionPlanArtifacts.refs })
    .from(missionPlanArtifacts)
    .where(and(
      eq(missionPlanArtifacts.companyId, companyId),
      eq(missionPlanArtifacts.missionId, missionId),
      eq(missionPlanArtifacts.status, "active"),
    ))
    .orderBy(desc(missionPlanArtifacts.revision), desc(missionPlanArtifacts.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const activePlanQaRef = activePlan?.refs && typeof activePlan.refs === "object" && !Array.isArray(activePlan.refs)
    ? (activePlan.refs as Record<string, unknown>).planQa
    : null;
  const activePlanQaRecord = activePlanQaRef && typeof activePlanQaRef === "object" && !Array.isArray(activePlanQaRef)
    ? activePlanQaRef as Record<string, unknown>
    : null;
  const activePlanQaIssueId = typeof activePlanQaRecord?.issueId === "string" && activePlanQaRecord.issueId.trim()
    ? activePlanQaRecord.issueId.trim()
    : null;
  const activeDecisionHash = typeof activePlanQaRecord?.decisionHash === "string" && activePlanQaRecord.decisionHash.trim()
    ? activePlanQaRecord.decisionHash.trim()
    : null;
  const activePlanQa = activePlanQaIssueId && activeDecisionHash
    ? { issueId: activePlanQaIssueId, decisionHash: activeDecisionHash }
    : null;

  const planQaVerdicts: PlanQaVerdictForAdvice[] = [];
  if (activePlanQa) {
    const planQaVerdictRows = await db
      .select({
        planQaIssueId: missionPlanQaVerdicts.planQaIssueId,
        verdict: missionPlanQaVerdicts.verdict,
        diagnostics: missionPlanQaVerdicts.diagnostics,
        decisionHash: missionPlanQaVerdicts.decisionHash,
        sourceCommentId: missionPlanQaVerdicts.sourceCommentId,
        updatedAt: missionPlanQaVerdicts.updatedAt,
        createdAt: missionPlanQaVerdicts.createdAt,
      })
      .from(missionPlanQaVerdicts)
      .where(and(
        eq(missionPlanQaVerdicts.companyId, companyId),
        eq(missionPlanQaVerdicts.missionId, missionId),
        eq(missionPlanQaVerdicts.planQaIssueId, activePlanQa.issueId),
        eq(missionPlanQaVerdicts.decisionHash, activePlanQa.decisionHash),
        isNull(missionPlanQaVerdicts.sourceCommentId),
      ))
      .orderBy(desc(missionPlanQaVerdicts.updatedAt), desc(missionPlanQaVerdicts.createdAt))
      .limit(20);

    for (const row of planQaVerdictRows) {
      if (row.verdict !== "pass" && row.verdict !== "request_changes") continue;
      // Exact active issueId+decisionHash only (query already binds both; keep read-path fail closed).
      if (row.planQaIssueId !== activePlanQa.issueId || row.decisionHash !== activePlanQa.decisionHash) continue;
      const diagnostics = Array.isArray(row.diagnostics) ? row.diagnostics : [];
      const reasonParts = diagnostics
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
          const record = entry as Record<string, unknown>;
          if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
          if (typeof record.code === "string" && record.code.trim()) return record.code.trim();
          return null;
        })
        .filter((part): part is string => Boolean(part));
      planQaVerdicts.push({
        issueId: row.planQaIssueId,
        verdict: row.verdict,
        reason: reasonParts.length > 0 ? reasonParts.join("; ") : null,
        observedAt: row.updatedAt ?? row.createdAt,
        decisionHash: row.decisionHash,
        sourceCommentId: row.sourceCommentId,
      });
    }
  }

  return resolveMissionRecoveryAdvice({
    missionId,
    issues: issueRows.map(toIssue),
    validationVerdicts,
    planQaVerdicts,
    runs: runRows.map((r) => ({ id: r.id, issueId: r.issueId, status: r.status })),
    workProducts: workProductRows.map((r) => ({
      id: r.id,
      issueId: r.issueId,
      title: r.title,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    workflowSteps,
    selectedIssueId: input.issueId ?? null,
  });
}
