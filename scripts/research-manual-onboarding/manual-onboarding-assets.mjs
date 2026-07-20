import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const CONTENT_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

export function contentTypeForPath(path) {
  return CONTENT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream";
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Asset directory must not contain symlinks: ${path}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files;
}

export async function stageSourceAssets(sourceAssetDir, destinationDetailDir) {
  const source = resolve(sourceAssetDir);
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`sourceAssetDir must be a real directory: ${source}`);
  }
  const files = (await listFiles(source)).sort();
  const destination = join(resolve(destinationDetailDir), "assets");
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, dereference: false });
  return files.map((file) => join("assets", file));
}
