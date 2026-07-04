import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments } from "@paperclipai/db";
import { isPathInsideOrEqual } from "./output-paths.js";

const CLAIMED_ARTIFACT_EXTENSION_PATTERN = "md|markdown|json|html|htm|pdf|png|jpg|jpeg|webp|svg|csv|txt|docx|pptx|xlsx";
const CLAIMED_ARTIFACT_JSON_PATH_RE = new RegExp(
  `"(?:outputPath|artifactPath|documentPath|filePath|path|url)"\\s*:\\s*"([^"]+\\.(?:${CLAIMED_ARTIFACT_EXTENSION_PATTERN}))"`,
  "giu",
);
const CLAIMED_ARTIFACT_ABSOLUTE_PATH_RE = new RegExp(
  `(/[^\\r\\n\`'"]+?\\.(?:${CLAIMED_ARTIFACT_EXTENSION_PATTERN}))(?=$|[\\s\`'"\\\\,}\\]])`,
  "giu",
);
const EXPLICIT_ARTIFACT_DECLARATION_RE = /`?\[?ARTIFACT\]?`?\s*:\s*[`'"]?(\/[^\s`'")\]\n]+)/giu;
const EXPLICIT_ARTIFACT_URL_DECLARATION_RE = /`?\[?ARTIFACT\]?`?\s*:\s*[`'"]?(https?:\/\/[^\s`'")\]\n]+)/giu;

export type CommentArtifactPathCandidates = {
  paths: string[];
  sourceCommentIds: string[];
  safeForAutoRegistration: boolean;
};

export function stripArtifactTokenPunctuation(value: string) {
  return value
    .trim()
    .replace(/^[`'"]+/u, "")
    .replace(/[`'",;.)\\\]]+$/u, "");
}

function normalizeClaimedArtifactPath(value: string): string {
  return value
    .trim()
    .replace(/^[-*\u2022]\s*/, "")
    .replace(/^`+|`+$/g, "")
    .replace(/[),.;:]+$/g, "")
    .trim();
}

export function isActionableClaimedArtifactPath(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (value.includes("\\n") || value.includes("\\r") || /[\r\n]/u.test(value)) return false;
  if (/[<>]/u.test(value)) return false;
  if (/\{\$date\}|YYYY(?:MM|-MM-DD)?|MMDD/u.test(value)) return false;

  const nonDeliverablePathMarkers = [
    "/papercompany-runtime/skills/",
    "/papercompany-operations/scripts/paperclip-addon/agents/",
    "/instructions/",
    "/node_modules/",
    "/.git/",
    "/data/",
    "/input/",
    "/source/",
    "/sources/",
  ];
  if (nonDeliverablePathMarkers.some((marker) => value.includes(marker))) return false;
  if (/(?:^|\/)(?:AGENTS|CLAUDE|SKILL)\.md$/u.test(value)) return false;
  if (/(?:^|\/)\.cursorrules$/u.test(value)) return false;

  return true;
}

export function extractExplicitArtifactPaths(...sources: Array<string | null | undefined>): string[] {
  const paths = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(EXPLICIT_ARTIFACT_DECLARATION_RE)) {
      const candidate = stripArtifactTokenPunctuation(match[1]!);
      if (candidate.startsWith("/")) paths.add(candidate);
    }
  }
  return Array.from(paths);
}

function normalizeExplicitArtifactUrl(value: string): string | null {
  const candidate = stripArtifactTokenPunctuation(value);
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function extractExplicitArtifactUrls(...sources: Array<string | null | undefined>): string[] {
  const urls = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(EXPLICIT_ARTIFACT_URL_DECLARATION_RE)) {
      const url = normalizeExplicitArtifactUrl(match[1]!);
      if (url) urls.add(url);
    }
  }
  return Array.from(urls);
}

