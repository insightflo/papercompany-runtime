import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { workflowQaRemediationsSchema } from "@paperclipai/shared";
import { captureArtifactRoot, readArtifactBytes } from "../services/workflow/artifact-files.js";
import { createArtifactDirectory } from "../services/workflow/artifact-writer.js";
import { readHtmlBundle } from "../services/workflow/qa-html-input.js";
import { patchQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-patch.js";

type Source = Parameters<typeof patchQaCorrectionSources>[0][number];
type Patched = ReturnType<typeof patchQaCorrectionSources>;
type File = Source["files"][number];
type Entry = { fileName: string; sha256: string; byteSize: number };
type Manifest = {
  schemaVersion: string; htmlSha256: string; assets: Entry[];
  ancillary: (Entry & { role: string })[];
};
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const readManifest = (bytes: Buffer): Manifest => JSON.parse(bytes.toString("utf8"));
const entry = (fileName: string, bytes: Buffer): Entry => ({
  fileName, sha256: sha(bytes), byteSize: bytes.length,
});
const document = (main: Buffer, assets: Manifest["assets"] = [], ancillary: Manifest["ancillary"] = []) =>
  Buffer.from(JSON.stringify({ schemaVersion: "patch.v1", htmlSha256: sha(main), assets, ancillary }, null, 2) + "\n");
const structure = (m: Manifest) => ({
  schemaVersion: m.schemaVersion, assets: m.assets.map(a => a.fileName),
  ancillary: m.ancillary.map(a => ({ fileName: a.fileName, role: a.role })),
});
const snapshot = (sources: Source[]) => sources.map(s => ({
  ...s, root: { ...s.root }, files: s.files.map(f => ({ ...f, bytes: Buffer.from(f.bytes) })),
}));

function fixture(role: "ancillary" | "main" | "asset", rootPath = "/qa-patch") {
  const root = { path: rootPath, dev: 1, ino: 1 };
  const innerRoot = role === "asset" ? path.join(rootPath, "assets") : rootPath;
  const file = (base: string, relativePath: string, role: File["role"], bytes: Buffer,
    ancillaryRole?: string): File => ({
    relativePath, role, bytes, sourcePath: path.join(base, relativePath),
    sha256: sha(bytes), byteSize: bytes.length, ...(ancillaryRole ? { ancillaryRole } : {}),
  });
  const main = file(innerRoot, "first.html", "main", Buffer.from("<p>seed one</p>\n"));
  const assets = [
    file(innerRoot, "assets/z.dat", "asset", Buffer.from([0, 255, 7])),
    file(innerRoot, "assets/a.dat", "asset", Buffer.from("unchanged asset")),
  ];
  const notes = [
    file(innerRoot, "z.txt", "ancillary", Buffer.from("unchanged z"), "last-note"),
    file(innerRoot, "a.txt", "ancillary", Buffer.from("unchanged a"), "first-note"),
  ];
  const inner = file(innerRoot, "inner.json", "ancillary", document(main.bytes,
    assets.map(a => entry(path.basename(a.relativePath), a.bytes)),
    notes.map(a => ({ ...entry(a.relativePath, a.bytes), role: a.ancillaryRole! }))));
  const outerMain = role === "main"
    ? { ...inner, role: "main" as const }
    : file(rootPath, "second.html", "main", Buffer.from("<p>seed two</p>\n"));
  const shared: File = { ...inner, role, relativePath: role === "asset" ? "assets/inner.json" : "inner.json",
    ...(role === "ancillary" ? { ancillaryRole: "nested" } : {}) };
  const outer = file(rootPath, "outer.json", "ancillary", document(outerMain.bytes,
    role === "asset" ? [entry("inner.json", inner.bytes)] : [],
    role === "ancillary" ? [{ ...entry("inner.json", inner.bytes), role: "nested" }] : []));
  const sources: Source[] = [
    { productId: "inner", root, mainRelativePath: main.relativePath, assetsRoot: null,
      files: [main, ...assets, ...notes, inner] },
    { productId: "outer", root, mainRelativePath: outerMain.relativePath, assetsRoot: null,
      files: role === "main" ? [outerMain, outer] : [outerMain, shared, outer] },
  ];
  const layouts = sources.map(s => ({ productId: s.productId, assetsRelativeRoot: "assets",
    bundleManifestRelativePath: s.productId + ".json" }));
  const remediations = workflowQaRemediationsSchema.parse({ items: [
    { op: "string_replace", file: main.sourcePath, find: "seed one", replace: "seed one updated" },
    ...(role === "main" ? [] : [
      { op: "string_replace", file: outerMain.sourcePath, find: "seed two", replace: "seed two updated" },
    ]),
  ] });
  return { sources, layouts, remediations };
}

// C03 expectation source: qa-html-input.ts compares declarations with real referenced bytes.
function checkFinal(f: ReturnType<typeof fixture>, patched: Patched) {
  expect(patched.map(s => s.sourceProductId)).toEqual(f.sources.map(s => s.productId));
  for (const output of patched) {
    const source = f.sources.find(s => s.productId === output.sourceProductId)!;
    expect(output.mainRelativePath).toBe(source.mainRelativePath);
    expect(output.files.map(({ relativePath, role }) => ({ relativePath, role })))
      .toEqual(source.files.map(({ relativePath, role }) => ({ relativePath, role })));
    for (const [i, actual] of output.files.entries()) {
      const original = source.files[i]!;
      expect(actual.beforeSha256).toBe(sha(original.bytes));
      expect(actual.sha256).toBe(sha(actual.bytes));
      expect(actual.byteSize).toBe(actual.bytes.length);
      if (!["first.html", "second.html", "inner.json", "outer.json", "assets/inner.json"].includes(actual.relativePath)) {
        expect(actual.bytes).toEqual(original.bytes);
      }
    }
    const byPath = (name: string) => output.files.find(file => file.relativePath === name)!.bytes;
    const layout = f.layouts.find(l => l.productId === source.productId)!;
    const manifest = readManifest(byPath(layout.bundleManifestRelativePath));
    const original = readManifest(source.files.find(file => file.relativePath === layout.bundleManifestRelativePath)!.bytes);
    expect(structure(manifest)).toEqual(structure(original));
    expect(manifest.htmlSha256).toBe(sha(byPath(source.mainRelativePath)));
    for (const e of manifest.assets) expect(e).toEqual(entry(e.fileName, byPath("assets/" + e.fileName)));
    for (const e of manifest.ancillary) expect(e).toEqual({ ...entry(e.fileName, byPath(e.fileName)), role: e.role });
  }
  const inner = patched.find(s => s.sourceProductId === "inner")!;
  expect(inner.files.find(file => file.role === "main")!.bytes).toEqual(Buffer.from("<p>seed one updated</p>\n"));
  const innerManifest = inner.files.find(file => file.relativePath === "inner.json")!.bytes;
  const outer = patched.find(s => s.sourceProductId === "outer")!;
  expect(outer.files.find(file => file.relativePath.endsWith("inner.json"))!.bytes).toEqual(innerManifest);
  const second = outer.files.find(file => file.relativePath === "second.html");
  if (second) expect(second.bytes).toEqual(Buffer.from("<p>seed two updated</p>\n"));
}

function plain(bytes: Buffer) {
  const root = { path: "/qa-patch", dev: 1, ino: 1 };
  const sources: Source[] = [{ productId: "plain", root, mainRelativePath: "plain.txt", assetsRoot: null,
    files: [{ role: "main", relativePath: "plain.txt", sourcePath: path.join(root.path, "plain.txt"),
      bytes, sha256: sha(bytes), byteSize: bytes.length }] }];
  return { sources, layouts: [{ productId: "plain", bundleManifestRelativePath: null, assetsRelativeRoot: null }] };
}

async function ownedDirectory() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-patch-")));
  onTestFinished(async () => {
    const unlock = async (dir: string): Promise<void> => {
      await chmod(dir, 0o700);
      for (const child of await readdir(dir, { withFileTypes: true })) {
        if (child.isDirectory()) await unlock(path.join(dir, child.name));
      }
    };
    await unlock(root);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

describe("C03 final bytes of shared manifests", () => {
  it.each([false, true])("writes reader-valid ancillary bundles, reverse=%s", async reverse => {
    const owned = await ownedDirectory(), input = path.join(owned, "A");
    const f = fixture("ancillary", input), before = snapshot(f.sources);
    const unique = new Map(f.sources.flatMap(s => s.files).map(file => [file.sourcePath, file.bytes]));
    for (const [target, bytes] of unique) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    const aRoot = await captureArtifactRoot(input), destination = await captureArtifactRoot(owned);
    const config = (id: string) => ({ fileName: id + ".json", schemaVersion: "patch.v1",
      ancillaryRoles: id === "inner" ? ["last-note", "first-note"] : ["nested"] });
    for (const source of f.sources) {
      await readHtmlBundle(aRoot, path.join(input, source.mainRelativePath), source.files[0]!.bytes,
        path.join(input, source.productId + ".json"), config(source.productId));
    }
    const ordered = { ...f, sources: reverse ? [...f.sources].reverse() : f.sources };
    const patched = patchQaCorrectionSources(ordered.sources, [f.remediations], [...f.layouts].reverse());
    checkFinal(ordered, patched);
    for (const source of patched) {
      const bRoot = await createArtifactDirectory(destination, source.sourceProductId,
        source.files.map(file => ({ relative: file.relativePath, bytes: file.bytes })), [".", "assets"]);
      const files = new Map<string, Buffer>();
      for (const file of source.files) {
        const bytes = await readArtifactBytes(bRoot, file.relativePath, 1024 * 1024);
        expect(bytes).toEqual(file.bytes);
        files.set(file.relativePath, bytes);
      }
      const main = files.get(source.mainRelativePath)!;
      await expect(readHtmlBundle(bRoot, path.join(bRoot.path, source.mainRelativePath), main,
        path.join(bRoot.path, source.sourceProductId + ".json"), config(source.sourceProductId))).resolves.toBeDefined();
      if (source.sourceProductId === "outer") {
        const manifest = readManifest(files.get("outer.json")!);
        expect(manifest.ancillary[0]).toEqual({ ...entry("inner.json", files.get("inner.json")!), role: "nested" });
      }
    }
    expect(f.sources).toEqual(before);
    for (const [target, bytes] of unique) expect(await readFile(target)).toEqual(bytes);
  });

  it.each([
    ["main", false], ["main", true], ["asset", false], ["asset", true],
  ] as const)("hashes a generated manifest used as %s, reverse=%s", (role, reverse) => {
    const f = fixture(role), before = snapshot(f.sources);
    if (reverse) f.sources.reverse();
    const orderedBefore = snapshot(f.sources);
    checkFinal(f, patchQaCorrectionSources(f.sources, [f.remediations], f.layouts));
    expect(f.sources).toEqual(orderedBefore);
    expect(reverse ? [...f.sources].reverse() : f.sources).toEqual(before);
  });

  it.each([false, true])("accepts compatible layouts and patches shared physical files once, reverse=%s", reverse => {
    const f = fixture("ancillary");
    f.sources.push({ ...f.sources[0]!, productId: "shared" });
    f.layouts.push({ ...f.layouts[0]!, productId: "shared" });
    if (reverse) f.sources.reverse();
    const before = snapshot(f.sources);
    const patched = patchQaCorrectionSources(f.sources, [f.remediations], f.layouts);
    checkFinal(f, patched);
    expect(patched.find(s => s.sourceProductId === "shared")!.files)
      .toEqual(patched.find(s => s.sourceProductId === "inner")!.files);
    expect(f.sources).toEqual(before);
  });

  it.each([false, true])("rejects incompatible final requirements for one physical manifest, reverse=%s", reverse => {
    const f = fixture("ancillary"), original = f.sources[0]!;
    const files = original.files.map(file => file.role === "main"
      ? { ...file, relativePath: "alternate.html", sourcePath: path.join(original.root.path, "alternate.html") } : file);
    f.sources.push({ ...original, productId: "conflict", mainRelativePath: "alternate.html", files });
    f.layouts.push({ ...f.layouts[0]!, productId: "conflict" });
    if (reverse) f.sources.reverse();
    const before = snapshot(f.sources);
    expect(() => patchQaCorrectionSources(f.sources, [f.remediations], f.layouts)).toThrow("qa_correction_source");
    expect(f.sources).toEqual(before);
  });

  it("preserves ordered replacements", () => {
    const f = fixture("ancillary"), first = f.sources[0]!.files[0]!;
    const next = workflowQaRemediationsSchema.parse({ items: [
      { op: "string_replace", file: first.sourcePath, find: "seed one updated", replace: "done" },
    ] });
    const patched = patchQaCorrectionSources(f.sources, [f.remediations, next], f.layouts);
    expect(patched[0]!.files[0]!.bytes).toEqual(Buffer.from("<p>done</p>\n"));
  });

  it("rejects an initially oversized target even when the replacement would shrink it", () => {
    const f = plain(Buffer.from("seed" + "x".repeat(2 * 1024 * 1024))), before = snapshot(f.sources);
    const remediation = workflowQaRemediationsSchema.parse({ items: [
      { op: "string_replace", file: f.sources[0]!.files[0]!.sourcePath, find: "seed", replace: "" },
    ] });
    expect(() => patchQaCorrectionSources(f.sources, [remediation], f.layouts)).toThrow("qa_correction_source");
    expect(f.sources).toEqual(before);
  });

  it.each(["absent", "seed seed"])("still rejects a replacement with no unique match: %s", text => {
    const f = plain(Buffer.from(text === "absent" ? "seed" : text)), before = snapshot(f.sources);
    const remediation = workflowQaRemediationsSchema.parse({ items: [
      { op: "string_replace", file: f.sources[0]!.files[0]!.sourcePath,
        find: text === "absent" ? "absent" : "seed", replace: "new" },
    ] });
    expect(() => patchQaCorrectionSources(f.sources, [remediation], f.layouts)).toThrow("qa_correction_source");
    expect(f.sources).toEqual(before);
  });
});
