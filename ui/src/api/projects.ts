import type { Project, ProjectWorkspace, WorkContext, WorkContextSpace } from "@paperclipai/shared";
import { api } from "./client";

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}companyId=${encodeURIComponent(companyId)}`;
}

function projectPath(id: string, companyId?: string, suffix = "") {
  return withCompanyScope(`/projects/${encodeURIComponent(id)}${suffix}`, companyId);
}

export const projectsApi = {
  list: (companyId: string) => api.get<Project[]>(`/companies/${companyId}/projects`),
  get: (id: string, companyId?: string) => api.get<Project>(projectPath(id, companyId)),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Project>(`/companies/${companyId}/projects`, data),
  update: (id: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<Project>(projectPath(id, companyId), data),
  listWorkspaces: (projectId: string, companyId?: string) =>
    api.get<ProjectWorkspace[]>(projectPath(projectId, companyId, "/workspaces")),
  createWorkspace: (projectId: string, data: Record<string, unknown>, companyId?: string) =>
    api.post<ProjectWorkspace>(projectPath(projectId, companyId, "/workspaces"), data),
  updateWorkspace: (projectId: string, workspaceId: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<ProjectWorkspace>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`),
      data,
    ),
  removeWorkspace: (projectId: string, workspaceId: string, companyId?: string) =>
    api.delete<ProjectWorkspace>(projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`)),
  remove: (id: string, companyId?: string) => api.delete<Project>(projectPath(id, companyId)),
};

export const workContextsApi = {
  list: (companyId: string) => api.get<WorkContext[]>(`/companies/${companyId}/work-contexts`),
  get: (workContextId: string, companyId?: string) => api.get<WorkContext>(withCompanyScope(`/work-contexts/${encodeURIComponent(workContextId)}`, companyId)),
  create: (companyId: string, data: Record<string, unknown>) => api.post<WorkContext>(`/companies/${companyId}/work-contexts`, data),
  update: (workContextId: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<WorkContext>(withCompanyScope(`/work-contexts/${encodeURIComponent(workContextId)}`, companyId), data),
  listSpaces: (workContextId: string, companyId?: string) =>
    api.get<WorkContextSpace[]>(withCompanyScope(`/work-contexts/${encodeURIComponent(workContextId)}/workspaces`, companyId)),
  createSpace: (workContextId: string, data: Record<string, unknown>, companyId?: string) =>
    api.post<WorkContextSpace>(withCompanyScope(`/work-contexts/${encodeURIComponent(workContextId)}/workspaces`, companyId), data),
  updateSpace: (workContextId: string, spaceId: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<WorkContextSpace>(withCompanyScope(`/work-contexts/${encodeURIComponent(workContextId)}/workspaces/${encodeURIComponent(spaceId)}`, companyId), data),
  removeSpace: (workContextId: string, spaceId: string, companyId?: string) =>
    api.delete<WorkContextSpace>(withCompanyScope(`/work-contexts/${encodeURIComponent(workContextId)}/workspaces/${encodeURIComponent(spaceId)}`, companyId)),
  remove: (workContextId: string, companyId?: string) => api.delete<WorkContext>(withCompanyScope(`/work-contexts/${encodeURIComponent(workContextId)}`, companyId)),
};
