// Pure display assembly. Never infer mission scope from the working-note path.
export const MISSION_DECISION_REPORT_INSTRUCTION =
  "Report mission-level decisions (new, changed, confirmed, or retired) via POST /api/missions/{missionId}/decision-reports with updates [{id, summary, status, supersedes}]; the mission decision log is the record.";

// Pinned producer shape: custom, partial, reordered, or future instructions retain
// the legacy rendering. Only the report string is shared with the producer.
const COMPACTABLE_INSTRUCTIONS = [
  "Read this working.md before acting on mission-scoped work.",
  "Update it with mission-relevant current status, evidence, decisions, open questions, and next steps.",
  "When updating, rewrite the sections in place instead of appending; raw logs, chat transcripts, and draft outputs do not belong in this file.",
  "Keep only beliefs, progress, and reusable experience; anything else belongs in run logs, issue comments, or workProducts.",
  "Record each decision with a status (confirmed, under_review, or retired); when a decision replaces an earlier one, keep the old entry retired with a pointer to its replacement.",
  "When citing files as evidence, record the path with a content hash (for example sha256) so later runs can detect stale references.",
  MISSION_DECISION_REPORT_INSTRUCTION,
  "Do not treat working.md as a final deliverable; official outputs must still be registered as workProducts.",
];

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function buildMissionWorkingNoteBriefLines(
  note: Record<string, unknown> | null,
  scopeMissionIds: readonly unknown[],
): string[] {
  const notePath = asString(note?.path);
  if (note?.available !== true || !notePath) return [];

  const instructions = Array.isArray(note.instructions) ? note.instructions : [];
  const instructionLines = instructions.filter(
    (line): line is string => typeof line === "string" && line.trim().length > 0,
  );
  const missionId = asString(note.missionId);
  const knownScopeIds = scopeMissionIds.filter((id) => id !== undefined && id !== null);
  // Equality only gates this display optimization; unknown or conflicting scope
  // falls back without changing execution, authority, or the producer's array.
  const compact = missionId !== null
    && note.missionId === missionId
    && knownScopeIds.length > 0
    && knownScopeIds.every((id) => id === missionId)
    && instructions.length === COMPACTABLE_INSTRUCTIONS.length
    && COMPACTABLE_INSTRUCTIONS.every((line, index) => instructions[index] === line);

  return [
    `- Mission working note: ${notePath} (shared scratch context; read before acting, update mission status/evidence/decisions/next steps, not a final workProduct).`,
    ...instructionLines
      .filter((line) => !compact || line !== MISSION_DECISION_REPORT_INSTRUCTION)
      .map((line) => `- ${line}`),
    missionId
      ? compact
        ? `- Mission decision log: report mission-level decisions (new, changed, confirmed, or retired) via POST /api/missions/${missionId}/decision-reports with updates [{id, summary, status, supersedes}]; statuses confirmed/under_review/retired; the mission decision log is the record.`
        : `- Mission decision log: report mission-level decisions via POST /api/missions/${missionId}/decision-reports with updates [{id, summary, status, supersedes}]; statuses confirmed/under_review/retired.`
      : null,
  ].filter((line): line is string => line !== null);
}
