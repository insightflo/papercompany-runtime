import { z } from "zod";

export const missionPlanTemplateOriginSchema = z.enum(["system_default", "custom"]);

const nameSchema = z.string().trim().min(1).max(120);
const selectionDescriptionSchema = z.string().trim().min(1).max(500);
const instructionsSchema = z.string().trim().min(1).max(16_000);

export const createMissionPlanTemplateSchema = z.object({
  name: nameSchema,
  selectionDescription: selectionDescriptionSchema,
  instructions: instructionsSchema,
}).strict();

export const updateMissionPlanTemplateSchema = z.object({
  name: nameSchema.optional(),
  selectionDescription: selectionDescriptionSchema.optional(),
  instructions: instructionsSchema.optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field must be provided");

export const duplicateMissionPlanTemplateSchema = z.object({
  name: nameSchema.optional(),
}).strict();

export type CreateMissionPlanTemplate = z.infer<typeof createMissionPlanTemplateSchema>;
export type UpdateMissionPlanTemplate = z.infer<typeof updateMissionPlanTemplateSchema>;
export type DuplicateMissionPlanTemplate = z.infer<typeof duplicateMissionPlanTemplateSchema>;
