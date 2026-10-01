import { z } from "zod";

export const jsonPointerSchema = z.string().max(500).regex(/^(?:\/(?:[^~\u0000-\u001f]|~[01])*)*$/u);
export const mandatoryQaRuleIds = ["provenance", "result-format", "no-sensitive-data", "no-external-script",
  "no-external-iframe", "https-links"] as const;
const base = { enabled: z.boolean().optional() };
const empty = z.object({ ...base, params: z.object({}).strict().optional() }).strict();
const mandatory = empty.extend({ enabled: z.literal(true).optional() });
const minimum = z.number().int().nonnegative().max(10000);
const pointers = z.array(jsonPointerSchema).min(1).max(100);
const texts = z.array(z.string().min(1).max(500)).min(1).max(100);
export const qaConfigSchema = z.object({ rules: z.object({
  provenance: mandatory.optional(),
  "result-format": mandatory.optional(),
  "no-sensitive-data": mandatory.optional(),
  "no-external-script": mandatory.optional(),
  "no-external-iframe": mandatory.optional(),
  "https-links": mandatory.optional(),
  "min-source-links": z.object({ ...base, params: z.object({ min: minimum, pointers: pointers.optional() }).strict().optional() }).strict().optional(),
  "links-reachable": empty.optional(),
  "uploaded-asset-required": empty.optional(),
  "tag-count": z.object({ ...base, params: z.object({ pointer: jsonPointerSchema.optional(), min: minimum,
    max: minimum.optional() }).strict().refine(p => p.max === undefined || p.max >= p.min, "max must be >= min").optional() }).strict().optional(),
  "required-fields": z.object({ ...base, params: z.object({ pointers }).strict().optional() }).strict().optional(),
  "no-template-remnants": z.object({ ...base, params: z.object({ patterns: texts }).strict().optional() }).strict().optional(),
  "asset-existence": z.object({ ...base, params: z.object({ pointers: pointers.optional() }).strict().optional() }).strict().optional(),
}).strict() }).strict();
export type QaConfig = z.infer<typeof qaConfigSchema>;
export type QaRuleId = keyof QaConfig["rules"];

/** Three layers: runtime mandatory rules, declared tool preset, frozen step overrides. */
export function resolveEffectiveQaConfig(defaultRules?: QaConfig, stepConfig?: QaConfig): QaConfig {
  const rules: Record<string, unknown> = Object.fromEntries(mandatoryQaRuleIds.map(id => [id, { enabled: true }]));
  for (const layer of [defaultRules, stepConfig]) {
    if (!layer) continue;
    const parsed = qaConfigSchema.parse(layer);
    for (const [id, value] of Object.entries(parsed.rules)) {
      if (value !== undefined) rules[id] = { enabled: true, ...rules[id] as object, ...value };
    }
  }
  return qaConfigSchema.parse({ rules });
}

/** Stable JSON for validated contracts; arrays retain semantic order. */
export function canonicalQaJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalQaJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalQaJson(v)}`).join(",")}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("qa_config_not_json");
  return json;
}
