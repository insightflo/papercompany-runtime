import { z } from "zod";

export const toolDefinitionAdapterTypeSchema = z.enum(["mcp", "builtin", "http"]);
const toolDefinitionNameSchema = z.string().trim().min(1).max(120);

export const toolDefinitionSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
  adapterType: toolDefinitionAdapterTypeSchema,
  adapterConfig: z.record(z.unknown()),
  enabled: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const createToolDefinitionSchema = z.object({
  name: toolDefinitionNameSchema,
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).optional(),
  adapterType: toolDefinitionAdapterTypeSchema,
  adapterConfig: z.record(z.unknown()),
  enabled: z.boolean().optional(),
}).strict();

export const updateToolDefinitionSchema = createToolDefinitionSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");

export type ToolDefinitionAdapterType = z.infer<typeof toolDefinitionAdapterTypeSchema>;
export type CreateToolDefinition = z.infer<typeof createToolDefinitionSchema>;
export type UpdateToolDefinition = z.infer<typeof updateToolDefinitionSchema>;

export const testToolSchema = z.object({
  input: z.record(z.unknown()),
}).strict();

export type TestToolRequest = z.infer<typeof testToolSchema>;
