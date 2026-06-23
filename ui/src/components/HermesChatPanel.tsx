import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Company,
  HermesChatAttachment,
  HermesChatMessage,
  HermesChatPageContext,
  HermesChatSession,
  Issue,
  IssueComment,
  IssueWorkProduct,
} from "@paperclipai/shared";
import {
  Archive,
  Bot,
  Eye,
  MessageSquareText,
  Paperclip,
  PanelLeft,
  Plus,
  RefreshCw,
  Send,
  X,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { hermesChatApi } from "../api/hermesChat";
import { issuesApi } from "../api/issues";
import { missionsApi, type MissionDetailItem, type MissionWorkflowRun } from "../api/missions";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { useLocation } from "../lib/router";
import { EmptyState } from "./EmptyState";
import { MarkdownBody } from "./MarkdownBody";
import { PageSkeleton } from "./PageSkeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

const RUNNING_STATUSES = new Set(["queued", "running"]);
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

type HermesChatPanelMode = "page" | "sidebar";

interface HermesChatPanelProps {
  mode?: HermesChatPanelMode;
  onCollapse?: () => void;
}

function sessionTitle(session: HermesChatSession) {
  return session.title?.trim() || "New Hermes chat";
}

function messageStatusLabel(message: HermesChatMessage) {
  if (message.status === "queued") return "queued";
  if (message.status === "running") return "running";
  if (message.status === "failed") return "failed";
  if (message.status === "timed_out") return "timed out";
  if (message.status === "cancelled") return "cancelled";
  return null;
}

function hasPendingMessage(messages: HermesChatMessage[]) {
  return messages.some((message) => RUNNING_STATUSES.has(message.status));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageAttachments(message: HermesChatMessage): HermesChatAttachment[] {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const attachments = metadata && Array.isArray(metadata.attachments) ? metadata.attachments : [];
  return attachments.filter((entry): entry is HermesChatAttachment =>
    isRecord(entry) &&
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.contentType === "string" &&
    typeof entry.size === "number");
}

function readFileAttachment(file: File): Promise<HermesChatAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return Promise.reject(new Error(`${file.name} is larger than 8MB.`));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const isImage = file.type.startsWith("image/");
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        contentType: file.type || "application/octet-stream",
        size: file.size,
        kind: isImage ? "image" : "file",
        ...(isImage ? { dataUrl: result } : { text: result }),
      });
    };

    if (file.type.startsWith("image/")) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

function countByStatus(items: Array<{ status: string }>) {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
}

type MissionPageWorkItemContext = {
  issue: Issue;
  comments: Array<Pick<IssueComment, "id" | "body" | "createdAt" | "authorAgentId" | "authorUserId">>;
  workProducts: Array<Pick<IssueWorkProduct, "id" | "title" | "type" | "provider" | "externalId" | "url" | "status" | "metadata" | "isPrimary">>;
};

function serializeWorkItemContext(item: MissionPageWorkItemContext) {
  return {
    id: item.issue.id,
    identifier: item.issue.identifier,
    title: item.issue.title,
    description: item.issue.description,
    status: item.issue.status,
    priority: item.issue.priority,
    assigneeAgentId: item.issue.assigneeAgentId,
    checkoutRunId: item.issue.checkoutRunId,
    executionRunId: item.issue.executionRunId,
    originKind: item.issue.originKind ?? null,
    originRunId: item.issue.originRunId ?? null,
    startedAt: item.issue.startedAt,
    completedAt: item.issue.completedAt,
    workProducts: {
      total: item.workProducts.length,
      latest: item.workProducts.slice(0, 6).map((product) => ({
        id: product.id,
        title: product.title ?? null,
        type: product.type ?? null,
        provider: product.provider ?? null,
        externalId: product.externalId ?? null,
        url: product.url ?? null,
        status: product.status ?? null,
        metadata: product.metadata ?? null,
        isPrimary: product.isPrimary ?? false,
      })),
    },
    latestComments: item.comments.slice(-6).map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      authorAgentId: comment.authorAgentId ?? null,
      authorUserId: comment.authorUserId ?? null,
    })),
  };
}

