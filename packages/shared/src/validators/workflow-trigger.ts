import { z } from "zod";
import { replacementIntentSchema } from "./workflow-replacement.js";
import { workflowSeedRequestSchema } from "./workflow-seed.js";

export const triggerWorkflowRunSchema = z.object({
  replacementIntent: replacementIntentSchema.optional(),
  seedFromRun: workflowSeedRequestSchema.optional(),
  missionId: z.string().uuid().optional(),
  triggeredBy: z.string().min(1).optional(),
  triggerSource: z.string().nullable().optional(),
  runDate: z.string().nullable().optional(),
  runNumber: z.number().int().positive().nullable().optional(),
  runLabel: z.string().nullable().optional(),
  parentIssueId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type TriggerWorkflowRun = z.infer<typeof triggerWorkflowRunSchema>;
