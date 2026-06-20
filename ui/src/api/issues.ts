import type {
  Approval,
  DocumentRevision,
  Issue,
  IssueAttachment,
  IssueComment,
  IssueDocument,
  IssueLabel,
  IssueWorkProduct,
  WorkItem,
  WorkItemAttachment,
  WorkItemComment,
  WorkItemDocument,
  WorkItemProduct,
  WorkItemLabel,
  UpsertIssueDocument,
  UpsertWorkItemDocument,
} from "@paperclipai/shared";
import { api } from "./client";

export const ACTIVE_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
export const ACTIVE_ISSUE_STATUS_FILTER = ACTIVE_ISSUE_STATUSES.join(",");

export const issuesApi = {
  list: (
    companyId: string,
    filters?: {
      status?: string;
      projectId?: string;
      assigneeAgentId?: string;
      assigneeUserId?: string;
      touchedByUserId?: string;
      unreadForUserId?: string;
      labelId?: string;
      originKind?: string;
      originId?: string;
      includeRoutineExecutions?: boolean;
      q?: string;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.assigneeAgentId) params.set("assigneeAgentId", filters.assigneeAgentId);
    if (filters?.assigneeUserId) params.set("assigneeUserId", filters.assigneeUserId);
    if (filters?.touchedByUserId) params.set("touchedByUserId", filters.touchedByUserId);
    if (filters?.unreadForUserId) params.set("unreadForUserId", filters.unreadForUserId);
    if (filters?.labelId) params.set("labelId", filters.labelId);
    if (filters?.originKind) params.set("originKind", filters.originKind);
    if (filters?.originId) params.set("originId", filters.originId);
    if (filters?.includeRoutineExecutions) params.set("includeRoutineExecutions", "true");
    if (filters?.q) params.set("q", filters.q);
    const qs = params.toString();
    return api.get<Issue[]>(`/companies/${companyId}/issues${qs ? `?${qs}` : ""}`);
  },
  listLabels: (companyId: string) => api.get<IssueLabel[]>(`/companies/${companyId}/labels`),
  createLabel: (companyId: string, data: { name: string; color: string }) =>
    api.post<IssueLabel>(`/companies/${companyId}/labels`, data),
  deleteLabel: (id: string) => api.delete<IssueLabel>(`/labels/${id}`),
  get: (id: string) => api.get<Issue>(`/issues/${id}`),
  markRead: (id: string) => api.post<{ id: string; lastReadAt: Date }>(`/issues/${id}/read`, {}),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Issue>(`/companies/${companyId}/issues`, data),
  update: (id: string, data: Record<string, unknown>) => api.patch<Issue>(`/issues/${id}`, data),
  remove: (id: string) => api.delete<Issue>(`/issues/${id}`),
  checkout: (id: string, agentId: string) =>
    api.post<Issue>(`/issues/${id}/checkout`, {
      agentId,
      expectedStatuses: ["todo", "backlog", "blocked"],
    }),
  release: (id: string) => api.post<Issue>(`/issues/${id}/release`, {}),
  listComments: (id: string) => api.get<IssueComment[]>(`/issues/${id}/comments`),
  addComment: (id: string, body: string, reopen?: boolean, interrupt?: boolean) =>
    api.post<IssueComment>(
      `/issues/${id}/comments`,
      {
        body,
        ...(reopen === undefined ? {} : { reopen }),
        ...(interrupt === undefined ? {} : { interrupt }),
      },
    ),
  listDocuments: (id: string) => api.get<IssueDocument[]>(`/issues/${id}/documents`),
  getDocument: (id: string, key: string) => api.get<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}`),
  upsertDocument: (id: string, key: string, data: UpsertIssueDocument) =>
    api.put<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}`, data),
  listDocumentRevisions: (id: string, key: string) =>
    api.get<DocumentRevision[]>(`/issues/${id}/documents/${encodeURIComponent(key)}/revisions`),
  deleteDocument: (id: string, key: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/documents/${encodeURIComponent(key)}`),
  listAttachments: (id: string) => api.get<IssueAttachment[]>(`/issues/${id}/attachments`),
  uploadAttachment: (
    companyId: string,
    issueId: string,
    file: File,
    issueCommentId?: string | null,
  ) => {
    const form = new FormData();
    form.append("file", file);
    if (issueCommentId) {
      form.append("issueCommentId", issueCommentId);
    }
    return api.postForm<IssueAttachment>(`/companies/${companyId}/issues/${issueId}/attachments`, form);
  },
  deleteAttachment: (id: string) => api.delete<{ ok: true }>(`/attachments/${id}`),
  listApprovals: (id: string) => api.get<Approval[]>(`/issues/${id}/approvals`),
  linkApproval: (id: string, approvalId: string) =>
    api.post<Approval[]>(`/issues/${id}/approvals`, { approvalId }),
  unlinkApproval: (id: string, approvalId: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/approvals/${approvalId}`),
  listWorkProducts: (id: string) => api.get<IssueWorkProduct[]>(`/issues/${id}/work-products`),
  createWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.post<IssueWorkProduct>(`/issues/${id}/work-products`, data),
  openWorkProduct: (id: string) =>
    api.post<{ ok: true; target: { kind: "path" | "url"; value: string } }>(`/work-products/${id}/open`, {}),
  updateWorkProduct: (id: string, data: Record<string, unknown>) =>
    api.patch<IssueWorkProduct>(`/work-products/${id}`, data),
  deleteWorkProduct: (id: string) => api.delete<IssueWorkProduct>(`/work-products/${id}`),
};

