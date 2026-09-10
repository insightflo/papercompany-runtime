import { z } from "zod";

const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const unit = z.enum(["bytes", "items", "frames", "milliseconds"]);
export const toolProgressPolicySchema = z.object({
  version: z.literal(1),
  idleTimeoutMs: z.number().int().min(1000).max(2147483647),
  maxDurationMs: z.number().int().min(1000).max(2147483647),
  stages: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), unit,
  }).strict()).min(1).max(32),
}).strict().refine((p) => p.idleTimeoutMs <= p.maxDurationMs, "idle exceeds maximum")
  .refine((p) => new Set(p.stages.map((s) => s.key)).size === p.stages.length, "duplicate stages");

export const toolProgressEventSchema = z.object({
  version: z.literal(1), executionId: z.string().uuid(),
  sequence: safeCount.refine((n) => n > 0),
  stage: z.string().min(1).max(64), unit, current: safeCount, total: safeCount.optional(),
}).strict().refine((e) => e.total === undefined || (e.total > 0 && e.current <= e.total), "invalid total");

export type ToolProgressPolicy = z.infer<typeof toolProgressPolicySchema>;
export type ToolProgressEvent = z.infer<typeof toolProgressEventSchema>;
