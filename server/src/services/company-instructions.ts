import fs from "node:fs/promises";
import path from "node:path";
import { unprocessable } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);
const IGNORED_DIRECTORY_NAMES = new Set([".git", ".nox", ".pytest_cache", "__pycache__", "node_modules"]);

function inferLanguage(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  return "text";
}

function isMarkdown(relativePath: string) {
  return relativePath.toLowerCase().endsWith(".md");
}

function normalizeRelativeFilePath(candidatePath: string): string {
  const normalized = path.posix.normalize(candidatePath.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw unprocessable("Company instruction file path must stay within the company instructions root");
  }
  return normalized;
}

function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativeFilePath(relativePath);
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw unprocessable("Company instruction file path must stay within the company instructions root");
  }
  return absolutePath;
}

function shouldIgnoreEntry(entry: { name: string; isDirectory(): boolean; isFile(): boolean }) {
  if (entry.isDirectory()) return IGNORED_DIRECTORY_NAMES.has(entry.name);
  if (!entry.isFile()) return false;
  return IGNORED_FILE_NAMES.has(entry.name) || entry.name.startsWith("._");
}

async function listFilesRecursive(rootPath: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (shouldIgnoreEntry(entry)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = normalizeRelativeFilePath(
        relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name,
      );
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (entry.isFile()) output.push(relativePath);
    }
  }

  await walk(rootPath, "");
  return output.sort((left, right) => left.localeCompare(right));
}

function resolveCompanyInstructionsRoot(companyId: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "companies", companyId, "instructions");
}

async function readSummary(rootPath: string, relativePath: string) {
  const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
  const stat = await fs.stat(absolutePath);
  return {
    path: relativePath,
    size: stat.size,
    language: inferLanguage(relativePath),
    markdown: isMarkdown(relativePath),
    editable: true,
  };
}

export function companyInstructionsService() {
  async function list(companyId: string) {
    const rootPath = resolveCompanyInstructionsRoot(companyId);
    await fs.mkdir(rootPath, { recursive: true });
    const files = await listFilesRecursive(rootPath);
    const summaries = await Promise.all(files.map((relativePath) => readSummary(rootPath, relativePath)));
    return { companyId, rootPath, files: summaries };
  }

  async function readFile(companyId: string, relativePath: string) {
    const rootPath = resolveCompanyInstructionsRoot(companyId);
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    const absolutePath = resolvePathWithinRoot(rootPath, normalizedPath);
    const [content, stat] = await Promise.all([
      fs.readFile(absolutePath, "utf8").catch(() => null),
      fs.stat(absolutePath).catch(() => null),
    ]);
    if (content === null || !stat?.isFile()) return null;
    return {
      path: normalizedPath,
      size: stat.size,
      language: inferLanguage(normalizedPath),
      markdown: isMarkdown(normalizedPath),
      editable: true,
      content,
    };
  }

  async function writeFile(companyId: string, relativePath: string, content: string) {
    const rootPath = resolveCompanyInstructionsRoot(companyId);
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    const absolutePath = resolvePathWithinRoot(rootPath, normalizedPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    const file = await readFile(companyId, normalizedPath);
    if (!file) throw unprocessable("Company instruction file could not be written");
    return file;
  }

  async function deleteFile(companyId: string, relativePath: string) {
    const rootPath = resolveCompanyInstructionsRoot(companyId);
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    const absolutePath = resolvePathWithinRoot(rootPath, normalizedPath);
    await fs.rm(absolutePath, { force: true });
    return { path: normalizedPath };
  }

  return {
    list,
    readFile,
    writeFile,
    deleteFile,
    resolveRoot: resolveCompanyInstructionsRoot,
  };
}
