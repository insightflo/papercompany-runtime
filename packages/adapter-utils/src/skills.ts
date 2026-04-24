import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

export type ProviderSkillDeliveryMode = "provider_native" | "sidecar_only" | "unsupported";

export interface ProviderSkillsDirResolution {
  adapterType: string;
  mode: ProviderSkillDeliveryMode;
  skillsDir: string | null;
  sidecarDir: string;
  warnings: string[];
}

export interface ProviderSkillMaterializeEntry {
  key: string;
  runtimeName: string;
  sourceDir: string;
  revision: string;
}

export interface ProviderSkillMaterializeResult {
  adapterType: string;
  skillsDir: string | null;
  sidecarDir: string;
  created: string[];
  updated: string[];
  skipped: string[];
  warnings: string[];
}

const PHASE_A_PROVIDER_DIRS: Record<string, (workDir: string, env: Record<string, string | undefined>) => {
  skillsDir: string;
  warnings?: string[];
}> = {
  "claude-local": (workDir) => ({ skillsDir: path.join(workDir, ".claude", "skills") }),
  "codex-local": (workDir, env) => {
    const codexHome = env.CODEX_HOME?.trim();
    if (codexHome) return { skillsDir: path.join(codexHome, "skills") };
    return {
      skillsDir: path.join(workDir, ".codex", "skills"),
      warnings: ["codex-local CODEX_HOME is unset; using Papercompany workDir fallback .codex/skills."],
    };
  },
  "gemini-local": (workDir) => ({ skillsDir: path.join(workDir, ".gemini", "skills") }),
  "opencode-local": (workDir) => ({ skillsDir: path.join(workDir, ".config", "opencode", "skills") }),
  "cursor-local": (workDir) => ({ skillsDir: path.join(workDir, ".cursor", "skills") }),
};

function normalizeAdapterType(adapterType: string): string {
  return adapterType.trim().toLowerCase().replaceAll("_", "-");
}

function getEnvValueMap(env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined): Record<string, string | undefined> {
  return env ?? process.env;
}

export function resolveProviderSkillsDir(options: {
  adapterType: string;
  workDir: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): ProviderSkillsDirResolution {
  const adapterType = normalizeAdapterType(options.adapterType);
  const sidecarDir = path.join(options.workDir, ".papercompany", "agent-context");
  const resolver = PHASE_A_PROVIDER_DIRS[adapterType];
  if (!resolver) {
    return {
      adapterType,
      mode: "unsupported",
      skillsDir: null,
      sidecarDir,
      warnings: [`${adapterType} does not support Phase A provider-native filesystem skill delivery.`],
    };
  }
  const resolved = resolver(options.workDir, getEnvValueMap(options.env));
  return {
    adapterType,
    mode: "provider_native",
    skillsDir: resolved.skillsDir,
    sidecarDir,
    warnings: resolved.warnings ?? [],
  };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readVersionMarker(targetDir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(path.join(targetDir, ".papercompany-version"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  await fs.mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryContents(source, target);
      continue;
    }
    if (entry.isFile()) {
      await fs.copyFile(source, target);
    }
  }
}

async function writeVersionMarker(options: {
  targetDir: string;
  entry: ProviderSkillMaterializeEntry;
  adapterType: string;
  timestamp: string;
}): Promise<void> {
  const payload = {
    managedBy: "papercompany",
    key: options.entry.key,
    runtimeName: options.entry.runtimeName,
    revision: options.entry.revision,
    adapterType: options.adapterType,
    materializedAt: options.timestamp,
  };
  await fs.writeFile(
    path.join(options.targetDir, ".papercompany-version"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

export async function materializeProviderSkills(options: {
  adapterType: string;
  workDir: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  entries: ProviderSkillMaterializeEntry[];
  timestamp?: string;
  persist?: boolean;
}): Promise<ProviderSkillMaterializeResult> {
  const resolution = resolveProviderSkillsDir(options);
  const result: ProviderSkillMaterializeResult = {
    adapterType: resolution.adapterType,
    skillsDir: resolution.skillsDir,
    sidecarDir: resolution.sidecarDir,
    created: [],
    updated: [],
    skipped: [],
    warnings: [...resolution.warnings],
  };

  await fs.mkdir(resolution.sidecarDir, { recursive: true });

  if (resolution.mode !== "provider_native" || !resolution.skillsDir) {
    return result;
  }

  await fs.mkdir(resolution.skillsDir, { recursive: true });
  const timestamp = options.timestamp ?? new Date().toISOString();

  for (const entry of options.entries) {
    const targetDir = path.join(resolution.skillsDir, entry.runtimeName);
    const exists = await pathExists(targetDir);
    const marker = exists ? await readVersionMarker(targetDir) : null;

    if (exists && !marker) {
      result.skipped.push(entry.runtimeName);
      result.warnings.push(`Skipped external skill directory "${entry.runtimeName}" at ${targetDir}.`);
      continue;
    }

    if (marker?.revision === entry.revision && marker?.key === entry.key) {
      result.skipped.push(entry.runtimeName);
      continue;
    }

    if (exists) {
      await rmManagedDirectory(targetDir);
      await copyDirectoryContents(entry.sourceDir, targetDir);
      await writeVersionMarker({ targetDir, entry, adapterType: resolution.adapterType, timestamp });
      result.updated.push(entry.runtimeName);
      continue;
    }

    await copyDirectoryContents(entry.sourceDir, targetDir);
    await writeVersionMarker({ targetDir, entry, adapterType: resolution.adapterType, timestamp });
    result.created.push(entry.runtimeName);
  }

  return result;
}

async function rmManagedDirectory(targetDir: string): Promise<void> {
  await fs.rm(targetDir, { recursive: true, force: true });
}
