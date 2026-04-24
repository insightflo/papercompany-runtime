import fs from "node:fs/promises";
import path from "node:path";

export interface ContextSafeFileView {
  workspaceId: string | null;
  relativePath: string;
  source: "wake_comment";
  exists: boolean;
}

const FILE_TOKEN_PATTERN = /(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g;

export async function buildContextSafeFileViews(input: {
  text: string | null;
  workspaceCwd: string | null;
  workspaceId: string | null;
  maxViews?: number;
}): Promise<ContextSafeFileView[]> {
  const text = input.text?.trim() ?? "";
  const workspaceCwd = input.workspaceCwd?.trim() ?? "";
  if (!text || !workspaceCwd) return [];

  const workspaceRoot = path.resolve(workspaceCwd);
  const matches = text.match(FILE_TOKEN_PATTERN) ?? [];
  const deduped = new Set<string>();
  for (const match of matches) {
    const normalized = normalizeRelativePath(match);
    if (!normalized) continue;
    deduped.add(normalized);
    if (deduped.size >= (input.maxViews ?? 8)) break;
  }

  const views: ContextSafeFileView[] = [];
  for (const relativePath of deduped) {
    const absolutePath = path.resolve(workspaceRoot, relativePath);
    if (absolutePath !== workspaceRoot && !absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
      continue;
    }
    const exists = await fs.stat(absolutePath).then((stat) => stat.isFile()).catch(() => false);
    views.push({
      workspaceId: input.workspaceId ?? null,
      relativePath,
      source: "wake_comment",
      exists,
    });
  }

  return views;
}

function normalizeRelativePath(candidate: string) {
  const trimmed = candidate.trim().replace(/^['"`]+|['"`,.:;!?]+$/g, "");
  if (!trimmed) return null;
  const slashNormalized = trimmed.replace(/\\/g, "/");
  if (slashNormalized.startsWith("/")) return null;
  const normalized = path.posix.normalize(slashNormalized);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return normalized;
}
