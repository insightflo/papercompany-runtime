import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { z } from "zod";
import type { MissionSupervisionIssue, MissionSupervisionMission, MissionSupervisionWorkflowStepRow } from "./mission-supervision-context.js";
import type { MissionOwnerDecisionRecord } from "./mission-owner-recovery-ledger.js";
import type { MissionOwnerDecisionOption } from "./mission-owner-recovery-events.js";
import { readOwnerToolIdentity } from "./owner-human-request-authority.js";
import type { OwnerHumanTx } from "./owner-human-request-contract.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";
import { isIssueLessToolStep } from "../workflow/issue-less-tool-shape.js";
import { issueLessToolRecoveryOwnsFailure } from "./tool-step-recovery-authority.js";

const nonempty = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const successfulToolResult = z.object({ success: z.literal(true), requestId: nonempty, completedAt: timestamp }).passthrough();
const completedToolInvocation = z.object({ requestId: nonempty }).passthrough();
const settledToolQueue = z.object({ status: z.literal("settled"), settledAt: timestamp,
  requestId: nonempty.optional() }).passthrough();
const sourceMetadata = z.object({ toolResult: successfulToolResult, toolInvocation: completedToolInvocation,
  toolQueue: settledToolQueue }).passthrough();

export type OwnerToolSourceState =
  | { kind: "source_recovered"; requestId: string; completedAt: string; authorityVersion: number; executionGeneration: number }
  | { kind: "failed_source" }
  | { kind: "held"; reason: string };

export async function loadOwnerToolSourceFacts(input: {
  db: Db; mission: Pick<MissionSupervisionMission, "id" | "companyId">;
  run: MissionSupervisionWorkflowStepRow["run"]; stepRun: MissionSupervisionWorkflowStepRow["stepRun"];
  propagateReadErrors?: boolean;
}): Promise<{ state: OwnerToolSourceState; step: WorkflowStep | null; definitionSource: "snapshot" | "legacy_current" | null }> {
  const { db, mission, run, stepRun } = input;
  const held = (reason: string) => ({ state: { kind: "held" as const, reason }, step: null, definitionSource: null });
  if (run.companyId !== mission.companyId || run.missionId !== mission.id || stepRun.workflowRunId !== run.id)
    return held("source_scope_mismatch");
  try {
    const execution = await loadExecutionDefinition(db, run.id, { requireHistorical: false });
    const steps = execution.steps.filter(candidate => candidate.id === stepRun.stepId);
    if (steps.length !== 1) return held("source_definition_ambiguous");
    const [heartbeat] = stepRun.dispatchOwnerHeartbeatRunId
      ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, stepRun.dispatchOwnerHeartbeatRunId)).limit(1) : [];
    const [wakeup] = stepRun.dispatchOwnerWakeupRequestId
      ? await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, stepRun.dispatchOwnerWakeupRequestId)).limit(1) : [];
    const activeWake = (status: string) => ["queued", "claimed", "deferred_issue_execution", "coalesced"].includes(status);
    const settledHeartbeat = heartbeat && ["succeeded", "failed", "cancelled"].includes(heartbeat.status) && heartbeat.settledAt !== null;
    if (stepRun.dispatchOwnerHeartbeatRunId && (!heartbeat || heartbeat.companyId !== mission.companyId
      || heartbeat.workflowStepRunId !== stepRun.id || heartbeat.workflowExecutionGeneration !== stepRun.executionGeneration
      || heartbeat.wakeupRequestId !== (stepRun.dispatchOwnerWakeupRequestId ?? null)
      || !settledHeartbeat))
      return held(heartbeat?.status === "queued" || heartbeat?.status === "running" || heartbeat?.settledAt === null
        ? "source_dispatch_still_live" : "source_dispatch_reference_mismatch");
    if (stepRun.dispatchOwnerWakeupRequestId && (!wakeup || wakeup.companyId !== mission.companyId
      || wakeup.workflowRunId !== run.id || wakeup.workflowStepRunId !== stepRun.id
      || wakeup.workflowExecutionGeneration !== stepRun.executionGeneration || activeWake(wakeup.status)
      || !["completed", "failed", "cancelled", "skipped"].includes(wakeup.status)))
      return held(wakeup && activeWake(wakeup.status) ? "source_dispatch_still_live" : "source_dispatch_reference_mismatch");
    return { state: classifyOwnerToolSourceFacts({ mission, run, stepRun, step: steps[0]! }),
      step: steps[0]!, definitionSource: execution.source };
  } catch (error) {
    // The brief's optionalRead owns a SAVEPOINT and must see SQL errors to roll it back.
    if (input.propagateReadErrors) throw error;
    return held("source_definition_unavailable");
  }
}

