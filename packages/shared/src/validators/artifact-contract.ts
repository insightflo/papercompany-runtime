import { z } from "zod";
import { jsonPointerSchema, qaConfigSchema } from "./qa-config.js";

export const artifactSchemaVersionSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const artifactRoleSchema = z.enum(["qa", "publication", "publication-verify"]);
export const artifactFileNameSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine(v => v !== "." && v !== "..", "relative basename required");
export const artifactRelativePathSchema = z.string().min(1).max(1000)
  .refine(v => v.split("/").every(part => artifactFileNameSchema.safeParse(part).success), "safe relative path required");
const param = z.string().max(100).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);

/** Declarative publication binding only; values are JSON pointers, never code or regexes. */
export const artifactPublicationConfigSchema = z.object({
  identity: z.object({ param: param.optional(), sourcePathParam: param.optional(), sourceFieldParam: param.optional(),
    format: z.enum(["literal", "date-prefixed-slug"]).optional(), dateParam: param.optional() }).strict().optional(),
  bindings: z.array(z.object({ resultPointer: jsonPointerSchema, parameter: param, optional: z.boolean().optional() }).strict()).max(50).optional(),
  command: z.string().min(1).max(100).optional(),
  commandKeySeparator: z.string().min(1).max(10).optional(),
  audience: z.object({ parameter: param, privateValue: z.string(), privateResult: z.string(), defaultResult: z.string() }).strict().optional(),
  legacyMapping: z.object({ fields: z.record(z.enum(['ok', 'command', 'mode', 'section', 'id', 'date', 'scope', 'title', 'publishedAt', 'publicUrl', 'cms']), jsonPointerSchema),
    contentMode: z.string(), htmlMode: z.string(), contentDigest: jsonPointerSchema, htmlDigest: jsonPointerSchema,
    qaDigest: jsonPointerSchema, assets: jsonPointerSchema, ancillary: jsonPointerSchema }).strict().optional(),
  publishedAt: z.object({ resultPointer: jsonPointerSchema, dateParam: param, suffix: z.string().max(64) }).strict().optional(),
}).strict();
export const artifactContractSchema = z.object({
  role: artifactRoleSchema,
  resultFileName: artifactFileNameSchema,
  resultSchemaVersion: artifactSchemaVersionSchema,
  resultAdapter: z.enum(["generic", "legacy-qa", "legacy-publication"]),
  inputParams: z.object({ content: param.optional(), html: param.optional(), assetsDir: param.optional(),
    manifest: param.optional(), out: param.optional() }).strict(),
  consumerParams: z.object({ receipt: param, content: param.optional(), html: param.optional() }).strict().optional(),
  deploymentFiles: z.array(artifactRelativePathSchema).min(1).max(100),
  bundleManifest: z.object({ fileName: artifactFileNameSchema, schemaVersion: artifactSchemaVersionSchema.optional(),
    ancillaryRoles: z.array(z.string().min(1).max(100)).max(100) }).strict().optional(),
  assetDiscovery: z.array(jsonPointerSchema).max(100).optional(),
  inputEnvelopeVersion: artifactSchemaVersionSchema,
  defaultRules: qaConfigSchema.optional(),
  publication: artifactPublicationConfigSchema.optional(),
  readback: z.object({ rejectTitlePatterns: z.array(z.string().min(1).max(500)).max(100) }).strict().optional(),
  previewProvider: z.string().min(1).max(100).optional(),
}).strict().superRefine((contract, ctx) => {
  // Verification binds to its durable source publication; only publishers need input declarations.
  if (contract.role !== "publication") return;
  const config = contract.publication, identity = config?.identity, timestamp = config?.publishedAt;
  const issue = (field: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom,
    path: ["publication", field], message });
  if (!identity?.param && !(identity?.sourcePathParam && identity.sourceFieldParam && identity.format
    && (identity.format === "literal" || identity.dateParam))) {
    issue("identity", "Publication requires an ID parameter or a complete source identity declaration");
  }
  const fields = contract.resultAdapter === "legacy-publication" ? config?.legacyMapping?.fields
    : { date: "/date", publishedAt: "/publishedAt" };
  if (!timestamp || !fields?.publishedAt || timestamp.resultPointer !== fields.publishedAt) {
    issue("publishedAt", "Publication requires a binding for the result publication timestamp");
  }
  // An optional date argument remains optional, but when supplied must bind the actual result date.
  if (!fields?.date || !timestamp || !config?.bindings?.some(binding =>
    binding.resultPointer === fields.date && binding.parameter === timestamp.dateParam)) {
    issue("bindings", "Publication requires a result date binding using the timestamp date parameter");
  }
});
export type ArtifactContract = z.infer<typeof artifactContractSchema>;
export type ArtifactPublicationConfig = z.infer<typeof artifactPublicationConfigSchema>;

/** JSON Pointer with an array-only '*' extension. Absent pointers are not errors. */
export function selectArtifactValues(document: unknown, pointers: readonly string[]): unknown[] {
  const walk = (value: unknown, segments: string[]): unknown[] => {
    if (!segments.length) return [value];
    const [key, ...rest] = segments;
    if (key === "*" && Array.isArray(value)) return value.flatMap(item => walk(item, rest));
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return [];
    return walk((value as Record<string, unknown>)[key], rest);
  };
  return pointers.flatMap(pointer => {
    jsonPointerSchema.parse(pointer);
    return walk(document, pointer === "" ? [] : pointer.slice(1).split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~")));
  });
}
