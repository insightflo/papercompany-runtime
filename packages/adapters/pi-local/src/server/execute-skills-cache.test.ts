import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  removeMaintainerOnlySkillSymlinks: vi.fn(),
  ensurePaperclipSkillSymlink: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    removeMaintainerOnlySkillSymlinks: (
      ...args: Parameters<typeof actual.removeMaintainerOnlySkillSymlinks>
    ) => mocks.removeMaintainerOnlySkillSymlinks(...args, actual.removeMaintainerOnlySkillSymlinks),
    ensurePaperclipSkillSymlink: (
      ...args: Parameters<typeof actual.ensurePaperclipSkillSymlink>
    ) => mocks.ensurePaperclipSkillSymlink(...args, actual.ensurePaperclipSkillSymlink),
  };
});

import {
  ensurePiSkillsInjected,
  resetPiSkillsInjectCacheForTests,
} from "./execute.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-skills-cache-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function makeSourceSkill(root: string, name: string): Promise<string> {
  const sourceDir = path.join(root, "sources", name);
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "SKILL.md"), `# ${name}\n`, "utf8");
  return sourceDir;
}

function useRealImplementations(): void {
  mocks.removeMaintainerOnlySkillSymlinks.mockImplementation(
    (
      skillsHome: string,
      allowed: Iterable<string>,
      impl: (home: string, allowedNames: Iterable<string>) => Promise<string[]>,
    ) => impl(skillsHome, allowed),
  );
  mocks.ensurePaperclipSkillSymlink.mockImplementation(
    (
      source: string,
      target: string,
      impl: (source: string, target: string) => Promise<string>,
    ) => impl(source, target),
  );
}

const noopLog = async () => {};