/** Positive source evidence is observational only; it never grants retry or artifact authority. */
export function classifyOwnerToolSourceFacts(input: {
  mission: Pick<MissionSupervisionMission, "id" | "companyId">;
  run: MissionSupervisionWorkflowStepRow["run"];
  stepRun: MissionSupervisionWorkflowStepRow["stepRun"];
  step: WorkflowStep | null;
}): OwnerToolSourceState {
  const { mission, run, stepRun, step } = input;
  if (run.companyId !== mission.companyId || run.missionId !== mission.id || stepRun.workflowRunId !== run.id)
    return { kind: "held", reason: "source_scope_mismatch" };
  if (!step || step.id !== stepRun.stepId || step.type !== "tool" || stepRun.issueId !== null || !isIssueLessToolStep(step))
    return { kind: "held", reason: "source_not_canonical_issue_less_tool" };
  if (stepRun.status === "failed") return { kind: "failed_source" };
  if (stepRun.status !== "completed") return { kind: "held", reason: "source_execution_unsettled" };
  const metadata = sourceMetadata.safeParse(stepRun.metadata);
  const completedAt = stepRun.completedAt;
  if (!metadata.success || !(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime()))
    return { kind: "held", reason: "source_success_evidence_missing" };
  const { toolResult, toolInvocation, toolQueue } = metadata.data;
  const requestId = stepRun.lastDispatchRequestId;
  const completedAtText = completedAt.toISOString();
  if (!requestId || toolResult.requestId !== requestId || toolInvocation.requestId !== requestId
    || (toolQueue.requestId !== undefined && toolQueue.requestId !== requestId)
    || Date.parse(toolResult.completedAt) !== completedAt.getTime()
    || Date.parse(toolQueue.settledAt) !== completedAt.getTime())
    return { kind: "held", reason: "source_success_evidence_mismatch" };
  return { kind: "source_recovered", requestId, completedAt: completedAtText,
    authorityVersion: run.dispatchAuthorityVersion, executionGeneration: stepRun.executionGeneration };
}

/** Resolves only a validated owner-card identity, then reloads its exact current run and step. */
export async function loadBoundOwnerToolSourceState(input: {
  db: Db;
  mission: MissionSupervisionMission;
  issue: MissionSupervisionIssue;
  sourceIssue: MissionSupervisionIssue | null;
  stepRows: MissionSupervisionWorkflowStepRow[];
  decision: MissionOwnerDecisionRecord | null;
}): Promise<OwnerToolSourceState> {
  const { db, mission, issue, sourceIssue, stepRows, decision } = input;
  const held = (reason: string): OwnerToolSourceState => ({ kind: "held", reason });
  if (issue.companyId !== mission.companyId || issue.missionId !== mission.id
    || issue.originKind !== "mission_main_executor_unblock" || !issue.originId
    || !sourceIssue || sourceIssue.id !== issue.originId || sourceIssue.companyId !== mission.companyId
    || sourceIssue.missionId !== mission.id || sourceIssue.originKind !== "mission_main_executor_oversight")
    return held("source_binding_scope_mismatch");
  try {
    const identity = await readOwnerToolIdentity(db as unknown as OwnerHumanTx, mission.companyId, mission.id, issue.id);
    if (!identity) return held("source_binding_missing");
    if (identity.sourceIssueId !== sourceIssue.id) return held("source_binding_scope_mismatch");
    if (decision && (decision.missionId !== mission.id || decision.authorAgentId !== mission.ownerAgentId
      || decision.sourceIssueId !== issue.originId)) return held("decision_scope_mismatch");
    const target = decision?.decision.recoveryTarget;
    if (target && (target.kind !== "tool_step" || target.workflowRunId !== identity.workflowRunId
      || target.stepRunId !== identity.stepRunId)) return held("decision_target_mismatch");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, identity.workflowRunId)).limit(1);
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, identity.stepRunId)).limit(1);
    if (!run || !stepRun || run.id !== identity.workflowRunId || run.companyId !== mission.companyId
      || run.missionId !== mission.id || stepRun.id !== identity.stepRunId || stepRun.workflowRunId !== run.id)
      return held("source_binding_target_mismatch");
    const matches = stepRows.filter(row => row.run.id === run.id && row.stepRun.id === stepRun.id);
    if (matches.length !== 1 || matches[0]!.definition.id !== run.workflowId
      || matches[0]!.definition.companyId !== mission.companyId) return held("source_binding_target_ambiguous");
    if (target && (target.expectedAuthorityVersion !== run.dispatchAuthorityVersion
      || target.expectedExecutionGeneration !== stepRun.executionGeneration
      || target.failedDispatchRequestId !== stepRun.lastDispatchRequestId)) return held("decision_target_mismatch");
    const facts = await loadOwnerToolSourceFacts({ db, mission, run, stepRun });
    if (facts.state.kind === "failed_source" && facts.definitionSource === "legacy_current")
      return held("legacy_source_observation_only");
    return facts.state;
  } catch {
    return held("source_binding_invalid");
  }
}

