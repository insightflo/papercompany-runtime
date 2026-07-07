// server/src/services/missions/mission-recovery-advice.ts
//
// [파일 목적] 운영자/Hermes에게 "왜 멈췄고, 누구를 깨우고 뭐라고 해야 하는지"를 구조화된
//   처방(MissionRecoveryAdvice)으로 반환하는 read-only 진단 서비스.
// [주요 흐름]
//   1) getMissionRecoveryAdvice(db, ...) — 이슈/댓글/런을 로드(직접 drizzle 쿼리).
//   2) resolveMissionRecoveryAdvice(순수 함수) — 휴리스틱으로 decision/target/leafCause/comment 산출.
// [외부 연결]
//   - extractLatestRequestChangesSummary(mission-owner-recovery-comments.ts)를 재사용해 REQUEST_CHANGES
//     leaf cause를 추출. 동일 신호의 다른 consumer이므로 classifier drift가 아님.
//   - plan QA producer 링크는 QA 이슈의 originId(issues.origin_id)로 해석한다.
//   - workflow QA producer 링크는 workflow graph의 qa_request_changes back-edge로 해석한다.
// [수정시 주의]
//   - producer 판정은 "공식 계획/실행표 장부"에서만 읽는다. 텍스트 제목 예외를 늘리지 말 것.
//   - operatorComment는 한국어 paste-ready. plan 회수 시 템플릿만 교체.
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueComments,
  issues,
  heartbeatRuns,
  issueWorkProducts,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { extractLatestRequestChangesSummary } from "./mission-owner-recovery-comments.js";

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

export interface CommentForAdvice {
  id: string;
  issueId: string;
  body: string;
  createdAt: Date;
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

function findLatestRequestChangesSignal(list: CommentForAdvice[]): { summary: string; requestAt: Date } | null {
  for (const comment of list.slice().reverse()) {
    const summary = extractLatestRequestChangesSummary([comment.body]);
    if (summary) return { summary, requestAt: comment.createdAt };
  }
  return null;
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
 * [목적] 이슈/댓글/런으로부터 recovery 처방을 산출. 순수 함수.
 * [입력] missionId, issues, comments, runs, (선택) selectedIssueId/now.
 * [출력] MissionRecoveryAdvice.
 * [주의] producer 판정이 originId direct lookup으로 안 되면 supervision_run으로 위임(duplicate 금지).
 */
export function resolveMissionRecoveryAdvice(input: {
  missionId: string;
  issues: IssueForAdvice[];
  comments: CommentForAdvice[];
  runs: RunForAdvice[];
  workProducts?: WorkProductForAdvice[];
  workflowSteps?: WorkflowStepForAdvice[];
  selectedIssueId?: string | null;
}): MissionRecoveryAdvice {
  const evidence: RecoveryEvidence[] = [];
  const missingEvidence: string[] = [];

  const issueById = new Map(input.issues.map((i) => [i.id, i]));
  const commentsByIssue = new Map<string, CommentForAdvice[]>();
  for (const c of input.comments) {
    const list = commentsByIssue.get(c.issueId) ?? [];
    list.push(c);
    commentsByIssue.set(c.issueId, list);
  }
  for (const list of commentsByIssue.values()) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  const workflowSteps = input.workflowSteps ?? [];
  const workProducts = input.workProducts ?? [];

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
    const list = commentsByIssue.get(issue.id) ?? [];
    const requestChanges = findLatestRequestChangesSignal(list);
    if (!requestChanges) continue;
    const role = classifyRecoveryRole(issue.originKind);
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

  // 케이스 1: QA REQUEST_CHANGES 존재 → producer rework 또는 qa recheck.
  if (qaSignal) {
    evidence.push({
      kind: "comment",
      label: `QA REQUEST_CHANGES on ${qaSignal.issue.identifier ?? qaSignal.issue.id}`,
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
  missingEvidence.push("REQUEST_CHANGES 댓글이 없고 no-active-run 상위 이슈도 없습니다. 수동 판단이 필요합니다.");
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

  const commentRows = issueIds.length > 0
    ? await db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.companyId, companyId), inArray(issueComments.issueId, issueIds)))
      .orderBy(desc(issueComments.createdAt))
      .limit(200)
    : [];

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

  const definitionStepsByRunId = new Map<string, ReturnType<typeof normalizeWorkflowDefinitionSteps>>();
  const workflowSteps = workflowRows.map((row): WorkflowStepForAdvice => {
    let definitionSteps = definitionStepsByRunId.get(row.workflowRunId);
    if (!definitionSteps) {
      definitionSteps = normalizeWorkflowDefinitionSteps(row.stepsJson);
      definitionStepsByRunId.set(row.workflowRunId, definitionSteps);
    }
    const definitionStep = definitionSteps.get(row.stepRun.stepId);
    return {
      workflowRunId: row.workflowRunId,
      stepId: row.stepRun.stepId,
      issueId: row.stepRun.issueId,
      status: row.stepRun.status,
      dependencies: definitionStep?.dependencies ?? [],
      conditionalDependencies: definitionStep?.conditionalDependencies ?? [],
    };
  });

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

  return resolveMissionRecoveryAdvice({
    missionId,
    issues: issueRows.map(toIssue),
    comments: commentRows.map((r) => ({
      id: r.id,
      issueId: r.issueId,
      body: r.body,
      createdAt: r.createdAt,
    })),
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
