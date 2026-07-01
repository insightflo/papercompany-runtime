import { useCallback, useEffect, useState } from "react";
import { useCompany } from "../../context/CompanyContext.js";
import { getSelectableWorkflowTools, getWorkflowToolSystemState, type WorkflowToolSystemState } from "./tool-availability.js";
import type { LabelOption, OverviewData, WorkflowRunDetailData, WorkflowToolGrant, WorkflowToolOption } from "./workflow-page-types.js";

export function normalizeLabel(input: Record<string, unknown>): LabelOption {
  return {
    id: String(input.id ?? ""),
    name: String(input.name ?? input.id ?? ""),
    color: typeof input.color === "string" && input.color.trim() ? input.color : "#6366f1",
  };
}

export function apiBaseUrl(): string {
  if (typeof window !== "undefined" && typeof window.location?.origin === "string" && window.location.origin.startsWith("http")) {
    return window.location.origin;
  }
  return "http://localhost:3100";
}

export function useHostContext(): { companyId?: string } {
  const { selectedCompanyId } = useCompany();
  return { companyId: selectedCompanyId ?? "" };
}

export async function coreApiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  if (!(init?.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${apiBaseUrl()}/api${path}`, {
    credentials: "include",
    ...init,
    headers,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new Error(payload?.error ?? payload?.message ?? `Request failed (${res.status})`);
  }
  return await res.json() as T;
}

export function usePluginData<T>(key: string, params: Record<string, unknown>): {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
} {
  const paramsKey = JSON.stringify(params);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    const parsedParams = JSON.parse(paramsKey) as Record<string, unknown>;
    setLoading(true);
    setError(null);
    try {
      if (key === "workflow-overview") {
        const companyId = typeof parsedParams.companyId === "string" ? parsedParams.companyId : "";
        if (!companyId.trim()) {
          setData({ workflows: [], activeRuns: [], recentRuns: [], projects: [], labels: [] } as T);
          return;
        }
        setData(await coreApiJson<T>(`/companies/${encodeURIComponent(companyId)}/workflows/overview`));
        return;
      }
      if (key === "workflow-run-detail") {
        const runId = typeof parsedParams.runId === "string" ? parsedParams.runId : "";
        if (!runId.trim()) {
          setData(null);
          return;
        }
        setData(await coreApiJson<T>(`/workflow-runs/${encodeURIComponent(runId)}/detail`));
        return;
      }
      throw new Error(`Unsupported workflow data key: ${key}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError : new Error(String(nextError)));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [key, paramsKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refresh().finally(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  return { data, loading, error, refresh };
}

export function usePluginAction(key: string): (params: Record<string, unknown>) => Promise<unknown> {
  return useCallback(async (params: Record<string, unknown>) => {
    if (key === "create-workflow") {
      const companyId = String(params.companyId ?? "");
      const workflow = (params.workflow && typeof params.workflow === "object" ? params.workflow : params) as Record<string, unknown>;
      return await coreApiJson(`/companies/${encodeURIComponent(companyId)}/workflows`, {
        method: "POST",
        body: JSON.stringify(workflow),
      });
    }
    if (key === "update-workflow") {
      const workflowId = String(params.workflowId ?? params.id ?? "");
      const workflow = (params.patch && typeof params.patch === "object")
        ? params.patch as Record<string, unknown>
        : (params.workflow && typeof params.workflow === "object" ? params.workflow : params) as Record<string, unknown>;
      const { workflowId: _workflowId, id: _id, companyId: _companyId, patch: _patch, ...patch } = workflow;
      if (patch.projectId === "") patch.projectId = null;
      if (patch.goalId === "") patch.goalId = null;
      return await coreApiJson(`/workflows/${encodeURIComponent(workflowId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    }
    if (key === "delete-workflow") {
      const workflowId = String(params.workflowId ?? params.id ?? "");
      return await coreApiJson(`/workflows/${encodeURIComponent(workflowId)}`, { method: "DELETE" });
    }
    if (key === "start-workflow") {
      const workflowId = String(params.workflowId ?? params.id ?? "");
      const { workflowId: _workflowId, id: _id, companyId: _companyId, ...body } = params;
      return await coreApiJson(`/workflows/${encodeURIComponent(workflowId)}/runs`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    }
    if (key === "resume-run") {
      const runId = String(params.runId ?? params.id ?? "");
      return await coreApiJson(`/workflow-runs/${encodeURIComponent(runId)}/resume`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    }
    if (key === "abort-run" || key === "cancel-run") {
      const runId = String(params.runId ?? params.id ?? "");
      return await coreApiJson(`/workflow-runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: key }),
      });
    }
    if (key === "manual-complete") {
      const issueId = String(params.issueId ?? "");
      return await coreApiJson(`/issues/${encodeURIComponent(issueId)}/workflow/manual-complete`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    }
    if (key === "rerun-step") {
      const stepRunId = String(params.stepRunId ?? "");
      return await coreApiJson(`/workflow-step-runs/${encodeURIComponent(stepRunId)}/rerun`, {
        method: "POST",
        body: JSON.stringify({ issueId: params.issueId ?? undefined }),
      });
    }
    throw new Error(`Unsupported workflow action key: ${key}`);
  }, [key]);
}

