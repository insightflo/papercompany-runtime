import { heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { issueService } from "../issues.js";
import type { MissionRow, MissionServiceDeps } from "../missions.js";
import { buildMissionOwnerDecisionWakeupIdempotencyKey, hasMissionOwnerDecisionWakeupDispatchedMarker } from "./mission-owner-recovery-events.js";
import { resolveRecoveryOwnership, isQaRecoveryLive } from "./recovery-ownership-guard.js";
import { buildRetrySourceIssueWakeupResultComment } from "./mission-owner-recovery-comments.js";
import { findValidationGateNeedingFreshPass } from "./validation-gate-assessment.js";
import { normalizeMissionOwnerDecisionWakeupDispatchResult, type MissionOwnerDecisionWakeupDispatchStatus, type MissionOwnerSupervisionAppliedAction } from "./supervision-types.js";
import type { MissionSupervisionIssue, MissionSupervisionWorkflowStepRow } from "./mission-supervision-context.js";

type IssueRow = typeof issues.$inferSelect;

type ApplyResult = { findings: string[]; appliedAction?: MissionOwnerSupervisionAppliedAction };
type GateMarkerInput = { missionId: string; ownerActionIssueId: string; sourceIssueId: string; validationIssueId: string; requiredAfter: Date | null };

function buildRequeueMarker(input: GateMarkerInput) {
  return `<!-- mission-owner-validation-gate-requeued:${JSON.stringify({
    missionId: input.missionId,
    ownerActionIssueId: input.ownerActionIssueId,
    sourceIssueId: input.sourceIssueId,
    validationIssueId: input.validationIssueId,
    requiredAfter: input.requiredAfter?.toISOString() ?? null,
  })} -->`;
}

function buildValidationGateWakeupKey(input: GateMarkerInput) {
  const baseKey = buildMissionOwnerDecisionWakeupIdempotencyKey({
    missionId: input.missionId,
    ownerActionIssueId: input.ownerActionIssueId,
    sourceIssueId: input.validationIssueId,
  });
  return `${baseKey}:source:${input.sourceIssueId}:after:${input.requiredAfter?.toISOString() ?? "none"}`;
}

function buildBlockMarker(input: GateMarkerInput) {
  return `<!-- mission-owner-validation-gate-blocked:${JSON.stringify({
    missionId: input.missionId,
    ownerActionIssueId: input.ownerActionIssueId,
    sourceIssueId: input.sourceIssueId,
    validationIssueId: input.validationIssueId,
    requiredAfter: input.requiredAfter?.toISOString() ?? null,
  })} -->`;
}

async function addBlockCommentOnce(input: {
  db: Db;
  mission: MissionRow;
  ownerActionIssue: IssueRow;
  ownerActionLabel: string;
  sourceIssue: IssueRow;
  sourceLabel: string;
  validationIssueId: string;
  validationLabel: string;
  requiredAfter: Date | null;
  reason: string;
}): Promise<boolean> {
  const marker = buildBlockMarker({
    missionId: input.mission.id,
    ownerActionIssueId: input.ownerActionIssue.id,
    sourceIssueId: input.sourceIssue.id,
    validationIssueId: input.validationIssueId,
    requiredAfter: input.requiredAfter,
  });
  const existing = await input.db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, input.mission.companyId), eq(issueComments.issueId, input.sourceIssue.id)))
    .then((rows: Array<{ body: string }>) => rows.some((row) => row.body.includes(marker)));
  if (existing) return false;
  await issueService(input.db).addComment(input.sourceIssue.id, [
    "### Mission owner retry blocked by validation gate",
    marker,
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssue.id})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssue.id})`,
    `Validation gate issue: ${input.validationLabel} (${input.validationIssueId})`,
    "Action: did not wake the source issue because the validation gate has no current PASS.",
    `Reason: ${input.reason}.`,
  ].join("\n"), { agentId: input.mission.ownerAgentId });
  return true;
}

async function activeHeartbeatRunId(db: Db, issueId: string): Promise<string | null> {
  return db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.issueId, issueId), inArray(heartbeatRuns.status, ["queued", "running"])))
    .limit(1)
    .then((rows: Array<{ id: string }>) => rows[0]?.id ?? null);
}

async function resetValidationGateIssue(input: {
  db: Db;
  issue: IssueRow;
  now: Date;
  marker: string;
  mission: MissionRow;
  ownerActionIssue: IssueRow;
  ownerActionLabel: string;
  sourceIssue: IssueRow;
  sourceLabel: string;
  gateLabel: string;
  reason: string;
}): Promise<{ issue: IssueRow; commentId?: string }> {
  const issue = await input.db
    .update(issues)
    .set({
      status: "todo",
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      updatedAt: input.now,
    })
    .where(and(eq(issues.id, input.issue.id), eq(issues.companyId, input.mission.companyId), isNull(issues.hiddenAt)))
    .returning()
    .then((rows: IssueRow[]) => rows[0] ?? input.issue);
  const comment = await issueService(input.db).addComment(input.issue.id, [
    "### Mission owner validation gate requeued",
    input.marker,
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssue.id})`,
    `Blocked source issue: ${input.sourceLabel} (${input.sourceIssue.id})`,
    `Validation gate issue: ${input.gateLabel} (${input.issue.id})`,
    "Action: moved validation gate back to todo before retrying the blocked source issue.",
    `Reason: ${input.reason}.`,
  ].join("\n"), { agentId: input.mission.ownerAgentId });
  return { issue, commentId: comment.id };
}

