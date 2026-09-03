import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface ContextSafeFileView {
  workspaceId: string | null;
  relativePath: string;
  source: "wake_comment";
  exists: boolean;
  /**
   * sha-256 hex fingerprint of the file contents at view time. Machine-generated
   * from the file bytes only; null when the file was missing, unreadable, or
   * larger than the fingerprint byte cap. Optional so snapshots recorded before
   * this field existed keep parsing.
   */
  contentHash?: string | null;
}

export type FileViewFreshnessStatus =
  | "current"
  | "stale"
  | "missing"
  | "created"
  | "unknown"
  | "invalid_path";

export interface FileViewFreshness {
  relativePath: string;
  status: FileViewFreshnessStatus;
  recordedContentHash: string | null;
  currentContentHash: string | null;
}

/**
 * Files larger than this are reported as views without a content fingerprint so
 * dispatch-time hashing cannot stall on huge binaries referenced in wake text.
 */
const MAX_CONTENT_HASH_BYTES = 4 * 1024 * 1024;

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
    const stat = await fs.stat(absolutePath).catch(() => null);
    const exists = stat?.isFile() ?? false;
    const contentHash =
      exists && stat !== null && stat.size <= MAX_CONTENT_HASH_BYTES
        ? await hashFileContents(absolutePath)
        : null;
    views.push({
      workspaceId: input.workspaceId ?? null,
      relativePath,
      source: "wake_comment",
      exists,
      contentHash,
    });
  }

  return views;
}

/**
 * Compare recorded file views (e.g. from a heartbeat run's context snapshot)
 * against the current files in the workspace. Only machine-generated content
 * fingerprints are compared; each recorded path is re-validated against the
 * workspace root before any file is touched.
 */
export async function evaluateFileViewFreshness(input: {
  views: unknown;
  workspaceCwd: string | null;
}): Promise<FileViewFreshness[]> {
  const workspaceCwd = input.workspaceCwd?.trim() ?? "";
  if (!workspaceCwd || !Array.isArray(input.views)) return [];

  const workspaceRoot = path.resolve(workspaceCwd);
  const results: FileViewFreshness[] = [];
  for (const entry of input.views) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const relativePath = typeof record.relativePath === "string" ? record.relativePath : "";
    const recordedContentHash =
      typeof record.contentHash === "string" && record.contentHash.length > 0
        ? record.contentHash
        : null;

    const normalized = normalizeRelativePath(relativePath);
    const absolutePath = normalized ? path.resolve(workspaceRoot, normalized) : null;
    const withinWorkspace =
      absolutePath !== null &&
      absolutePath !== workspaceRoot &&
      absolutePath.startsWith(`${workspaceRoot}${path.sep}`);
    if (!normalized || !withinWorkspace) {
      results.push({
        relativePath,
        status: "invalid_path",
        recordedContentHash,
        currentContentHash: null,
      });
      continue;
    }

    if (recordedContentHash === null) {
      if (record.exists !== true) {
        const stat = await fs.stat(absolutePath).catch(() => null);
        if (stat?.isFile()) {
          const currentContentHash =
            stat.size <= MAX_CONTENT_HASH_BYTES ? await hashFileContents(absolutePath) : null;
          results.push({
            relativePath,
            status: "created",
            recordedContentHash: null,
            currentContentHash,
          });
        } else {
          results.push({
            relativePath,
            status: "missing",
            recordedContentHash: null,
            currentContentHash: null,
          });
        }
      } else {
        results.push({
          relativePath,
          status: "unknown",
          recordedContentHash: null,
          currentContentHash: null,
        });
      }
      continue;
    }

    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) {
      results.push({
        relativePath,
        status: "missing",
        recordedContentHash,
        currentContentHash: null,
      });
      continue;
    }
    const currentContentHash =
      stat.size <= MAX_CONTENT_HASH_BYTES ? await hashFileContents(absolutePath) : null;
    if (currentContentHash === null) {
      results.push({
        relativePath,
        status: "unknown",
        recordedContentHash,
        currentContentHash: null,
      });
      continue;
    }
    results.push({
      relativePath,
      status: currentContentHash === recordedContentHash ? "current" : "stale",
      recordedContentHash,
      currentContentHash,
    });
  }

  return results;
}

async function hashFileContents(absolutePath: string): Promise<string | null> {
  try {
    const contents = await fs.readFile(absolutePath);
    return createHash("sha256").update(contents).digest("hex");
  } catch {
    return null;
  }
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
