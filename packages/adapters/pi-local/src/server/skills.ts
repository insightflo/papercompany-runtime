import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

import { resolvePiSkillsDir } from "./runtime-paths.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildPiSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolvePiSkillsDir(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "pi_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.pi/agent/skills",
    missingDetail: "Configured but not currently linked into the Pi skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

export async function listPiSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildPiSkillSnapshot(ctx.config);
}

export async function syncPiSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...desiredSkills,
    ...availableEntries.filter((entry) => entry.required).map((entry) => entry.key),
  ]);
  const skillsHome = resolvePiSkillsDir(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    const isPaperclipManagedInstall =
      installedEntry.targetPath === available.source ||
      installedEntry.managedSourcePath === available.source ||
      installedEntry.managedKey === available.key;
    if (!isPaperclipManagedInstall) continue;
    await fs.rm(path.join(skillsHome, name), { recursive: true, force: true }).catch(() => {});
  }

  return buildPiSkillSnapshot(ctx.config);
}

export function resolvePiDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}
