import { z } from "zod";

export const missionRevisionSourceSchema = z.object({
  sourceMissionId: z.string().uuid().nullable().optional(),
  sourceWorkflowRunId: z.string().uuid().nullable().optional(),
}).refine(value => !value.sourceWorkflowRunId || Boolean(value.sourceMissionId), {
  message: "sourceWorkflowRunId requires sourceMissionId", path: ["sourceMissionId"],
});

/** Structured plan-unit identity. Labels/descriptions are never source identity. */
export const missionRevisionUnitSchema = z.object({
  sourceStepId: z.string().min(1).max(200).optional(),
}).passthrough();
export type MissionRevisionUnit = z.infer<typeof missionRevisionUnitSchema>;
