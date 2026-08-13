import os from "node:os";
import path from "node:path";

function configuredHome(config: Record<string, unknown>): string | null {
  const env = config.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return null;
  const home = (env as Record<string, unknown>).HOME;
  return typeof home === "string" && home.trim().length > 0 ? home.trim() : null;
}

export function resolvePiHome(config: Record<string, unknown>): string {
  return path.resolve(configuredHome(config) ?? os.homedir());
}

export function resolvePiSessionsDir(config: Record<string, unknown>): string {
  return path.join(resolvePiHome(config), ".pi", "paperclips");
}

export function resolvePiSkillsDir(config: Record<string, unknown>): string {
  return path.join(resolvePiHome(config), ".pi", "agent", "skills");
}
