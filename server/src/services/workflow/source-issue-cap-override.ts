// server/src/services/workflow/source-issue-cap-override.ts
//
// [파일 목적] Mission Owner(Oversight) 가 QA rework cap(maxIterations) 을 넘어 producer 를 1회 retry 하는
//   cap-override 의 fresh apply 경로. authority/dispatch/snapshot sibling module 을 단방향 import 하고,
//   recovery coordinator 는 crash-window audit 만 dispatch 로 연결한다(runtime cycle 없음).
// [계약]
//   - authority = exact structured mission-owner decision event ID (validated fail-closed).
//   - one-shot = decision event id. hash marker(qa-cap-key:<32-hex>) 는 company/run/producer/qa/generation bind.
//   - current official QA request_changes verdict 만 증거. producer iteration+1, cleaned metadata, run revive,
//     issue reopen — 단일 forward 트랜잭션(CAS + audit insert onConflictDoNothing). 이후 dispatchCapOverrideWake 가
//     pending→dispatching(token) claim → wake → accepted-mark 한다.
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { buildWorkflowExecutionSteps, wakeExistingWorkflowStepIssue, type WorkflowStep } from "./dag-engine.js";
import { resolveEdges } from "./control-flow/edge-condition.js";
import type { SourceIssueNativeResumeOutcome } from "./source-issue-native-resume.js";
import { validateOwnerDecisionComment } from "./source-issue-cap-override-authority.js";
import { dispatchCapOverrideWake } from "./source-issue-cap-override-dispatch.js";
import { buildCapOverridePriorSnapshot } from "./source-issue-cap-override-snapshot.js";

type StepRunRow = typeof workflowStepRuns.$inferSelect;

const MARKER_PATTERN = /(?:^|\s)qa-cap-key:([a-f0-9]{32})(?=\s|$)/g;
const REOPENABLE_ISSUE_STATUSES = ["blocked", "todo", "backlog", "done"];
const PRODUCER_CLEAR_KEYS = ["toolInvocation", "toolResult", "toolQueue", "cacheHit", "concurrencyBlocked", "controlFlowSkipped", "retentionDeleted", "workflowReworkContract", "semanticQaVerdict", "structuralGateVerdict", "structuralGateProducerToken"] as const;

export interface CapOverrideOwnerAction {
  ownerActionIssueId: string;
  missionId: string;
  // Legacy wire name; the value is the structured mission-owner decision event ID.
  decisionCommentId: string;
}

export function buildQaCapKey(input: { companyId: string; workflowRunId: string; producerStepId: string; qaStepId: string; producerIteration: number; producerCompletedAt: Date }): string {
  return createHash("sha256").update(JSON.stringify([input.companyId, input.workflowRunId, input.producerStepId, input.qaStepId, input.producerIteration, input.producerCompletedAt.toISOString()])).digest("hex").slice(0, 32);
}
function readQaCapKeys(description: string | null): Set<string> {
  return description ? new Set(Array.from(description.matchAll(MARKER_PATTERN), (m) => m[1]!)) : new Set();
}
function cleanProducerMetadata(raw: unknown): Record<string, unknown> {
  const meta = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  for (const key of PRODUCER_CLEAR_KEYS) delete meta[key];
  return meta;
}
function cas<T>(col: T, value: unknown): SQL {
  return value === null || value === undefined ? isNull(col as never) : eq(col as never, value as never);
}

// current official request_changes 증거 for ONE exact QA step run.
async function findCurrentRequestChangesEvidence(db: Db, companyId: string, qaRun: StepRunRow, producerCompletedAt: Date | null): Promise<{ workflowStepRunId: string; heartbeatRunId: string; observedAt: Date } | null> {
  if (!qaRun.issueId) return null;
  const [row] = await db.select({ verdict: workflowTransitionEvents.verdict, createdAt: workflowTransitionEvents.createdAt, workflowStepRunId: workflowTransitionEvents.workflowStepRunId, heartbeatRunId: workflowTransitionEvents.heartbeatRunId })
    .from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.issueId, qaRun.issueId), eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"), eq(workflowTransitionEvents.reason, "workflow_api"), isNotNull(workflowTransitionEvents.heartbeatRunId)))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(1);
  if (!row || row.verdict !== "request_changes") return null;
  if (!row.workflowStepRunId || row.workflowStepRunId !== qaRun.id) return null;
  if (!producerCompletedAt || !row.createdAt || row.createdAt.getTime() < producerCompletedAt.getTime()) return null;
  if (!row.heartbeatRunId) return null;
  const [latest] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .innerJoin(agentWakeupRequests, eq(heartbeatRuns.wakeupRequestId, agentWakeupRequests.id))
    .where(and(eq(heartbeatRuns.issueId, qaRun.issueId), eq(agentWakeupRequests.workflowStepRunId, qaRun.id)))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  if (latest?.id !== row.heartbeatRunId) return null;
  return { workflowStepRunId: row.workflowStepRunId, heartbeatRunId: row.heartbeatRunId, observedAt: row.createdAt };
}

