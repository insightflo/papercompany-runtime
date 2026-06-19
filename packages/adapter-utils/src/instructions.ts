import fs from "node:fs/promises";
import path from "node:path";

export type LoadedInstructionsWithReferences = {
  entryPath: string;
  content: string;
  includedPaths: string[];
  /** inline 임계 초과로 경로만 남긴 참조(에이전트가 on-demand 로 읽음). */
  deferredPaths: string[];
  warnings: string[];
};

type LoadOptions = {
  maxDepth?: number;
  maxFiles?: number;
  maxBytesPerFile?: number;
  /** 참조 파일이 이 크기(바이트) 초과면 inline하지 않고 경로만 남김(agentic 어댑터 on-demand 읽기). 기본 10KB, env PAPERCLIP_INSTRUCTIONS_INLINE_MAX_BYTES 로 전역 조정. */
  inlineMaxBytes?: number;
};

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_BYTES_PER_FILE = 512 * 1024;
const DEFAULT_INLINE_MAX_BYTES = 10 * 1024;

/**
 * [목적] resolveInlineMaxBytes — inline 임계 결정. 명시 opt > env(PAPERCLIP_INSTRUCTIONS_INLINE_MAX_BYTES) > 기본 10KB.
 *   임계 초과 참조는 inline하지 않고 경로만 남겨 agentic 어댑터(claude/codex/opencode/gemini)가
 *   on-demand 로 읽게 한다. 0 → 모든 참조를 경로로(inline 완전 중단), 큰 값 → 종래 동작(전부 inline).
 */
function resolveInlineMaxBytes(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const env = Number.parseInt(process.env.PAPERCLIP_INSTRUCTIONS_INLINE_MAX_BYTES ?? "", 10);
  return Number.isFinite(env) && env >= 0 ? env : DEFAULT_INLINE_MAX_BYTES;
}
const MARKDOWN_PATH_RE =
  /`([^`\n]+\.md)`|\(([^()\n]+\.md)\)|(?:^|[\s:])((?:~|\.{1,2}|\/)[^\s`"')]+\.md)(?=$|[\s`"')])/gim;

function expandHome(candidatePath: string) {
  if (candidatePath === "~") return process.env.HOME ?? candidatePath;
  if (candidatePath.startsWith("~/")) {
    const home = process.env.HOME;
    return home ? path.join(home, candidatePath.slice(2)) : candidatePath;
  }
  return candidatePath;
}

function normalizeCandidatePath(rawPath: string): string {
  return rawPath.trim().replace(/^<(.+)>$/, "$1");
}

function extractReferencedMarkdownPaths(content: string): string[] {
  const output: string[] = [];
  for (const match of content.matchAll(MARKDOWN_PATH_RE)) {
    const candidate = normalizeCandidatePath(match[1] ?? match[2] ?? match[3] ?? "");
    if (!candidate || candidate.includes("\0")) continue;
    output.push(candidate);
  }
  return [...new Set(output)];
}

async function readBoundedTextFile(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error("not a file");
  }
  if (stat.size > maxBytes) {
    throw new Error(`file is too large (${stat.size} bytes, max ${maxBytes})`);
  }
  return fs.readFile(filePath, "utf8");
}

export async function loadInstructionsWithInlinedReferences(
  entryPath: string,
  options: LoadOptions = {},
): Promise<LoadedInstructionsWithReferences> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const inlineMaxBytes = resolveInlineMaxBytes(options.inlineMaxBytes);
  const resolvedEntryPath = path.resolve(entryPath);
  const seen = new Set<string>();
  const includedPaths: string[] = [];
  const warnings: string[] = [];
  const deferredPaths: string[] = [];

  async function loadFile(filePath: string, depth: number, isEntry: boolean): Promise<string> {
    const resolvedPath = path.resolve(expandHome(filePath));
    if (seen.has(resolvedPath)) return "";
    if (!isEntry && includedPaths.length >= maxFiles) {
      warnings.push(`Skipped referenced instructions file ${resolvedPath}: include limit reached.`);
      return "";
    }

    seen.add(resolvedPath);
    let content = await readBoundedTextFile(resolvedPath, maxBytesPerFile);
    if (!isEntry) includedPaths.push(resolvedPath);
    if (depth >= maxDepth) return content;

    const references = extractReferencedMarkdownPaths(content);
    const inlinedSections: string[] = [];
    for (const reference of references) {
      const candidatePath = path.isAbsolute(expandHome(reference))
        ? expandHome(reference)
        : path.resolve(path.dirname(resolvedPath), reference);
      const candidate = path.resolve(candidatePath);
      if (candidate === resolvedPath || seen.has(candidate)) continue;
      // [SIZE GATE] 큰 참조 파일은 inline하지 않고 경로만 남긴다(agentic 어댑터가 on-demand 읽기).
      // 작성자의 "read `<path>`" 지시가 이미 instructions 에 있으므로 경로는 그대로 에이전트에게 유효하다.
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile() && stat.size > inlineMaxBytes) {
          deferredPaths.push(candidate);
          warnings.push(
            `Left referenced instructions as path for on-demand read: ${candidate} (${stat.size} bytes > inline limit ${inlineMaxBytes}).`,
          );
          continue;
        }
      } catch {
        // stat 실패 시 아래 loadFile 경로에서 더 명확한 에러로 처리됨.
      }
      try {
        const nested = await loadFile(candidate, depth + 1, false);
        if (!nested.trim()) continue;
        inlinedSections.push([
          "---",
          "",
          `## Inlined Referenced Instructions: ${candidate}`,
          "",
          nested,
        ].join("\n"));
      } catch (err) {
        warnings.push(
          `Skipped referenced instructions file ${candidate}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (inlinedSections.length > 0) {
      content = [content, ...inlinedSections].join("\n\n");
    }
    return content;
  }

  const content = await loadFile(resolvedEntryPath, 0, true);
  return {
    entryPath: resolvedEntryPath,
    content,
    includedPaths,
    deferredPaths,
    warnings,
  };
}
