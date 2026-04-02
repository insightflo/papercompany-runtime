import { api } from "./client";

export type RuleSeverity = "MUST" | "SHOULD" | "MAY";

export type RuleAction =
  | "tool_call"
  | "file_read"
  | "file_write"
  | "file_delete"
  | "network_request"
  | "command_execution"
  | "state_query";

export type Predicate = Record<string, unknown>;

export interface WorktreeRule {
  id: string;
  companyId: string;
  name: string;
  severity: RuleSeverity;
  action: string;
  predicate: Predicate;
  decisionMap: Record<string, unknown>;
  message: string;
  enabled: boolean;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRuleInput {
  name: string;
  severity: RuleSeverity;
  action: string;
  predicate: Predicate;
  decisionMap?: Record<string, unknown>;
  message?: string;
  enabled?: boolean;
}

export interface UpdateRuleInput {
  name?: string;
  severity?: RuleSeverity;
  action?: string;
  predicate?: Predicate;
  decisionMap?: Record<string, unknown>;
  message?: string;
  enabled?: boolean;
}

export type ProposalStatus = "proposed" | "approved" | "rejected";

export interface ProposedRuleChange {
  name: string;
  severity: RuleSeverity;
  action: string;
  predicate: Predicate;
  decisionMap: Record<string, unknown>;
  message?: string;
}

export interface WorktreeProposal {
  id: string;
  ruleId: string | null;
  companyId: string;
  proposedBy: string;
  proposedChange: ProposedRuleChange;
  rationale: string;
  status: ProposalStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface ReviewProposalInput {
  status: "approved" | "rejected";
  reviewedByAgentId: string;
  reviewNote?: string;
}

export const worktreeApi = {
  listRules: (
    companyId: string,
    filters?: { severity?: RuleSeverity; enabled?: boolean },
  ) => {
    const params = new URLSearchParams();
    if (filters?.severity) params.set("severity", filters.severity);
    if (filters?.enabled !== undefined) params.set("enabled", String(filters.enabled));
    const qs = params.toString();
    return api.get<WorktreeRule[]>(
      `/companies/${companyId}/worktree/rules${qs ? `?${qs}` : ""}`,
    );
  },
  createRule: (companyId: string, data: CreateRuleInput) =>
    api.post<WorktreeRule>(`/companies/${companyId}/worktree/rules`, data),
  updateRule: (id: string, data: UpdateRuleInput) =>
    api.patch<WorktreeRule>(`/worktree/rules/${id}`, data),
  deleteRule: (id: string) => api.delete<void>(`/worktree/rules/${id}`),
  listProposals: (
    companyId: string,
    filters?: { status?: ProposalStatus; proposedByAgentId?: string },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.proposedByAgentId) params.set("proposedByAgentId", filters.proposedByAgentId);
    const qs = params.toString();
    return api.get<WorktreeProposal[]>(
      `/companies/${companyId}/worktree/proposals${qs ? `?${qs}` : ""}`,
    );
  },
  reviewProposal: (id: string, data: ReviewProposalInput) =>
    api.patch<WorktreeProposal>(`/worktree/proposals/${id}/review`, data),
};
