import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { findServerAdapter } from "../adapters/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "papercompany-hermes-skills-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("hermes_local skill sync", () => {
  it("materializes Papercompany skills into HERMES_HOME and reports persistent installed state", async () => {
    await withTempDir(async (dir) => {
      const sourceDir = path.join(dir, "source", "paperclip");
      const hermesHome = path.join(dir, "hermes-home");
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, "SKILL.md"), "# Paperclip\n", "utf8");

      const adapter = findServerAdapter("hermes_local");
      expect(adapter?.listSkills).toBeTypeOf("function");
      expect(adapter?.syncSkills).toBeTypeOf("function");

      const ctx = {
        agentId: "agent-1",
        companyId: "company-1",
        adapterType: "hermes_local",
        config: {
          env: { HERMES_HOME: hermesHome },
          paperclipRuntimeSkills: [
            {
              key: "paperclipai/paperclip/paperclip",
              runtimeName: "paperclip",
              source: sourceDir,
              required: true,
              requiredReason: "required",
            },
          ],
        },
      };

      const before = await adapter!.listSkills!(ctx);
      expect(before.supported).toBe(true);
      expect(before.mode).toBe("persistent");
      expect(before.entries.find((entry) => entry.key === "paperclipai/paperclip/paperclip")?.state).toBe("missing");

      const after = await adapter!.syncSkills!(ctx, ["paperclipai/paperclip/paperclip"]);
      const entry = after.entries.find((candidate) => candidate.key === "paperclipai/paperclip/paperclip");
      expect(entry).toMatchObject({
        managed: true,
        state: "installed",
        targetPath: path.join(hermesHome, "skills", "paperclip"),
      });
      await expect(fs.readFile(path.join(hermesHome, "skills", "paperclip", "SKILL.md"), "utf8")).resolves.toBe("# Paperclip\n");
      await expect(fs.readFile(path.join(hermesHome, "skills", "paperclip", ".papercompany-version"), "utf8")).resolves.toContain("paperclipai/paperclip/paperclip");
    });
  });
});
