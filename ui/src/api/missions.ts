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

export interface MissionListFilters {
  status?: MissionStatus;
  goalId?: string;
  ownerAgentId?: string;
  from?: string;
  to?: string;
  sortBy?: "createdAt" | "updatedAt" | "title" | "status";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface MissionPlanRuntimeSummary {
  available: boolean;
  missionPlanId?: string | null;
  revision?: number | null;
  status?: string | null;
  missionGoal?: string | null;
  requiredInputsCount?: number;
  openRequiredInputs?: string[];
  successCriteriaCount?: number;
  riskCount?: number;
  stepCount?: number;
  stepSummary?: string[];
  executionUnitCount?: number;
  blockedOrFailedUnitCount?: number;
  ruleRefCount?: number;
  ruleNames?: string[];
  ruleModes?: string[];
  refs?: Record<string, unknown>;
}

export interface MissionDetailItem extends MissionListItem {
  agents: MissionAgentEntry[];
  ownerAgentName?: string;
  sessionBindings: MissionSessionBinding[];
  activeMissionPlan?: MissionPlanRuntimeSummary;
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
  list: (companyId: string, filters?: MissionListFilters) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.goalId) params.set("goalId", filters.goalId);
    if (filters?.ownerAgentId) params.set("ownerAgentId", filters.ownerAgentId);
    if (filters?.from) params.set("from", filters.from);
    if (filters?.to) params.set("to", filters.to);
    if (filters?.sortBy) params.set("sortBy", filters.sortBy);
    if (filters?.sortOrder) params.set("sortOrder", filters.sortOrder);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
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
