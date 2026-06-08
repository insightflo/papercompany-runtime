import { z } from "zod";

export const companyInstructionFileSummarySchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  language: z.string(),
  markdown: z.boolean(),
  editable: z.boolean(),
});

export const companyInstructionFileDetailSchema = companyInstructionFileSummarySchema.extend({
  content: z.string(),
});

export const companyInstructionsBundleSchema = z.object({
  companyId: z.string().uuid(),
  rootPath: z.string(),
  files: z.array(companyInstructionFileSummarySchema),
});

export const upsertCompanyInstructionFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type UpsertCompanyInstructionFile = z.infer<typeof upsertCompanyInstructionFileSchema>;