export const workItemsApi = {
  list: (companyId: string, filters?: Parameters<typeof issuesApi.list>[1]) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.projectId) params.set("workContextId", filters.projectId);
    if (filters?.assigneeAgentId) params.set("assigneeAgentId", filters.assigneeAgentId);
    if (filters?.assigneeUserId) params.set("assigneeUserId", filters.assigneeUserId);
    if (filters?.touchedByUserId) params.set("touchedByUserId", filters.touchedByUserId);
    if (filters?.unreadForUserId) params.set("unreadForUserId", filters.unreadForUserId);
    if (filters?.labelId) params.set("labelId", filters.labelId);
    if (filters?.originKind) params.set("originKind", filters.originKind);
    if (filters?.originId) params.set("originId", filters.originId);
    if (filters?.includeRoutineExecutions) params.set("includeRoutineExecutions", "true");
    if (filters?.q) params.set("q", filters.q);
    const qs = params.toString();
    return api.get<WorkItem[]>(`/companies/${companyId}/work-items${qs ? `?${qs}` : ""}`);
  },
  listLabels: (companyId: string) => api.get<WorkItemLabel[]>(`/companies/${companyId}/labels`),
  createLabel: (companyId: string, data: { name: string; color: string }) => api.post<WorkItemLabel>(`/companies/${companyId}/labels`, data),
  deleteLabel: (id: string) => api.delete<WorkItemLabel>(`/labels/${id}`),
  get: (workItemId: string) => api.get<WorkItem>(`/work-items/${workItemId}`),
  markRead: (workItemId: string) => api.post<{ id: string; lastReadAt: Date }>(`/work-items/${workItemId}/read`, {}),
  create: (companyId: string, data: Record<string, unknown>) => api.post<WorkItem>(`/companies/${companyId}/work-items`, data),
  update: (workItemId: string, data: Record<string, unknown>) => api.patch<WorkItem>(`/work-items/${workItemId}`, data),
  remove: (workItemId: string) => api.delete<WorkItem>(`/work-items/${workItemId}`),
  checkout: (workItemId: string, agentId: string) => api.post<WorkItem>(`/work-items/${workItemId}/checkout`, { agentId, expectedStatuses: ["todo", "backlog", "blocked"] }),
  release: (workItemId: string) => api.post<WorkItem>(`/work-items/${workItemId}/release`, {}),
  listComments: (workItemId: string) => api.get<WorkItemComment[]>(`/work-items/${workItemId}/comments`),
  addComment: (workItemId: string, body: string, reopen?: boolean, interrupt?: boolean) =>
    api.post<WorkItemComment>(`/work-items/${workItemId}/comments`, {
      body,
      ...(reopen === undefined ? {} : { reopen }),
      ...(interrupt === undefined ? {} : { interrupt }),
    }),
  listDocuments: (workItemId: string) => api.get<WorkItemDocument[]>(`/work-items/${workItemId}/documents`),
  getDocument: (workItemId: string, key: string) => api.get<WorkItemDocument>(`/work-items/${workItemId}/documents/${encodeURIComponent(key)}`),
  upsertDocument: (workItemId: string, key: string, data: UpsertWorkItemDocument) =>
    api.put<WorkItemDocument>(`/work-items/${workItemId}/documents/${encodeURIComponent(key)}`, data),
  listDocumentRevisions: (workItemId: string, key: string) => api.get<DocumentRevision[]>(`/work-items/${workItemId}/documents/${encodeURIComponent(key)}/revisions`),
  deleteDocument: (workItemId: string, key: string) => api.delete<{ ok: true }>(`/work-items/${workItemId}/documents/${encodeURIComponent(key)}`),
  listAttachments: (workItemId: string) => api.get<WorkItemAttachment[]>(`/work-items/${workItemId}/attachments`),
  uploadAttachment: (companyId: string, workItemId: string, file: File, workItemCommentId?: string | null) => {
    const form = new FormData();
    form.append("file", file);
    if (workItemCommentId) form.append("issueCommentId", workItemCommentId);
    return api.postForm<WorkItemAttachment>(`/companies/${companyId}/work-items/${workItemId}/attachments`, form);
  },
  deleteAttachment: (attachmentId: string) => api.delete<{ ok: true }>(`/attachments/${attachmentId}`),
  listApprovals: (workItemId: string) => api.get<Approval[]>(`/work-items/${workItemId}/approvals`),
  linkApproval: (workItemId: string, approvalId: string) => api.post<Approval[]>(`/work-items/${workItemId}/approvals`, { approvalId }),
  unlinkApproval: (workItemId: string, approvalId: string) => api.delete<{ ok: true }>(`/work-items/${workItemId}/approvals/${approvalId}`),
  listProducts: (workItemId: string) => api.get<WorkItemProduct[]>(`/work-items/${workItemId}/work-products`),
  createProduct: (workItemId: string, data: Record<string, unknown>) =>
    api.post<WorkItemProduct>(`/work-items/${workItemId}/work-products`, data),
  updateProduct: (productId: string, data: Record<string, unknown>) =>
    api.patch<WorkItemProduct>(`/work-products/${productId}`, data),
  deleteProduct: (productId: string) => api.delete<WorkItemProduct>(`/work-products/${productId}`),
};
