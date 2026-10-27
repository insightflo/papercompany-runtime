import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { WorkflowVerdictFinding } from "@paperclipai/shared/validators/workflow-agent-api";
import type { WorkflowStep } from "./dag-engine.js";
import type { PersistedWorkflowStep } from "./execution-steps.js";
import { heartbeatService } from "../heartbeat.js";
import { queueIssueAssignmentWakeup } from "../issue-assignment-wakeup.js";
import { findAcceptedWorkflowResumeWakeForStep } from "../workflow-resume-wake.js";
import { admitOwnerLinkedStepWake, type OwnerExecutionAdmission } from "../missions/mission-owner-execution-state.js";
import { logActivity } from "../activity-log.js";
import { isCapOverrideWakeKey } from "./cap-override-wakeup-conflict.js";
import { resolveEdges } from "./control-flow/edge-condition.js";
import { readWorkflowReworkContract } from "./control-flow/rework-contract.js";
import { loadDownstreamQaCapAcceptanceContext } from "./control-flow/qa-cap-acceptance-context.js";
import { buildQaCapAcceptanceRuntimeContract } from "./control-flow/qa-cap-runtime-contract.js";
import { evaluateSemanticStructuralReadiness } from "./control-flow/structural-semantic-readiness.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { projectExecutionDefinition } from "./execution-definition-view.js";

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function wakeExistingWorkflowStepIssue(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  stepRunId?: string;
  stepRunMetadata?: unknown;
  issueId: string;
  allowCompletedIssue?: boolean;
  allowBlockedIssue?: boolean;
  /** When true, the heartbeat session is forced fresh (no stale context reuse). */
  forceFreshSession?: boolean;
  /** [recheck priority] Structured findings from the previous REQUEST_CHANGES that
   *  this recheck should verify FIRST (then continue the full checklist). Machine
   *  contract only — never natural-language parsing. */
  priorFindings?: readonly WorkflowVerdictFinding[];
  /** Optional correlation key; cap-override keys also enable exact queue-conflict propagation. */
  idempotencyKey?: string | null;
  /** [owner admission] owner-linked 실행의 typed 승인 정보 — 생략해도 저장 영수증 맥락에서
   *  동일 검사가 적용된다(인자 생략으로 우회 불가). */
  ownerExecution?: OwnerExecutionAdmission;
}): Promise<boolean> {
  // [Task5a2a] external recovery paths 는 live steps/definition 을 넘길 수 있다. 진입 시 1회 로드해 snapshot 이면
  //   caller 입력을 캡처 정의/저장 step 으로 대체하고(구조게이트·QA-cap 배열 소비자 모두 캡처 배열), 저장 step 이
  //   없으면 mutation/wake 없이 false. legacy_current 는 caller step/definition 동작 + legacy builder 배열 유지.
  const execution = await loadExecutionDefinition(input.db, input.run.id, { requireHistorical: false });
  let effectiveInput = input;
  if (execution.source === "snapshot") {
    const storedStep = execution.steps.find((candidate) => candidate.id === input.step.id);
    if (!storedStep) return false;
    effectiveInput = {
      ...input,
      definition: projectExecutionDefinition(input.definition, execution),
      step: storedStep,
    };
  }
  const executionSteps = execution.steps;
  // This guards every resume entry point (normal recheck, reconciler, owner
  // recovery). A semantic QA issue may not be queued from status alone.
  const structuralReadiness = await evaluateSemanticStructuralReadiness({
    db: input.db,
    companyId: input.run.companyId,
    workflowRunId: input.run.id,
    step: effectiveInput.step,
    steps: executionSteps,
  });
  if (!structuralReadiness.ready) return false;

  const [issue] = await input.db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      assigneeAgentId: issues.assigneeAgentId,
      status: issues.status,
    })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1);
  if (!issue) return false;
  const isRunnableIssue =
    issue.status === "todo" ||
    (input.allowCompletedIssue === true && issue.status === "done") ||
    (input.allowBlockedIssue === true && issue.status === "blocked");
  if (!isRunnableIssue) return false;

  let wakeIssue = issue;
  if (!wakeIssue.assigneeAgentId) {
    const assigneeAgentId = await resolveWorkflowStepAssigneeAgentId(input.db, input.run.companyId, effectiveInput.step);
    if (!assigneeAgentId) return false;

    const [updatedIssue] = await input.db
      .update(issues)
      .set({
        assigneeAgentId,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, wakeIssue.id))
      .returning({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
      });
    if (!updatedIssue) return false;

    await logActivity(input.db, {
      companyId: updatedIssue.companyId,
      actorType: "system",
      actorId: `workflow:${input.definition.id}`,
      action: "issue.assignee_restored",
      entityType: "issue",
      entityId: updatedIssue.id,
      details: {
        assigneeAgentId,
        reason: "workflow_step_runnable",
        workflowRunId: input.run.id,
        workflowDefinitionId: input.definition.id,
        stepId: input.step.id,
      },
    });

    wakeIssue = updatedIssue;
  }

  const stepRunMetadata = normalizeRecord(input.stepRunMetadata);
  const reworkContract = readWorkflowReworkContract(stepRunMetadata.workflowReworkContract);
  const reworkContext = reworkContract
    ? { paperclipWorkflowReworkContract: reworkContract }
    : {};
  const priorFindingsContext = input.priorFindings && input.priorFindings.length > 0
    ? { priorQaFindings: input.priorFindings.map((finding) => ({ id: finding.id, summary: finding.summary, layer: finding.layer })) }
    : {};
  // [qa-cap acceptance] resumed downstream issue sees predecessor cap-accepted limitations.
  const capAcceptanceContext = await loadDownstreamQaCapAcceptanceContext({
    db: input.db,
    workflowRunId: input.run.id,
    predecessorStepIds: resolveEdges(effectiveInput.step).filter((e) => e.isBackEdge !== true).map((e) => e.stepId),
  });
  const capAcceptancePayload = capAcceptanceContext.accepted.length > 0
    ? { acceptedQaLimitations: capAcceptanceContext }
    : {};
  const executionStepRuns = await input.db
    .select({
      stepId: workflowStepRuns.stepId,
      status: workflowStepRuns.status,
      iterationIndex: workflowStepRuns.iterationIndex,
    })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, input.run.id));
  const qaCapAcceptanceContract = buildQaCapAcceptanceRuntimeContract({
    qaStep: effectiveInput.step,
    qaIssueId: issue.id,
    steps: executionSteps,
    stepRuns: executionStepRuns,
  });
  const qaCapAcceptancePayload = qaCapAcceptanceContract
    ? { paperclipQaCapAcceptanceContract: qaCapAcceptanceContract }
    : {};

  // Plain scheduler retries can reuse an accepted wake for this exact generation. Calls carrying
  // fresh context, an explicit key, or an owner-recovery receipt must enqueue their own durable
  // wake so that their payload and receipt are not silently lost.
  const hasCallSpecificWakeContract = input.forceFreshSession === true
    || (input.priorFindings?.length ?? 0) > 0
    || (typeof input.idempotencyKey === "string" && input.idempotencyKey.trim().length > 0)
    || input.ownerExecution !== undefined;
  const reusableStepRunId = !hasCallSpecificWakeContract
    && typeof input.stepRunId === "string" && input.stepRunId.length > 0
    ? input.stepRunId
    : null;
  const canReuseAcceptedWake = reusableStepRunId !== null;
  const [stepAuthority] = canReuseAcceptedWake
    ? await input.db.select({ executionGeneration: workflowStepRuns.executionGeneration })
      .from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.id, reusableStepRunId), eq(workflowStepRuns.workflowRunId, input.run.id)))
      .limit(1)
    : [];
  const acceptedWakeExists = canReuseAcceptedWake && stepAuthority
    ? (await findAcceptedWorkflowResumeWakeForStep(input.db, {
      companyId: input.run.companyId,
      issueId: issue.id,
      workflowRunId: input.run.id,
      workflowStepRunId: reusableStepRunId,
      workflowExecutionGeneration: stepAuthority.executionGeneration,
    })).length > 0
    : false;
  // [owner admission] 실제 durable wake 직전, 저장된 owner-execute 연결 영수증에서 현재
  //   intent/권한버전/세대를 재확인한다(무연결 run은 무변화 통과). 검사와 wake 사이에 다른 await 없음.
  if (!(await admitOwnerLinkedStepWake(input.db, { companyId: input.run.companyId,
    workflowRunId: input.run.id, stepRunId: input.stepRunId ?? null,
    ownerExecution: input.ownerExecution ?? null }))) return false;
  if (acceptedWakeExists) return true;
  await queueIssueAssignmentWakeup({
    heartbeat: heartbeatService(input.db),
    issue: wakeIssue,
    reason: "workflow_step_runnable",
    mutation: "workflow_resume",
    contextSource: "workflow.resume",
    payload: {
      ...(input.run.missionId ? { missionId: input.run.missionId } : {}),
      workflowRunId: input.run.id,
      workflowDefinitionId: input.definition.id,
      stepId: input.step.id,
      ...(input.stepRunId ? { workflowStepRunId: input.stepRunId } : {}),
      ...(input.forceFreshSession ? { forceFreshSession: true } : {}),
      ...(structuralReadiness.coverage.length > 0 ? { structuralGateCoverage: structuralReadiness.coverage } : {}),
      ...reworkContext,
      ...priorFindingsContext,
      ...capAcceptancePayload,
      ...qaCapAcceptancePayload,
    },
    contextSnapshot: {
      issueId: issue.id,
      taskId: issue.id,
      ...(input.run.missionId ? { missionId: input.run.missionId } : {}),
      workflowRunId: input.run.id,
      workflowDefinitionId: input.definition.id,
      ...(input.stepRunId ? { workflowStepRunId: input.stepRunId } : {}),
      workflowStepId: input.step.id,
      stepId: input.step.id,
      source: "workflow.resume",
      wakeReason: "workflow_step_runnable",
      ...(input.forceFreshSession ? { forceFreshSession: true } : {}),
      ...(structuralReadiness.coverage.length > 0 ? { structuralGateCoverage: structuralReadiness.coverage } : {}),
      ...reworkContext,
      ...capAcceptancePayload,
      ...qaCapAcceptancePayload,
    },
    requestedByActorType: "system",
    requestedByActorId: `workflow:${input.definition.id}`,
    idempotencyKey: input.idempotencyKey ?? null,
    rethrowOnError: isCapOverrideWakeKey(input.idempotencyKey),
  });
  return true;
}

export async function resolveWorkflowStepAssigneeAgentId(
  db: Db,
  companyId: string,
  step: WorkflowStep,
): Promise<string | undefined> {
  if (typeof step.agentId === "string" && step.agentId.trim()) {
    return step.agentId.trim();
  }

  const rawAgentName = (step as PersistedWorkflowStep).agentName;
  const agentName = typeof rawAgentName === "string"
    ? rawAgentName.trim()
    : "";
  if (!agentName) return undefined;

  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      eq(agents.name, agentName),
      ne(agents.status, "terminated"),
      ne(agents.status, "pending_approval"),
    ))
    .orderBy(asc(agents.createdAt))
    .limit(1);
  return agent?.id;
}
