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
  return "gemini-local";
}

export async function listGeminiSkills(ctx: AdapterSkillContext) {
  return buildProviderNativeSkillSnapshot({
    adapterType: adapterType(),
    config: ctx.config,
    moduleDir: __moduleDir,
    locationLabel: ".gemini/skills",
  });
}

export async function syncGeminiSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
) {
  await syncProviderNativeSkills({
    adapterType: adapterType(),
    config: ctx.config,
    moduleDir: __moduleDir,
    desiredSkills,
  });
  return listGeminiSkills(ctx);
}

export function resolveGeminiDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}

export async function readGeminiRuntimeSkillEntries(config: Record<string, unknown>) {
  return readPaperclipRuntimeSkillEntries(config, __moduleDir);
}
