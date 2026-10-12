export const HUMAN_INPUT_INSTRUCTIONS_START_MARKER = "<!-- papercompany:mission-owner-human-input-instructions:start -->";
export const HUMAN_INPUT_INSTRUCTIONS_END_MARKER = "<!-- papercompany:mission-owner-human-input-instructions:end -->";

export const MISSION_OWNER_HUMAN_INPUT_INSTRUCTIONS = `When you judge that this mission cannot proceed without a human decision:
1. Check the current structured mission, run and recovery state. Keep existing safe recovery limits.
2. Submit request_input or escalate to POST /api/issues/{current oversight issue id}/owner-recovery/decision using the current agent run credentials.
3. Include the blocker, the human action needed, and evidence in reason, nextAction and evidence.
4. Confirm HTTP 201 and the returned eventId before reporting that the request was submitted.
5. If submission fails, report that failure; a comment alone does not notify the human.
Do not resume or modify a cancelled mission. Do not put credentials in comments or evidence.`;

const markedInstructions = [
  HUMAN_INPUT_INSTRUCTIONS_START_MARKER,
  MISSION_OWNER_HUMAN_INPUT_INSTRUCTIONS,
  HUMAN_INPUT_INSTRUCTIONS_END_MARKER,
].join("\n");

export function appendOrRefreshMissionOwnerHumanInputInstructions(description: string): string {
  const startIndex = description.indexOf(HUMAN_INPUT_INSTRUCTIONS_START_MARKER);
  const endIndex = startIndex < 0
    ? -1
    : description.indexOf(HUMAN_INPUT_INSTRUCTIONS_END_MARKER, startIndex + HUMAN_INPUT_INSTRUCTIONS_START_MARKER.length);

  if (startIndex >= 0 && endIndex >= 0) {
    const afterEndIndex = endIndex + HUMAN_INPUT_INSTRUCTIONS_END_MARKER.length;
    return `${description.slice(0, startIndex)}${markedInstructions}${description.slice(afterEndIndex)}`;
  }
  if (startIndex >= 0 || description.includes(HUMAN_INPUT_INSTRUCTIONS_END_MARKER)) return description;

  const separator = description.length === 0 ? "" : description.endsWith("\n") ? "\n" : "\n\n";
  return `${description}${separator}${markedInstructions}`;
}

export function buildMainExecutorOversightDescription(input: {
  missionTitle: string;
  workflowName: string;
}): string {
  return appendOrRefreshMissionOwnerHumanInputInstructions([
    "Monitor this mission and keep execution moving.",
    "",
    `Mission: ${input.missionTitle}`,
    `Scope: ${input.workflowName}`,
    "",
    "Main executor duties:",
    "- Watch step progress and comments.",
    "- Comment on failed, stale, undispatched, or blocked steps with the current judgement.",
    "- Retry failed workflow steps when retry is safe and within the retry limit.",
    "- Recover/replan toward completion, or escalate/report impossible states with evidence.",
    "- When every non-oversight issue of the mission is done, verify the work products and complete this oversight issue — completing it closes the mission. If completion evidence is missing, wake the responsible step agent instead of waiting silently.",
  ].join("\n"));
}
