import { agents, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { issueService } from "../issues.js";
import type { MissionRow, MissionServiceDeps } from "../missions.js";
import {
  describeMissionExecutionLiaisonBoundary,
  isMissionExecutionLiaisonAgent,
  isRunnableMissionExecutionAssigneeStatus,
} from "./agent-role-boundaries.js";
import {
  buildMissionOwnerDecisionAppliedMarker,
  buildMissionOwnerDecisionWakeupDispatchedMarker,
  buildMissionOwnerDecisionWakeupIdempotencyKey,
  hasMissionOwnerDecisionAppliedMarker,
  hasMissionOwnerDecisionWakeupDispatchedMarker,
} from "./mission-owner-recovery-events.js";
import { summarizeOwnerDecisionNotApplied } from "./mission-owner-recovery-comments.js";
import {
  normalizeMissionOwnerDecisionWakeupDispatchResult,
  type MissionOwnerDecisionWakeupDispatchStatus,
  type MissionOwnerSupervisionAppliedAction,
} from "./supervision-types.js";

const UUID_SOURCE = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`;
const UUID_PATTERN = new RegExp(String.raw`\b${UUID_SOURCE}\b`, "giu");
const TARGET_AGENT_PATTERN = new RegExp(String.raw`(?:^|\n)\s*(?:target\s+agent|target\s+assignee|assignee\s+agent|new\s+assignee)\s*:\s*[^\n]*?\b(${UUID_SOURCE})\b`, "iu");
const TO_AGENT_PATTERN = new RegExp(String.raw`\bto\s+[^\n]*?\bagent\b[^\n]*?\b(${UUID_SOURCE})\b`, "iu");
const AGENT_LABEL_PATTERN = new RegExp(String.raw`\bagent\b[^\n]*?\b(${UUID_SOURCE})\b`, "iu");

export type ReassignSourceIssueDecisionText = {
  readonly nextAction?: string;
  readonly reason?: string;
  readonly evidence?: string;
};

type ReassignSourceIssueDecision = ReassignSourceIssueDecisionText & {
  readonly decision: "reassign_source_issue";
};

type ReassignSourceIssueResult = {
  readonly findings: string[];
  readonly appliedAction?: MissionOwnerSupervisionAppliedAction;
};

export function extractReassignTargetAgentId(input: ReassignSourceIssueDecisionText): string | null {
  const fields = [input.nextAction, input.reason, input.evidence].filter((field): field is string => Boolean(field));
  const targetPatterns = [TARGET_AGENT_PATTERN, TO_AGENT_PATTERN, AGENT_LABEL_PATTERN];
  for (const field of fields) {
    for (const pattern of targetPatterns) {
      const targetAgentId = field.match(pattern)?.[1] ?? null;
      if (targetAgentId) return targetAgentId;
    }
  }
  for (const field of fields) {
    const matches = Array.from(field.matchAll(UUID_PATTERN), (match) => match[0]);
    if (matches.length === 1) return matches[0] ?? null;
  }
  return null;
}

export function buildReassignSourceIssueComment(input: {
  readonly ownerActionIssueId: string;
  readonly ownerActionLabel: string;
  readonly sourceIssueId: string;
  readonly sourceLabel: string;
  readonly previousAgentId: string | null;
  readonly targetAgentId: string;
  readonly decisionReason?: string;
}): string {
  return [
    "### Mission owner reassignment applied",
    buildMissionOwnerDecisionAppliedMarker({
      ownerActionIssueId: input.ownerActionIssueId,
      sourceIssueId: input.sourceIssueId,
      decision: "reassign_source_issue",
    }),
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssueId})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    "Decision: reassign_source_issue",
    `Previous assignee: ${input.previousAgentId ?? "unassigned"}`,
    `Target assignee: ${input.targetAgentId}`,
    "Action: explicit mission-owner reassignment changed the source issue assignee and kept it runnable.",
    `Reason: ${input.decisionReason ?? "Owner requested source issue reassignment."}`,
  ].join("\n");
}

export function buildReassignSourceIssueWakeupResultComment(input: {
  readonly status: MissionOwnerDecisionWakeupDispatchStatus;
  readonly missionId: string;
  readonly ownerActionIssueId: string;
  readonly ownerActionLabel: string;
  readonly sourceIssueId: string;
  readonly sourceLabel: string;
  readonly targetAgentId: string;
  readonly idempotencyKey: string;
}): string {
  const marker = buildMissionOwnerDecisionWakeupDispatchedMarker({
    missionId: input.missionId,
    ownerActionIssueId: input.ownerActionIssueId,
    sourceIssueId: input.sourceIssueId,
    decision: "reassign_source_issue",
    idempotencyKey: input.idempotencyKey,
  });
  return [
    input.status === "workflow_already_dispatched"
      ? "### Mission owner reassignment wakeup handled by workflow"
      : "### Mission owner reassignment wakeup dispatched",
    marker,
    `Owner-action issue: ${input.ownerActionLabel} (${input.ownerActionIssueId})`,
    `Source issue: ${input.sourceLabel} (${input.sourceIssueId})`,
    `Target agent: ${input.targetAgentId}`,
    input.status === "workflow_already_dispatched"
      ? "Wakeup: skipped direct mission-owner wake because an existing workflow resume wake already covered this source issue."
      : `Wakeup status: ${input.status}`,
    `Idempotency key: ${input.idempotencyKey}`,
  ].join("\n");
}

export async function applyReassignSourceIssueDecision(input: {
  readonly db: Db;
  readonly mission: MissionRow;
  readonly ownerActionIssue: typeof issues.$inferSelect;
  readonly ownerActionLabel: string;
  readonly ownerDecision: ReassignSourceIssueDecision;
  readonly sourceIssue: typeof issues.$inferSelect | null;
  readonly sourceLabel: string;
  readonly sourceComments: readonly string[];
  readonly sourceHasActiveHeartbeat: boolean;
  readonly sourcePlanGateReason: string | null;
  readonly now: Date;
  readonly dispatchWakeup: boolean;
  readonly onWakeup?: MissionServiceDeps["onOwnerDecisionRetrySourceIssueApplied"];
}): Promise<ReassignSourceIssueResult> {
  const findings: string[] = [];
  if (!input.sourceIssue) {
    findings.push(notApplied(input, input.sourceLabel, "owner-action issue has no canonical originId source issue"));
    return { findings };
  }

  const sourceLabel = input.sourceIssue.identifier ?? input.sourceIssue.id;
  const fail = (reason: string): ReassignSourceIssueResult => ({ findings: [notApplied(input, sourceLabel, reason)] });
  if (input.sourceIssue.missionId !== input.mission.id) return fail("canonical source issue belongs to a different mission");
  if (input.sourceIssue.hiddenAt) return fail("canonical source issue is hidden");
  if (input.sourceIssue.status === "done" || input.sourceIssue.status === "cancelled") {
    return fail(`canonical source issue is already terminal status=${input.sourceIssue.status}`);
  }
  if (input.sourceHasActiveHeartbeat) return fail("canonical source issue already has an active heartbeat run");
  if (input.sourcePlanGateReason) return fail(input.sourcePlanGateReason);

  const targetAgentId = extractReassignTargetAgentId(input.ownerDecision);
  if (!targetAgentId) {
    return fail("reassign_source_issue did not include an unambiguous target agent UUID; use a Target agent line when multiple UUIDs are present");
  }

  const targetAgent = await input.db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      adapterType: agents.adapterType,
      runtimeConfig: agents.runtimeConfig,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(and(eq(agents.companyId, input.mission.companyId), eq(agents.id, targetAgentId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!targetAgent) return fail(`target agent ${targetAgentId} was not found in this company`);
  if (!isRunnableMissionExecutionAssigneeStatus(targetAgent.status)) {
    return fail(`target agent ${targetAgent.name} is not runnable status=${targetAgent.status || "unknown"}`);
  }
  if (isMissionExecutionLiaisonAgent(targetAgent)) return fail(describeMissionExecutionLiaisonBoundary(targetAgent));

  const markerInput = {
    ownerActionIssueId: input.ownerActionIssue.id,
    sourceIssueId: input.sourceIssue.id,
    decision: "reassign_source_issue" as const,
  };
  const idempotencyKey = buildMissionOwnerDecisionWakeupIdempotencyKey({
    missionId: input.mission.id,
    ownerActionIssueId: input.ownerActionIssue.id,
    sourceIssueId: input.sourceIssue.id,
    decision: "reassign_source_issue",
  });
  const wakeupMarkerInput = {
    missionId: input.mission.id,
    ownerActionIssueId: input.ownerActionIssue.id,
    sourceIssueId: input.sourceIssue.id,
    decision: "reassign_source_issue" as const,
    idempotencyKey,
  };

  let updatedSourceIssue = input.sourceIssue;
  if (!hasMissionOwnerDecisionAppliedMarker([...input.sourceComments], markerInput)) {
    const updated = await input.db
      .update(issues)
      .set({
        assigneeAgentId: targetAgentId,
        assigneeUserId: null,
        status: "todo",
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        completedAt: null,
        cancelledAt: null,
        updatedAt: input.now,
      })
      .where(and(
        eq(issues.id, input.sourceIssue.id),
        eq(issues.companyId, input.mission.companyId),
        inArray(issues.status, ["todo", "backlog", "blocked"]),
        isNull(issues.hiddenAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) {
      return fail(`canonical source issue is status=${input.sourceIssue.status}, not todo/backlog/blocked for safe reassignment`);
    }
    updatedSourceIssue = updated;
    await issueService(input.db).addComment(
      input.sourceIssue.id,
      buildReassignSourceIssueComment({
        ownerActionIssueId: input.ownerActionIssue.id,
        ownerActionLabel: input.ownerActionLabel,
        sourceIssueId: input.sourceIssue.id,
        sourceLabel,
        previousAgentId: input.sourceIssue.assigneeAgentId,
        targetAgentId,
        decisionReason: input.ownerDecision.reason,
      }),
      { agentId: input.mission.ownerAgentId },
    );
  }

  let wakeupDispatchStatus: MissionOwnerDecisionWakeupDispatchStatus = input.dispatchWakeup ? "skipped_no_assignee" : "not_requested";
  if (input.dispatchWakeup && !hasMissionOwnerDecisionWakeupDispatchedMarker([...input.sourceComments], wakeupMarkerInput)) {
    if (input.onWakeup) {
      try {
        const wakeupResult = await input.onWakeup({
          mission: input.mission,
          ownerActionIssue: input.ownerActionIssue,
          sourceIssue: updatedSourceIssue,
          targetAgentId,
          idempotencyKey,
        });
        wakeupDispatchStatus = normalizeMissionOwnerDecisionWakeupDispatchResult(wakeupResult);
        await issueService(input.db).addComment(
          input.sourceIssue.id,
          buildReassignSourceIssueWakeupResultComment({
            status: wakeupDispatchStatus,
            missionId: input.mission.id,
            ownerActionIssueId: input.ownerActionIssue.id,
            ownerActionLabel: input.ownerActionLabel,
            sourceIssueId: input.sourceIssue.id,
            sourceLabel,
            targetAgentId,
            idempotencyKey,
          }),
          { agentId: input.mission.ownerAgentId },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        findings.push(`owner_action_wakeup_failed: ${sourceLabel} reassign_source_issue wakeup callback failed — ${message}`);
        wakeupDispatchStatus = "failed";
      }
    } else {
      findings.push(`owner_action_wakeup_skipped: ${sourceLabel} dispatchOwnerDecisionWakeups enabled but no wakeup callback configured`);
      wakeupDispatchStatus = "failed";
    }
  }

  return {
    findings,
    appliedAction: {
      type: "owner_decision_reassign_source_issue",
      missionId: input.mission.id,
      ownerActionIssueId: input.ownerActionIssue.id,
      sourceIssueId: input.sourceIssue.id,
      previousAgentId: input.sourceIssue.assigneeAgentId,
      targetAgentId,
      resultStatus: updatedSourceIssue.status,
      wakeupDispatchStatus,
      idempotencyKey,
    },
  };
}

function notApplied(input: {
  readonly ownerActionLabel: string;
}, sourceLabel: string, reason: string): string {
  return summarizeOwnerDecisionNotApplied({
    ownerActionLabel: input.ownerActionLabel,
    sourceLabel,
    reason,
    decision: "reassign_source_issue",
  });
}