export function extractClaimedArtifactPathsFromText(text: string): string[] {
  if (!text.trim()) return [];

  const paths = new Set<string>();
  for (const artifactPath of extractExplicitArtifactPaths(text)) {
    if (isActionableClaimedArtifactPath(artifactPath)) paths.add(artifactPath);
  }
  for (const match of text.matchAll(CLAIMED_ARTIFACT_JSON_PATH_RE)) {
    const value = normalizeClaimedArtifactPath(match[1] ?? "");
    if (value && isActionableClaimedArtifactPath(value)) paths.add(value);
  }
  for (const match of text.matchAll(CLAIMED_ARTIFACT_ABSOLUTE_PATH_RE)) {
    const value = normalizeClaimedArtifactPath(match[1] ?? "");
    if (value && isActionableClaimedArtifactPath(value)) paths.add(value);
  }
  return [...paths].slice(0, 10);
}

export function resolveCommentArtifactPathCandidates(input: {
  comments: Array<{ id: string | null; body: string | null; createdAt: Date | null }>;
  runStartedAt: Date | null;
  runFinishedAt?: Date | null;
  allowedArtifactRoot: string | null;
  clockSkewMs?: number;
}): CommentArtifactPathCandidates {
  if (!input.allowedArtifactRoot || !(input.runStartedAt instanceof Date)) {
    return { paths: [], sourceCommentIds: [], safeForAutoRegistration: false };
  }

  const paths = new Set<string>();
  const sourceCommentIds = new Set<string>();
  const runStartedAtMs = input.runStartedAt.getTime();
  const runFinishedAtMs = input.runFinishedAt instanceof Date ? input.runFinishedAt.getTime() : null;
  const clockSkewMs = input.clockSkewMs ?? 5_000;
  for (const comment of input.comments) {
    if (!(comment.createdAt instanceof Date)) continue;
    const createdAtMs = comment.createdAt.getTime();
    if (createdAtMs < runStartedAtMs - clockSkewMs) continue;
    if (runFinishedAtMs !== null && createdAtMs > runFinishedAtMs + clockSkewMs) continue;

    let addedFromComment = false;
    for (const artifactPath of extractExplicitArtifactPaths(comment.body ?? "")) {
      if (!isActionableClaimedArtifactPath(artifactPath)) continue;
      if (!isPathInsideOrEqual(artifactPath, input.allowedArtifactRoot)) continue;
      paths.add(artifactPath);
      addedFromComment = true;
    }
    if (addedFromComment && comment.id) {
      sourceCommentIds.add(comment.id);
    }
  }

  const resolvedPaths = Array.from(paths).slice(0, 10);
  return {
    paths: resolvedPaths,
    sourceCommentIds: Array.from(sourceCommentIds).slice(0, 10),
    safeForAutoRegistration: resolvedPaths.length === 1,
  };
}

export async function collectRecentIssueCommentArtifactPathCandidates(input: {
  tx: Pick<Db, "select">;
  issueId: string;
  companyId: string;
  agentId: string;
  runStartedAt: Date | null;
  runCreatedAt: Date | null;
  runFinishedAt: Date | null;
  runUpdatedAt: Date | null;
  allowedArtifactRoot: string | null;
  now?: Date;
}): Promise<CommentArtifactPathCandidates> {
  const runStartedAt = input.runStartedAt ?? input.runCreatedAt;
  if (!input.allowedArtifactRoot || !(runStartedAt instanceof Date)) {
    return { paths: [], sourceCommentIds: [], safeForAutoRegistration: false };
  }

  const comments = await input.tx
    .select({
      id: issueComments.id,
      body: issueComments.body,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(and(
      eq(issueComments.issueId, input.issueId),
      eq(issueComments.companyId, input.companyId),
      eq(issueComments.authorAgentId, input.agentId),
      isNull(issueComments.authorUserId),
    ))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(25);

  return resolveCommentArtifactPathCandidates({
    comments,
    runStartedAt,
    runFinishedAt: input.runFinishedAt ?? input.runUpdatedAt ?? input.now ?? new Date(),
    allowedArtifactRoot: input.allowedArtifactRoot,
  });
}
