import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { artifactRelativePathSchema, type WorkflowQaRemediations } from "@paperclipai/shared";
import { assetDigestSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { digest } from "../artifact-files.js";
import { requireQaCorrection } from "./qa-correction-authority.js";
import { QA_REMEDIATION_MAX_FILE_BYTES } from "./qa-remediation-contract.js";
import type { QaCorrectionSourceBytes } from "./qa-correction-source-bytes.js";
import type { QaCorrectionApplied } from "./qa-correction-contract.js";

export type QaCorrectionProductLayout = {
  productId: string; bundleManifestRelativePath: string | null; assetsRelativeRoot: string | null;
};
export type QaCorrectionPatchedSource = {
  sourceProductId: string; mainRelativePath: string;
  files: (QaCorrectionApplied["revisions"][number]["files"][number] & { bytes: Buffer })[];
};
const name = z.string().max(512).refine(s => s.split("/").every(p =>
  /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(p) && ![".", ".."].includes(p)));
const asset = assetDigestSchema.extend({ fileName: name });
const manifestSchema = z.object({
  schemaVersion: z.string().min(1), htmlSha256: z.string().regex(/^[a-f0-9]{64}$/),
  assets: z.array(asset).max(256), ancillary: z.array(asset.extend({ role: name })).max(100),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const parseManifest = (bytes: Buffer) => manifestSchema.parse(JSON.parse(decode(bytes)));
const structure = (m: Manifest) => ({
  schemaVersion: m.schemaVersion, assets: m.assets.map(a => a.fileName),
  ancillary: m.ancillary.map(a => ({ role: a.role, fileName: a.fileName })),
});

/** C03/C12: only held, measured bytes enter this pure, ordered correction. No reads or issuance. */
export function patchQaCorrectionSources(sources: readonly QaCorrectionSourceBytes[],
  remediations: readonly WorkflowQaRemediations[], productLayouts: readonly QaCorrectionProductLayout[]): QaCorrectionPatchedSource[] {
  requireQaCorrection(sources.length === productLayouts.length
    && new Set(sources.map(s => s.productId)).size === sources.length
    && new Set(productLayouts.map(s => s.productId)).size === sources.length, "source");
  const held = new Map<string, { original: Buffer; bytes: Buffer }>();
  for (const source of sources) {
    requireQaCorrection(new Set(source.files.map(f => f.relativePath)).size === source.files.length, "source");
    for (const file of source.files) {
      artifactRelativePathSchema.parse(file.relativePath);
      requireQaCorrection(path.isAbsolute(file.sourcePath) && path.resolve(file.sourcePath) === file.sourcePath
        && file.sha256 === digest(file.bytes) && file.byteSize === file.bytes.length, "source");
      const previous = held.get(file.sourcePath);
      requireQaCorrection(!previous || previous.original.equals(file.bytes), "source");
      if (!previous) held.set(file.sourcePath, { original: Buffer.from(file.bytes), bytes: Buffer.from(file.bytes) });
    }
  }
  for (const remediation of remediations) for (const item of remediation.items) {
    requireQaCorrection(item.op === "string_replace" && path.isAbsolute(item.file) && item.find.length > 0, "source");
    const file = held.get(path.resolve(item.file));
    requireQaCorrection(file && file.original.length <= QA_REMEDIATION_MAX_FILE_BYTES, "source");
    const text = decode(file.bytes), first = text.indexOf(item.find);
    requireQaCorrection(first !== -1 && text.indexOf(item.find, first + 1) === -1, "source");
    file.bytes = Buffer.from(text.slice(0, first) + item.replace + text.slice(first + item.find.length));
  }
  const generated = new Map<string, Buffer>();
  for (const source of sources) {
    const layout = productLayouts.find(l => l.productId === source.productId);
    requireQaCorrection(layout, "source");
    if (layout.assetsRelativeRoot !== null) artifactRelativePathSchema.parse(layout.assetsRelativeRoot);
    requireQaCorrection(source.files.every(f => f.role !== "asset"
      || (layout.assetsRelativeRoot !== null && f.relativePath.startsWith(layout.assetsRelativeRoot + "/"))), "source");
    if (layout.bundleManifestRelativePath === null) continue;
    artifactRelativePathSchema.parse(layout.bundleManifestRelativePath);
    const manifest = source.files.find(f => f.relativePath === layout.bundleManifestRelativePath);
    const main = source.files.find(f => f.role === "main" && f.relativePath === source.mainRelativePath);
    requireQaCorrection(manifest?.role === "ancillary" && main && layout.assetsRelativeRoot !== null, "source");
    const original = parseManifest(manifest.bytes), changed = parseManifest(held.get(manifest.sourcePath)!.bytes);
    // Direct edits may change values, but never the authoritative file/role references or their order.
    requireQaCorrection(isDeepStrictEqual(structure(original), structure(changed))
      && original.htmlSha256 === main.sha256
      && new Set(original.assets.map(a => a.fileName)).size === original.assets.length
      && new Set(original.ancillary.map(a => a.fileName)).size === original.ancillary.length
      && new Set(original.ancillary.map(a => a.role)).size === original.ancillary.length, "source");
    const referenced = [main.relativePath, manifest.relativePath];
    const update = (entry: z.infer<typeof asset>, relativePath: string, role: "asset" | "ancillary", alias?: string) => {
      const file = source.files.find(f => f.relativePath === relativePath && f.role === role);
      requireQaCorrection(file && file.sha256 === entry.sha256 && file.byteSize === entry.byteSize
        && (file.ancillaryRole === undefined || file.ancillaryRole === alias), "source");
      referenced.push(relativePath);
      const bytes = held.get(file.sourcePath)!.bytes;
      return { ...entry, sha256: digest(bytes), byteSize: bytes.length };
    };
    const assets = original.assets.map(a => update(a, layout.assetsRelativeRoot + "/" + a.fileName, "asset"));
    const ancillary = original.ancillary.map(a => ({
      ...update(a, a.fileName, "ancillary", a.role), role: a.role,
    }));
    requireQaCorrection(referenced.length === source.files.length
      && new Set(referenced).size === referenced.length, "source");
    const bytes = Buffer.from(JSON.stringify({ ...changed, htmlSha256: digest(held.get(main.sourcePath)!.bytes),
      assets, ancillary }));
    const previous = generated.get(manifest.sourcePath);
    requireQaCorrection(!previous || previous.equals(bytes), "source");
    generated.set(manifest.sourcePath, bytes);
  }
  return sources.map(source => ({ sourceProductId: source.productId, mainRelativePath: source.mainRelativePath,
    files: source.files.map(file => {
      const bytes = Buffer.from(generated.get(file.sourcePath) ?? held.get(file.sourcePath)!.bytes);
      return { role: file.role, relativePath: file.relativePath, bytes,
        beforeSha256: file.sha256, sha256: digest(bytes), byteSize: bytes.length };
    }) }));
}
