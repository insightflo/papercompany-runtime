import fs from "node:fs/promises";
import path from "node:path";

export type LoadedInstructionsWithReferences = {
  entryPath: string;
  content: string;
  includedPaths: string[];
  warnings: string[];
};

type LoadOptions = {
  maxDepth?: number;
  maxFiles?: number;
  maxBytesPerFile?: number;
};

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_BYTES_PER_FILE = 512 * 1024;
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
  const resolvedEntryPath = path.resolve(entryPath);
  const seen = new Set<string>();
  const includedPaths: string[] = [];
  const warnings: string[] = [];

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
    warnings,
  };
}
