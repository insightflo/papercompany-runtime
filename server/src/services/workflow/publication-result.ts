import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { assetDigestSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { captureArtifactRoot, digest, readArtifactBytes, type ArtifactRoot } from "./artifact-files.js";
import { isPathInsideOrEqual } from "../work-products/output-paths.js";
import { writeArtifactFile } from "./artifact-writer.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const scopeSchema = z.object({ companyId: z.string().uuid(), missionId: z.string().uuid(),
  workflowRunId: z.string().uuid(), stepRunId: z.string().uuid(), stepId: z.string().min(1),
  requestId: z.string().min(1), executionGeneration: count, retryCount: count, iterationIndex: count }).strict();
export type PublicationScope = z.infer<typeof scopeSchema>;
const resultSchema = z.object({ schemaVersion: z.literal("manual-onboarding.publication.v1"),
  ok: z.literal(true), command: z.literal("publish"), mode: z.enum(["content-draft", "html"]),
  section: z.string().min(1), id: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), scope: scopeSchema,
  title: z.string().min(1).nullable(), publishedAtKst: z.string(), publicUrl: z.string().url(),
  input: z.union([
    z.object({ contentSha256: hash, qaSha256: hash, assetManifest: z.array(assetDigestSchema) }).strict(),
    z.object({ htmlSha256: hash, qaSha256: hash, assetManifest: z.array(assetDigestSchema), ancillaryManifest: z.array(assetDigestSchema) }).strict(),
  ]),
  cms: z.object({ ok: z.literal(true), audience: z.enum(["public", "private"]), contentId: z.string().min(1),
    slug: z.string().min(1), publicUrl: z.string().url(), liveStatus: z.literal(200), blocks: count, assets: count,
    commandKey: z.string().min(1), contentHash: hash, contentBytes: z.number().int().positive() }).strict(),
}).strict();

/**
 * Expected publication id, derived by the runtime itself (never from the producer result).
 * Mirrors ops manual-onboarding detail-id-source.mjs deriveDetailId: explicit `id` wins; otherwise read the
 * JSON at `idSourcePath`, take dot-path `idSourceField`, require a lowercase kebab slug, keep an existing
 * YYYYMMDD- prefix or add it from `date`. The source must be a file inside this run's work-product directory
 * and is opened without following symlinks. Every failure is fail-closed.
 */
export async function expectedPublicationId(parameters: Record<string, unknown>, runOutputDir: string | null | undefined) {
  if (typeof parameters.id === "string" && parameters.id.trim()) return parameters.id.trim();
  const sourcePath = parameters.idSourcePath, field = parameters.idSourceField;
  if (typeof sourcePath !== "string" || !sourcePath.trim()) return undefined;
  const invalid = () => new Error("qa_publish_result_id_source_invalid");
  if (!runOutputDir || typeof field !== "string" || !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(field)) throw invalid();
  const resolved = path.resolve(sourcePath.trim()), runDir = path.resolve(runOutputDir);
  if (resolved === runDir || !isPathInsideOrEqual(resolved, runDir)) throw invalid();
  let doc: unknown;
  try {
    const root = await captureArtifactRoot(runDir);
    doc = JSON.parse((await readArtifactBytes(root, path.relative(runDir, resolved).split(path.sep).join("/"), 1024 * 1024)).toString("utf8"));
  } catch { throw invalid(); }
  let value: unknown = doc;
  for (const key of field.split(".")) value = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
  const slug = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw invalid();
  if (/^\d{8}-/.test(slug)) return slug;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof parameters.date === "string" ? parameters.date : "");
  if (!match) throw invalid();
  return `${match[1]}${match[2]}${match[3]}-${slug}`;
}

/** Publication data comes exclusively from the scoped machine channel, never diagnostics. */
export async function verifyPublicationResult(input: { bytes?: Buffer; root: ArtifactRoot;
  scope: PublicationScope; inputBytes: Buffer; parameters: Record<string, unknown>; runOutputDir?: string | null }) {
  if (!input.bytes?.length) throw new Error("qa_publish_result_transport_missing");
  let raw: unknown;
  try { raw = JSON.parse(input.bytes.toString("utf8")); } catch { throw new Error("qa_publish_result_invalid_json"); }
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) throw new Error("qa_publish_result_schema_invalid");
  const result = parsed.data, transport = JSON.parse(input.inputBytes.toString("utf8"));
  if (!isDeepStrictEqual(result.scope, input.scope)) throw new Error("qa_publish_result_scope_mismatch");
  const assets = (items: { fileName: string; sha256: string; byteSize: number }[]) => items.map(({ fileName, sha256, byteSize }) =>
    ({ fileName, sha256, byteSize })).sort((a, b) => a.fileName.localeCompare(b.fileName));
  const html = "htmlSha256" in result.input;
  if (html !== (result.mode === "html") || html !== (transport.mode === "html") || (html ? result.title === null : result.title !== null)) throw new Error("qa_publish_result_input_mismatch");
  if (html && "ancillaryManifest" in result.input && !isDeepStrictEqual(assets(result.input.ancillaryManifest), assets(transport.ancillary))) throw new Error("qa_publish_result_input_mismatch");
  if (("htmlSha256" in result.input ? result.input.htmlSha256 : result.input.contentSha256) !== transport.content.sha256 || result.input.qaSha256 !== transport.qa.sha256
    || !isDeepStrictEqual(assets(result.input.assetManifest), assets(transport.assets))) throw new Error("qa_publish_result_input_mismatch");
  const commandSequence = result.cms.commandKey.slice(result.id.length + 1);
  const expectedId = await expectedPublicationId(input.parameters, input.runOutputDir);
  if (expectedId === undefined || result.id !== expectedId || result.section !== input.parameters.section
    || (input.parameters.date !== undefined && result.date !== input.parameters.date)
    || result.publicUrl !== result.cms.publicUrl || result.publishedAtKst !== `${result.date}T00:00:00+09:00`
    || result.cms.contentId !== result.id || result.cms.audience !== (input.parameters.visibility === "private" ? "private" : "public")
    || !result.cms.commandKey.startsWith(`${result.id}:`) || !/^[1-9][0-9]*$/.test(commandSequence)) {
    throw new Error("qa_publish_result_target_mismatch");
  }
  const relativePath = "manual-onboarding-publish-result.json";
  await writeArtifactFile(input.root, relativePath, input.bytes);
  const stored = await readArtifactBytes(input.root, relativePath, 1024 * 1024);
  if (stored.length !== input.bytes.length || digest(stored) !== digest(input.bytes)) throw new Error("qa_publish_result_bytes_changed");
  // artifactPath is compatibility/display only and is never accepted from the producer.
  return { ...result, artifactPath: path.join(input.root.path, relativePath) };
}
