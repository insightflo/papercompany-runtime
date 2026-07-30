import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";

export function infloOpportunityOperatorDecisionInput(
  requestKey: string,
  issueId: string,
): CreateOperatorDecisionInput {
  return {
    schemaVersion: 1,
    requestKey,
    priority: "high",
    interactionType: "single_select",
    title: "Choose an opportunity for internal proposal",
    description: "Select one shortlisted opportunity or hold/reject the shortlist.",
    sourceType: "workflow_step",
    sourceId: "inflo-opportunity-shortlist",
    sourceContext: {
      missionId: null,
      workflowId: "inflo-opportunity-workflow",
      workflowRunId: "fixture-run",
      artifactRefs: [{ label: "Morning shortlist", uri: "artifact:inflo/morning-shortlist" }],
    },
    definition: {
      options: [
        {
          id: "candidate-north",
          label: "North District modernization",
          description: "Internal proposal candidate",
          facts: [
            { label: "Duration", value: "12 months", status: "known" },
            { label: "Budget", value: "Unverified", status: "unknown" },
          ],
          evidenceRefs: [{ label: "Collection source", href: "https://example.com/inflo/north" }],
        },
        {
          id: "candidate-harbor",
          label: "Harbor operations review",
          description: "Alternative internal proposal candidate",
          facts: [{ label: "Fit", value: "High", status: "known" }],
          evidenceRefs: [{ label: "Collection source", href: "https://example.com/inflo/harbor" }],
        },
      ],
      actions: [
        {
          id: "prepare_internal_proposal",
          label: "Prepare internal proposal",
          outcome: "submit",
          tone: "primary",
          requiresSelection: true,
        },
        { id: "hold_all", label: "Hold all", outcome: "hold", tone: "neutral", requiresSelection: false },
        { id: "reject_shortlist", label: "Reject shortlist", outcome: "reject", tone: "danger", requiresSelection: false },
      ],
      selection: { min: 1, max: 1 },
      comment: { mode: "optional", label: "Operator note", placeholder: null, maxLength: 500 },
      approvedScope: ["Create or update the internal proposal-intake work item", "Prepare an internal draft only"],
      forbiddenScope: ["External contact", "Submission", "Price commitment", "Contract commitment"],
    },
    issueId,
    continuationMode: "issue_current_assignee",
  };
}
