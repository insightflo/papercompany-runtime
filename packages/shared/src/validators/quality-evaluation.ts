import { z } from "zod";
import { artifactRefSchema, uuidSchema } from "./quality-automation.js";

/** 실제 평가 스코프·결과 계약(설계 §3.2 EvaluationScope/CheckResult). */

const nonNegativeInteger = z.number().int().safe().min(0);

export const evaluationScopeSchema = z.object({
  kind: z.literal("evaluation"),
  companyId: uuidSchema,
  actionId: uuidSchema,
  evaluationId: uuidSchema,
  missionId: uuidSchema,
  workflowRunId: uuidSchema,
  stepRunId: uuidSchema,
  generation: nonNegativeInteger,
  issueId: uuidSchema,
  heartbeatRunId: uuidSchema,
  executionEpoch: nonNegativeInteger,
}).strict();
export type EvaluationScope = z.infer<typeof evaluationScopeSchema>;

export const checkResultStatusSchema = z.enum([
  "satisfied",
  "defect",
  "insufficient_evidence",
  "execution_error",
  "excluded",
]);
export type CheckResultStatus = z.infer<typeof checkResultStatusSchema>;

export const checkResultSchema = z.object({
  checkId: z.string().min(1).max(200),
  status: checkResultStatusSchema,
  readRef: artifactRefSchema,
  evidence: z.array(artifactRefSchema).refine(
    (refs) => new Set(refs.map((ref) => ref.attachmentId)).size === refs.length, "quality_duplicate_entry",
  ),
}).strict();
export type CheckResult = z.infer<typeof checkResultSchema>;
