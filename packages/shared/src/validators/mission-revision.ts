import { z } from "zod";

export const missionRevisionSourceSchema = z.object({
  sourceMissionId: z.string().uuid().nullable().optional(),
  sourceWorkflowRunId: z.string().uuid().nullable().optional(),
}).refine(value => !value.sourceWorkflowRunId || Boolean(value.sourceMissionId), {
  message: "sourceWorkflowRunId requires sourceMissionId", path: ["sourceMissionId"],
});
