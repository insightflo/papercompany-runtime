import type {
  HeartbeatRun,
  HeartbeatRunAttention,
  HeartbeatRunCounts,
  HeartbeatRunCursor,
  HeartbeatRunEvent,
  HeartbeatRunPage,
  HeartbeatRunStats,
  InstanceSchedulerHeartbeatAgent,
  WorkspaceOperation,
} from "@paperclipai/shared";
import { api } from "./client";

export interface ActiveRunForIssue extends HeartbeatRun {
  agentId: string;
  agentName: string;
  adapterType: string;
}

export interface LiveRunForIssue {
  id: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  issueId?: string | null;
}

export function encodeHeartbeatCursor(cursor: HeartbeatRunCursor | null | undefined): string | null {
  if (!cursor) return null;
  // Do NOT encodeURIComponent here: callers pass the result to
  // URLSearchParams.set(), which already percent-encodes. Double-encoding
  // the ISO colons (':' → '%3A' → '%253A') makes the server's parseRunCursor
  // produce an Invalid Date and return 400 on every page-2 request.
  return `${cursor.createdAt}_${cursor.id}`;
}

export const heartbeatsApi = {
  list: (companyId: string, agentId?: string, limit?: number) => {
    const searchParams = new URLSearchParams();
    if (agentId) searchParams.set("agentId", agentId);
    if (limit) searchParams.set("limit", String(limit));
    const qs = searchParams.toString();
    return api.get<HeartbeatRun[]>(`/companies/${companyId}/heartbeat-runs${qs ? `?${qs}` : ""}`);
  },
  get: (runId: string) => api.get<HeartbeatRun>(`/heartbeat-runs/${runId}`),
  events: (runId: string, afterSeq = 0, limit = 200) =>
    api.get<HeartbeatRunEvent[]>(
      `/heartbeat-runs/${runId}/events?afterSeq=${encodeURIComponent(String(afterSeq))}&limit=${encodeURIComponent(String(limit))}`,
    ),
  log: (runId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ runId: string; store: string; logRef: string; content: string; nextOffset?: number }>(
      `/heartbeat-runs/${runId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
    ),
  workspaceOperations: (runId: string) =>
    api.get<WorkspaceOperation[]>(`/heartbeat-runs/${runId}/workspace-operations`),
  workspaceOperationLog: (operationId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ operationId: string; store: string; logRef: string; content: string; nextOffset?: number }>(
      `/workspace-operations/${operationId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
    ),
  cancel: (runId: string) => api.post<void>(`/heartbeat-runs/${runId}/cancel`, {}),
  liveRunsForIssue: (issueId: string) =>
    api.get<LiveRunForIssue[]>(`/issues/${issueId}/live-runs`),
  activeRunForIssue: (issueId: string) =>
    api.get<ActiveRunForIssue | null>(`/issues/${issueId}/active-run`),
  liveRunsForCompany: (companyId: string, minCount?: number, agentId?: string) => {
    const searchParams = new URLSearchParams();
    if (minCount) searchParams.set("minCount", String(minCount));
    if (agentId) searchParams.set("agentId", agentId);
    const qs = searchParams.toString();
    return api.get<LiveRunForIssue[]>(`/companies/${companyId}/live-runs${qs ? `?${qs}` : ""}`);
  },
  page: (companyId: string, opts?: { agentId?: string; limit?: number; cursor?: HeartbeatRunCursor | null }) => {
    const searchParams = new URLSearchParams();
    if (opts?.agentId) searchParams.set("agentId", opts.agentId);
    if (opts?.limit) searchParams.set("limit", String(opts.limit));
    const cursor = encodeHeartbeatCursor(opts?.cursor);
    if (cursor) searchParams.set("cursor", cursor);
    const qs = searchParams.toString();
    return api.get<HeartbeatRunPage>(`/companies/${companyId}/heartbeat-runs/page${qs ? `?${qs}` : ""}`);
  },
  count: (companyId: string, opts?: { agentId?: string; statuses?: string[] }) => {
    const searchParams = new URLSearchParams();
    if (opts?.agentId) searchParams.set("agentId", opts.agentId);
    if (opts?.statuses && opts.statuses.length > 0) searchParams.set("status", opts.statuses.join(","));
    const qs = searchParams.toString();
    return api.get<HeartbeatRunCounts>(`/companies/${companyId}/heartbeat-runs/count${qs ? `?${qs}` : ""}`);
  },
  stats: (companyId: string, opts?: { agentId?: string; days?: number }) => {
    const searchParams = new URLSearchParams();
    if (opts?.agentId) searchParams.set("agentId", opts.agentId);
    if (opts?.days) searchParams.set("days", String(opts.days));
    const qs = searchParams.toString();
    return api.get<HeartbeatRunStats>(`/companies/${companyId}/heartbeat-runs/stats${qs ? `?${qs}` : ""}`);
  },
  attention: (companyId: string, opts?: { agentId?: string; limit?: number; cursor?: HeartbeatRunCursor | null; dismissedRunIds?: string[] }) => {
    const searchParams = new URLSearchParams();
    if (opts?.agentId) searchParams.set("agentId", opts.agentId);
    if (opts?.limit) searchParams.set("limit", String(opts.limit));
    const cursor = encodeHeartbeatCursor(opts?.cursor);
    if (cursor) searchParams.set("cursor", cursor);
    if (opts?.dismissedRunIds && opts.dismissedRunIds.length > 0) {
      searchParams.set("dismissedRunIds", opts.dismissedRunIds.join(","));
    }
    const qs = searchParams.toString();
    return api.get<HeartbeatRunAttention>(`/companies/${companyId}/heartbeat-runs/attention${qs ? `?${qs}` : ""}`);
  },
  listInstanceSchedulerAgents: () =>
    api.get<InstanceSchedulerHeartbeatAgent[]>("/instance/scheduler-heartbeats"),
};
