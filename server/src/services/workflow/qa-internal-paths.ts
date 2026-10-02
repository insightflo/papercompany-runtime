import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../config.js";
import { resolvePaperclipHomeDir, resolvePaperclipInstanceRoot } from "../../home-paths.js";

/** Runtime configuration and captured attempt paths only; never plugin/agent claims. */
export async function resolveQaInternalPathRoots(attemptRoots: readonly (string | null | undefined)[] = []) {
  const roots = [...attemptRoots, os.tmpdir()];
  // A missing/unreadable configuration must not discard roots already available.
  try { roots.push(resolvePaperclipHomeDir()); } catch { /* unavailable */ }
  try { roots.push(resolvePaperclipInstanceRoot()); } catch { /* unavailable */ }
  try {
    const config = loadConfig();
    roots.push(config.embeddedPostgresDataDir, config.storageLocalDiskBaseDir, config.databaseBackupDir,
      path.dirname(config.secretsMasterKeyFilePath));
  } catch { /* unavailable */ }
  const absolute = [...new Set(roots.filter((root): root is string => !!root && path.isAbsolute(root)).map(root => path.resolve(root)))];
  const canonical = await Promise.all(absolute.map(root => realpath(root).catch(() => root)));
  return [...new Set([...absolute, ...canonical])];
}

export function containsInternalPath(text: string, roots: readonly string[] = []) {
  const local = text.replace(/https?:\/\/[^\s<>"']+/gi, "");
  // Preserve portable local-file forms even when runtime roots are unavailable.
  if (/(?:^|[\s>"'(=])(?:[a-z]:\\|file:\/\/|\\\\)/im.test(local)) return true;
  return roots.some(root => {
    if (!path.isAbsolute(root)) return false;
    const escaped = path.resolve(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[\\s>"'(=])${escaped}(?=$|[/\\\\\\s<>"'\x60),;:?!\\]}])`, "m").test(local);
  });
}
