import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext } from "@paperclipai/adapter-utils";
import {
  buildProviderNativeSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  syncProviderNativeSkills,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function adapterType() {
  return "cursor-local";
}

export async function listCursorSkills(ctx: AdapterSkillContext) {
  return buildProviderNativeSkillSnapshot({
    adapterType: adapterType(),
    config: ctx.config,
    moduleDir: __moduleDir,
    locationLabel: ".cursor/skills",
  });
}

export async function syncCursorSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
) {
  await syncProviderNativeSkills({
    adapterType: adapterType(),
    config: ctx.config,
    moduleDir: __moduleDir,
    desiredSkills,
  });
  return listCursorSkills(ctx);
}

export function resolveCursorDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}

export async function readCursorRuntimeSkillEntries(config: Record<string, unknown>) {
  return readPaperclipRuntimeSkillEntries(config, __moduleDir);
}
