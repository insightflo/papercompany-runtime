import { useQuery } from "@tanstack/react-query";
import { missionsApi, type MissionAgentRole } from "../api/missions";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { GitBranch, User } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkflowDagPanelProps {
  missionId: string;
}

const ROLE_ORDER: MissionAgentRole[] = [
  "owner",
  "executor",
  "reviewer",
  "specialist",
  "observer",
];

const ROLE_COLORS: Record<MissionAgentRole, string> = {
  owner: "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  executor: "border-yellow-500 bg-yellow-50 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-300",
  reviewer: "border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  specialist: "border-cyan-500 bg-cyan-50 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300",
  observer: "border-neutral-400 bg-neutral-50 text-neutral-600 dark:bg-neutral-900/40 dark:text-neutral-400",
};

// ---------------------------------------------------------------------------
// WorkflowDagPanel
// ---------------------------------------------------------------------------

export function WorkflowDagPanel({ missionId }: WorkflowDagPanelProps) {
  const { selectedCompanyId } = useCompany();

  const { data: mission, isLoading: missionLoading } = useQuery({
    queryKey: queryKeys.missions.detail(missionId),
    queryFn: () => missionsApi.get(missionId),
    enabled: !!missionId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = agents
    ? Object.fromEntries(agents.map((a) => [a.id, a.name]))
    : {};

  if (missionLoading) {
    return (
      <div className="space-y-2 py-2">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-12 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  if (!mission) {
    return (
      <p className="text-sm text-destructive px-3 py-2">Failed to load mission data.</p>
    );
  }

  // Group agents by role from the mission detail endpoint
  // The list endpoint returns MissionListItem (no agents field),
  // so we show a simplified view from what we have.
  // A future DAG endpoint will replace this with real node/edge data.

  return (
    <div className="space-y-6">
      {/* DAG placeholder notice */}
      <div className="rounded-md border border-dashed border-border p-4 text-center">
        <GitBranch className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm font-medium">Workflow DAG</p>
        <p className="text-xs text-muted-foreground mt-1">
          Full DAG visualization requires the workflow DAG API endpoint (planned for a future phase).
          Agent roster is shown below.
        </p>
      </div>

      {/* Agent roster grouped by role */}
      <AgentRoster missionId={missionId} agentMap={agentMap} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentRoster — fetches /missions/:id agents directly via the missions detail
// ---------------------------------------------------------------------------

interface AgentRosterProps {
  missionId: string;
  agentMap: Record<string, string>;
}

interface MissionAgentEntry {
  agentId: string;
  role: MissionAgentRole;
}

function AgentRoster({ missionId, agentMap }: AgentRosterProps) {
  const { data: rosterData, isLoading } = useQuery<MissionAgentEntry[]>({
    queryKey: [...queryKeys.missions.detail(missionId), "agents"],
    queryFn: async () => {
      const res = await fetch(`/api/missions/${missionId}/agents`, {
        credentials: "include",
      });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!missionId,
  });

  if (isLoading) {
    return (
      <div className="space-y-1">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="h-10 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  const entries: MissionAgentEntry[] = rosterData ?? [];

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <User className="h-6 w-6 mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No agents assigned to this mission.</p>
      </div>
    );
  }

  // Sort by canonical role order
  const sorted = [...entries].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
  );

  // Group by role
  const grouped = ROLE_ORDER.reduce<Record<string, MissionAgentEntry[]>>((acc, role) => {
    const members = sorted.filter((e) => e.role === role);
    if (members.length > 0) acc[role] = members;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {Object.entries(grouped).map(([role, members]) => (
        <div key={role} className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {role}
          </p>
          <div className="flex flex-wrap gap-2">
            {members.map((entry) => (
              <div
                key={entry.agentId}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium",
                  ROLE_COLORS[entry.role as MissionAgentRole] ?? "border-border bg-muted text-muted-foreground",
                )}
              >
                <User className="h-3 w-3" />
                {agentMap[entry.agentId] ?? entry.agentId}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
