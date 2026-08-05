import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext } from "@paperclipai/adapter-utils";
import {
  buildProviderNativeSkillSnapshot,
  syncProviderNativeSkills,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function adapterType() {
  return "commandcode-local";
}

export async function listCommandCodeSkills(ctx: AdapterSkillContext) {
  return buildProviderNativeSkillSnapshot({
    adapterType: adapterType(),
    config: ctx.config,
    moduleDir: __moduleDir,
    locationLabel: ".commandcode/skills",
  });
}

export async function syncCommandCodeSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
) {
  await syncProviderNativeSkills({
    adapterType: adapterType(),
    config: ctx.config,
    moduleDir: __moduleDir,
    desiredSkills,
  });
  return listCommandCodeSkills(ctx);
}
