import { extractMissionOwnerDecisionFromText } from "./mission-owner-recovery-events.js";
import type { GovernanceThreadActor, GovernanceThreadEvent } from "./governance-thread.js";

type MissionOwnerDecisionComment = {
  id: string;
  companyId: string;
  issueId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date | string | null;
};

function commentActor(comment: MissionOwnerDecisionComment): GovernanceThreadActor {
  if (comment.authorAgentId) {
    return { type: "agent", id: comment.authorAgentId, authorityRole: "mission_owner" };
  }
  if (comment.authorUserId) {
    return { type: "user", id: comment.authorUserId, authorityRole: "operator" };
  }
  return { type: "system" };
}

function commentTimestamp(value: Date | string | null): string {
  const date = value instanceof Date ? value : new Date(value ?? 0);
  return Number.isNaN(date.getTime()) ? "1970-01-01T00:00:00.000Z" : date.toISOString();
}

function compactDecisionText(...values: Array<string | undefined>): string {
  return values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" | ")
    .slice(0, 280);
}

export function missionOwnerHumanReportEvents(input: {
  missionId: string;
  issueIds: ReadonlySet<string>;
  comments: readonly MissionOwnerDecisionComment[];
}): GovernanceThreadEvent[] {
  return input.comments.flatMap((comment) => {
    if (!input.issueIds.has(comment.issueId)) return [];
    const decision = extractMissionOwnerDecisionFromText(comment.body);
    if (!decision || decision.decision === null) return [];
    if (decision.decision !== "request_input" && decision.decision !== "escalate") return [];

    const detail = compactDecisionText(decision.reason, decision.nextAction, decision.evidence);
    const decisionLabel = decision.decision === "request_input" ? "Human/operator input requested" : "Mission blocker escalated";
    const summary = detail
      ? `${decisionLabel}: ${detail}`
      : `${decisionLabel}; unresolved mission blocker needs human/operator decision.`;

    return [{
      id: `owner_diagnosis:issue_comment:${comment.id}:human-input`,
      companyId: comment.companyId,
      scope: { missionId: input.missionId, issueId: comment.issueId },
      sourceRef: { type: "issue_comment", id: comment.id, table: "issue_comments" },
      eventType: "owner_diagnosis",
      title: decisionLabel,
      summary,
      timestamp: commentTimestamp(comment.createdAt),
      severity: decision.decision === "escalate" ? "blocked" : "attention",
      actor: commentActor(comment),
      evidenceRefs: [{ type: "comment", ref: comment.id, label: "mission owner decision" }],
      suggestedResumeTarget: { action: "request_human_input", issueId: comment.issueId },
      rawAvailable: true,
    }];
  });
}