function attentionIssueScore(issue: Issue) {
  const text = `${issue.identifier ?? ""} ${issue.title} ${issue.description ?? ""}`.toLowerCase();
  let score = 0;
  if (issue.status === "blocked") score += 100;
  if (issue.status === "in_progress" || issue.status === "in_review") score += 40;
  if (issue.status === "todo" || issue.status === "backlog") score += 20;
  if (text.includes("qa") || text.includes("request_changes") || text.includes("request changes")) score += 35;
  if (text.includes("fail") || text.includes("failed") || text.includes("blocked")) score += 30;
  if (text.includes("recovery") || text.includes("retry")) score += 20;
  if (issue.executionRunId || issue.checkoutRunId || issue.originRunId) score += 10;
  return score;
}

async function loadWorkItemContext(issue: Issue): Promise<MissionPageWorkItemContext> {
  const [comments, workProducts] = await Promise.all([
    issuesApi.listComments(issue.id).catch(() => []),
    issuesApi.listWorkProducts(issue.id).catch(() => []),
  ]);
  return {
    issue,
    comments: comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      authorAgentId: comment.authorAgentId ?? null,
      authorUserId: comment.authorUserId ?? null,
    })),
    workProducts: workProducts.map((product) => ({
      id: product.id,
      title: product.title ?? null,
      type: product.type,
      provider: product.provider,
      externalId: product.externalId ?? null,
      url: product.url ?? null,
      status: product.status,
      metadata: product.metadata ?? null,
      isPrimary: product.isPrimary,
    })),
  };
}

function visiblePath(pathname: string, search: string) {
  return `${pathname}${search}`;
}

function routeParts(pathname: string, company: Company | null) {
  const parts = pathname.split("/").filter(Boolean);
  const companyPrefix = company?.issuePrefix ?? null;
  const hasCompanyPrefix = companyPrefix
    ? parts[0]?.toLowerCase() === companyPrefix.toLowerCase()
    : parts.length > 1 && /^[a-z0-9]{2,12}$/i.test(parts[0] ?? "");
  return {
    companyPrefix: hasCompanyPrefix ? parts[0] ?? companyPrefix : companyPrefix,
    parts: hasCompanyPrefix ? parts.slice(1) : parts,
  };
}

function fallbackPageContext({
  pathname,
  search,
  company,
  kind = "route",
  summary,
  facts,
}: {
  pathname: string;
  search: string;
  company: Company | null;
  kind?: string;
  summary?: string;
  facts?: Record<string, unknown>;
}): HermesChatPageContext {
  const route = routeParts(pathname, company);
  const path = visiblePath(pathname, search);
  return {
    kind,
    path,
    url: typeof window === "undefined" ? path : window.location.href,
    companyId: company?.id ?? null,
    companyName: company?.name ?? null,
    companyPrefix: route.companyPrefix ?? null,
    title: route.parts[0] ? route.parts.join(" / ") : "Dashboard",
    summary: summary ?? `Current Paperclip route: ${path}`,
    facts,
    loadedAt: new Date().toISOString(),
  };
}

