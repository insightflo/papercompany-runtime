import type { ExtractedMissionOwnerDecision } from "./mission-owner-recovery-events.js";
import type { GovernanceThreadActor, GovernanceThreadEvent } from "./governance-thread.js";
import { formatOperatorDecisionSummary } from "./operator-card-summary.js";

type LegacyMissionOwnerDecisionComment = {
  id: string;
  companyId: string;
  issueId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date | string | null;
};

export type MissionOwnerHumanReportDecision = {
  companyId: string;
  issueId: string;
  eventId: string;
  commentId?: string | null;
  createdAt: Date | string | null;
  authorAgentId: string;
  decision: ExtractedMissionOwnerDecision;
};

function decisionActor(decision: MissionOwnerHumanReportDecision): GovernanceThreadActor {
  return { type: "agent", id: decision.authorAgentId, authorityRole: "mission_owner" };
}

function decisionTimestamp(value: Date | string | null): string {
  const date = value instanceof Date ? value : new Date(value ?? 0);
  return Number.isNaN(date.getTime()) ? "1970-01-01T00:00:00.000Z" : date.toISOString();
}

function decisionSummary(input: {
  decision: "request_input" | "escalate";
  issueId: string;
  reason?: string;
  nextAction?: string;
  evidence?: string;
}): string {
  // [display-only] 구조화된 결정 필드로 한국어 운영자 카드 요약. rule 8: 표시 전용.
  return formatOperatorDecisionSummary(input);
}

export function missionOwnerHumanReportEvents(input: {
  missionId: string;
  issueIds: ReadonlySet<string>;
  decisions?: readonly MissionOwnerHumanReportDecision[];
  // Legacy comment input remains type-compatible for callers during migration, but
  // comments are not parsed or otherwise used as human-reporting authority.
  comments?: readonly LegacyMissionOwnerDecisionComment[];
}): GovernanceThreadEvent[] {
  return (input.decisions ?? []).flatMap((record) => {
    if (!input.issueIds.has(record.issueId) || !record.authorAgentId) return [];
    const decision = record.decision;
    if (decision.decision !== "request_input" && decision.decision !== "escalate") return [];

    const decisionLabel = decision.decision === "request_input"
      ? "Human/operator input requested"
      : "Mission blocker escalated";
    const summary = decisionSummary({
      decision: decision.decision,
      issueId: record.issueId,
      reason: decision.reason,
      nextAction: decision.nextAction,
      evidence: decision.evidence,
    });
    // The durable transition event is the authority and primary source. A linked
    // comment is display-only evidence, never the source of this diagnosis.
    const sourceRef: GovernanceThreadEvent["sourceRef"] = {
      type: "workflow_transition_event",
      id: record.eventId,
      table: "workflow_transition_events",
    };
    const evidenceRefs = [
      { type: "log" as const, ref: record.eventId, label: "mission owner recovery decision" },
      ...(record.commentId
        ? [{ type: "comment" as const, ref: record.commentId, label: "display comment" }]
        : []),
    ];
    const actor = decisionActor(record);

    return [{
      id: `owner_diagnosis:workflow_transition_event:${record.eventId}:human-input`,
      companyId: record.companyId,
      scope: { missionId: input.missionId, issueId: record.issueId },
      sourceRef,
      eventType: "owner_diagnosis",
      title: decisionLabel,
      summary,
      timestamp: decisionTimestamp(record.createdAt),
      severity: decision.decision === "escalate" ? "blocked" : "attention",
      ...(actor ? { actor } : {}),
      evidenceRefs,
      suggestedResumeTarget: { action: "request_human_input", issueId: record.issueId },
      rawAvailable: true,
    }];
  });
}
