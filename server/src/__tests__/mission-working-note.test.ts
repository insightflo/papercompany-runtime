import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureMissionWorkingNote } from "../services/missions/mission-working-note.js";

const originalPaperclipHome = process.env.PAPERCLIP_HOME;
const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

async function withTempPaperclipHome() {
  const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mission-working-note-"));
  process.env.PAPERCLIP_HOME = paperclipHome;
  process.env.PAPERCLIP_INSTANCE_ID = "test";
  return paperclipHome;
}

describe("mission working note", () => {
  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
  });

  it("creates a mission-scoped working.md without overwriting existing notes", async () => {
    const paperclipHome = await withTempPaperclipHome();

    const note = await ensureMissionWorkingNote({
      companyId: "company-1",
      missionId: "mission-1",
    });

    const expectedPath = path.join(
      paperclipHome,
      "instances",
      "test",
      "mission-working-notes",
      "company-1",
      "mission-1",
      "working.md",
    );
    expect(note).toEqual({
      available: true,
      missionId: "mission-1",
      path: expectedPath,
      fileName: "working.md",
      format: "markdown",
      role: "shared_mission_working_note",
      invariant: "Mission working note is shared scratch context, not an official workProduct deliverable.",
      instructions: [
        "Read this working.md before acting on mission-scoped work.",
        "Update it with mission-relevant current status, evidence, decisions, open questions, and next steps.",
        "Do not treat working.md as a final deliverable; official outputs must still be registered as workProducts.",
      ],
    });
    await expect(fs.readFile(expectedPath, "utf8")).resolves.toContain("# Mission Working Note");
    await expect(fs.readFile(expectedPath, "utf8")).resolves.toContain("- Mission ID: mission-1");

    await fs.writeFile(expectedPath, "operator note\n", "utf8");
    await ensureMissionWorkingNote({
      companyId: "company-1",
      missionId: "mission-1",
    });

    await expect(fs.readFile(expectedPath, "utf8")).resolves.toBe("operator note\n");
  });
});
