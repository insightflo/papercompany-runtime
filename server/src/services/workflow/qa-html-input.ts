import path from "node:path";
import { z } from "zod";
import { artifactContractSchema, type ArtifactContract } from "@paperclipai/shared";
import { assetDigestSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { digest, readArtifactBytes, type ArtifactRoot } from "./artifact-files.js";

const name = z.string().max(512).refine(s => s.split("/").every(p => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(p) && ![".", ".."].includes(p)));
const asset = assetDigestSchema.extend({ fileName: name });
const schema = z.object({ schemaVersion: z.string().min(1),
  htmlSha256: z.string().regex(/^[a-f0-9]{64}$/), assets: z.array(asset).max(256),
  ancillary: z.array(asset.extend({ role: name })).max(100),
}).strict();

/** Explicit source-bound manifest; no sibling discovery, directory crawling or unsafe reopening. */
export async function readHtmlBundle(root: ArtifactRoot, source: string, html: Buffer, manifestPath: unknown,
  config?: ArtifactContract["bundleManifest"]) {
  const declared = artifactContractSchema.innerType().shape.bundleManifest.parse(config);
  if (!declared || typeof manifestPath !== "string" || manifestPath !== path.join(path.dirname(source), declared.fileName)) {
    throw new Error("qa_artifact_html_asset_contract_unavailable");
  }
  const manifestBytes = await readArtifactBytes(root, path.relative(root.path, manifestPath), 1024 * 1024);
  const manifest = schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)));
  if ((declared.schemaVersion && manifest.schemaVersion !== declared.schemaVersion)
    || manifest.ancillary.some(a => !declared.ancillaryRoles.includes(a.role))) throw new Error("qa_artifact_html_manifest_contract_mismatch");
  if (manifest.htmlSha256 !== digest(html)) throw new Error("qa_artifact_html_digest_mismatch");
  if (new Set(manifest.assets.map(a => a.fileName)).size !== manifest.assets.length
    || new Set(manifest.ancillary.map(a => a.role)).size !== manifest.ancillary.length
    || new Set(manifest.ancillary.map(a => a.fileName)).size !== manifest.ancillary.length) throw new Error("qa_artifact_html_manifest_duplicate");
  let total = html.length + manifestBytes.length;
  const read = async (entry: z.infer<typeof asset>, dir: string) => {
    const bytes = await readArtifactBytes(root, path.relative(root.path, path.join(dir, entry.fileName)), dir.endsWith("/assets") ? 16 * 1024 * 1024 : 1024 * 1024);
    total += bytes.length;
    if (total > 40 * 1024 * 1024) throw new Error("qa_input_transport_too_large");
    if (digest(bytes) !== entry.sha256 || bytes.length !== entry.byteSize) throw new Error("qa_artifact_html_digest_mismatch");
    return { fileName: entry.fileName, sha256: entry.sha256, byteSize: entry.byteSize, bytes };
  };
  const assets = [], ancillary = [];
  for (const entry of manifest.assets) assets.push(await read(entry, path.join(path.dirname(source), "assets")));
  for (const entry of manifest.ancillary) ancillary.push({ ...await read(entry, path.dirname(source)), fileName: entry.role });
  return { assets, ancillary, manifest: { path: manifestPath, sha256: digest(manifestBytes), byteSize: manifestBytes.length } };
}
