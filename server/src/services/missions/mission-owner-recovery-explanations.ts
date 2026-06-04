import { hasMissionOwnerDecisionAppliedMarker, type ExtractedMissionOwnerDecision } from "./mission-owner-recovery-events.js";
import { extractLatestMissionOwnerDecision, isTerminalIssueStatus } from "./mission-owner-recovery-comments.js";

export type MissionOwnerActionExplanationStatus =
  | "decision_required"
  | "decision_recorded_read_only"
  | "retry_applied_no_wakeup"
  | "not_applicable_or_invalid";

export type MissionOwnerActionExplanationSource = {
  id: string;
  identifier?: string | null;
  status: string;
};

export type MissionOwnerActionExplanationOwnerIssue = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  originKind: string | null;
  originId: string | null;
};

export type MissionOwnerActionExplanationSourceIssue = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
};

export type MissionOwnerActionExplanation = {
  ownerActionIssue: Pick<MissionOwnerActionExplanationOwnerIssue, "id" | "identifier" | "title" | "status" | "originKind">;
  sourceIssue: MissionOwnerActionExplanationSourceIssue | null;
  latestDecision: ExtractedMissionOwnerDecision | null;
  retryApplied: boolean;
  status: MissionOwnerActionExplanationStatus;
  explanation: string;
};

export type MissionOwnerActionExplanationDataContext = {
  ownerActionIssues: MissionOwnerActionExplanationOwnerIssue[];
  commentsByIssueId: Map<string, string[]>;
  resolveSourceIssue: (sourceIssueId: string) => Promise<MissionOwnerActionExplanationSourceIssue | null>;
  resolveSourceComments: (sourceIssueId: string) => Promise<string[]>;
};

export function computeMissionOwnerActionExplanation(input: {
  retryApplied: boolean;
  latestDecision: ExtractedMissionOwnerDecision | null;
  sourceIssue: MissionOwnerActionExplanationSource | null;
  ownerActionOriginId?: string | null;
}): { status: MissionOwnerActionExplanationStatus; explanation: string } {
  let invalidDecisionValue: string | null = null;
  if (input.latestDecision && input.latestDecision.decision === null) {
    invalidDecisionValue = input.latestDecision.invalidDecision;
  }
  const invalidDecision = invalidDecisionValue !== null;
  const terminalSource = Boolean(input.sourceIssue && isTerminalIssueStatus(input.sourceIssue.status));
  const status: MissionOwnerActionExplanationStatus = input.retryApplied
    ? "retry_applied_no_wakeup"
    : invalidDecision || terminalSource || !input.sourceIssue
      ? "not_applicable_or_invalid"
      : input.latestDecision
        ? "decision_recorded_read_only"
        : "decision_required";
  const sourceLabel = input.sourceIssue
    ? (input.sourceIssue.identifier ?? input.sourceIssue.id)
    : (input.ownerActionOriginId ?? "unknown source");
  const explanation = status === "retry_applied_no_wakeup"
    ? `Retry was explicitly applied for source issue ${sourceLabel}; it is queued again and no heartbeat wakeup was created by this status surface.`
    : status === "decision_recorded_read_only"
      ? `Mission owner decision ${input.latestDecision?.decision ?? "unknown"} was recorded but not applied; source issue ${sourceLabel} remains assigned to its current assignee.`
      : status === "decision_required"
        ? `Owner decision required for source issue ${sourceLabel}; source issue remains assigned to its current assignee.`
        : invalidDecision
          ? `Mission owner decision is invalid (${invalidDecisionValue ?? "unknown"}); no execution action was taken.`
          : terminalSource
            ? `Source issue ${sourceLabel} is terminal; owner-action status is informational only and no execution action was taken.`
            : `Source issue ${sourceLabel} is unavailable for this mission; owner-action status is informational only and no execution action was taken.`;
  return { status, explanation };
}

export async function buildOwnerActionExplanations(input: MissionOwnerActionExplanationDataContext): Promise<MissionOwnerActionExplanation[]> {
  const explanations: MissionOwnerActionExplanation[] = [];
  for (const ownerActionIssue of input.ownerActionIssues) {
    const ownerActionComments = input.commentsByIssueId.get(ownerActionIssue.id) ?? [];
    const latestDecision = extractLatestMissionOwnerDecision(ownerActionComments);
    const sourceIssue = ownerActionIssue.originId
      ? await input.resolveSourceIssue(ownerActionIssue.originId)
      : null;
    const sourceComments = sourceIssue
      ? await input.resolveSourceComments(sourceIssue.id)
      : [];
    const retryApplied = Boolean(sourceIssue && hasMissionOwnerDecisionAppliedMarker(sourceComments, {
      ownerActionIssueId: ownerActionIssue.id,
      sourceIssueId: sourceIssue.id,
      decision: "retry_source_issue",
    }));
    const { status, explanation } = computeMissionOwnerActionExplanation({
      retryApplied,
      latestDecision,
      sourceIssue,
      ownerActionOriginId: ownerActionIssue.originId,
    });
    explanations.push({
      ownerActionIssue: {
        id: ownerActionIssue.id,
        identifier: ownerActionIssue.identifier,
        title: ownerActionIssue.title,
        status: ownerActionIssue.status,
        originKind: ownerActionIssue.originKind,
      },
      sourceIssue,
      latestDecision,
      retryApplied,
      status,
      explanation,
    });
  }
  return explanations;
}
