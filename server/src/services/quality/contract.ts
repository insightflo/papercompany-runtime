import { createHash } from "node:crypto";
import { z } from "zod";
import { artifactRefSchema, evidenceScopeSchema, sourceAttemptSchema, uuidSchema } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { unprocessable } from "../../errors.js";

export type QualityTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type QualityDb = Db | QualityTx;
export const occurrenceSetSchema = z.array(uuidSchema)
  .refine((ids) => new Set(ids).size === ids.length, "quality_duplicate_entry")
  .transform((ids) => [...ids].sort());
export const occurrenceInputSchema = z.object({
  companyId: uuidSchema, reviewItemId: uuidSchema, producerRunId: uuidSchema,
  submissionKey: z.string().min(1).max(200), source: sourceAttemptSchema,
  evidence: z.array(artifactRefSchema).refine((refs) => new Set(refs.map((r) => r.attachmentId)).size === refs.length, "quality_duplicate_entry"),
}).strict();

/** Internal server-produced receipt, never extracted from agent text. */
export const evidenceContractSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["input", "read", "submission", "evaluation", "adoption", "use", "observation", "rollback"]),
  ref: artifactRefSchema, source: sourceAttemptSchema, scope: evidenceScopeSchema.nullable(),
  issuedBy: z.string().min(1).max(200), verifiedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(), originalRef: artifactRefSchema.nullable(),
}).strict().refine((receipt) => receipt.scope !== null || receipt.kind === "input", "quality_input_scope_only");
export type EvidenceContract = z.infer<typeof evidenceContractSchema>;

export function evidenceError(code: string): never {
  throw unprocessable(code, { code });
}

export function parseEvidence<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) evidenceError("quality_evidence_invalid_contract");
  return result.data;
}

/** Canonical JSON only: no coercion, omitted values, custom serializers or prose. */
export function hashContract(value: unknown): string {
  const seen = new Set<object>();
  function encode(input: unknown): string {
    if (input === null) return "null";
    if (typeof input === "string" || typeof input === "boolean") return JSON.stringify(input);
    if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== "object" || seen.has(input)) throw new Error("quality_invalid_json");
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length) throw new Error("quality_invalid_json");
        return `[${Array.from(input, encode).join(",")}]`;
      }
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
        throw new Error("quality_invalid_json");
      }
      if (Object.getOwnPropertySymbols(input).length) throw new Error("quality_invalid_json");
      const record = input as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => {
        if (!Object.getOwnPropertyDescriptor(record, key)?.get) return `${JSON.stringify(key)}:${encode(record[key])}`;
        throw new Error("quality_invalid_json");
      }).join(",")}}`;
    } finally { seen.delete(input); }
  }
  return createHash("sha256").update(encode(value)).digest("hex");
}
