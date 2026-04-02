import { api } from "./client";

export interface Schedule {
  id: string;
  companyId: string;
  agentId: string;
  cronExpression: string;
  timezone: string;
  missionId: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduleInput {
  agentId: string;
  cronExpression: string;
  timezone?: string;
  missionId?: string;
  enabled?: boolean;
}

export interface UpdateScheduleInput {
  cronExpression?: string;
  timezone?: string;
  missionId?: string | null;
  enabled?: boolean;
}

export const schedulerApi = {
  list: (companyId: string, filters?: { enabled?: boolean; agentId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.enabled !== undefined) params.set("enabled", String(filters.enabled));
    if (filters?.agentId) params.set("agentId", filters.agentId);
    const qs = params.toString();
    return api.get<Schedule[]>(`/companies/${companyId}/schedules${qs ? `?${qs}` : ""}`);
  },
  create: (companyId: string, data: CreateScheduleInput) =>
    api.post<Schedule>(`/companies/${companyId}/schedules`, data),
  update: (id: string, data: UpdateScheduleInput) =>
    api.patch<Schedule>(`/schedules/${id}`, data),
  remove: (id: string) => api.delete<void>(`/schedules/${id}`),
};