/** Pure ordered preflight shared by executor and display. Success is NOT locked execution permission. */
export function evaluateOwnerToolRecoverySnapshot(input: {
  mission: Pick<MissionSupervisionMission, "id" | "companyId" | "ownerAgentId">;
  issue: Pick<MissionSupervisionIssue, "originId">;
  sourceIssue: Pick<MissionSupervisionIssue, "originKind"> | null;
  stepRows: MissionSupervisionWorkflowStepRow[];
  decision: MissionOwnerDecisionRecord | null;
  toolCard: boolean; qaCard: boolean; apply: boolean;
}): { kind: "not_applicable" } | { kind: "blocked"; reason: string; outcome: "blocked" | "requires_decision" }
  | { kind: "candidate"; row: MissionSupervisionWorkflowStepRow } {
  const { mission, issue, decision } = input;
  const target = decision?.decision.recoveryTarget ?? null;
  const blocked = (reason: string, outcome: "blocked" | "requires_decision" = "blocked") => ({ kind: "blocked" as const, reason, outcome });
  if (!input.toolCard && target?.kind === "issue") return { kind: "not_applicable" };
  if (!input.toolCard && target?.kind !== "tool_step"
    && (input.qaCard || input.sourceIssue?.originKind !== "mission_main_executor_oversight")) return { kind: "not_applicable" };
  if (!target || target.kind !== "tool_step") return blocked("target_missing", "requires_decision");
  if (!decision || decision.missionId !== mission.id || decision.authorAgentId !== mission.ownerAgentId
    || decision.sourceIssueId !== issue.originId) return blocked("decision_scope_mismatch");
  const matches = input.stepRows.filter(({ run, stepRun }) =>
    run.id === target.workflowRunId && stepRun.id === target.stepRunId
    && stepRun.workflowRunId === target.workflowRunId && run.companyId === mission.companyId && run.missionId === mission.id);
  if (matches.length !== 1) return blocked(matches.length ? "target_ambiguous" : "no_step_run");
  const row = matches[0]!;
  if (row.run.status !== "failed") return blocked("run_not_failed");
  if (row.run.dispatchAuthorityVersion !== target.expectedAuthorityVersion
    || row.stepRun.executionGeneration !== target.expectedExecutionGeneration
    || row.stepRun.lastDispatchRequestId !== target.failedDispatchRequestId) return blocked("stale_generation");
  if (!issueLessToolRecoveryOwnsFailure(row)) return blocked("step_not_retryable");
  if (!input.apply) return blocked("not_requested");
  return { kind: "candidate", row };
}

/** These are the existing branches, not a new policy or a prose-derived action. */
export function toolRecoveryDecisionEffect(decision: MissionOwnerDecisionOption | null) {
  if (decision === "recover_artifact") return "artifact";
  if (decision === "retry_source_issue") return "retry";
  return "no_tool_action";
}
export function ownerDecisionRequestsHuman(decision: MissionOwnerDecisionOption | null) {
  return decision === "request_input" || decision === "escalate";
}