function summarizeMissionPage(
  mission: MissionDetailItem,
  issues: Issue[],
  workflowRuns: MissionWorkflowRun[],
  pathname: string,
  search: string,
  company: Company | null,
  selectedWorkItem?: MissionPageWorkItemContext | null,
  attentionWorkItems: MissionPageWorkItemContext[] = [],
): HermesChatPageContext {
  const issueCounts = countByStatus(issues);
  const workflowRunCounts = countByStatus(workflowRuns);
  const openIssueCount = issues.filter((issue) => !["done", "completed", "cancelled"].includes(issue.status)).length;
  const blockedIssueCount = issues.filter((issue) => issue.status === "blocked").length;
  const latestWorkflowRuns = workflowRuns.slice(0, 5).map((run) => ({
    id: run.id,
    workflowId: run.workflowId,
    name: run.workflowName,
    status: run.status,
    progress: run.progress,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
  }));
  const decisionRequiredCount = mission.ownerActionExplanations?.filter((entry) => entry.status === "decision_required").length ?? 0;
  const route = routeParts(pathname, company);
  const path = visiblePath(pathname, search);

  return {
    kind: "mission",
    path,
    url: typeof window === "undefined" ? path : window.location.href,
    companyId: company?.id ?? mission.companyId,
    companyName: company?.name ?? null,
    companyPrefix: route.companyPrefix ?? null,
    entityId: mission.id,
    title: mission.title,
    status: mission.status,
    summary: [
      `Mission "${mission.title}" is ${mission.status}.`,
      `${issues.length} issues (${openIssueCount} open, ${blockedIssueCount} blocked).`,
      `${workflowRuns.length} workflow runs.`,
      selectedWorkItem ? `Selected work item ${selectedWorkItem.issue.identifier ?? selectedWorkItem.issue.id} is ${selectedWorkItem.issue.status}.` : null,
      attentionWorkItems.length > 0 ? `${attentionWorkItems.length} attention work items loaded with recent comments.` : null,
      decisionRequiredCount > 0 ? `${decisionRequiredCount} owner decisions required.` : null,
    ].filter(Boolean).join(" "),
    facts: {
      missionId: mission.id,
      ownerAgentId: mission.ownerAgentId,
      ownerAgentName: mission.ownerAgentName ?? null,
      agents: mission.agents.map((agent) => ({
        agentId: agent.agentId,
        role: agent.role,
        agentName: agent.agentName ?? null,
      })),
      issues: {
        total: issues.length,
        byStatus: issueCounts,
        openCount: openIssueCount,
        blockedCount: blockedIssueCount,
        latest: issues.slice(0, 8).map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          assigneeAgentId: issue.assigneeAgentId,
          originKind: issue.originKind ?? null,
        })),
      },
      selectedWorkItem: selectedWorkItem
        ? serializeWorkItemContext(selectedWorkItem)
        : null,
      attentionWorkItems: attentionWorkItems.map(serializeWorkItemContext),
      workflowRuns: {
        total: workflowRuns.length,
        byStatus: workflowRunCounts,
        latest: latestWorkflowRuns,
      },
      activeMissionPlan: mission.activeMissionPlan
        ? {
            available: mission.activeMissionPlan.available,
            status: mission.activeMissionPlan.status ?? null,
            stepCount: mission.activeMissionPlan.stepCount ?? null,
            executionUnitCount: mission.activeMissionPlan.executionUnitCount ?? null,
            selectedExecutionUnitCount: mission.activeMissionPlan.selectedExecutionUnitCount ?? null,
            blockedOrFailedUnitCount: mission.activeMissionPlan.blockedOrFailedUnitCount ?? null,
          }
        : null,
      ownerActions: {
        decisionRequiredCount,
        explanations: mission.ownerActionExplanations?.slice(0, 5).map((entry) => ({
          status: entry.status,
          explanation: entry.explanation,
          issue: entry.ownerActionIssue,
        })) ?? [],
      },
    },
    loadedAt: new Date().toISOString(),
  };
}

function summarizeIssuePage(
  issue: Issue,
  workProductCount: number,
  pathname: string,
  search: string,
  company: Company | null,
): HermesChatPageContext {
  const route = routeParts(pathname, company);
  const path = visiblePath(pathname, search);
  return {
    kind: "issue",
    path,
    url: typeof window === "undefined" ? path : window.location.href,
    companyId: company?.id ?? issue.companyId,
    companyName: company?.name ?? null,
    companyPrefix: route.companyPrefix ?? null,
    entityId: issue.id,
    title: issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title,
    status: issue.status,
    summary: `Issue "${issue.title}" is ${issue.status}; ${workProductCount} registered work products.`,
    facts: {
      issueId: issue.id,
      identifier: issue.identifier,
      status: issue.status,
      priority: issue.priority,
      assigneeAgentId: issue.assigneeAgentId,
      checkoutRunId: issue.checkoutRunId,
      executionRunId: issue.executionRunId,
      originKind: issue.originKind ?? null,
      originId: issue.originId ?? null,
      workProductCount,
    },
    loadedAt: new Date().toISOString(),
  };
}