describe("ensurePiSkillsInjected memoization", () => {
  beforeEach(() => {
    resetPiSkillsInjectCacheForTests();
    mocks.removeMaintainerOnlySkillSymlinks.mockReset();
    mocks.ensurePaperclipSkillSymlink.mockReset();
    useRealImplementations();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_PI_SKILLS_INJECT_TTL_MS;
    resetPiSkillsInjectCacheForTests();
  });

  it("skips all filesystem work on the second identical call", async () => {
    await withTempDir(async (dir) => {
      const skillsHome = path.join(dir, "home", "skills");
      const source = await makeSourceSkill(dir, "skill-a");
      const entries = [{ key: "papercompany/skill-a", runtimeName: "skill-a", source }];

      await ensurePiSkillsInjected(noopLog, skillsHome, entries);
      expect(mocks.removeMaintainerOnlySkillSymlinks).toHaveBeenCalledTimes(1);
      expect(mocks.ensurePaperclipSkillSymlink).toHaveBeenCalledTimes(1);
      await expect(fs.readlink(path.join(skillsHome, "skill-a"))).resolves.toBe(source);

      const removeCalls = mocks.removeMaintainerOnlySkillSymlinks.mock.calls.length;
      const ensureCalls = mocks.ensurePaperclipSkillSymlink.mock.calls.length;

      await ensurePiSkillsInjected(noopLog, skillsHome, entries);

      expect(mocks.removeMaintainerOnlySkillSymlinks.mock.calls.length).toBe(removeCalls);
      expect(mocks.ensurePaperclipSkillSymlink.mock.calls.length).toBe(ensureCalls);
      await expect(fs.readlink(path.join(skillsHome, "skill-a"))).resolves.toBe(source);
    });
  });

  it("re-runs when the injection signature changes", async () => {
    await withTempDir(async (dir) => {
      const skillsHome = path.join(dir, "home", "skills");
      const sourceA = await makeSourceSkill(dir, "skill-a");
      const sourceB = await makeSourceSkill(dir, "skill-b");
      const entries = [
        { key: "papercompany/skill-a", runtimeName: "skill-a", source: sourceA },
        { key: "papercompany/skill-b", runtimeName: "skill-b", source: sourceB },
      ];

      await ensurePiSkillsInjected(noopLog, skillsHome, entries, ["papercompany/skill-a"]);
      expect(mocks.ensurePaperclipSkillSymlink).toHaveBeenCalledTimes(1);

      // Same selection again → cache hit, no extra work.
      await ensurePiSkillsInjected(noopLog, skillsHome, entries, ["papercompany/skill-a"]);
      expect(mocks.ensurePaperclipSkillSymlink).toHaveBeenCalledTimes(1);

      // Different desired skills → different signature → re-run (re-checks
      // every selected entry, including the already-linked one).
      await ensurePiSkillsInjected(
        noopLog,
        skillsHome,
        entries,
        ["papercompany/skill-a", "papercompany/skill-b"],
      );
      expect(mocks.removeMaintainerOnlySkillSymlinks).toHaveBeenCalledTimes(2);
      expect(mocks.ensurePaperclipSkillSymlink).toHaveBeenCalledTimes(3);
    });
  });

  it("does not cache a run where an entry failed to inject", async () => {
    await withTempDir(async (dir) => {
      const skillsHome = path.join(dir, "home", "skills");
      const source = await makeSourceSkill(dir, "skill-a");
      const entries = [{ key: "papercompany/skill-a", runtimeName: "skill-a", source }];

      mocks.ensurePaperclipSkillSymlink.mockImplementation(async () => {
        throw new Error("simulated symlink failure");
      });
      const logs: string[] = [];
      await ensurePiSkillsInjected(
        async (_stream, chunk) => {
          logs.push(chunk);
        },
        skillsHome,
        entries,
      );
      expect(logs.join("")).toContain("Failed to inject Pi skill");

      mocks.ensurePaperclipSkillSymlink.mockImplementation(
        (source: string, target: string, impl: (s: string, t: string) => Promise<string>) =>
          impl(source, target),
      );
      await ensurePiSkillsInjected(noopLog, skillsHome, entries);
      expect(mocks.ensurePaperclipSkillSymlink).toHaveBeenCalledTimes(2);

      // The retry succeeded, so the next identical call is cached.
      await ensurePiSkillsInjected(noopLog, skillsHome, entries);
      expect(mocks.ensurePaperclipSkillSymlink).toHaveBeenCalledTimes(2);
    });
  });

  it("honors PAPERCLIP_PI_SKILLS_INJECT_TTL_MS including invalid values", async () => {
    await withTempDir(async (dir) => {
      const skillsHome = path.join(dir, "home", "skills");
      const source = await makeSourceSkill(dir, "skill-a");
      const entries = [{ key: "papercompany/skill-a", runtimeName: "skill-a", source }];

      // TTL 0: every call re-runs the filesystem procedure.
      process.env.PAPERCLIP_PI_SKILLS_INJECT_TTL_MS = "0";
      await ensurePiSkillsInjected(noopLog, skillsHome, entries);
      await ensurePiSkillsInjected(noopLog, skillsHome, entries);
      expect(mocks.removeMaintainerOnlySkillSymlinks).toHaveBeenCalledTimes(2);

      // Invalid values fall back to the default TTL → cached.
      for (const invalid of ["not-a-number", "-1", ""]) {
        resetPiSkillsInjectCacheForTests();
        mocks.removeMaintainerOnlySkillSymlinks.mockClear();
        mocks.ensurePaperclipSkillSymlink.mockClear();
        process.env.PAPERCLIP_PI_SKILLS_INJECT_TTL_MS = invalid;
        await ensurePiSkillsInjected(noopLog, skillsHome, entries);
        await ensurePiSkillsInjected(noopLog, skillsHome, entries);
        expect(mocks.removeMaintainerOnlySkillSymlinks).toHaveBeenCalledTimes(1);
        expect(mocks.ensurePaperclipSkillSymlink).toHaveBeenCalledTimes(1);
      }
    });
  });

  it("resetPiSkillsInjectCacheForTests forces a re-run", async () => {
    await withTempDir(async (dir) => {
      const skillsHome = path.join(dir, "home", "skills");
      const source = await makeSourceSkill(dir, "skill-a");
      const entries = [{ key: "papercompany/skill-a", runtimeName: "skill-a", source }];

      await ensurePiSkillsInjected(noopLog, skillsHome, entries);
      expect(mocks.ensurePaperclipSkillSymlink).toHaveBeenCalledTimes(1);

      resetPiSkillsInjectCacheForTests();
      await ensurePiSkillsInjected(noopLog, skillsHome, entries);
      expect(mocks.ensurePaperclipSkillSymlink).toHaveBeenCalledTimes(2);
    });
  });
});
