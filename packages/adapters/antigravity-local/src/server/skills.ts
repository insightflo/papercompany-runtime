import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export interface AntigravitySkillCatalogEntry {
  key: string;
  runtimeName: string;
  source: string;
}

/**
 * Build the compact, on-demand skill catalog injected into an Antigravity run.
 * Selected skills are NOT loaded into the prompt wholesale; Antigravity is told
 * to read only the matching skill's SKILL.md when a task matches. This keeps the
 * prompt small and avoids touching Antigravity's shared global skills directory.
 */
export function buildAntigravitySkillPrompt(entries: AntigravitySkillCatalogEntry[]): string {
  if (entries.length === 0) return "";
  const catalog = entries
    .map((entry) => `- ${entry.key}: ${path.join(entry.source, "SKILL.md")}`)
    .join("\n");
  return [
    "## Papercompany skills",
    "The following skills are selected for this agent. They are available on disk but are not automatically loaded.",
    "When a task matches a skill, read that skill's SKILL.md first and follow its instructions. Do not read unrelated skills.",
    catalog,
  ].join("\n");
}

async function readAntigravitySkillSelection(config: Record<string, unknown>) {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  return { availableEntries, desiredSkills };
}

/**
 * Resolve the on-demand skill prompt for a single Antigravity run from the
 * agent's effective runtime config. Used by execute() so each run receives only
 * its own selected skills without mutating any shared skill directory.
 */
export async function resolveAntigravitySkillPrompt(config: Record<string, unknown>): Promise<string> {
  const { availableEntries, desiredSkills } = await readAntigravitySkillSelection(config);
  const desiredSet = new Set(desiredSkills);
  const selectedEntries = availableEntries
    .filter((entry) => desiredSet.has(entry.key))
    .map((entry) => ({ key: entry.key, runtimeName: entry.runtimeName, source: entry.source }));
  return buildAntigravitySkillPrompt(selectedEntries);
}

async function buildAntigravitySkillSnapshot(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  const { availableEntries, desiredSkills } = await readAntigravitySkillSelection(ctx.config);
  const desiredSet = new Set(desiredSkills);

  return {
    adapterType: "antigravity_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries: availableEntries.map((entry) => {
      const desired = desiredSet.has(entry.key);
      return {
        key: entry.key,
        runtimeName: entry.runtimeName,
        desired,
        managed: desired,
        state: desired ? "configured" : "available",
        required: Boolean(entry.required),
        requiredReason: entry.requiredReason ?? null,
        origin: entry.required ? "paperclip_required" : "company_managed",
        originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
        readOnly: false,
        sourcePath: entry.source,
        targetPath: null,
        detail: desired
          ? "Provided to Antigravity for this run; read its SKILL.md when the task matches."
          : null,
      };
    }),
    warnings: [
      "Antigravity receives selected skills as on-demand run context; no shared global skills directory is modified.",
    ],
  };
}

export async function listAntigravitySkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildAntigravitySkillSnapshot(ctx);
}

export async function syncAntigravitySkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  // Selection is durable (persisted on the agent config by the skill-sync route)
  // and delivered per-run as on-demand prompt context, so there is no shared
  // directory to materialize. Recompute the snapshot from the effective config.
  return buildAntigravitySkillSnapshot(ctx);
}
