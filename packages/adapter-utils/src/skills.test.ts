import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  materializeProviderSkills,
  resolveProviderSkillsDir,
} from "./skills.js";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "papercompany-skills-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveProviderSkillsDir", () => {
  it("resolves Phase A provider-native skill directories", () => {
    const workDir = "/workspace/project";
    const codexHome = "/runtime/codex-home";
    const hermesHome = "/runtime/hermes-home";

    expect(resolveProviderSkillsDir({ adapterType: "claude-local", workDir }).skillsDir).toBe(
      path.join(workDir, ".claude", "skills"),
    );
    expect(resolveProviderSkillsDir({ adapterType: "claude_local", workDir }).mode).toBe(
      "provider_native",
    );
    expect(
      resolveProviderSkillsDir({ adapterType: "codex-local", workDir, env: { CODEX_HOME: codexHome } })
        .skillsDir,
    ).toBe(path.join(codexHome, "skills"));
    expect(resolveProviderSkillsDir({ adapterType: "codex-local", workDir }).skillsDir).toBe(
      path.join(workDir, ".codex", "skills"),
    );
    expect(resolveProviderSkillsDir({ adapterType: "gemini-local", workDir }).skillsDir).toBe(
      path.join(workDir, ".gemini", "skills"),
    );
    expect(resolveProviderSkillsDir({ adapterType: "opencode-local", workDir }).skillsDir).toBe(
      path.join(workDir, ".config", "opencode", "skills"),
    );
    expect(resolveProviderSkillsDir({ adapterType: "cursor-local", workDir }).skillsDir).toBe(
      path.join(workDir, ".cursor", "skills"),
    );
    expect(
      resolveProviderSkillsDir({ adapterType: "hermes", workDir, env: { HERMES_HOME: hermesHome } }).skillsDir,
    ).toBe(path.join(hermesHome, "skills"));
    expect(resolveProviderSkillsDir({ adapterType: "hermes-local", workDir, env: {} }).skillsDir).toBe(
      path.join(workDir, ".hermes", "skills"),
    );
    expect(resolveProviderSkillsDir({ adapterType: "hermes_local", workDir, env: {} }).mode).toBe("provider_native");
  });

  it("does not fake provider-native directories for excluded adapters", () => {
    const workDir = "/workspace/project";

    for (const adapterType of ["pi-local", "openclaw-gateway", "unknown-local"]) {
      const resolution = resolveProviderSkillsDir({ adapterType, workDir });
      expect(resolution.skillsDir).toBeNull();
      expect(resolution.mode).toBe("unsupported");
      expect(resolution.sidecarDir).toBe(path.join(workDir, ".papercompany", "agent-context"));
    }
  });
});

describe("materializeProviderSkills", () => {
  it("copies managed skills idempotently without touching root instruction files or external skills", async () => {
    await withTempDir(async (dir) => {
      const workDir = path.join(dir, "work");
      const sourceDir = path.join(dir, "source", "design-guide");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(path.join(sourceDir, "SKILL.md"), "# Design Guide\n", "utf8");
      await writeFile(path.join(sourceDir, "notes.md"), "v1\n", "utf8");
      await mkdir(path.join(workDir, ".claude", "skills", "external-skill"), { recursive: true });
      await writeFile(path.join(workDir, ".claude", "skills", "external-skill", "SKILL.md"), "external\n", "utf8");
      await writeFile(path.join(workDir, "CLAUDE.md"), "user root instruction\n", "utf8");

      const first = await materializeProviderSkills({
        adapterType: "claude-local",
        workDir,
        timestamp: "2026-04-24T11:18:00.000Z",
        entries: [
          {
            key: "papercompany/design-guide",
            runtimeName: "design-guide",
            sourceDir,
            revision: "rev-1",
          },
        ],
      });

      expect(first.created).toEqual(["design-guide"]);
      expect(first.updated).toEqual([]);
      expect(first.skipped).toEqual([]);
      expect(await readFile(path.join(workDir, ".claude", "skills", "design-guide", "SKILL.md"), "utf8")).toBe(
        "# Design Guide\n",
      );
      expect(await readFile(path.join(workDir, ".claude", "skills", "design-guide", ".papercompany-version"), "utf8")).toContain(
        "rev-1",
      );
      expect(await readFile(path.join(workDir, "CLAUDE.md"), "utf8")).toBe("user root instruction\n");
      expect(await readFile(path.join(workDir, ".claude", "skills", "external-skill", "SKILL.md"), "utf8")).toBe(
        "external\n",
      );

      const second = await materializeProviderSkills({
        adapterType: "claude-local",
        workDir,
        timestamp: "2026-04-24T11:19:00.000Z",
        entries: [
          {
            key: "papercompany/design-guide",
            runtimeName: "design-guide",
            sourceDir,
            revision: "rev-1",
          },
        ],
      });
      expect(second.created).toEqual([]);
      expect(second.updated).toEqual([]);
      expect(second.skipped).toEqual(["design-guide"]);

      await writeFile(path.join(sourceDir, "notes.md"), "v2\n", "utf8");
      const third = await materializeProviderSkills({
        adapterType: "claude-local",
        workDir,
        timestamp: "2026-04-24T11:20:00.000Z",
        entries: [
          {
            key: "papercompany/design-guide",
            runtimeName: "design-guide",
            sourceDir,
            revision: "rev-2",
          },
        ],
      });
      expect(third.updated).toEqual(["design-guide"]);
      expect(await readFile(path.join(workDir, ".claude", "skills", "design-guide", "notes.md"), "utf8")).toBe(
        "v2\n",
      );
    });
  });

  it("skips existing non-managed target directories", async () => {
    await withTempDir(async (dir) => {
      const workDir = path.join(dir, "work");
      const sourceDir = path.join(dir, "source", "design-guide");
      const targetDir = path.join(workDir, ".claude", "skills", "design-guide");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(path.join(sourceDir, "SKILL.md"), "managed\n", "utf8");
      await writeFile(path.join(targetDir, "SKILL.md"), "external conflict\n", "utf8");

      const result = await materializeProviderSkills({
        adapterType: "claude-local",
        workDir,
        entries: [
          {
            key: "papercompany/design-guide",
            runtimeName: "design-guide",
            sourceDir,
            revision: "rev-1",
          },
        ],
      });

      expect(result.created).toEqual([]);
      expect(result.updated).toEqual([]);
      expect(result.skipped).toEqual(["design-guide"]);
      expect(result.warnings.join("\n")).toContain("external");
      expect(await readFile(path.join(targetDir, "SKILL.md"), "utf8")).toBe("external conflict\n");
    });
  });

  it("does not write provider-native skill files for unsupported adapters", async () => {
    await withTempDir(async (dir) => {
      const sourceDir = path.join(dir, "source", "design-guide");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(path.join(sourceDir, "SKILL.md"), "managed\n", "utf8");

      const result = await materializeProviderSkills({
        adapterType: "openclaw-gateway",
        workDir: path.join(dir, "work"),
        entries: [
          {
            key: "papercompany/design-guide",
            runtimeName: "design-guide",
            sourceDir,
            revision: "rev-1",
          },
        ],
      });

      expect(result.skillsDir).toBeNull();
      expect(result.created).toEqual([]);
      await expect(stat(path.join(dir, "work", ".openclaw"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
