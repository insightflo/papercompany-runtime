import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { badRequest } from "../errors.js";
import type { DataObjectMeta } from "./company-data-objects.js";

export const LOCAL_DATA_SUBDIR = "company-data";
const UUID_SEGMENT = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export type LocalDirent = { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };

export type LocalStat = { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtime: Date };

export type LocalFsAdapter = {
  mkdir: (dir: string, opts?: { recursive?: boolean }) => Promise<void>;
  writeFile: (filePath: string, body: Buffer) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  stat: (filePath: string) => Promise<LocalStat | null>;
  lstat: (filePath: string) => Promise<LocalStat | null>;
  realpath: (filePath: string) => Promise<string>;
  createReadStream: (filePath: string) => Readable;
  readdir: (dir: string, opts?: { withFileTypes?: boolean }) => Promise<LocalDirent[]>;
};

function contentTypeFor(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case ".json": return "application/json";
    case ".md": return "text/markdown; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".csv": return "text/csv; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

export function isWithin(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  const rel = path.relative(p, c);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolveWithin(baseDir: string, objectKey: string): string {
  const normalizedKey = objectKey.replace(/\\/g, "/").trim();
  if (!normalizedKey || normalizedKey.startsWith("/")) {
    throw badRequest("Invalid object key");
  }
  const parts = normalizedKey.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw badRequest("Invalid object key");
  }
  const resolved = path.resolve(baseDir, parts.join("/"));
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw badRequest("Invalid object key path");
  }
  return resolved;
}

export function localCompanyDir(localDataRoot: string, companyId: string): string {
  if (!UUID_SEGMENT.test(companyId)) throw badRequest("Invalid company ID");
  const companyDataBase = path.resolve(localDataRoot, LOCAL_DATA_SUBDIR);
  const companyRoot = path.resolve(companyDataBase, companyId);
  if (companyRoot === companyDataBase || !isWithin(companyDataBase, companyRoot)) {
    throw badRequest("Invalid company data root");
  }
  return companyRoot;
}

export async function realpathOrSelf(adapter: LocalFsAdapter, target: string): Promise<string> {
  try {
    return path.resolve(await adapter.realpath(target));
  } catch {
    return path.resolve(target);
  }
}

/**
 * Reject planted symlinks and any existing ancestry segment whose real path
 * escapes the real company root. Lexical containment is already enforced by
 * `resolveWithin`; this guard defeats symlink traversal, since `stat` follows
 * links and an ancestor directory could be redirected outside the root.
 */
export async function assertSafeTarget(
  adapter: LocalFsAdapter,
  lexicalRoot: string,
  realRoot: string,
  lexicalTarget: string,
): Promise<void> {
  const root = path.resolve(lexicalRoot);
  const realBound = path.resolve(realRoot);
  let current = path.resolve(lexicalTarget);
  if (!isWithin(root, current)) throw badRequest("Invalid object key path");

  while (true) {
    const lstat = await adapter.lstat(current);
    if (lstat) {
      if (lstat.isSymbolicLink()) throw badRequest("Invalid object key path");
      const real = path.resolve(await adapter.realpath(current));
      if (!isWithin(realBound, real)) throw badRequest("Invalid object key path");
    }
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current || !isWithin(root, parent)) {
      throw badRequest("Invalid object key path");
    }
    current = parent;
  }
}

export function createDefaultLocalFs(): LocalFsAdapter {
  return {
    mkdir: async (dir, opts) => {
      await fs.mkdir(dir, opts);
    },
    writeFile: (filePath, body) => fs.writeFile(filePath, body),
    rename: (from, to) => fs.rename(from, to),
    stat: async (filePath) => {
      try {
        const s = await fs.stat(filePath);
        return { isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), isSymbolicLink: () => s.isSymbolicLink(), size: s.size, mtime: s.mtime };
      } catch {
        return null;
      }
    },
    lstat: async (filePath) => {
      try {
        const s = await fs.lstat(filePath);
        return { isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), isSymbolicLink: () => s.isSymbolicLink(), size: s.size, mtime: s.mtime };
      } catch {
        return null;
      }
    },
    realpath: (filePath) => fs.realpath(filePath),
    createReadStream: (filePath) => createReadStream(filePath),
    readdir: async (dir) => fs.readdir(dir, { withFileTypes: true }) as unknown as LocalDirent[],
  };
}

/** Recursively list regular files under a local company directory, capped at `limit`. */
export async function walkLocalTree(
  adapter: LocalFsAdapter,
  root: string,
  relBase: string,
  limit: number,
): Promise<DataObjectMeta[]> {
  const results: DataObjectMeta[] = [];
  let dirs: string[] = [relBase || "."];
  while (dirs.length > 0 && results.length < limit) {
    const current = dirs.shift()!;
    const dirPath = current === "." ? root : path.join(root, current);
    let entries: LocalDirent[];
    try {
      entries = await adapter.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      // Never follow symlinks while listing — only descend real directories.
      if (entry.isSymbolicLink()) continue;
      const rel = current === "." ? entry.name : `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        dirs.push(rel);
      } else if (entry.isFile()) {
        const stat = await adapter.stat(path.join(root, rel));
        if (stat) {
          results.push({
            key: rel,
            size: stat.size,
            contentType: contentTypeFor(entry.name),
            lastModified: stat.mtime.toISOString(),
          });
        }
      }
    }
  }
  return results;
}
