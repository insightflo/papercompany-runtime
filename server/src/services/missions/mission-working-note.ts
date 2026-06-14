import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";

export const MISSION_WORKING_NOTE_FILENAME = "working.md";
export const MISSION_WORKING_NOTE_INVARIANT =
  "Mission working note is shared scratch context, not an official workProduct deliverable.";

const PATH_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;

export type PaperclipMissionWorkingNoteContext = {
  available: true;
  missionId: string;
  path: string;
  fileName: typeof MISSION_WORKING_NOTE_FILENAME;
  format: "markdown";
  role: "shared_mission_working_note";
  invariant: typeof MISSION_WORKING_NOTE_INVARIANT;
  instructions: string[];
};

export const MISSION_WORKING_NOTE_INSTRUCTIONS = [
  "Read this working.md before acting on mission-scoped work.",
  "Update it with mission-relevant current status, evidence, decisions, open questions, and next steps.",
  "Do not treat working.md as a final deliverable; official outputs must still be registered as workProducts.",
];

function pathSegment(value: string, label: string) {
  const trimmed = value.trim();
  if (!PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid ${label} for mission working note path '${value}'.`);
  }
  return trimmed;
}

export function resolveMissionWorkingNotePath(input: {
  companyId: string;
  missionId: string;
}) {
  return path.join(
    resolvePaperclipInstanceRoot(),
    "mission-working-notes",
    pathSegment(input.companyId, "companyId"),
    pathSegment(input.missionId, "missionId"),
    MISSION_WORKING_NOTE_FILENAME,
  );
}

function buildInitialMissionWorkingNote(input: {
  companyId: string;
  missionId: string;
}) {
  return [
    "# Mission Working Note",
    "",
    "This file is shared scratch context for mission-scoped agents.",
    "It is not an official deliverable; final outputs must still be registered as workProducts.",
    "",
    "## Identity",
    `- Company ID: ${input.companyId}`,
    `- Mission ID: ${input.missionId}`,
    "",
    "## Current Situation",
    "- No status recorded yet.",
    "",
    "## Decisions",
    "- No decisions recorded yet.",
    "",
    "## Evidence",
    "- No evidence recorded yet.",
    "",
    "## Open Questions",
    "- No open questions recorded yet.",
    "",
    "## Next Steps",
    "- No next steps recorded yet.",
    "",
  ].join("\n");
}

export function buildMissionWorkingNoteContext(input: {
  missionId: string;
  path: string;
}): PaperclipMissionWorkingNoteContext {
  return {
    available: true,
    missionId: input.missionId,
    path: input.path,
    fileName: MISSION_WORKING_NOTE_FILENAME,
    format: "markdown",
    role: "shared_mission_working_note",
    invariant: MISSION_WORKING_NOTE_INVARIANT,
    instructions: MISSION_WORKING_NOTE_INSTRUCTIONS,
  };
}

export async function ensureMissionWorkingNote(input: {
  companyId: string;
  missionId: string;
}): Promise<PaperclipMissionWorkingNoteContext> {
  const notePath = resolveMissionWorkingNotePath(input);
  await fs.mkdir(path.dirname(notePath), { recursive: true });
  try {
    await fs.writeFile(notePath, buildInitialMissionWorkingNote(input), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return buildMissionWorkingNoteContext({
    missionId: input.missionId,
    path: notePath,
  });
}
