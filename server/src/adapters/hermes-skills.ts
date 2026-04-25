import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import { materializeProviderSkills, resolveProviderSkillsDir } from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readConfigEnv(config: Record<string, unknown>): Record<string, string | undefined> {
  if (typeof config.env !== "object" || config.env === null || Array.isArray(config.env)) return {};
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(config.env as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function resolveHermesWorkDir(config: Record<string, unknown>): string {
  return asString(config.cwd) ?? process.cwd();
}

async function hashDirectory(dir: string): Promise<string> {
  const hash = createHash("sha256");

  async function walk(current: string, relativePrefix = "") {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path.posix.join(relativePrefix, entry.name);
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`dir:${relative}\n`);
        await walk(fullPath, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      hash.update(`file:${relative}\n`);
      hash.update(await fs.readFile(fullPath));
      hash.update("\n");
    }
  }

  await walk(dir);
  return hash.digest("hex");
}

async function buildHermesSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const resolution = resolveProviderSkillsDir({
    adapterType: "hermes-local",
    workDir: resolveHermesWorkDir(config),
    env: readConfigEnv(config),
  });
  const skillsHome = resolution.skillsDir ?? path.join(resolveHermesWorkDir(config), ".hermes", "skills");
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "hermes_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: resolution.skillsDir ? "Hermes skills home" : ".hermes/skills",
    installedDetail: "Materialized into the Hermes skills home.",
    missingDetail: "Configured but not currently materialized into the Hermes skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Papercompany management.",
    warnings: resolution.warnings,
  });
}

export async function listHermesSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildHermesSkillSnapshot(ctx.config);
}

export async function syncHermesSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...desiredSkills,
    ...availableEntries.filter((entry) => entry.required).map((entry) => entry.key),
  ]);
  const resolution = resolveProviderSkillsDir({
    adapterType: "hermes-local",
    workDir: resolveHermesWorkDir(ctx.config),
    env: readConfigEnv(ctx.config),
  });
  const skillsHome = resolution.skillsDir;

  if (skillsHome) {
    const installed = await readInstalledSkillTargets(skillsHome);
    const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));
    for (const [name, installedEntry] of installed.entries()) {
      const available = availableByRuntimeName.get(name);
      if (!available) continue;
      if (desiredSet.has(available.key)) continue;
      const isPapercompanyManagedInstall =
        installedEntry.targetPath === available.source ||
        installedEntry.managedSourcePath === available.source ||
        installedEntry.managedKey === available.key;
      if (!isPapercompanyManagedInstall) continue;
      await fs.rm(path.join(skillsHome, name), { recursive: true, force: true }).catch(() => {});
    }
  }

  await materializeProviderSkills({
    adapterType: "hermes-local",
    workDir: resolveHermesWorkDir(ctx.config),
    env: readConfigEnv(ctx.config),
    entries: await Promise.all(
      availableEntries
        .filter((entry) => desiredSet.has(entry.key))
        .map(async (entry) => ({
          key: entry.key,
          runtimeName: entry.runtimeName,
          sourceDir: entry.source,
          revision: await hashDirectory(entry.source),
        })),
    ),
  });

  return buildHermesSkillSnapshot({
    ...ctx.config,
    paperclipSkillSync: { desiredSkills: Array.from(desiredSet) },
  });
}
