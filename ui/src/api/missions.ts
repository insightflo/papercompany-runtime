import { api } from "./client";

export type MissionStatus = "planning" | "active" | "paused" | "completed" | "cancelled";
export type MissionAgentRole = "executor" | "reviewer" | "observer" | "specialist" | "owner";

export interface MissionAgentEntry {
  agentId: string;
  role: MissionAgentRole;
}

export interface MissionListItem {
  id: string;
  companyId: string;
  ownerAgentId: string;
  title: string;
  description: string | null;
  status: MissionStatus;
  goalId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMissionInput {
  ownerAgentId: string;
  title: string;
  description?: string;
  goalId?: string;
  status?: MissionStatus;
  agentIds?: Array<{ agentId: string; role: MissionAgentRole }>;
}

export interface UpdateMissionInput {
  title?: string;
  description?: string;
  status?: MissionStatus;
  goalId?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export const missionsApi = {
  list: (companyId: string, filters?: { status?: MissionStatus; goalId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.goalId) params.set("goalId", filters.goalId);
    const qs = params.toString();
    return api.get<MissionListItem[]>(`/companies/${companyId}/missions${qs ? `?${qs}` : ""}`);
  },
  get: (id: string) => api.get<MissionListItem>(`/missions/${id}`),
  listAgents: (id: string) => api.get<MissionAgentEntry[]>(`/missions/${id}/agents`),
  create: (companyId: string, data: CreateMissionInput) =>
    api.post<MissionListItem>(`/companies/${companyId}/missions`, data),
  update: (id: string, data: UpdateMissionInput) =>
    api.patch<MissionListItem>(`/missions/${id}`, data),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/missions/${id}`),
};
