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
        // [SKILL.state] 상태파일은 재작성 not append — 원시 로그·대화·초안은 상태가 아니다.
        "When updating, rewrite the sections in place instead of appending; raw logs, chat transcripts, and draft outputs do not belong in this file.",
        // [SKILL.state] 선별 보존 — 믿음/진척/경험 아니면 로그로.
        "Keep only beliefs, progress, and reusable experience; anything else belongs in run logs, issue comments, or workProducts.",
        // 결정 수명주기: 지위 + 대체 링크(폐기 결정도 잔류).
        "Record each decision with a status (confirmed, under_review, or retired); when a decision replaces an earlier one, keep the old entry retired with a pointer to its replacement.",
        // 파일 인용 지문 — 낡은 증거 판별용(C안 contentHash와 호환되는 일반 표현).
        "When citing files as evidence, record the path with a content hash (for example sha256) so later runs can detect stale references.",
        "Do not treat working.md as a final deliverable; official outputs must still be registered as workProducts.",
      ],
    });
    await expect(fs.readFile(expectedPath, "utf8")).resolves.toContain("# Mission Working Note");
    await expect(fs.readFile(expectedPath, "utf8")).resolves.toContain("- Mission ID: mission-1");
    // 초기 템플릿도 결정 지위 힌트를 포함한다(신규 미션만 — 기존 파일은 wx 플래그로 보존).
    await expect(fs.readFile(expectedPath, "utf8")).resolves.toContain(
      "status: confirmed | under_review | retired",
    );

    await fs.writeFile(expectedPath, "operator note\n", "utf8");
    await ensureMissionWorkingNote({
      companyId: "company-1",
      missionId: "mission-1",
    });

    await expect(fs.readFile(expectedPath, "utf8")).resolves.toBe("operator note\n");
  });
});
