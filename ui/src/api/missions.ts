import { api } from "./client";
import type { Issue } from "@paperclipai/shared";

export type MissionStatus = "planning" | "active" | "paused" | "completed" | "cancelled";
export type MissionAgentRole = "executor" | "reviewer" | "observer" | "specialist" | "owner";

export interface MissionAgentEntry {
  agentId: string;
  role: MissionAgentRole;
  agentName?: string;
}

export interface MissionSessionBinding {
  agentId: string;
  adapterType: string;
  status: string;
  lastActiveAt: string | null;
  runCount: number;
}

export interface MissionWorkflowStepRun {
  id: string;
  workflowRunId: string;
  stepId: string;
  issueId: string | null;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt: string | null;
  completedAt: string | null;
}

export interface MissionWorkflowStepIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
}

export interface MissionWorkflowStep {
  stepId: string;
  name: string;
  agentId: string;
  dependencies: string[];
  description: string | null;
  toolNames: string[];
  knowledgeBaseIds: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  issueId: string | null;
  issue: MissionWorkflowStepIssue | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MissionWorkflowRunProgress {
  totalSteps: number;
  pendingSteps: number;
  runningSteps: number;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
}

export interface MissionWorkflowRun {
  id: string;
  workflowId: string;
  companyId: string;
  missionId: string | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  triggeredBy: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  workflowName: string | null;
  stepRuns: MissionWorkflowStepRun[];
  steps: MissionWorkflowStep[];
  progress: MissionWorkflowRunProgress;
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

export interface MissionDetailItem extends MissionListItem {
  agents: MissionAgentEntry[];
  ownerAgentName?: string;
  sessionBindings: MissionSessionBinding[];
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
  get: (id: string) => api.get<MissionDetailItem>(`/missions/${id}`),
  listAgents: (id: string) => api.get<MissionAgentEntry[]>(`/missions/${id}/agents`),
  listIssues: (id: string) => api.get<Issue[]>(`/missions/${id}/issues`),
  listWorkflowRuns: (id: string) => api.get<MissionWorkflowRun[]>(`/missions/${id}/workflow-runs`),
  create: (companyId: string, data: CreateMissionInput) =>
    api.post<MissionListItem>(`/companies/${companyId}/missions`, data),
  update: (id: string, data: UpdateMissionInput) =>
    api.patch<MissionListItem>(`/missions/${id}`, data),
  remove: (id: string) => api.delete<{ ok: boolean }>(`/missions/${id}`),
};
