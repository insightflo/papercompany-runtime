import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncPiSkills } from "./skills.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "papercompany-pi-skills-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("syncPiSkills", () => {
  it("removes stale Papercompany-managed materialized skill directories when deselected", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      const sourceDir = path.join(dir, "source", "design-guide");
      const skillsHome = path.join(home, ".pi", "agent", "skills");
      const targetDir = path.join(skillsHome, "design-guide");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(path.join(sourceDir, "SKILL.md"), "# Design Guide\n", "utf8");
      await mkdir(targetDir, { recursive: true });
      await writeFile(path.join(targetDir, "SKILL.md"), "# Materialized Copy\n", "utf8");
      await writeFile(
        path.join(targetDir, ".papercompany-version"),
        `${JSON.stringify({ managedBy: "papercompany", key: "papercompany/design-guide", revision: "rev-1" }, null, 2)}\n`,
        "utf8",
      );

      await syncPiSkills(
        {
          agentId: "agent-1",
          companyId: "company-1",
          adapterType: "pi_local",
          config: {
            env: { HOME: home },
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
        [],
      );

      await expect(stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(sourceDir, "SKILL.md"), "utf8")).resolves.toBe("# Design Guide\n");
    });
  });
});
