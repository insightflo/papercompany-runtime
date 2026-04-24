import type { ExecutionContext, ExecutionWorkspace } from "@paperclipai/shared";
import { api } from "./client";

export const executionWorkspacesApi = {
  list: (
    companyId: string,
    filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.projectWorkspaceId) params.set("projectWorkspaceId", filters.projectWorkspaceId);
    if (filters?.issueId) params.set("issueId", filters.issueId);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.reuseEligible) params.set("reuseEligible", "true");
    const qs = params.toString();
    return api.get<ExecutionWorkspace[]>(`/companies/${companyId}/execution-workspaces${qs ? `?${qs}` : ""}`);
  },
  get: (id: string) => api.get<ExecutionWorkspace>(`/execution-workspaces/${id}`),
  update: (id: string, data: Record<string, unknown>) => api.patch<ExecutionWorkspace>(`/execution-workspaces/${id}`, data),
};

export const executionContextsApi = {
  list: (
    companyId: string,
    filters?: {
      workContextId?: string;
      workContextSpaceId?: string;
      workItemId?: string;
      status?: string;
      reuseEligible?: boolean;
    },
  ) =>
    api.get<ExecutionContext[]>(`/companies/${companyId}/execution-contexts${filters ? (() => {
      const params = new URLSearchParams();
      if (filters.workContextId) params.set("workContextId", filters.workContextId);
      if (filters.workContextSpaceId) params.set("workContextSpaceId", filters.workContextSpaceId);
      if (filters.workItemId) params.set("workItemId", filters.workItemId);
      if (filters.status) params.set("status", filters.status);
      if (filters.reuseEligible) params.set("reuseEligible", "true");
      const qs = params.toString();
      return qs ? `?${qs}` : "";
    })() : ""}`),
  get: (executionContextId: string) => api.get<ExecutionContext>(`/execution-contexts/${executionContextId}`),
  update: (executionContextId: string, data: Record<string, unknown>) => api.patch<ExecutionContext>(`/execution-contexts/${executionContextId}`, data),
};
