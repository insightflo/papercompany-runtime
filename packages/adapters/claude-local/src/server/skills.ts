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
  return "claude-local";
}

export async function listClaudeSkills(ctx: AdapterSkillContext) {
  return buildProviderNativeSkillSnapshot({
    adapterType: adapterType(),
    config: ctx.config,
    moduleDir: __moduleDir,
    locationLabel: ".claude/skills",
  });
}

export async function syncClaudeSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
) {
  await syncProviderNativeSkills({
    adapterType: adapterType(),
    config: ctx.config,
    moduleDir: __moduleDir,
    desiredSkills,
  });
  return listClaudeSkills(ctx);
}

export function resolveClaudeDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}

export async function readClaudeRuntimeSkillEntries(config: Record<string, unknown>) {
  return readPaperclipRuntimeSkillEntries(config, __moduleDir);
}
