import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { artifactContractSchema, selectArtifactValues, type ArtifactContract, type ArtifactPublicationConfig } from "@paperclipai/shared";
import { assetDigestSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { captureArtifactRoot, digest, readArtifactBytes, type ArtifactRoot } from "./artifact-files.js";
import { isPathInsideOrEqual } from "../work-products/output-paths.js";
import { writeArtifactFile } from "./artifact-writer.js";
import { readbackPublicUrl } from '../public-url-readback.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/), count = z.number().int().nonnegative();
const scopeSchema = z.object({ companyId: z.string().uuid(), missionId: z.string().uuid(),
  workflowRunId: z.string().uuid(), stepRunId: z.string().uuid(), stepId: z.string().min(1),
  requestId: z.string().min(1), executionGeneration: count, retryCount: count, iterationIndex: count }).strict();
export type PublicationScope = z.infer<typeof scopeSchema>;
export const publicationResultSchema = z.object({ schemaVersion: z.literal("workflow.publication-result.v1"),
  ok: z.literal(true), command: z.string().min(1), mode: z.enum(["content", "html"]),
  section: z.string().min(1), id: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), scope: scopeSchema,
  title: z.string().min(1).nullable(), publishedAt: z.string(), publicUrl: z.string().url(),
  inputDigest: z.object({ mode: z.enum(["content", "html"]), sha256: hash, qaSha256: hash,
    assetManifest: z.array(assetDigestSchema), ancillaryManifest: z.array(assetDigestSchema).optional() }).strict(),
  cms: z.object({ ok: z.literal(true), audience: z.string().min(1), contentId: z.string().min(1),
    slug: z.string().min(1), publicUrl: z.string().url(), liveStatus: z.literal(200), blocks: count, assets: count,
    commandKey: z.string().min(1), contentHash: hash, contentBytes: z.number().int().positive() }).strict(),
}).strict();
const valueAt = (raw: unknown, pointer: string) => {
  const values = selectArtifactValues(raw, [pointer]);
  if (values.length !== 1) throw new Error("qa_publish_result_schema_invalid");
  return values[0];
};

export function adaptPublication(raw: unknown, contract: ArtifactContract) {
  const invalid = () => { throw new Error("qa_publish_result_schema_invalid"); };
  if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).schemaVersion !== contract.resultSchemaVersion) return invalid();
  if (contract.resultAdapter === 'generic') return publicationResultSchema.parse(raw);
  const mapping = contract.publication?.legacyMapping;
  if (contract.resultAdapter !== 'legacy-publication' || !mapping) return invalid();
  const fields = Object.fromEntries(Object.entries(mapping.fields).map(([key, pointer]) => [key, valueAt(raw, pointer)]));
  const mode = fields.mode === mapping.htmlMode ? 'html' : fields.mode === mapping.contentMode ? 'content' : invalid();
  const pointers = ['/schemaVersion', ...Object.values(mapping.fields), mapping.qaDigest, mapping.assets,
    mode === 'html' ? mapping.htmlDigest : mapping.contentDigest, ...(mode === 'html' ? [mapping.ancillary] : [])];
  // Legacy dialects are closed too: unconfigured fields cannot carry hidden authority or claimed paths.
  const assertMapped = (value: unknown, pointer: string): void => {
    if (pointers.includes(pointer)) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    for (const [key, child] of Object.entries(value)) {
      const next = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!pointers.some(p => p === next || p.startsWith(`${next}/`))) return invalid();
      assertMapped(child, next);
    }
  };
  assertMapped(raw, '');
  return publicationResultSchema.parse({ ...fields, schemaVersion: 'workflow.publication-result.v1', mode,
    inputDigest: { mode, sha256: valueAt(raw, mode === 'html' ? mapping.htmlDigest : mapping.contentDigest),
      qaSha256: valueAt(raw, mapping.qaDigest), assetManifest: valueAt(raw, mapping.assets),
      ...(mode === 'html' ? { ancillaryManifest: valueAt(raw, mapping.ancillary) } : {}) } });
}

/** Derive identity from independent run-scoped bytes, never the producer's claimed identity. */
export async function expectedPublicationId(parameters: Record<string, unknown>, runOutputDir: string | null | undefined,
  config: ArtifactPublicationConfig['identity']) {
  if (!config) return undefined;
  const explicit = config.param ? parameters[config.param] : undefined;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const sourcePath = config.sourcePathParam ? parameters[config.sourcePathParam] : undefined;
  const field = config.sourceFieldParam ? parameters[config.sourceFieldParam] : undefined;
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
  for (const key of field.split(".")) value = value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
  const slug = typeof value === "string" ? value.trim() : "";
  if (config.format === 'literal') { if (!slug) throw invalid(); return slug; }
  if (config.format !== 'date-prefixed-slug' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw invalid();
  if (/^\d{8}-/.test(slug)) return slug;
  const date = config.dateParam ? parameters[config.dateParam] : undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof date === "string" ? date : "");
  if (!match) throw invalid();
  return `${match[1]}${match[2]}${match[3]}-${slug}`;
}

