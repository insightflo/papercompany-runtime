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
  it("materializes into explicit HERMES_HOME and prunes undesired managed skills", async () => {
    await withTempDir(async (dir) => {
      const sourceDir = path.join(dir, "source", "paperclip");
      const hermesHome = path.join(dir, "hermes-home");
      const optionalSourceDir = path.join(dir, "source", "optional");
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.mkdir(optionalSourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, "SKILL.md"), "# Paperclip\n", "utf8");
      await fs.writeFile(path.join(optionalSourceDir, "SKILL.md"), "# Optional\n", "utf8");

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
            {
              key: "company/optional",
              runtimeName: "optional",
              source: optionalSourceDir,
              required: false,
            },
          ],
        },
      };

      const before = await adapter!.listSkills!(ctx);
      expect(before.supported).toBe(true);
      expect(before.mode).toBe("persistent");
      expect(before.entries.find((entry) => entry.key === "paperclipai/paperclip/paperclip")?.state).toBe("missing");

      const after = await adapter!.syncSkills!(ctx, [
        "paperclipai/paperclip/paperclip",
        "company/optional",
      ]);
      const entry = after.entries.find((candidate) => candidate.key === "paperclipai/paperclip/paperclip");
      expect(entry).toMatchObject({
        managed: true,
        state: "installed",
        targetPath: path.join(hermesHome, "skills", "paperclip"),
      });
      await expect(fs.readFile(path.join(hermesHome, "skills", "paperclip", "SKILL.md"), "utf8")).resolves.toBe("# Paperclip\n");
      await expect(fs.readFile(path.join(hermesHome, "skills", "paperclip", ".papercompany-version"), "utf8")).resolves.toContain("paperclipai/paperclip/paperclip");
      await expect(fs.readFile(path.join(hermesHome, "skills", "optional", "SKILL.md"), "utf8")).resolves.toBe("# Optional\n");

      await adapter!.syncSkills!(ctx, []);
      await expect(fs.readFile(path.join(hermesHome, "skills", "paperclip", "SKILL.md"), "utf8")).resolves.toBe("# Paperclip\n");
      await expect(fs.access(path.join(hermesHome, "skills", "optional"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
  it("preserves managed skills from other agents in a shared fallback cwd", async () => {
    await withTempDir(async (dir) => {
      const sharedCwd = path.join(dir, "shared-workspace");
      const agentASource = path.join(dir, "source", "agent-a");
      const agentBSource = path.join(dir, "source", "agent-b");
      await fs.mkdir(agentASource, { recursive: true });
      await fs.mkdir(agentBSource, { recursive: true });
      await fs.writeFile(path.join(agentASource, "SKILL.md"), "# Agent A\n", "utf8");
      await fs.writeFile(path.join(agentBSource, "SKILL.md"), "# Agent B\n", "utf8");

      const adapter = findServerAdapter("hermes_local");
      const paperclipRuntimeSkills = [
        {
          key: "company/agent-a",
          runtimeName: "agent-a",
          source: agentASource,
          required: false,
        },
        {
          key: "company/agent-b",
          runtimeName: "agent-b",
          source: agentBSource,
          required: false,
        },
      ];

      await adapter!.syncSkills!(
        {
          agentId: "agent-a",
          companyId: "company-1",
          adapterType: "hermes_local",
          config: { cwd: sharedCwd, env: {}, paperclipRuntimeSkills },
        },
        ["company/agent-a"],
      );
      await expect(
        fs.readFile(path.join(sharedCwd, ".hermes", "skills", "agent-a", "SKILL.md"), "utf8"),
      ).resolves.toBe("# Agent A\n");

      await adapter!.syncSkills!(
        {
          agentId: "agent-b",
          companyId: "company-1",
          adapterType: "hermes_local",
          config: { cwd: sharedCwd, env: {}, paperclipRuntimeSkills },
        },
        ["company/agent-b"],
      );

      await expect(
        fs.readFile(path.join(sharedCwd, ".hermes", "skills", "agent-a", "SKILL.md"), "utf8"),
      ).resolves.toBe("# Agent A\n");
      await expect(
        fs.readFile(path.join(sharedCwd, ".hermes", "skills", "agent-b", "SKILL.md"), "utf8"),
      ).resolves.toBe("# Agent B\n");
    });
  });
});
