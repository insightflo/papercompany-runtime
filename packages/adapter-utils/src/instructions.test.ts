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
});