/** Only versioned machine-channel data is accepted; return original dialect for compatibility. */
export async function verifyPublicationResult(input: { bytes?: Buffer; root: ArtifactRoot; contract: ArtifactContract;
  scope: PublicationScope; inputBytes: Buffer; parameters: Record<string, unknown>; runOutputDir?: string | null;
  sourcePublication?: unknown }) {
  const contract = artifactContractSchema.parse(input.contract), config = contract.publication;
  const verifying = contract.role === 'publication-verify';
  const source = input.sourcePublication === undefined ? undefined : publicationResultSchema.parse(input.sourcePublication);
  if ((!verifying && contract.role !== 'publication') || !config?.command || !config.commandKeySeparator
    || (verifying ? !source : !config.identity || !config.audience)) throw new Error('qa_publish_result_contract_invalid');
  if (!input.bytes?.length) throw new Error("qa_publish_result_transport_missing");
  let raw: unknown;
  try { raw = JSON.parse(input.bytes.toString("utf8")); } catch { throw new Error("qa_publish_result_invalid_json"); }
  let result: z.infer<typeof publicationResultSchema>;
  try { result = adaptPublication(raw, contract); } catch { throw new Error("qa_publish_result_schema_invalid"); }
  const transport = verifying && source ? { mode: source.mode, content: { sha256: source.inputDigest.sha256 },
    qa: { sha256: source.inputDigest.qaSha256 }, assets: source.inputDigest.assetManifest, ancillary: source.inputDigest.ancillaryManifest }
    : JSON.parse(input.inputBytes.toString("utf8"));
  if (!isDeepStrictEqual(result.scope, input.scope)) throw new Error("qa_publish_result_scope_mismatch");
  const assets = (items: { fileName: string; sha256: string; byteSize: number }[]) => items.map(({ fileName, sha256, byteSize }) =>
    ({ fileName, sha256, byteSize })).sort((a, b) => a.fileName.localeCompare(b.fileName));
  const html = result.inputDigest.mode === 'html';
  if (html !== (result.mode === "html") || html !== (transport.mode === "html") || (html ? result.title === null : result.title !== null))
    throw new Error("qa_publish_result_input_mismatch");
  if (html && (!result.inputDigest.ancillaryManifest || !isDeepStrictEqual(assets(result.inputDigest.ancillaryManifest), assets(transport.ancillary))))
    throw new Error("qa_publish_result_input_mismatch");
  if ((!html && result.inputDigest.ancillaryManifest !== undefined) || result.inputDigest.sha256 !== transport.content.sha256
    || result.inputDigest.qaSha256 !== transport.qa.sha256 || !isDeepStrictEqual(assets(result.inputDigest.assetManifest), assets(transport.assets)))
    throw new Error("qa_publish_result_input_mismatch");
  const declaredId = await expectedPublicationId(input.parameters, input.runOutputDir, config.identity);
  const expectedId = verifying ? source!.id : declaredId;
  const prefix = `${result.id}${config.commandKeySeparator}`;
  const audience = config.audience ? (input.parameters[config.audience.parameter] === config.audience.privateValue
    ? config.audience.privateResult : config.audience.defaultResult) : source!.cms.audience;
  if (verifying && (declaredId !== undefined && declaredId !== expectedId || result.date !== source!.date
    || result.section !== source!.section || result.publicUrl !== source!.publicUrl || result.publishedAt !== source!.publishedAt
    || result.title !== source!.title || !isDeepStrictEqual(result.cms, source!.cms))) throw new Error('qa_publish_result_target_mismatch');
  const bindingsOk = (config.bindings ?? []).every(b => b.optional && input.parameters[b.parameter] === undefined
    || isDeepStrictEqual(valueAt(raw, b.resultPointer), input.parameters[b.parameter]));
  const timestamp = config.publishedAt;
  // Timestamp is independently bound to the validated result date, even when the optional argument is absent.
  const timestampOk = !timestamp || valueAt(raw, timestamp.resultPointer) === `${input.parameters[timestamp.dateParam] ?? result.date}${timestamp.suffix}`;
  if (expectedId === undefined || result.id !== expectedId || !bindingsOk || !timestampOk || result.command !== config.command
    || result.publicUrl !== result.cms.publicUrl || result.cms.contentId !== result.id || result.cms.audience !== audience
    || !result.cms.commandKey.startsWith(prefix) || !/^[1-9][0-9]*$/.test(result.cms.commandKey.slice(prefix.length)))
    throw new Error("qa_publish_result_target_mismatch");
  if (contract.readback) {
    const readback = await readbackPublicUrl(result.publicUrl, contract.readback);
    if (!readback.ok) throw new Error(readback.error ?? 'qa_publish_result_readback_failed');
  }
  const relativePath = contract.resultFileName;
  await writeArtifactFile(input.root, relativePath, input.bytes);
  const stored = await readArtifactBytes(input.root, relativePath, 1024 * 1024);
  if (stored.length !== input.bytes.length || digest(stored) !== digest(input.bytes)) throw new Error("qa_publish_result_bytes_changed");
  return { ...(raw as Record<string, unknown>), artifactPath: path.join(input.root.path, relativePath) };
}