export async function requeueStaleValidationGateBeforeOwnerRetry(input: {
  db: Db;
  mission: MissionRow;
  ownerActionIssue: IssueRow;
  ownerActionLabel: string;
  sourceIssue: IssueRow;
  sourceLabel: string;
  sourceStepRows: MissionSupervisionWorkflowStepRow[];
  stepRows: MissionSupervisionWorkflowStepRow[];
  missionIssues: MissionSupervisionIssue[];
  now: Date;
  dispatchWakeup: boolean;
  onWakeup?: MissionServiceDeps["onOwnerDecisionRetrySourceIssueApplied"];
}): Promise<ApplyResult | null> {
  const gate = await findValidationGateNeedingFreshPass({
    db: input.db,
    companyId: input.mission.companyId,
    sourceStepRows: input.sourceStepRows,
    stepRows: input.stepRows,
    missionIssues: input.missionIssues,
  });
  if (!gate) return null;

  // [P5] source 의 QA recovery chain 이 live 면 duplicate gate reset/wakeup 금지(observe-only, codex 계약).
  // stalled 는 producer wake ❌ — 이 함수는 gate issue 만 다루므로 gate requeue/retry 는 허용(producer 미건드).
  const ownership = await resolveRecoveryOwnership(input.db, {
    companyId: input.mission.companyId,
    missionId: input.mission.id,
    sourceIssueId: input.sourceIssue.id,
    qaGateIssueId: gate.issue.id,
  });
  if (isQaRecoveryLive(ownership)) {
    return {
      findings: [`validation_gate_requeue_qa_recovery_live: ${input.sourceLabel} ownership=qa_recovery_live signal=${ownership.signal} — observe-only, no duplicate gate reset/wakeup`],
    };
  }

  const findings = [`owner_action_validation_gate_not_passed: ${input.sourceLabel} retry blocked; ${gate.reason}`];
  if (gate.action === "block_source_retry") {
    const commented = await addBlockCommentOnce({
      db: input.db,
      mission: input.mission,
      ownerActionIssue: input.ownerActionIssue,
      ownerActionLabel: input.ownerActionLabel,
      sourceIssue: input.sourceIssue,
      sourceLabel: input.sourceLabel,
      validationIssueId: gate.issue.id,
      validationLabel: gate.label,
      requiredAfter: gate.requiredAfter,
      reason: gate.reason,
    });
    findings.push(`owner_action_validation_gate_retry_blocked: ${gate.label} has current-generation validation output; source retry waits for explicit PASS or producer rework`);
    if (commented) {
      findings.push(`owner_action_validation_gate_block_comment_added: ${input.sourceLabel} documents blocker from ${gate.label}`);
    }
    return { findings };
  }

  const marker = buildRequeueMarker({
    missionId: input.mission.id,
    ownerActionIssueId: input.ownerActionIssue.id,
    sourceIssueId: input.sourceIssue.id,
    validationIssueId: gate.issue.id,
    requiredAfter: gate.requiredAfter,
  });
  const gateCommentBodies: string[] = await input.db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, input.mission.companyId), eq(issueComments.issueId, gate.issue.id)))
    .then((rows: Array<{ body: string }>) => rows.map((row) => row.body));
  const alreadyRequeued = gateCommentBodies.some((body: string) => body.includes(marker));
  const activeRunId = await activeHeartbeatRunId(input.db, gate.issue.id);

  let retryIssue = gate.issue;
  let wakeCommentId: string | undefined;
  if (!activeRunId && !alreadyRequeued) {
    const reset = await resetValidationGateIssue({
      db: input.db,
      issue: gate.issue,
      now: input.now,
      marker,
      mission: input.mission,
      ownerActionIssue: input.ownerActionIssue,
      ownerActionLabel: input.ownerActionLabel,
      sourceIssue: input.sourceIssue,
      sourceLabel: input.sourceLabel,
      gateLabel: gate.label,
      reason: gate.reason,
    });
    retryIssue = reset.issue;
    wakeCommentId = reset.commentId;
    findings.push(`owner_action_validation_gate_requeued: ${gate.label} reset to todo before retrying ${input.sourceLabel}`);
  } else if (activeRunId) {
    findings.push(`owner_action_validation_gate_active: ${gate.label} already has active heartbeat run ${activeRunId}`);
  } else {
    findings.push(`owner_action_validation_gate_requeue_already_recorded: ${gate.label} marker already exists`);
  }

  const idempotencyKey = buildValidationGateWakeupKey({
    missionId: input.mission.id,
    ownerActionIssueId: input.ownerActionIssue.id,
    sourceIssueId: input.sourceIssue.id,
    validationIssueId: gate.issue.id,
    requiredAfter: gate.requiredAfter,
  });
  const wakeupMarkerInput = {
    missionId: input.mission.id,
    ownerActionIssueId: input.ownerActionIssue.id,
    sourceIssueId: gate.issue.id,
    decision: "retry_source_issue" as const,
    idempotencyKey,
  };
  let wakeupDispatchStatus: MissionOwnerDecisionWakeupDispatchStatus = input.dispatchWakeup ? "skipped_no_assignee" : "not_requested";
  if (input.dispatchWakeup && !activeRunId && !hasMissionOwnerDecisionWakeupDispatchedMarker(gateCommentBodies, wakeupMarkerInput)) {
    if (!retryIssue.assigneeAgentId) {
      findings.push(`owner_action_validation_gate_wakeup_skipped: ${gate.label} validation issue has no assignee`);
    } else if (input.onWakeup) {
      try {
        const result = await input.onWakeup({
          mission: input.mission,
          ownerActionIssue: input.ownerActionIssue,
          sourceIssue: retryIssue,
          targetAgentId: retryIssue.assigneeAgentId,
          idempotencyKey,
          wakeCommentId,
        });
        wakeupDispatchStatus = normalizeMissionOwnerDecisionWakeupDispatchResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        findings.push(`owner_action_validation_gate_wakeup_failed: ${gate.label} wakeup callback failed - ${message}`);
        wakeupDispatchStatus = "failed";
      }
    } else {
      findings.push("owner_action_validation_gate_wakeup_skipped: dispatch requested but no wakeup callback configured");
      wakeupDispatchStatus = "failed";
    }
  }

  if (retryIssue.assigneeAgentId && input.dispatchWakeup) {
    await issueService(input.db).addComment(gate.issue.id, buildRetrySourceIssueWakeupResultComment({
      status: wakeupDispatchStatus,
      missionId: input.mission.id,
      ownerActionIssueId: input.ownerActionIssue.id,
      ownerActionLabel: input.ownerActionLabel,
      sourceIssueId: gate.issue.id,
      sourceLabel: gate.label,
      targetAgentId: retryIssue.assigneeAgentId,
      idempotencyKey,
    }), { agentId: input.mission.ownerAgentId });
  }

  return {
    findings,
    appliedAction: {
      type: "owner_decision_retry_source_issue",
      missionId: input.mission.id,
      ownerActionIssueId: input.ownerActionIssue.id,
      sourceIssueId: gate.issue.id,
      resultStatus: retryIssue.status,
      wakeupDispatchStatus,
      idempotencyKey,
    },
  };
}
