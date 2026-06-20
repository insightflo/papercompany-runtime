import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadInstructionsWithInlinedReferences } from "./instructions.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "papercompany-instructions-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("loadInstructionsWithInlinedReferences", () => {
  it("inlines referenced company instruction files from an agent AGENTS.md", async () => {
    await withTempDir(async (dir) => {
      const agentInstructionsDir = path.join(dir, "companies", "company-1", "agents", "agent-1", "instructions");
      const companyInstructionsDir = path.join(dir, "companies", "company-1", "instructions");
      await mkdir(agentInstructionsDir, { recursive: true });
      await mkdir(companyInstructionsDir, { recursive: true });

      const entryPath = path.join(agentInstructionsDir, "AGENTS.md");
      const commonPath = path.join(companyInstructionsDir, "research-company-common.md");
      await writeFile(
        entryPath,
        [
          "# Research Director Instructions",
          "",
          "Before working, read `../../../instructions/research-company-common.md`.",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        commonPath,
        [
          "# Shared Research Company Operating Contract",
          "",
          "## Official Work Product Rule",
          "",
          "- Register deliverables as issue workProducts.",
        ].join("\n"),
        "utf8",
      );

      const loaded = await loadInstructionsWithInlinedReferences(entryPath);

      expect(loaded.includedPaths).toEqual([commonPath]);
      expect(loaded.warnings).toEqual([]);
      expect(loaded.content).toContain("Research Director Instructions");
      expect(loaded.content).toContain("Official Work Product Rule");
      expect(loaded.content).toContain("Register deliverables as issue workProducts.");
    });
  });

  it("defers large referenced files (leaves them as path) when they exceed inlineMaxBytes", async () => {
    await withTempDir(async (dir) => {
      const entryPath = path.join(dir, "AGENTS.md");
      const bigPath = path.join(dir, "big-skill.md");
      await writeFile(entryPath, "Read the skill at `./big-skill.md` before writing.\n", "utf8");
      const bigBody = `BIGBODY-${"X".repeat(2000)}`;
      await writeFile(bigPath, `# Big Skill\n${bigBody}\n`, "utf8");

      const loaded = await loadInstructionsWithInlinedReferences(entryPath, { inlineMaxBytes: 64 });

      expect(loaded.includedPaths).toEqual([]);
      expect(loaded.deferredPaths).toEqual([bigPath]);
      expect(loaded.content).not.toContain(bigBody);
      expect(loaded.content).toContain("big-skill.md");
      expect(
        loaded.warnings.some(
          (w) => w.startsWith("Left referenced instructions as path") && w.includes(bigPath),
        ),
      ).toBe(true);
    });
  });

  it("still inlines references that are under inlineMaxBytes", async () => {
    await withTempDir(async (dir) => {
      const entryPath = path.join(dir, "AGENTS.md");
      const smallPath = path.join(dir, "shared.md");
      await writeFile(entryPath, "See `./shared.md` for shared rules.\n", "utf8");
      await writeFile(smallPath, "# Shared\n- rule one\n", "utf8");

      const loaded = await loadInstructionsWithInlinedReferences(entryPath, { inlineMaxBytes: 4096 });

      expect(loaded.includedPaths).toEqual([smallPath]);
      expect(loaded.deferredPaths).toEqual([]);
      expect(loaded.content).toContain("rule one");
    });
  });

  it("treats inlineMaxBytes=0 as 'never inline' (every reference left as path)", async () => {
    await withTempDir(async (dir) => {
      const entryPath = path.join(dir, "AGENTS.md");
      const refPath = path.join(dir, "tiny.md");
      await writeFile(entryPath, "See `./tiny.md`.\n", "utf8");
      await writeFile(refPath, "UNIQUE_BODY_MARKER_42", "utf8");

      const loaded = await loadInstructionsWithInlinedReferences(entryPath, { inlineMaxBytes: 0 });

      expect(loaded.includedPaths).toEqual([]);
      expect(loaded.deferredPaths).toEqual([refPath]);
      expect(loaded.content).not.toContain("UNIQUE_BODY_MARKER_42");
      expect(loaded.content).toContain("tiny.md");
    });
  });
});