const report = (reason: SourceIssueNativeResumeOutcome, runId: string | null, srId: string | null, stepId: string | null): SourceIssueNativeResumeOutcome => reason;

export async function applyOwnerCapOverrideRetry(db: Db, input: { companyId: string; issueId: string; allowBlockedIssue?: boolean; ownerAction: CapOverrideOwnerAction; wakeFn?: typeof wakeExistingWorkflowStepIssue }): Promise<SourceIssueNativeResumeOutcome> {
  const { companyId, issueId } = input;
  const noMarker = (runId: string | null, srId: string | null, stepId: string | null) => report({ kind: "report_only", reason: "cap_override_no_marker", workflowRunId: runId, workflowStepRunId: srId, stepId }, runId, srId, stepId);

  const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.issueId, issueId)).orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt)).limit(1);
  if (!stepRun) return report({ kind: "report_only", reason: "cap_override_no_back_edge", workflowRunId: null, workflowStepRunId: null, stepId: null }, null, null, null);
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, stepRun.workflowRunId), eq(workflowRuns.companyId, companyId))).limit(1);
  if (!run || run.status !== "failed") return report({ kind: "report_only", reason: "cap_override_under_cap", workflowRunId: stepRun.workflowRunId, workflowStepRunId: stepRun.id, stepId: stepRun.stepId }, stepRun.workflowRunId, stepRun.id, stepRun.stepId);
  if (stepRun.status !== "completed") return report({ kind: "report_only", reason: "cap_override_under_cap", workflowRunId: run.id, workflowStepRunId: stepRun.id, stepId: stepRun.stepId }, run.id, stepRun.id, stepRun.stepId);
  const [definition] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.id, run.workflowId), eq(workflowDefinitions.companyId, companyId))).limit(1);
  const steps: WorkflowStep[] = definition ? buildWorkflowExecutionSteps(definition) : [];
  const producerStep = steps.find((s) => s.id === stepRun.stepId) ?? null;
  if (!producerStep || !definition) return report({ kind: "report_only", reason: "cap_override_no_back_edge", workflowRunId: run.id, workflowStepRunId: stepRun.id, stepId: stepRun.stepId }, run.id, stepRun.id, stepRun.stepId);

  const [sourceIssue] = await db.select({ companyId: issues.companyId, missionId: issues.missionId, identifier: issues.identifier, status: issues.status, completedAt: issues.completedAt, updatedAt: issues.updatedAt }).from(issues).where(eq(issues.id, issueId)).limit(1);
  if (!sourceIssue || sourceIssue.companyId !== companyId || !sourceIssue.missionId || sourceIssue.missionId !== input.ownerAction.missionId || run.missionId !== input.ownerAction.missionId) return report({ kind: "report_only", reason: "cap_override_wrong_scope", workflowRunId: run.id, workflowStepRunId: stepRun.id, stepId: stepRun.stepId }, run.id, stepRun.id, stepRun.stepId);
  const [mission] = await db.select({ ownerAgentId: missions.ownerAgentId }).from(missions).where(and(eq(missions.id, input.ownerAction.missionId), eq(missions.companyId, companyId))).limit(1);
  const [ownerActionIssue] = await db.select({ id: issues.id, missionId: issues.missionId, originKind: issues.originKind, assigneeAgentId: issues.assigneeAgentId, description: issues.description }).from(issues).where(and(eq(issues.id, input.ownerAction.ownerActionIssueId), eq(issues.companyId, companyId))).limit(1);
  if (!mission || !ownerActionIssue || ownerActionIssue.missionId !== input.ownerAction.missionId || ownerActionIssue.originKind !== "mission_main_executor_unblock" || ownerActionIssue.assigneeAgentId !== mission.ownerAgentId) return report({ kind: "report_only", reason: "cap_override_wrong_scope", workflowRunId: run.id, workflowStepRunId: stepRun.id, stepId: stepRun.stepId }, run.id, stepRun.id, stepRun.stepId);

  const decision = await validateOwnerDecisionComment(db, companyId, { decisionCommentId: input.ownerAction.decisionCommentId, ownerActionIssueId: input.ownerAction.ownerActionIssueId, missionOwnerAgentId: mission.ownerAgentId, producerCompletedAt: stepRun.completedAt, producerIssueId: issueId, producerIdentifier: sourceIssue.identifier });
  if (!decision) return noMarker(run.id, stepRun.id, stepRun.stepId);

  const backEdges = resolveEdges(producerStep).filter((e) => e.isBackEdge === true && typeof e.maxIterations === "number" && e.maxIterations >= 1);
  if (backEdges.length === 0 || !stepRun.completedAt) return report({ kind: "report_only", reason: "cap_override_no_back_edge", workflowRunId: run.id, workflowStepRunId: stepRun.id, stepId: stepRun.stepId }, run.id, stepRun.id, stepRun.stepId);
  const fromIteration = stepRun.iterationIndex ?? 0;
  const capKeys = readQaCapKeys(ownerActionIssue.description);
  const matchedEdges = backEdges.filter((edge) => capKeys.has(buildQaCapKey({ companyId, workflowRunId: run.id, producerStepId: producerStep.id, qaStepId: edge.stepId, producerIteration: fromIteration, producerCompletedAt: stepRun.completedAt! })));
  if (matchedEdges.length !== 1) return noMarker(run.id, stepRun.id, stepRun.stepId);
  const qaEdge = matchedEdges[0]!;
  const qaStepId = qaEdge.stepId;
  const cap = qaEdge.maxIterations!;
  if (fromIteration < cap) return report({ kind: "report_only", reason: "cap_override_under_cap", workflowRunId: run.id, workflowStepRunId: stepRun.id, stepId: stepRun.stepId }, run.id, stepRun.id, stepRun.stepId);

  const auditKey = `cap-override:${decision.eventId}`;
  const wakeKey = `cap-override-wake:${decision.eventId}`;
  const [qaRun] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, run.id), eq(workflowStepRuns.stepId, qaStepId))).limit(1);
  if (!qaRun) return report({ kind: "report_only", reason: "cap_override_no_current_request_changes", workflowRunId: run.id, workflowStepRunId: stepRun.id, stepId: stepRun.stepId }, run.id, stepRun.id, stepRun.stepId);
  const evidence = await findCurrentRequestChangesEvidence(db, companyId, qaRun, stepRun.completedAt);
  if (!evidence) return report({ kind: "report_only", reason: "cap_override_no_current_request_changes", workflowRunId: run.id, workflowStepRunId: stepRun.id, stepId: stepRun.stepId }, run.id, stepRun.id, stepRun.stepId);

  const cleanedMeta = cleanProducerMetadata(stepRun.metadata);
  const forwardAppliedAt = new Date();
  const priorSnapshot = buildCapOverridePriorSnapshot({
    run,
    stepRun,
    issue: {
      id: issueId,
      status: sourceIssue.status,
      completedAt: sourceIssue.completedAt,
      updatedAt: sourceIssue.updatedAt,
    },
  });
  const basePayload = {
    kind: "owner_cap_override_retry" as const,
    ownerActionIssueId: input.ownerAction.ownerActionIssueId,
    decisionCommentId: decision.eventId,
    decisionCommentCreatedAt: decision.createdAt.toISOString(),
    wakeIdempotencyKey: wakeKey,
    missionId: input.ownerAction.missionId,
    missionOwnerAgentId: mission.ownerAgentId,
    workflowRunId: run.id,
    workflowDefinitionId: definition.id,
    producerIssueId: issueId,
    producerStepId: producerStep.id,
    producerStepRunId: stepRun.id,
    qaStepId,
    qaStepRunId: qaRun.id,
    qaIssueId: qaRun.issueId ?? null,
    fromIteration,
    toIteration: fromIteration + 1,
    cap,
    generation: fromIteration,
    producerCleanedMetadata: cleanedMeta,
    dispatchEpoch: 0,
    verdictWorkflowStepRunId: evidence.workflowStepRunId,
    verdictHeartbeatRunId: evidence.heartbeatRunId,
    producerCompletedAt: stepRun.completedAt?.toISOString() ?? null,
    forwardedIssueUpdatedAt: forwardAppliedAt.toISOString(),
    priorSnapshot,
  };
  let auditEventId: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const s = workflowStepRuns;
      const prodRes = await tx.update(s).set({ status: "pending", iterationIndex: fromIteration + 1, startedAt: null, completedAt: null, lastDispatchAttemptAt: null, lastDispatchAcceptedAt: null, lastDispatchErrorAt: null, lastDispatchErrorSummary: null, lastDispatchRequestId: null, metadata: cleanedMeta })
        .where(and(eq(s.id, stepRun.id), eq(s.status, "completed"), eq(s.iterationIndex, fromIteration), cas(s.startedAt, stepRun.startedAt), cas(s.completedAt, stepRun.completedAt), cas(s.lastDispatchAttemptAt, stepRun.lastDispatchAttemptAt), cas(s.lastDispatchAcceptedAt, stepRun.lastDispatchAcceptedAt), cas(s.lastDispatchErrorAt, stepRun.lastDispatchErrorAt), cas(s.lastDispatchErrorSummary, stepRun.lastDispatchErrorSummary), cas(s.lastDispatchRequestId, stepRun.lastDispatchRequestId), eq(s.metadata, stepRun.metadata))).returning({ id: s.id });
      if (prodRes.length === 0) throw new Error("cap-override-cas-lost-producer");
      const r = workflowRuns;
      const runRes = await tx.update(r).set({ status: "running", completedAt: null }).where(and(eq(r.id, run.id), eq(r.companyId, companyId), eq(r.status, "failed"), cas(r.startedAt, run.startedAt), cas(r.completedAt, run.completedAt))).returning({ id: r.id });
      if (runRes.length === 0) throw new Error("cap-override-cas-lost-run");
      const issueRes = await tx.update(issues).set({ status: "todo", completedAt: null, updatedAt: forwardAppliedAt }).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId), eq(issues.status, sourceIssue.status), cas(issues.completedAt, sourceIssue.completedAt), cas(issues.updatedAt, sourceIssue.updatedAt), inArray(issues.status, REOPENABLE_ISSUE_STATUSES))).returning({ id: issues.id });
      if (issueRes.length === 0) throw new Error("cap-override-cas-lost-issue");
      const inserted = await tx.insert(workflowTransitionEvents).values({ companyId, missionId: run.missionId ?? null, workflowRunId: run.id, workflowStepRunId: stepRun.id, issueId: stepRun.issueId ?? null, heartbeatRunId: evidence.heartbeatRunId, eventType: "owner_cap_override_retry", layer: "workflow_validation", fromStatus: "failed", toStatus: "running", decision: "retry_source_issue", verdict: "request_changes", reason: "workflow_api", reasonCode: "owner_cap_override", correlationId: input.ownerAction.ownerActionIssueId, idempotencyKey: auditKey, payload: { ...basePayload, status: "pending" } }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
      if (inserted.length === 0) throw new Error("cap-override-audit-conflict-duplicate");
      auditEventId = inserted[0]!.id;
    });
  } catch {
    return report({ kind: "report_only", reason: "cap_override_queue_rolled_back", workflowRunId: run.id, workflowStepRunId: stepRun.id, stepId: stepRun.stepId }, run.id, stepRun.id, stepRun.stepId);
  }
  // [A] shared wake phase(recovery): pending→dispatching(token) claim → shape/decision verify → wake → accepted-mark.
  return dispatchCapOverrideWake(db, { companyId, auditId: auditEventId!, auditIdempotencyKey: auditKey, payload: { ...basePayload, status: "pending" }, wakeKey, wakeFn: input.wakeFn, allowBlockedIssue: input.allowBlockedIssue ?? true, mode: "fresh" });
}
