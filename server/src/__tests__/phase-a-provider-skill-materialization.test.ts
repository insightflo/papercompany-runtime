import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listClaudeSkills, syncClaudeSkills } from "@paperclipai/adapter-claude-local/server";
import { listCodexSkills, syncCodexSkills } from "@paperclipai/adapter-codex-local/server";
import { listCursorSkills, syncCursorSkills } from "@paperclipai/adapter-cursor-local/server";
import { listGeminiSkills, syncGeminiSkills } from "@paperclipai/adapter-gemini-local/server";
import { listOpenCodeSkills, syncOpenCodeSkills } from "@paperclipai/adapter-opencode-local/server";
import { resolveProviderSkillsDir, type AdapterSkillContext } from "@paperclipai/adapter-utils";

async function makeTempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeSourceSkill(root: string) {
  const sourceDir = path.join(root, "source", "design-guide");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "SKILL.md"), "# Design Guide\n", "utf8");
  await fs.writeFile(path.join(sourceDir, "notes.md"), "v1\n", "utf8");
  return sourceDir;
}

function contextFor(adapterType: string, workDir: string, sourceDir: string): AdapterSkillContext {
  return {
    agentId: "agent-1",
    companyId: "company-1",
    adapterType,
    config: {
      cwd: workDir,
      env: {},
      paperclipRuntimeSkills: [
        {
          key: "paperclipai/paperclip/design-guide",
          runtimeName: "design-guide",
          source: sourceDir,
          required: false,
        },
      ],
      paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/design-guide"] },
    },
  };
}

const adapters = [
  { adapterType: "claude-local", list: listClaudeSkills, sync: syncClaudeSkills },
  { adapterType: "codex-local", list: listCodexSkills, sync: syncCodexSkills },
  { adapterType: "gemini-local", list: listGeminiSkills, sync: syncGeminiSkills },
  { adapterType: "opencode-local", list: listOpenCodeSkills, sync: syncOpenCodeSkills },
  { adapterType: "cursor-local", list: listCursorSkills, sync: syncCursorSkills },
];

describe("Phase A provider-native skill materialization", () => {
  it("materializes configured skills into all five Phase A local adapter skill homes", async () => {
    const root = await makeTempDir("papercompany-phase-a-skills-");
    try {
      const sourceDir = await makeSourceSkill(root);
      for (const adapter of adapters) {
        const workDir = path.join(root, adapter.adapterType);
        const ctx = contextFor(adapter.adapterType, workDir, sourceDir);
        const before = await adapter.list(ctx);
        expect(before.mode).toBe("persistent");
        expect(before.entries.find((entry) => entry.key === "paperclipai/paperclip/design-guide")?.state).toBe("missing");

        const after = await adapter.sync(ctx, ["paperclipai/paperclip/design-guide"]);
        const resolution = resolveProviderSkillsDir({ adapterType: adapter.adapterType, workDir, env: {} });
        expect(resolution.skillsDir).toBeTruthy();
        expect(after.entries.find((entry) => entry.key === "paperclipai/paperclip/design-guide")).toMatchObject({
          managed: true,
          state: "installed",
          targetPath: path.join(resolution.skillsDir!, "design-guide"),
        });
        await expect(fs.lstat(path.join(resolution.skillsDir!, "design-guide"))).resolves.toMatchObject({});
        expect((await fs.lstat(path.join(resolution.skillsDir!, "design-guide"))).isSymbolicLink()).toBe(false);
        await expect(fs.readFile(path.join(resolution.skillsDir!, "design-guide", ".papercompany-version"), "utf8")).resolves.toContain("paperclipai/paperclip/design-guide");
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps excluded adapters unsupported for provider-native filesystem materialization", () => {
    const resolution = resolveProviderSkillsDir({
      adapterType: "openclaw-gateway",
      workDir: "/workspace/project",
      env: {},
    });
    expect(resolution.mode).toBe("unsupported");
    expect(resolution.skillsDir).toBeNull();
  });
});
