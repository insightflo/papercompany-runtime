import { heartbeatRuns, issueComments, issues, workflowTransitionEvents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { issueService } from "../issues.js";
import type { MissionRow, MissionServiceDeps } from "../missions.js";
import { buildMissionOwnerDecisionWakeupIdempotencyKey } from "./mission-owner-recovery-events.js";
import { loadLatestMissionOwnerDecision } from "./mission-owner-recovery-ledger.js";
import { resolveRecoveryOwnership, isQaRecoveryLive } from "./recovery-ownership-guard.js";
import { buildRetrySourceIssueWakeupResultComment } from "./mission-owner-recovery-comments.js";
import { findValidationGateNeedingFreshPass } from "./validation-gate-assessment.js";
import { normalizeMissionOwnerDecisionWakeupDispatchResult, type MissionOwnerDecisionWakeupDispatchStatus, type MissionOwnerSupervisionAppliedAction } from "./supervision-types.js";
import type { MissionSupervisionIssue, MissionSupervisionWorkflowStepRow } from "./mission-supervision-context.js";

type IssueRow = typeof issues.$inferSelect;
type ApplyResult = { findings: string[]; appliedAction?: MissionOwnerSupervisionAppliedAction };
type GateMarkerInput = { missionId: string; ownerActionIssueId: string; sourceIssueId: string; validationIssueId: string; requiredAfter: Date | null };

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
  db: Db; mission: MissionRow; ownerActionIssue: IssueRow; ownerActionLabel: string; sourceIssue: IssueRow; sourceLabel: string;
  validationIssueId: string; validationLabel: string; requiredAfter: Date | null; reason: string;
}): Promise<boolean> {
  const marker = buildBlockMarker({
    missionId: input.mission.id, ownerActionIssueId: input.ownerActionIssue.id, sourceIssueId: input.sourceIssue.id,
    validationIssueId: input.validationIssueId, requiredAfter: input.requiredAfter,
  });
  // Display-only duplicate suppression; this marker never controls gate requeue or wakeup execution.
  const existing = await input.db.select({ body: issueComments.body }).from(issueComments)
    .where(and(eq(issueComments.companyId, input.mission.companyId), eq(issueComments.issueId, input.sourceIssue.id)))
    .then((rows: Array<{ body: string }>) => rows.some((row) => row.body.includes(marker)));
  if (existing) return false;
  await issueService(input.db).addComment(input.sourceIssue.id, [
    "### Mission owner retry blocked by validation gate", marker,
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssue.id})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssue.id})`,
    `Validation gate issue: ${input.validationLabel} (${input.validationIssueId})`,
    "Action: did not wake the source issue because the validation gate has no current PASS.", `Reason: ${input.reason}.`,
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
  db: Db; issue: IssueRow; now: Date; mission: MissionRow; ownerActionIssue: IssueRow; ownerActionLabel: string;
  sourceIssue: IssueRow; sourceLabel: string; gateLabel: string; reason: string; decisionEventId: string;
  heartbeatRunId: string | null; actionIdempotencyKey: string;
}): Promise<{ issue: IssueRow; commentId?: string } | null> {
  const issue = await input.db.transaction(async (tx) => {
    const updated = await tx.update(issues).set({
      status: "todo", startedAt: null, completedAt: null, cancelledAt: null, checkoutRunId: null,
      executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, updatedAt: input.now,
    }).where(and(
      eq(issues.id, input.issue.id), eq(issues.companyId, input.mission.companyId),
      eq(issues.status, input.issue.status), isNull(issues.hiddenAt),
    )).returning().then((rows: IssueRow[]) => rows[0] ?? null);
    if (!updated) return null;
    const event = await tx.insert(workflowTransitionEvents).values({
      companyId: input.mission.companyId, missionId: input.mission.id, issueId: input.issue.id,
      heartbeatRunId: input.heartbeatRunId, eventType: "mission_owner_recovery_action",
      layer: "mission_owner_recovery", fromStatus: input.issue.status, toStatus: "todo",
      decision: "retry_source_issue", reason: "owner_recovery_api", reasonCode: "owner_recovery_api",
      correlationId: input.decisionEventId, idempotencyKey: input.actionIdempotencyKey,
      payload: { kind: "mission_owner_recovery_action", action: "validation_gate_requeue", decisionEventId: input.decisionEventId, ownerActionIssueId: input.ownerActionIssue.id, sourceIssueId: input.sourceIssue.id, validationIssueId: input.issue.id },
    }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
    if (event.length === 0) throw new Error("validation-gate-requeue: durable action already recorded");
    return updated;
  });
  if (!issue) return null;
  const comment = await issueService(input.db).addComment(input.issue.id, [
    "### Mission owner validation gate requeued",
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssue.id})`,
    `Blocked source issue: ${input.sourceLabel} (${input.sourceIssue.id})`,
    `Validation gate issue: ${input.gateLabel} (${input.issue.id})`, `Reason: ${input.reason}.`,
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
  // [gate-first] AUTO grace default 등 structured decision 이 없는 경로에서도 gate 가 없으면 null 을 반환해
  //   producer rework/authorize 경로를 막지 않는다. 실제 gate requeue mutation 만 structured ledger 권위를 요구한다.
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

  // [structured authority] gate requeue mutation 은 structured retry_source_issue decision 이 source 를
  //   타겟할 때만 허용. comment requeue marker 는 더 이상 권위가 아니다.
  //   gate 가 없으면 위에서 null 을 반환하므로 AUTO grace 등 structured 없는 일반 retry 는 막지 않는다.
  const structuredDecision = await loadLatestMissionOwnerDecision({
    db: input.db, companyId: input.mission.companyId, ownerActionIssueId: input.ownerActionIssue.id,
  });
  if (
    !structuredDecision ||
    structuredDecision.decision.decision !== "retry_source_issue" ||
    structuredDecision.missionId !== input.mission.id ||
    structuredDecision.authorAgentId !== input.mission.ownerAgentId
  ) {
    return { findings: [`owner_action_validation_gate_not_applied: ${input.sourceLabel} requires a current structured retry_source_issue decision`] };
  }
  const reworkTargetRef = structuredDecision.decision.reworkTargetRef?.trim();
  if (
    structuredDecision.sourceIssueId !== input.sourceIssue.id &&
    reworkTargetRef !== input.sourceIssue.id &&
    reworkTargetRef !== input.sourceIssue.identifier
  ) {
    return { findings: [`owner_action_validation_gate_not_applied: ${input.sourceLabel} is not targeted by the structured owner-recovery decision`] };
  }

  const idempotencyKey = buildValidationGateWakeupKey({
    missionId: input.mission.id, ownerActionIssueId: input.ownerActionIssue.id, sourceIssueId: input.sourceIssue.id,
    validationIssueId: gate.issue.id, requiredAfter: gate.requiredAfter,
  });
  const actionIdempotencyKey = `${idempotencyKey}:requeue`;
  const existingAction = await input.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.companyId, input.mission.companyId), eq(workflowTransitionEvents.idempotencyKey, actionIdempotencyKey))).limit(1);
  const activeRunId = await activeHeartbeatRunId(input.db, gate.issue.id);
  let retryIssue = gate.issue;
  let wakeCommentId: string | undefined;
  if (!activeRunId && existingAction.length === 0) {
    const reset = await resetValidationGateIssue({
      db: input.db, issue: gate.issue, now: input.now, mission: input.mission, ownerActionIssue: input.ownerActionIssue,
      ownerActionLabel: input.ownerActionLabel, sourceIssue: input.sourceIssue, sourceLabel: input.sourceLabel,
      gateLabel: gate.label, reason: gate.reason, decisionEventId: structuredDecision.eventId,
      heartbeatRunId: structuredDecision.heartbeatRunId, actionIdempotencyKey,
    });
    if (reset) {
      retryIssue = reset.issue;
      wakeCommentId = reset.commentId;
      findings.push(`owner_action_validation_gate_requeued: ${gate.label} reset to todo before retrying ${input.sourceLabel}`);
    } else {
      const duplicate = await input.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
        .where(and(eq(workflowTransitionEvents.companyId, input.mission.companyId), eq(workflowTransitionEvents.idempotencyKey, actionIdempotencyKey))).limit(1);
      if (duplicate.length === 0) return { findings: [...findings, `owner_action_validation_gate_requeue_not_applied: ${gate.label} changed before reset`] };
      retryIssue = await input.db.select().from(issues).where(and(eq(issues.id, gate.issue.id), eq(issues.companyId, input.mission.companyId))).limit(1).then((rows) => rows[0] ?? gate.issue);
      findings.push(`owner_action_validation_gate_requeue_already_recorded: ${gate.label} durable action exists`);
    }
  } else if (activeRunId) {
    findings.push(`owner_action_validation_gate_active: ${gate.label} already has active heartbeat run ${activeRunId}`);
  } else {
    retryIssue = await input.db.select().from(issues).where(and(eq(issues.id, gate.issue.id), eq(issues.companyId, input.mission.companyId))).limit(1).then((rows) => rows[0] ?? gate.issue);
    findings.push(`owner_action_validation_gate_requeue_already_recorded: ${gate.label} durable action exists`);
  }

  let wakeupDispatchStatus: MissionOwnerDecisionWakeupDispatchStatus = input.dispatchWakeup ? "skipped_no_assignee" : "not_requested";
  if (input.dispatchWakeup && !activeRunId) {
    const existingWake = await input.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.companyId, input.mission.companyId), eq(workflowTransitionEvents.idempotencyKey, idempotencyKey))).limit(1);
    if (existingWake.length === 0 && !retryIssue.assigneeAgentId) {
      findings.push(`owner_action_validation_gate_wakeup_skipped: ${gate.label} validation issue has no assignee`);
    } else if (existingWake.length === 0 && input.onWakeup && retryIssue.assigneeAgentId) {
      try {
        wakeupDispatchStatus = normalizeMissionOwnerDecisionWakeupDispatchResult(await input.onWakeup({
          mission: input.mission, ownerActionIssue: input.ownerActionIssue, sourceIssue: retryIssue,
          targetAgentId: retryIssue.assigneeAgentId, idempotencyKey, wakeCommentId,
        }));
        const wake = await input.db.insert(workflowTransitionEvents).values({
          companyId: input.mission.companyId, missionId: input.mission.id, issueId: gate.issue.id,
          heartbeatRunId: structuredDecision.heartbeatRunId, eventType: "mission_owner_recovery_wakeup",
          layer: "mission_owner_recovery", decision: "retry_source_issue", reason: "owner_recovery_api",
          reasonCode: "owner_recovery_api", correlationId: structuredDecision.eventId, idempotencyKey,
          payload: { kind: "mission_owner_recovery_wakeup", action: "validation_gate_requeue", decisionEventId: structuredDecision.eventId, ownerActionIssueId: input.ownerActionIssue.id, sourceIssueId: input.sourceIssue.id, validationIssueId: gate.issue.id, targetAgentId: retryIssue.assigneeAgentId, status: wakeupDispatchStatus },
        }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
        if (wake.length > 0) await issueService(input.db).addComment(gate.issue.id, buildRetrySourceIssueWakeupResultComment({
          status: wakeupDispatchStatus, missionId: input.mission.id, ownerActionIssueId: input.ownerActionIssue.id,
          ownerActionLabel: input.ownerActionLabel, sourceIssueId: gate.issue.id, sourceLabel: gate.label,
          targetAgentId: retryIssue.assigneeAgentId, idempotencyKey,
        }), { agentId: input.mission.ownerAgentId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        findings.push(`owner_action_validation_gate_wakeup_failed: ${gate.label} wakeup callback failed - ${message}`);
        wakeupDispatchStatus = "failed";
      }
    } else if (existingWake.length === 0) {
      findings.push("owner_action_validation_gate_wakeup_skipped: dispatch requested but no wakeup callback configured");
      wakeupDispatchStatus = "failed";
    }
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
