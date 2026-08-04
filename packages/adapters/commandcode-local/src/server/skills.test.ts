import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncCommandCodeSkills } from "./skills.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "papercompany-commandcode-skills-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("syncCommandCodeSkills", () => {
  it("materializes selected skills into the Command Code project skills directory", async () => {
    await withTempDir(async (dir) => {
      const workDir = path.join(dir, "work");
      const sourceDir = path.join(dir, "source", "design-guide");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(path.join(sourceDir, "SKILL.md"), "# Design Guide\n", "utf8");

      const snapshot = await syncCommandCodeSkills(
        {
          agentId: "agent-1",
          companyId: "company-1",
          adapterType: "commandcode_local",
          config: {
            cwd: workDir,
            paperclipSkillSync: {
              desiredSkills: ["papercompany/design-guide"],
            },
            paperclipRuntimeSkills: [
              {
                key: "papercompany/design-guide",
                runtimeName: "design-guide",
                source: sourceDir,
                required: false,
              },
            ],
          },
        },
        ["papercompany/design-guide"],
      );

      const target = path.join(workDir, ".commandcode", "skills", "design-guide", "SKILL.md");
      await expect(readFile(target, "utf8")).resolves.toBe("# Design Guide\n");
      expect(snapshot.supported).toBe(true);
      expect(snapshot.mode).toBe("persistent");
      expect(snapshot.desiredSkills).toContain("papercompany/design-guide");
    });
  });
});
