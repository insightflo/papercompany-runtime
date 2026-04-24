import { z } from "zod";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "../constants.js";

const executionWorkspaceStrategySchema = z
  .object({
    type: z.enum(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]).optional(),
    baseRef: z.string().optional().nullable(),
    branchTemplate: z.string().optional().nullable(),
    worktreeParentDir: z.string().optional().nullable(),
    provisionCommand: z.string().optional().nullable(),
    teardownCommand: z.string().optional().nullable(),
  })
  .strict();

export const issueExecutionWorkspaceSettingsSchema = z
  .object({
    mode: z.enum(["inherit", "shared_workspace", "isolated_workspace", "operator_branch", "reuse_existing", "agent_default"]).optional(),
    workspaceStrategy: executionWorkspaceStrategySchema.optional().nullable(),
    workspaceRuntime: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export const issueAssigneeAdapterOverridesSchema = z
  .object({
    adapterConfig: z.record(z.unknown()).optional(),
    useProjectWorkspace: z.boolean().optional(),
  })
  .strict();

function normalizeWorkItemShape(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = { ...(input as Record<string, unknown>) };
  if (value.workContextId !== undefined && value.projectId === undefined) value.projectId = value.workContextId;
  if (value.workContextSpaceId !== undefined && value.projectWorkspaceId === undefined) value.projectWorkspaceId = value.workContextSpaceId;
  if (value.executionContextId !== undefined && value.executionWorkspaceId === undefined) value.executionWorkspaceId = value.executionContextId;
  if (value.parentWorkItemId !== undefined && value.parentId === undefined) value.parentId = value.parentWorkItemId;
  return value;
}

const issueFields = {
  projectId: z.string().uuid().optional().nullable(),
  projectWorkspaceId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(ISSUE_STATUSES).optional().default("backlog"),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  assigneeUserId: z.string().optional().nullable(),
  requestDepth: z.number().int().nonnegative().optional().default(0),
  billingCode: z.string().optional().nullable(),
  assigneeAdapterOverrides: issueAssigneeAdapterOverridesSchema.optional().nullable(),
  executionWorkspaceId: z.string().uuid().optional().nullable(),
  executionWorkspacePreference: z.enum([
    "inherit",
    "shared_workspace",
    "isolated_workspace",
    "operator_branch",
    "reuse_existing",
    "agent_default",
  ]).optional().nullable(),
  executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.optional().nullable(),
  labelIds: z.array(z.string().uuid()).optional(),
};

const createIssueObjectSchema = z.object(issueFields);

export const createIssueSchema = z.preprocess(normalizeWorkItemShape, createIssueObjectSchema);

export type CreateIssue = z.infer<typeof createIssueSchema>;

export const createIssueLabelSchema = z.object({
  name: z.string().trim().min(1).max(48),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value"),
});

export type CreateIssueLabel = z.infer<typeof createIssueLabelSchema>;

export const updateIssueSchema = z.preprocess(normalizeWorkItemShape, createIssueObjectSchema.partial().extend({
  comment: z.string().min(1).optional(),
  reopen: z.boolean().optional(),
  hiddenAt: z.string().datetime().nullable().optional(),
}));

export type UpdateIssue = z.infer<typeof updateIssueSchema>;
export type IssueExecutionWorkspaceSettings = z.infer<typeof issueExecutionWorkspaceSettingsSchema>;

const checkoutIssueObjectSchema = z.object({
  agentId: z.string().uuid(),
  expectedStatuses: z.array(z.enum(ISSUE_STATUSES)).nonempty(),
});

export const checkoutIssueSchema = z.preprocess(normalizeWorkItemShape, checkoutIssueObjectSchema);

export type CheckoutIssue = z.infer<typeof checkoutIssueSchema>;

export const addIssueCommentSchema = z.object({
  body: z.string().min(1),
  reopen: z.boolean().optional(),
  interrupt: z.boolean().optional(),
});

export type AddIssueComment = z.infer<typeof addIssueCommentSchema>;

const linkIssueApprovalObjectSchema = z.object({
  approvalId: z.string().uuid(),
});

export const linkIssueApprovalSchema = z.preprocess(normalizeWorkItemShape, linkIssueApprovalObjectSchema);

export type LinkIssueApproval = z.infer<typeof linkIssueApprovalSchema>;

export const createIssueAttachmentMetadataSchema = z.object({
  issueCommentId: z.string().uuid().optional().nullable(),
});

export type CreateIssueAttachmentMetadata = z.infer<typeof createIssueAttachmentMetadataSchema>;

export const ISSUE_DOCUMENT_FORMATS = ["markdown"] as const;

export const issueDocumentFormatSchema = z.enum(ISSUE_DOCUMENT_FORMATS);

export const issueDocumentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Document key must be lowercase letters, numbers, _ or -");

export const upsertIssueDocumentSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  format: issueDocumentFormatSchema,
  body: z.string().max(524288),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

export type IssueDocumentFormat = z.infer<typeof issueDocumentFormatSchema>;
export type UpsertIssueDocument = z.infer<typeof upsertIssueDocumentSchema>;

export const createWorkItemSchema = createIssueSchema;
export const updateWorkItemSchema = updateIssueSchema;
export const workItemExecutionSettingsSchema = issueExecutionWorkspaceSettingsSchema;
export const checkoutWorkItemSchema = checkoutIssueSchema;
export const addWorkItemCommentSchema = addIssueCommentSchema;
export const linkWorkItemApprovalSchema = linkIssueApprovalSchema;
export const createWorkItemLabelSchema = createIssueLabelSchema;
export const createWorkItemAttachmentMetadataSchema = createIssueAttachmentMetadataSchema;
export const workItemDocumentFormatSchema = issueDocumentFormatSchema;
export const workItemDocumentKeySchema = issueDocumentKeySchema;
export const upsertWorkItemDocumentSchema = upsertIssueDocumentSchema;

export type CreateWorkItem = CreateIssue;
export type UpdateWorkItem = UpdateIssue;
export type CheckoutWorkItem = CheckoutIssue;
export type AddWorkItemComment = AddIssueComment;
export type LinkWorkItemApproval = LinkIssueApproval;
export type CreateWorkItemLabel = CreateIssueLabel;
export type CreateWorkItemAttachmentMetadata = CreateIssueAttachmentMetadata;
export type WorkItemDocumentFormat = IssueDocumentFormat;
export type UpsertWorkItemDocument = UpsertIssueDocument;
export type WorkItemExecutionSettings = IssueExecutionWorkspaceSettings;
