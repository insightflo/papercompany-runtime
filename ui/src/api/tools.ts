import type {
  CreateToolDefinitionRequest,
  ToolDefinition,
  UpdateToolDefinitionRequest,
} from "@paperclipai/shared";
import { api } from "./client";

export type WorkflowToolOption = {
  name: string;
  displayName: string;
  description: string;
  pluginId?: string;
  source?: string;
  enabled?: boolean;
};

export type WorkflowToolGrant = {
  agentId?: string;
  agentName?: string;
  toolName: string;
  source?: string;
};

export type WorkflowToolCatalog = {
  tools: WorkflowToolOption[];
  grants: WorkflowToolGrant[];
  sources?: Record<string, unknown>;
};

export type WorkflowToolGrantInput = {
  agentId: string;
  toolName: string;
};

function companyToolsPath(companyId: string, suffix = "") {
  return `/companies/${encodeURIComponent(companyId)}/tools${suffix}`;
}

function workflowToolsPath(companyId: string, suffix = "") {
  return `/companies/${encodeURIComponent(companyId)}/workflows/tools${suffix}`;
}

export const toolDefinitionsApi = {
  list: (companyId: string) =>
    api.get<ToolDefinition[]>(companyToolsPath(companyId)),
  create: (companyId: string, payload: CreateToolDefinitionRequest) =>
    api.post<ToolDefinition>(companyToolsPath(companyId), payload),
  update: (companyId: string, toolId: string, payload: UpdateToolDefinitionRequest) =>
    api.patch<ToolDefinition>(companyToolsPath(companyId, `/${encodeURIComponent(toolId)}`), payload),
  remove: (companyId: string, toolId: string) =>
    api.delete<{ ok: true }>(companyToolsPath(companyId, `/${encodeURIComponent(toolId)}`)),
};

export const workflowToolsApi = {
  catalog: (companyId: string) =>
    api.get<WorkflowToolCatalog>(workflowToolsPath(companyId)),
  grant: (companyId: string, payload: WorkflowToolGrantInput) =>
    api.post<WorkflowToolGrant>(workflowToolsPath(companyId, "/grants"), payload),
  revoke: (companyId: string, payload: WorkflowToolGrantInput) =>
    api.deleteWithBody<{ revoked: boolean }>(workflowToolsPath(companyId, "/grants"), payload),
};