async function loadPageContext(
  pathname: string,
  search: string,
  company: Company | null,
): Promise<HermesChatPageContext> {
  const route = routeParts(pathname, company);
  const [section, id] = route.parts;
  const selectedIssueId = new URLSearchParams(search).get("issue")
    ?? new URLSearchParams(search).get("workItem")
    ?? new URLSearchParams(search).get("selectedIssueId");

  try {
    if (section === "missions" && id) {
      const [mission, issues, workflowRuns] = await Promise.all([
        missionsApi.get(id),
        missionsApi.listIssues(id).catch(() => []),
        missionsApi.listWorkflowRuns(id).catch(() => []),
      ]);
      const selectedWorkItem = selectedIssueId
        ? await issuesApi.get(selectedIssueId)
            .then(loadWorkItemContext)
            .catch(() => null)
        : null;
      const selectedLoadedId = selectedWorkItem?.issue.id ?? selectedIssueId ?? null;
      const attentionIssues = issues
        .filter((issue) => issue.id !== selectedLoadedId)
        .map((issue) => ({ issue, score: attentionIssueScore(issue) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, 4)
        .map((entry) => entry.issue);
      const attentionWorkItems = await Promise.all(attentionIssues.map(loadWorkItemContext));
      return summarizeMissionPage(mission, issues, workflowRuns, pathname, search, company, selectedWorkItem, attentionWorkItems);
    }

    if ((section === "issues" || section === "work-items") && id) {
      const issue = await issuesApi.get(id);
      const workProducts = await issuesApi.listWorkProducts(id).catch(() => []);
      return summarizeIssuePage(issue, workProducts.length, pathname, search, company);
    }
  } catch (error) {
    return fallbackPageContext({
      pathname,
      search,
      company,
      kind: section ? `${section}:unavailable` : "route:unavailable",
      summary: `Current route is ${visiblePath(pathname, search)}, but page detail could not be loaded.`,
      facts: {
        routeSection: section ?? null,
        entityId: id ?? null,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }

  return fallbackPageContext({ pathname, search, company });
}

function PageContextStrip({
  context,
  loading,
  compact,
}: {
  context: HermesChatPageContext | undefined;
  loading: boolean;
  compact: boolean;
}) {
  return (
    <div className={cn("shrink-0 border-b border-border bg-muted/35", compact ? "px-3 py-2" : "px-4 py-2")}>
      <div className={cn("flex items-center gap-2 text-xs", compact ? "" : "mx-auto max-w-4xl")}>
        <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-muted-foreground">
          {loading ? "Reading page" : "Page context"}
        </span>
        <span className="min-w-0 truncate text-foreground">
          {context?.summary ?? context?.path ?? "Current route"}
        </span>
      </div>
    </div>
  );
}

function MessageBubble({ message, compact = false }: { message: HermesChatMessage; compact?: boolean }) {
  const isUser = message.role === "user";
  const status = messageStatusLabel(message);
  const attachments = messageAttachments(message);

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "rounded-lg border px-3 py-2 text-sm",
          compact ? "max-w-[92%]" : "max-w-[78ch]",
          isUser
            ? "border-primary/30 bg-primary text-primary-foreground"
            : "border-border bg-card text-card-foreground",
          message.status === "failed" && "border-destructive/40",
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-[11px] opacity-75">
          {isUser ? <span>Operator</span> : <span>Hermes</span>}
          <span>{relativeTime(message.createdAt)}</span>
          {status && (
            <Badge variant={message.status === "failed" ? "destructive" : "secondary"} className="h-4 px-1.5 text-[10px]">
              {status}
            </Badge>
          )}
        </div>
        {message.role === "assistant" ? (
          <MarkdownBody className="text-sm [&_p]:my-1 [&_pre]:my-2">
            {message.body}
          </MarkdownBody>
        ) : (
          <div className="whitespace-pre-wrap break-words">{message.body}</div>
        )}
        {attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex max-w-full items-center gap-1 rounded border border-border/70 bg-background/70 px-1.5 py-0.5 text-[11px]"
              >
                <Paperclip className="h-3 w-3 shrink-0" />
                <span className="truncate">{attachment.name}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: HermesChatSession;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full border-b border-border px-3 py-2 text-left transition-colors hover:bg-accent/50",
        selected && "bg-accent text-accent-foreground",
      )}
    >
      <div className="flex items-center gap-2">
        <MessageSquareText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{sessionTitle(session)}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-6 text-xs text-muted-foreground">
        <span>{session.lastMessageAt ? relativeTime(session.lastMessageAt) : relativeTime(session.createdAt)}</span>
        {session.messageCount !== undefined && <span>{session.messageCount} msg</span>}
      </div>
    </button>
  );
}

function SessionsList({
  loading,
  sessions,
  selectedSessionId,
  onSelect,
  onCreate,
  createPending,
  compact = false,
}: {
  loading: boolean;
  sessions: HermesChatSession[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  createPending: boolean;
  compact?: boolean;
}) {
  if (loading) {
    return compact ? (
      <div className="space-y-2 p-3">
        <PageSkeleton variant="list" />
      </div>
    ) : (
      <PageSkeleton variant="list" />
    );
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={MessageSquareText}
        message="No Hermes sessions."
        action="New Session"
        onAction={onCreate}
      />
    );
  }

  return (
    <>
      {sessions.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          selected={session.id === selectedSessionId}
          onSelect={() => onSelect(session.id)}
        />
      ))}
      {compact && (
        <div className="p-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onCreate}
            disabled={createPending}
          >
            <Plus className="h-4 w-4" />
            New Session
          </Button>
        </div>
      )}
    </>
  );
}

export function HermesChatPanel({ mode = "page", onCollapse }: HermesChatPanelProps) {
  const compact = mode === "sidebar";
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<HermesChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sessionListOpen, setSessionListOpen] = useState(!compact);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (mode !== "page") return;
    setBreadcrumbs([{ label: "Hermes" }]);
  }, [mode, setBreadcrumbs]);

  const sessionsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.hermesChat.sessions(selectedCompanyId) : ["hermes-chat", "no-company"],
    queryFn: () => hermesChatApi.listSessions(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const pageContextQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.hermesChat.pageContext(selectedCompanyId, location.pathname, location.search)
      : ["hermes-chat", "no-company", "page-context"],
    queryFn: () => loadPageContext(location.pathname, location.search, selectedCompany),
    enabled: !!selectedCompanyId,
    refetchInterval: compact ? 15_000 : false,
    retry: false,
  });

  const activeSessions = useMemo(
    () => (sessionsQuery.data ?? []).filter((session) => session.status === "active"),
    [sessionsQuery.data],
  );

  useEffect(() => {
    if (!selectedSessionId && activeSessions[0]) {
      setSelectedSessionId(activeSessions[0].id);
    }
    if (selectedSessionId && activeSessions.length > 0 && !activeSessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(activeSessions[0]?.id ?? null);
    }
  }, [activeSessions, selectedSessionId]);

  const detailQuery = useQuery({
    queryKey: selectedCompanyId && selectedSessionId
      ? queryKeys.hermesChat.detail(selectedCompanyId, selectedSessionId)
      : ["hermes-chat", "no-session"],
    queryFn: () => hermesChatApi.getSession(selectedCompanyId!, selectedSessionId!),
    enabled: !!selectedCompanyId && !!selectedSessionId,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && hasPendingMessage(data.messages) ? 2_000 : false;
    },
    refetchIntervalInBackground: true,
  });

  const createSessionMutation = useMutation({
    mutationFn: () => hermesChatApi.createSession(selectedCompanyId!, {}),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hermesChat.sessions(session.companyId) });
      setSelectedSessionId(session.id);
      setSessionListOpen(false);
    },
  });

  const archiveSessionMutation = useMutation({
    mutationFn: (sessionId: string) => hermesChatApi.updateSession(selectedCompanyId!, sessionId, { status: "archived" }),
    onSuccess: (_, sessionId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hermesChat.sessions(selectedCompanyId!) });
      if (selectedSessionId === sessionId) setSelectedSessionId(null);
    },
  });

  const sendMutation = useMutation({
    mutationFn: async (input: { body: string; attachments: HermesChatAttachment[] }) => {
      let sessionId = selectedSessionId;
      if (!sessionId) {
        const session = await hermesChatApi.createSession(selectedCompanyId!, {});
        sessionId = session.id;
        setSelectedSessionId(session.id);
      }
      const pageContext = pageContextQuery.data
        ?? fallbackPageContext({
          pathname: location.pathname,
          search: location.search,
          company: selectedCompany,
        });
      return hermesChatApi.sendMessage(selectedCompanyId!, sessionId, {
        body: input.body,
        pageContext,
        attachments: input.attachments,
      });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hermesChat.sessions(result.session.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.hermesChat.detail(result.session.companyId, result.session.id) });
      setSelectedSessionId(result.session.id);
    },
  });

  const messages = detailQuery.data?.messages ?? [];
  const currentTitle = detailQuery.data?.session
    ? sessionTitle(detailQuery.data.session)
    : activeSessions.find((session) => session.id === selectedSessionId)
      ? sessionTitle(activeSessions.find((session) => session.id === selectedSessionId)!)
      : "Hermes";
  const canSend =
    !!selectedCompanyId &&
    (draft.trim().length > 0 || attachments.length > 0) &&
    !sendMutation.isPending &&
    !pageContextQuery.isLoading;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, detailQuery.dataUpdatedAt]);

  function submit() {
    const body = draft.trim();
    if (!canSend) return;
    const outgoingAttachments = attachments;
    setDraft("");
    setAttachments([]);
    setAttachmentError(null);
    sendMutation.mutate({ body, attachments: outgoingAttachments });
  }

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setAttachmentError(null);
    try {
      const remainingSlots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
      const nextFiles = Array.from(files).slice(0, remainingSlots);
      const nextAttachments = await Promise.all(nextFiles.map(readFileAttachment));
      setAttachments((current) => [...current, ...nextAttachments].slice(0, MAX_ATTACHMENTS));
      if (files.length > remainingSlots) {
        setAttachmentError(`Only ${MAX_ATTACHMENTS} attachments can be sent at once.`);
      }
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Failed to attach file.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  if (!selectedCompanyId) {
    return (
      <div className={cn(compact ? "h-full border-l border-border bg-background" : "")}>
        <EmptyState icon={Bot} message="Select a company." />
      </div>
    );
  }

  const chatColumn = (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setSessionListOpen((value) => !value)}
          aria-label="Toggle Hermes sessions"
          title="Toggle Hermes sessions"
        >
          <PanelLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{currentTitle}</h1>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => detailQuery.refetch()}
          disabled={!selectedSessionId || detailQuery.isFetching}
          aria-label="Refresh Hermes"
          title="Refresh Hermes"
        >
          <RefreshCw className={cn("h-4 w-4", detailQuery.isFetching && "animate-spin")} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => selectedSessionId && archiveSessionMutation.mutate(selectedSessionId)}
          disabled={!selectedSessionId || archiveSessionMutation.isPending}
          aria-label="Archive Hermes session"
          title="Archive Hermes session"
        >
          <Archive className="h-4 w-4" />
        </Button>
        {compact && onCollapse && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onCollapse}
            aria-label="Collapse Hermes"
            title="Collapse Hermes"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <PageContextStrip
        context={pageContextQuery.data}
        loading={pageContextQuery.isLoading || pageContextQuery.isFetching}
        compact={compact}
      />

      {compact && sessionListOpen && (
        <div className="max-h-56 shrink-0 overflow-y-auto border-b border-border bg-card">
          <SessionsList
            loading={sessionsQuery.isLoading}
            sessions={activeSessions}
            selectedSessionId={selectedSessionId}
            onSelect={(sessionId) => {
              setSelectedSessionId(sessionId);
              setSessionListOpen(false);
            }}
            onCreate={() => createSessionMutation.mutate()}
            createPending={createSessionMutation.isPending}
            compact
          />
        </div>
      )}

      <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", compact ? "px-3 py-3" : "px-4 py-4")}>
        {detailQuery.isLoading && selectedSessionId ? (
          <PageSkeleton variant="detail" />
        ) : messages.length === 0 ? (
          <EmptyState icon={MessageSquareText} message="No messages." />
        ) : (
          <div className={cn("flex flex-col gap-3", compact ? "w-full" : "mx-auto max-w-4xl")}>
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} compact={compact} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <div className="sticky bottom-0 z-10 shrink-0 border-t border-border bg-card p-3">
        {attachments.length > 0 && (
          <div className={cn("mb-2 flex flex-wrap gap-1.5", compact ? "" : "mx-auto max-w-4xl")}>
            {attachments.map((attachment) => (
              <button
                key={attachment.id}
                type="button"
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent/50"
                onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                title="Remove attachment"
              >
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{attachment.name}</span>
                <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}
        <div className={cn("flex items-end gap-2", compact ? "w-full" : "mx-auto max-w-4xl")}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept="image/*,.txt,.md,.json,.csv,.html,.css,.js,.ts,.tsx,.py,.log"
            onChange={(event) => void addFiles(event.currentTarget.files)}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0"
            onClick={() => fileInputRef.current?.click()}
            disabled={attachments.length >= MAX_ATTACHMENTS || sendMutation.isPending}
            aria-label="Attach file"
            title="Attach file"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Ask Hermes..."
            className="min-h-11 max-h-40 resize-none"
          />
          <Button type="button" onClick={submit} disabled={!canSend} className="shrink-0">
            <Send className="h-4 w-4" />
            <span className="sr-only">Send</span>
          </Button>
        </div>
        {sendMutation.error && (
          <p className={cn("mt-2 text-xs text-destructive", compact ? "" : "mx-auto max-w-4xl")}>
            {sendMutation.error instanceof Error ? sendMutation.error.message : "Failed to send message"}
          </p>
        )}
        {attachmentError && (
          <p className={cn("mt-2 text-xs text-destructive", compact ? "" : "mx-auto max-w-4xl")}>
            {attachmentError}
          </p>
        )}
      </div>
    </section>
  );

  if (compact) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">Hermes</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => createSessionMutation.mutate()}
            disabled={createSessionMutation.isPending}
            aria-label="New Hermes session"
            title="New Hermes session"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        {chatColumn}
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] min-h-[520px] overflow-hidden border border-border bg-background">
      <aside
        className={cn(
          "min-h-0 border-r border-border bg-card transition-[width] duration-100",
          sessionListOpen ? "w-72" : "w-0",
        )}
      >
        <div className="flex h-full w-72 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 text-sm font-semibold">Hermes</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => createSessionMutation.mutate()}
              disabled={createSessionMutation.isPending}
              aria-label="New Hermes session"
              title="New Hermes session"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SessionsList
              loading={sessionsQuery.isLoading}
              sessions={activeSessions}
              selectedSessionId={selectedSessionId}
              onSelect={setSelectedSessionId}
              onCreate={() => createSessionMutation.mutate()}
              createPending={createSessionMutation.isPending}
            />
          </div>
        </div>
      </aside>
      {chatColumn}
    </div>
  );
}
