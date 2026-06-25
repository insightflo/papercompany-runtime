export type AssignedIssuePromptInput = {
  id: string;
  identifier?: string | null;
  title: string;
  description?: string | null;
  missionId?: string | null;
  parentId?: string | null;
};

export function buildAssignedIssuePromptSection(issue: AssignedIssuePromptInput | null | undefined): string {
  if (!issue) return "";
  const body = issue.description ?? issue.title;
  const missionChildContract = issue.missionId && issue.parentId
    ? `
## Mission Child Issue Contract

This is a bounded mission child issue.

- Work only this issue's scoped deliverable.
- Do not create downstream, sibling, recovery, QA, synthesis, validator, or director-gate work unless this issue explicitly asks for it.
- Complete only after posting the requested evidence; otherwise post the precise blocker or missing input.
- Treat the mission final output as mission context unless this issue explicitly asks you to create it.`
    : "";

  return `

## Assigned Task

Issue ID: ${issue.id}
Identifier: ${issue.identifier ?? ""}
Title: ${issue.title}

${body}${missionChildContract}

## Workflow

	1. Work on the assigned issue, not just the agent role description.
	2. Use Paperclip API env vars for lifecycle updates or evidence/blocker comments when needed.
	3. Mark this issue done after its scoped evidence is posted; otherwise mark it blocked with the concrete missing input or tool/API failure.
	4. If the issue specifies a deliverable output directory or \`[ARTIFACT]:\` contract, follow that contract; do not POST/curl a workProduct registration.
	5. If this is a QA/validator issue, validate upstream/dependency issue workProducts rather than requiring this QA issue to have its own workProduct unless QA creates a separate deliverable.`;
}
