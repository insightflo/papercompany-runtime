import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  worktreeApi,
  type WorktreeProposal,
  type ProposalStatus,
  type ProposedRuleChange,
} from "../api/worktree";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  GitPullRequest,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Clock,
  Bot,
} from "lucide-react";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PROPOSALS_PER_AGENT_PER_DAY = 3;

const STATUS_TABS: { label: string; value: ProposalStatus | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Pending", value: "proposed" },
  { label: "Approved", value: "approved" },
  { label: "Rejected", value: "rejected" },
];

const STATUS_STYLES: Record<ProposalStatus, { icon: React.ElementType; classes: string; label: string }> = {
  proposed: { icon: Clock, classes: "text-yellow-600 dark:text-yellow-400", label: "Pending" },
  approved: { icon: CheckCircle2, classes: "text-green-600 dark:text-green-400", label: "Approved" },
  rejected: { icon: XCircle, classes: "text-red-600 dark:text-red-400", label: "Rejected" },
};

const SEVERITY_COLORS: Record<string, string> = {
  MUST: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  SHOULD: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  MAY: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(date: string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

// ---------------------------------------------------------------------------
// DiffView — shows proposed change fields
// ---------------------------------------------------------------------------

function DiffView({ change }: { change: ProposedRuleChange }) {
  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1.5 items-start">
        <span className="text-muted-foreground font-medium pt-0.5">Name</span>
        <span className="font-medium">{change.name}</span>

        <span className="text-muted-foreground font-medium pt-0.5">Severity</span>
        <span>
          <span className={cn("px-1.5 py-0.5 rounded font-mono font-medium text-xs", SEVERITY_COLORS[change.severity] ?? "bg-muted text-muted-foreground")}>
            {change.severity}
          </span>
        </span>

        <span className="text-muted-foreground font-medium pt-0.5">Action</span>
        <span className="font-mono">{change.action}</span>

        {change.message && (
          <>
            <span className="text-muted-foreground font-medium pt-0.5">Message</span>
            <span className="text-muted-foreground">{change.message}</span>
          </>
        )}

        <span className="text-muted-foreground font-medium pt-0.5 self-start">Predicate</span>
        <pre className="bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
          {JSON.stringify(change.predicate, null, 2)}
        </pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReviewForm
// ---------------------------------------------------------------------------

interface ReviewFormProps {
  proposal: WorktreeProposal;
  agentMap: Record<string, string>;
  onDone: () => void;
}

function ReviewForm({ proposal, agentMap, onDone }: ReviewFormProps) {
  const queryClient = useQueryClient();
  const [reviewNote, setReviewNote] = useState("");
  const [reviewError, setReviewError] = useState<string | null>(null);

  // We need a reviewedByAgentId — use the proposedBy agent's counterpart or
  // a sentinel value; the server only validates it is non-empty.
  // In a real flow the logged-in user's agent ID would come from auth context.
  // For now we send "board" which the server accepts for board actors.
  const REVIEWER_ID = "board";

  const mutation = useMutation({
    mutationFn: (status: "approved" | "rejected") =>
      worktreeApi.reviewProposal(proposal.id, {
        status,
        reviewedByAgentId: REVIEWER_ID,
        reviewNote: reviewNote.trim() || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.worktree.proposals(proposal.companyId) });
      onDone();
    },
    onError: (err) => setReviewError(err instanceof Error ? err.message : "Review failed"),
  });

  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <textarea
        className="w-full h-16 text-xs rounded-md border border-input bg-background px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder="Review note (optional)"
        value={reviewNote}
        onChange={(e) => setReviewNote(e.target.value)}
      />
      {reviewError && <p className="text-xs text-destructive">{reviewError}</p>}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white"
          onClick={() => mutation.mutate("approved")}
          disabled={mutation.isPending}
        >
          <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs border-destructive text-destructive hover:bg-destructive/10"
          onClick={() => mutation.mutate("rejected")}
          disabled={mutation.isPending}
        >
          <XCircle className="h-3.5 w-3.5 mr-1.5" />
          Reject
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={onDone}
          disabled={mutation.isPending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProposalRow
// ---------------------------------------------------------------------------

interface ProposalRowProps {
  proposal: WorktreeProposal;
  agentMap: Record<string, string>;
}

function ProposalRow({ proposal, agentMap }: ProposalRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const status = proposal.status as ProposalStatus;
  const { icon: StatusIcon, classes: statusClasses, label: statusLabel } = STATUS_STYLES[status];
  const change = proposal.proposedChange;
  const isPending = status === "proposed";

  return (
    <div className="border-b border-border last:border-b-0">
      {/* Row header */}
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <button
          className="p-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => { setExpanded((v) => !v); if (reviewing) setReviewing(false); }}
        >
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        <GitPullRequest className="h-4 w-4 shrink-0 text-muted-foreground" />

        {/* Proposed change name */}
        <span className="flex-1 truncate font-medium">{change.name}</span>

        {/* Severity badge */}
        <span className={cn(
          "shrink-0 text-xs px-1.5 py-0.5 rounded font-mono font-medium hidden sm:inline",
          SEVERITY_COLORS[change.severity] ?? "bg-muted text-muted-foreground",
        )}>
          {change.severity}
        </span>

        {/* Agent */}
        <div className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground hidden md:flex">
          <Bot className="h-3.5 w-3.5" />
          <span>{agentMap[proposal.proposedBy] ?? proposal.proposedBy}</span>
        </div>

        {/* Date */}
        <span className="shrink-0 text-xs text-muted-foreground hidden lg:block">
          {formatDate(proposal.createdAt)}
        </span>

        {/* Status */}
        <div className={cn("shrink-0 flex items-center gap-1 text-xs", statusClasses)}>
          <StatusIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{statusLabel}</span>
        </div>

        {/* Review button — only for pending */}
        {isPending && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-xs shrink-0"
            onClick={() => { setExpanded(true); setReviewing((v) => !v); }}
          >
            Review
          </Button>
        )}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-10 pb-4 space-y-3">
          {/* Rationale */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Rationale</p>
            <p className="text-xs">{proposal.rationale}</p>
          </div>

          {/* Proposed change diff */}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Proposed rule</p>
            <DiffView change={change} />
          </div>

          {/* Review info if already decided */}
          {!isPending && proposal.reviewedBy && (
            <div className="text-xs text-muted-foreground space-y-0.5 border-t border-border pt-2">
              <p>
                <span className="font-medium text-foreground">Reviewed by:</span>{" "}
                {agentMap[proposal.reviewedBy] ?? proposal.reviewedBy}
              </p>
              <p>
                <span className="font-medium text-foreground">Reviewed at:</span>{" "}
                {formatDate(proposal.reviewedAt)}
              </p>
              {proposal.ruleId && (
                <p>
                  <span className="font-medium text-foreground">Rule ID:</span>{" "}
                  <span className="font-mono">{proposal.ruleId}</span>
                </p>
              )}
            </div>
          )}

          {/* Review form */}
          {reviewing && isPending && (
            <ReviewForm
              proposal={proposal}
              agentMap={agentMap}
              onDone={() => setReviewing(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentRateLimitBar — shows proposals used today per agent
// ---------------------------------------------------------------------------

interface AgentRateLimitBarProps {
  proposals: WorktreeProposal[];
  agentMap: Record<string, string>;
}

function AgentRateLimitBar({ proposals, agentMap }: AgentRateLimitBarProps) {
  // Count today's proposals per agent (client-side approximate — server is authoritative)
  const today = new Date().toDateString();
  const countByAgent: Record<string, number> = {};
  for (const p of proposals) {
    if (new Date(p.createdAt).toDateString() === today) {
      countByAgent[p.proposedBy] = (countByAgent[p.proposedBy] ?? 0) + 1;
    }
  }

  const agents = Object.entries(countByAgent).sort((a, b) => b[1] - a[1]);
  if (agents.length === 0) return null;

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Today's proposal usage</p>
      {agents.map(([agentId, count]) => (
        <div key={agentId} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              <Bot className="h-3 w-3 text-muted-foreground" />
              {agentMap[agentId] ?? agentId}
            </span>
            <span className={cn(
              "font-mono",
              count >= MAX_PROPOSALS_PER_AGENT_PER_DAY
                ? "text-destructive font-medium"
                : "text-muted-foreground",
            )}>
              {count}/{MAX_PROPOSALS_PER_AGENT_PER_DAY}
            </span>
          </div>
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                count >= MAX_PROPOSALS_PER_AGENT_PER_DAY ? "bg-destructive" : "bg-primary",
              )}
              style={{ width: `${Math.min((count / MAX_PROPOSALS_PER_AGENT_PER_DAY) * 100, 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorktreeProposals page
// ---------------------------------------------------------------------------

export function WorktreeProposals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [statusFilter, setStatusFilter] = useState<ProposalStatus | "all">("proposed");

  useEffect(() => {
    setBreadcrumbs([{ label: "Worktree Proposals" }]);
  }, [setBreadcrumbs]);

  const { data: proposals, isLoading, error } = useQuery({
    queryKey: queryKeys.worktree.proposals(selectedCompanyId!),
    queryFn: () => worktreeApi.listProposals(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap: Record<string, string> = agents
    ? Object.fromEntries(agents.map((a) => [a.id, a.name]))
    : {};

  if (!selectedCompanyId) {
    return <EmptyState icon={GitPullRequest} message="Select a company to view proposals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const allProposals = proposals ?? [];

  const filtered =
    statusFilter === "all"
      ? allProposals
      : allProposals.filter((p) => p.status === statusFilter);

  const countByStatus = (s: ProposalStatus) => allProposals.filter((p) => p.status === s).length;

  return (
    <div className="space-y-4">
      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_TABS.map((tab) => (
            <Button
              key={tab.value}
              size="sm"
              variant={statusFilter === tab.value ? "default" : "ghost"}
              className="h-7 text-xs"
              onClick={() => setStatusFilter(tab.value)}
            >
              {tab.label}
              {tab.value !== "all" && (
                <span className="ml-1 text-[10px] opacity-70">
                  {countByStatus(tab.value)}
                </span>
              )}
            </Button>
          ))}
        </div>
      </div>

      {/* Rate limit bar */}
      {allProposals.length > 0 && (
        <AgentRateLimitBar proposals={allProposals} agentMap={agentMap} />
      )}

      <Separator />

      {/* Empty state */}
      {filtered.length === 0 && (
        <EmptyState
          icon={GitPullRequest}
          message={
            statusFilter === "all"
              ? "No proposals yet."
              : statusFilter === "proposed"
              ? "No pending proposals."
              : `No ${statusFilter} proposals.`
          }
        />
      )}

      {/* Proposal list */}
      {filtered.length > 0 && (
        <div className="border border-border">
          {filtered.map((proposal) => (
            <ProposalRow
              key={proposal.id}
              proposal={proposal}
              agentMap={agentMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}
