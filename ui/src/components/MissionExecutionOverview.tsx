import { useMemo, useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { AgentRuntimeState } from "@paperclipai/shared";
import { AlertTriangle, BookOpen, Bot, GitBranch, Wrench } from "lucide-react";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { missionsApi, type MissionDetailItem, type MissionOwnerActionExplanationStatus } from "../api/missions";
import { MissionGovernanceThreadPanel } from "./MissionGovernanceThreadPanel";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

interface MissionExecutionOverviewProps {
  missionId: string;
  mission: MissionDetailItem;
}

function formatAuthorityLabel(value: AgentRuntimeState["sessionAuthority"] | undefined) {
  if (!value || value === "none") return "No active authority";
  return value.replace(/_/g, " ");
}

function formatRoleLabel(value: string) {
  return value.replace(/_/g, " ");
}

function formatShortDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatKnowledgeBaseLabel(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "Knowledge Base";

  const withoutPrefix = trimmed.replace(/^kb[-_:]*/i, "");
  const normalized = withoutPrefix
    .split(/[-_:]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (normalized.length === 0) return trimmed;

  const readable = normalized
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  return readable || trimmed;
}

function formatToolLabel(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "Tool";

  const normalized = trimmed
    .split(/[-_:]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (normalized.length === 0) return trimmed;

  return normalized
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}

function formatIssueLabel(issue: { identifier: string | null; id: string; title: string }) {
  return `${issue.identifier ?? issue.id} · ${issue.title}`;
}

function formatDecisionLabel(decision: string | null | undefined) {
  if (!decision) return "none";
  return decision.replace(/_/g, " ");
}

function missionOwnerStatusLabel(status: MissionOwnerActionExplanationStatus) {
  switch (status) {
    case "decision_required":
      return "Decision required";
    case "decision_recorded_read_only":
      return "Decision recorded, not applied";
    case "retry_applied_no_wakeup":
      return "Retry queued, no wakeup created";
    case "not_applicable_or_invalid":
      return "Invalid or not applicable";
  }
}

function missionOwnerStatusText(status: MissionOwnerActionExplanationStatus) {
  switch (status) {
    case "decision_required":
      return "오너 결정 필요 — source issue는 현재 담당자와 상태를 유지합니다.";
    case "decision_recorded_read_only":
      return "결정 기록됨, 아직 적용 안 됨 — 명시 적용 전까지 source issue는 그대로 유지됩니다.";
    case "retry_applied_no_wakeup":
      return "재시도 대기열 복귀, 자동 실행 없음 — source issue만 todo로 돌아갔고 wakeup은 만들지 않았습니다.";
    case "not_applicable_or_invalid":
      return "적용 불가/잘못된 결정 — 실행 동작 없이 상태만 표시합니다.";
  }
}

function SummaryCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-md border border-border p-4 space-y-2">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function MissionExecutionOverview({ missionId, mission }: MissionExecutionOverviewProps) {
  const { selectedCompanyId } = useCompany();
  const [openingWorkProductId, setOpeningWorkProductId] = useState<string | null>(null);
  const [openedWorkProductId, setOpenedWorkProductId] = useState<string | null>(null);
  const [workProductOpenError, setWorkProductOpenError] = useState<string | null>(null);

  async function handleOpenWorkProduct(productId: string): Promise<void> {
    setOpeningWorkProductId(productId);
    setOpenedWorkProductId(null);
    setWorkProductOpenError(null);
    try {
      await issuesApi.openWorkProduct(productId);
      setOpenedWorkProductId(productId);
    } catch (error) {
      setWorkProductOpenError(error instanceof Error ? error.message : "Failed to open work product");
    } finally {
      setOpeningWorkProductId(null);
    }
  }

  const { data: companyAgents, isLoading: agentsLoading, error: agentsError } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: issues, isLoading: issuesLoading, error: issuesError } = useQuery({
    queryKey: queryKeys.missions.issues(missionId),
    queryFn: () => missionsApi.listIssues(missionId),
    enabled: !!missionId,
  });
  const { data: workflowRuns, isLoading: runsLoading, error: runsError } = useQuery({
    queryKey: queryKeys.missions.workflowRuns(missionId),
    queryFn: () => missionsApi.listWorkflowRuns(missionId),
    enabled: !!missionId,
  });

  const runtimeStateQueries = useQueries({
    queries: mission.agents.map((entry) => ({
      queryKey: queryKeys.agents.runtimeState(entry.agentId),
      queryFn: () => agentsApi.runtimeState(entry.agentId, selectedCompanyId ?? undefined),
      enabled: !!selectedCompanyId,
    })),
  });

  const runtimeStates = useMemo(() => {
    const result = new Map<string, AgentRuntimeState | null>();
    mission.agents.forEach((entry, index) => {
      result.set(entry.agentId, runtimeStateQueries[index]?.data ?? null);
    });
    return result;
  }, [mission.agents, runtimeStateQueries]);

  const companyAgentMap = useMemo(
    () => new Map((companyAgents ?? []).map((agent) => [agent.id, agent])),
    [companyAgents],
  );
  const sessionBindingByAgentId = useMemo(
    () => new Map(mission.sessionBindings.map((binding) => [binding.agentId, binding])),
    [mission.sessionBindings],
  );

  const issueList = issues ?? [];
  const workflowRunList = workflowRuns ?? [];
  const blockedIssues = issueList.filter((issue) => issue.status === "blocked").length;
  const openIssues = issueList.filter((issue) => issue.status !== "done" && issue.status !== "cancelled").length;
  const reviewIssues = issueList.filter((issue) => issue.status === "in_review").length;
  const failedRuns = workflowRunList.filter((run) => run.status === "failed").length;
  const activeRuns = workflowRunList.filter((run) => run.status === "running" || run.status === "pending").length;
  const agentsUsingMissionSession = mission.agents.filter((entry) => {
    return runtimeStates.get(entry.agentId)?.sessionAuthority === "mission_session";
  }).length;
  const agentsWithErrors = mission.agents.filter((entry) => {
    return Boolean(runtimeStates.get(entry.agentId)?.lastError);
  }).length;
  const uniqueToolNames = Array.from(
    new Set(
      workflowRunList.flatMap((run) => run.steps.flatMap((step) => step.toolNames)),
    ),
  ).sort();
  const uniqueKnowledgeBaseIds = Array.from(
    new Set(
      workflowRunList.flatMap((run) => run.steps.flatMap((step) => step.knowledgeBaseIds)),
    ),
  ).sort();

  const hasPrimaryError = agentsError || issuesError || runsError;
  const runtimeStateError = runtimeStateQueries.find((query) => query.error)?.error ?? null;
  const primaryLoading = agentsLoading || issuesLoading || runsLoading;
  const runtimeLoading = runtimeStateQueries.some((query) => query.isLoading);

  if (hasPrimaryError) {
    return (
      <p className="text-sm text-destructive">
        {hasPrimaryError instanceof Error ? hasPrimaryError.message : "Failed to load mission execution overview."}
      </p>
    );
  }

  if (primaryLoading) {
    return (
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {["overview-work", "overview-runs", "overview-session", "overview-risks"].map((key) => (
          <div key={key} className="h-28 rounded-md bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Work"
          value={String(openIssues)}
          detail={`${blockedIssues} blocked, ${reviewIssues} in review`}
          icon={<Bot className="h-3.5 w-3.5" />}
        />
        <SummaryCard
          label="Workflow"
          value={String(workflowRunList.length)}
          detail={`${activeRuns} active, ${failedRuns} failed`}
          icon={<GitBranch className="h-3.5 w-3.5" />}
        />
        <SummaryCard
          label="Continuity"
          value={String(mission.sessionBindings.length)}
          detail={`${agentsUsingMissionSession}/${mission.agents.length} agents currently using mission session authority`}
          icon={<BookOpen className="h-3.5 w-3.5" />}
        />
        <SummaryCard
          label="Risks"
          value={String(blockedIssues + failedRuns + agentsWithErrors)}
          detail={`${agentsWithErrors} agents with runtime errors`}
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
        />
      </div>

      <MissionGovernanceThreadPanel missionId={missionId} />

      <section className="rounded-md border border-border p-4 space-y-3" aria-label="Mission owner status">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Mission owner status</h3>
            <p className="text-xs text-muted-foreground">Read-only owner-action decisions and source issue status</p>
          </div>
          <span className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">read-only</span>
        </div>
        {(mission.ownerActionExplanations ?? []).length > 0 ? (
          <div className="space-y-2">
            {(mission.ownerActionExplanations ?? []).map((item) => (
              <article key={item.ownerActionIssue.id} className="rounded border border-border/70 px-3 py-2 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{formatIssueLabel(item.ownerActionIssue)}</p>
                    <p className="text-xs text-muted-foreground">Owner-action status: {item.ownerActionIssue.status}</p>
                  </div>
                  <span className="rounded border border-border px-2 py-1 text-xs text-muted-foreground">
                    {missionOwnerStatusLabel(item.status)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{missionOwnerStatusText(item.status)}</p>
                {item.sourceIssue ? (
                  <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <span>Source: {formatIssueLabel(item.sourceIssue)}</span>
                    <span>Source status: {item.sourceIssue.status}</span>
                    <span>Assignee: {item.sourceIssue.assigneeAgentId ?? "unassigned"}</span>
                    <span>Decision: {formatDecisionLabel(item.latestDecision?.decision)}</span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Source issue unavailable for this mission.</p>
                )}
              </article>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No owner-action status to show.</p>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="rounded-md border border-border p-4 space-y-3">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Mission Continuity</h3>
          </div>
          {runtimeStateError ? (
            <p className="text-sm text-destructive">
              {runtimeStateError instanceof Error ? runtimeStateError.message : "Failed to load agent runtime state."}
            </p>
          ) : null}
          {mission.agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No mission agents assigned yet.</p>
          ) : (
            <div className="space-y-2">
              {mission.agents.map((entry) => {
                const agent = companyAgentMap.get(entry.agentId);
                const runtimeState = runtimeStates.get(entry.agentId);
                const binding = sessionBindingByAgentId.get(entry.agentId);

                return (
                  <div key={entry.agentId} className="rounded border border-border/70 px-3 py-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{agent?.name ?? entry.agentName ?? entry.agentId}</span>
                          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {formatRoleLabel(entry.role)}
                          </span>
                          {agent?.status ? (
                            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                              {formatRoleLabel(agent.status)}
                            </span>
                          ) : null}
                        </div>
                        <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                          <span>Authority: {formatAuthorityLabel(runtimeState?.sessionAuthority)}</span>
                          <span>
                            Binding: {binding ? `${binding.status} (${binding.runCount} runs)` : "none"}
                          </span>
                          <span>Last active: {formatShortDate(binding?.lastActiveAt ?? null)}</span>
                          {runtimeState?.lastRunStatus ? <span>Last run: {runtimeState.lastRunStatus}</span> : null}
                        </div>
                        {runtimeState?.lastError ? (
                          <p className="text-xs text-destructive">{runtimeState.lastError}</p>
                        ) : null}
                      </div>
                      <div className="shrink-0 text-right text-xs text-muted-foreground">
                        <div>{runtimeLoading ? "Loading runtime..." : runtimeState?.sessionDisplayId ?? runtimeState?.sessionId ?? "No session"}</div>
                        {runtimeState?.latestMissionSession ? (
                          <div>
                            latest mission {runtimeState.latestMissionSession.missionId.slice(0, 8)}...
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-md border border-border p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Delivery Contract</h3>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded border border-border/70 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Tool coverage</p>
              <p className="mt-1 text-sm font-medium">{uniqueToolNames.length} unique tools across {workflowRunList.length} workflow runs</p>
            </div>
            <div className="rounded border border-border/70 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Knowledge coverage</p>
              <p className="mt-1 text-sm font-medium">{uniqueKnowledgeBaseIds.length} knowledge bases across {workflowRunList.length} workflow runs</p>
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Tools</p>
              {uniqueToolNames.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {uniqueToolNames.map((toolName) => (
                    <span
                      key={toolName}
                      title={toolName}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                    >
                      {formatToolLabel(toolName)}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No workflow-owned tools attached.</p>
              )}
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Workflow runs</p>
              {workflowRunList.length > 0 ? (
                <div className="space-y-2">
                  {workflowRunList.map((run) => {
                    const runToolNames = Array.from(
                      new Set(run.steps.flatMap((step) => step.toolNames).filter((toolName) => toolName.trim().length > 0)),
                    );
                    const runKnowledgeBaseIds = Array.from(
                      new Set(
                        run.steps.flatMap((step) => step.knowledgeBaseIds).filter((knowledgeBaseId) => knowledgeBaseId.trim().length > 0),
                      ),
                    );
                    const runWorkProducts = run.steps.flatMap((step) => step.workProducts ?? []);

                    return (
                      <div key={run.id} className="rounded border border-border/70 px-3 py-2 space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-foreground">{run.id}</span>
                          <span className="rounded border border-border px-1.5 py-0.5 uppercase tracking-wide text-muted-foreground">
                            {run.status}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground space-y-1">
                          <div>
                            Tools:{" "}
                            {runToolNames.length > 0
                              ? runToolNames.map((toolName) => formatToolLabel(toolName)).join(", ")
                              : "none"}
                          </div>
                          <div>
                            Knowledge:{" "}
                            {runKnowledgeBaseIds.length > 0
                              ? runKnowledgeBaseIds.map((knowledgeBaseId) => formatKnowledgeBaseLabel(knowledgeBaseId)).join(", ")
                              : "none"}
                          </div>
                          <div>
                            Work products:{" "}
                            {runWorkProducts.length > 0 ? `${runWorkProducts.length} outputs` : "none"}
                          </div>
                        </div>
                        {runWorkProducts.length > 0 ? (
                          <div className="space-y-1.5 border-t border-border/70 pt-2">
                            {runWorkProducts.map((product) => (
                              <div key={product.id} className="rounded border border-border/70 px-2 py-1.5 space-y-1">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <div className="min-w-0 space-y-0.5">
                                    {product.url ? (
                                      <a
                                        href={product.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-xs font-medium text-blue-400 hover:underline break-words"
                                      >
                                        {product.title}
                                      </a>
                                    ) : (
                                      <p className="text-xs font-medium text-foreground break-words">{product.title}</p>
                                    )}
                                    {openedWorkProductId === product.id ? (
                                      <p className="text-[11px] text-emerald-400">Opened</p>
                                    ) : null}
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1.5">
                                    {product.isPrimary ? (
                                      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                        Primary
                                      </span>
                                    ) : null}
                                    <button
                                      type="button"
                                      className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
                                      disabled={openingWorkProductId === product.id}
                                      onClick={() => void handleOpenWorkProduct(product.id)}
                                      title="Open with the operating system"
                                    >
                                      {openingWorkProductId === product.id ? "Opening" : "Open"}
                                    </button>
                                  </div>
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {product.type}
                                  </span>
                                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {product.status}
                                  </span>
                                </div>
                                {product.summary ? <p className="text-[11px] text-muted-foreground break-words">{product.summary}</p> : null}
                              </div>
                            ))}
                            {workProductOpenError ? (
                              <p className="text-[11px] text-destructive break-words">{workProductOpenError}</p>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No workflow runs recorded yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