function companyLabelsUrl(companyId: string): string {
  return `${apiBaseUrl()}/api/companies/${encodeURIComponent(companyId)}/labels`;
}

export async function fetchCompanyLabels(companyId: string): Promise<LabelOption[]> {
  if (!companyId.trim()) {
    return [];
  }

  try {
    const res = await fetch(companyLabelsUrl(companyId));
    if (!res.ok) {
      return [];
    }
    const raw = await res.json() as Array<Record<string, unknown>>;
    return raw.map(normalizeLabel).filter((label) => label.id);
  } catch {
    return [];
  }
}

export async function createCompanyLabel(companyId: string, name: string, color: string): Promise<LabelOption> {
  const res = await fetch(companyLabelsUrl(companyId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, color }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `레이블 생성 실패 (${res.status})`);
  }
  const payload = await res.json() as Record<string, unknown>;
  return normalizeLabel(payload);
}

function normalizeWorkflowToolOption(input: Record<string, unknown>): WorkflowToolOption {
  const name = String(input.name ?? "");
  return {
    name,
    displayName: String(input.displayName ?? name),
    description: String(input.description ?? ""),
    pluginId: String(input.pluginId ?? ""),
    source: typeof input.source === "string" ? input.source : undefined,
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
  };
}

async function fetchAvailableWorkflowTools(companyId: string): Promise<{ tools: WorkflowToolOption[]; grants: WorkflowToolGrant[]; toolSystem: WorkflowToolSystemState }> {
  if (!companyId.trim()) {
    return { tools: [], grants: [], toolSystem: { available: false, reason: "No company selected." } };
  }

  const catalogRes = await fetch(`${apiBaseUrl()}/api/companies/${encodeURIComponent(companyId)}/workflows/tools`);
  if (!catalogRes.ok) {
    return { tools: [], grants: [], toolSystem: { available: false, reason: "Workflow tools could not be loaded." } };
  }
  const catalogPayload = await catalogRes.json() as Record<string, unknown>;
  const pageData = catalogPayload && typeof catalogPayload === "object" && !Array.isArray(catalogPayload)
    ? catalogPayload
    : {};
  const sources = pageData.sources && typeof pageData.sources === "object" && !Array.isArray(pageData.sources)
    ? pageData.sources as Record<string, unknown>
    : {};
  const toolRegistry = sources.toolRegistry && typeof sources.toolRegistry === "object" && !Array.isArray(sources.toolRegistry)
    ? sources.toolRegistry as Record<string, unknown>
    : {};
  const coreSource = sources.core && typeof sources.core === "object" && !Array.isArray(sources.core)
    ? sources.core as Record<string, unknown>
    : {};
  const toolsPayload = Array.isArray(pageData.tools) ? pageData.tools : [];
  const allTools = toolsPayload
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map(normalizeWorkflowToolOption);
  const tools = getSelectableWorkflowTools(allTools);
  const pluginToolsAvailable = tools.some((tool) => tool.source === "plugin");
  const coreToolsAvailable = tools.some((tool) => tool.source === "core");
  const toolSystem = getWorkflowToolSystemState(allTools, {
    available: coreSource.available === true || coreToolsAvailable || toolRegistry.available === true || pluginToolsAvailable,
    reason: typeof toolRegistry.unavailableReason === "string" ? toolRegistry.unavailableReason : undefined,
  });

  const grantsPayload = Array.isArray(pageData.grants) ? pageData.grants : [];
  const grants: WorkflowToolGrant[] = grantsPayload
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => {
      const d = (item as Record<string, unknown>);
      const inner = (d.data && typeof d.data === "object" && !Array.isArray(d.data)) ? d.data as Record<string, unknown> : {};
      return {
        agentName: String(d.agentName ?? inner.agentName ?? "").trim(),
        toolName: String(d.toolName ?? inner.toolName ?? "").trim(),
      };
    })
    .filter((g) => g.agentName && g.toolName);

  return { tools, grants, toolSystem };
}

export function useAvailableWorkflowTools(companyId: string): { tools: WorkflowToolOption[]; grants: WorkflowToolGrant[]; toolSystem: WorkflowToolSystemState } {
  const [tools, setTools] = useState<WorkflowToolOption[]>([]);
  const [grants, setGrants] = useState<WorkflowToolGrant[]>([]);
  const [toolSystem, setToolSystem] = useState<WorkflowToolSystemState>({ available: false });
  useEffect(() => {
    let cancelled = false;
    void fetchAvailableWorkflowTools(companyId)
      .then((result) => {
        if (!cancelled) {
          setTools(result.tools);
          setGrants(result.grants);
          setToolSystem(result.toolSystem);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTools([]);
          setGrants([]);
          setToolSystem({ available: false, reason: "Workflow tools could not be loaded." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);
  return { tools, grants, toolSystem };
}

export function useWorkflowOverview(companyId: string | null | undefined) {
  return usePluginData<OverviewData>("workflow-overview", {
    companyId: companyId ?? "",
  });
}

export function useWorkflowRunDetail(runId: string | null | undefined) {
  return usePluginData<WorkflowRunDetailData | null>("workflow-run-detail", {
    runId: runId ?? "",
  });
}

export function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}
