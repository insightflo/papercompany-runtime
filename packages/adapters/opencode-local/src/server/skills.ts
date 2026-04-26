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
  return "opencode-local";
}

export async function listOpenCodeSkills(ctx: AdapterSkillContext) {
  return buildProviderNativeSkillSnapshot({
    adapterType: adapterType(),
    config: ctx.config,
    moduleDir: __moduleDir,
    locationLabel: ".config/opencode/skills",
  });
}

export async function syncOpenCodeSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
) {
  await syncProviderNativeSkills({
    adapterType: adapterType(),
    config: ctx.config,
    moduleDir: __moduleDir,
    desiredSkills,
  });
  return listOpenCodeSkills(ctx);
}

export function resolveOpenCodeDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}

export async function readOpenCodeRuntimeSkillEntries(config: Record<string, unknown>) {
  return readPaperclipRuntimeSkillEntries(config, __moduleDir);
}
