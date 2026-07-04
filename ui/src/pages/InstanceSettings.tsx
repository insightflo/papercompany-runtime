import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, ExternalLink, Settings } from "lucide-react";
import type { InstanceSchedulerHeartbeatAgent } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, relativeTime } from "../lib/utils";

type HeartbeatPatch = {
  readonly enabled?: boolean;
  readonly intervalSec?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function buildAgentHref(agent: InstanceSchedulerHeartbeatAgent) {
  return `/${agent.companyIssuePrefix}/agents/${encodeURIComponent(agent.agentUrlKey)}`;
}

export function intervalMinutesValue(intervalSec: number): string {
  const minutes = Math.max(0, intervalSec) / 60;
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
}

export function parseIntervalMinutesToSec(value: string): number | null {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  return Math.round(minutes * 60);
}

export function formatHeartbeatInterval(intervalSec: number): string {
  if (intervalSec < 60) return `${intervalSec}s`;
  return `${intervalMinutesValue(intervalSec)} min`;
}

export function InstanceSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [intervalDrafts, setIntervalDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Heartbeats" },
    ]);
  }, [setBreadcrumbs]);

  const heartbeatsQuery = useQuery({
    queryKey: queryKeys.instance.schedulerHeartbeats,
    queryFn: () => heartbeatsApi.listInstanceSchedulerAgents(),
    refetchInterval: 15_000,
  });

  const heartbeatMutation = useMutation({
    mutationFn: async (input: {
      readonly agentRow: InstanceSchedulerHeartbeatAgent;
      readonly patch: HeartbeatPatch;
    }) => {
      const { agentRow, patch } = input;
      const agent = await agentsApi.get(agentRow.id, agentRow.companyId);
      const runtimeConfig = asRecord(agent.runtimeConfig) ?? {};
      const heartbeat = asRecord(runtimeConfig.heartbeat) ?? {};

      return agentsApi.update(
        agentRow.id,
        {
          runtimeConfig: {
            ...runtimeConfig,
            heartbeat: {
              ...heartbeat,
              ...patch,
            },
          },
        },
        agentRow.companyId,
      );
    },
    onSuccess: async (_, input) => {
      setActionError(null);
      if (typeof input.patch.intervalSec === "number") {
        const intervalSec = input.patch.intervalSec;
        setIntervalDrafts((current) => ({
          ...current,
          [input.agentRow.id]: intervalMinutesValue(intervalSec),
        }));
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.schedulerHeartbeats }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(input.agentRow.companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(input.agentRow.id) }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update heartbeat.");
    },
  });

  const agents = heartbeatsQuery.data ?? [];
  const activeCount = agents.filter((agent) => agent.schedulerActive).length;
  const disabledCount = agents.length - activeCount;

  const grouped = useMemo(() => {
    const map = new Map<string, { companyName: string; agents: InstanceSchedulerHeartbeatAgent[] }>();
    for (const agent of agents) {
      let group = map.get(agent.companyId);
      if (!group) {
        group = { companyName: agent.companyName, agents: [] };
        map.set(agent.companyId, group);
      }
      group.agents.push(agent);
    }
    return [...map.values()];
  }, [agents]);

  if (heartbeatsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading scheduler heartbeats...</div>;
  }

  if (heartbeatsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {heartbeatsQuery.error instanceof Error
          ? heartbeatsQuery.error.message
          : "Failed to load scheduler heartbeats."}
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Scheduler Heartbeats</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Agents with a timer heartbeat enabled across all of your companies.
        </p>
      </div>

      <div className="flex gap-4 text-sm text-muted-foreground">
        <span><span className="font-semibold text-foreground">{activeCount}</span> active</span>
        <span><span className="font-semibold text-foreground">{disabledCount}</span> disabled</span>
        <span><span className="font-semibold text-foreground">{grouped.length}</span> {grouped.length === 1 ? "company" : "companies"}</span>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {agents.length === 0 ? (
        <EmptyState
          icon={Clock3}
          message="No scheduler heartbeats match the current criteria."
        />
      ) : (
        <div className="space-y-4">
          {grouped.map((group) => (
            <Card key={group.companyName}>
              <CardContent className="p-0">
                <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.companyName}
                </div>
                <div className="divide-y">
                  {group.agents.map((agent) => {
                    const draftValue = intervalDrafts[agent.id] ?? intervalMinutesValue(agent.intervalSec);
                    const parsedIntervalSec = parseIntervalMinutesToSec(draftValue);
                    const intervalInvalid = parsedIntervalSec === null;
                    const intervalDirty = parsedIntervalSec !== null && parsedIntervalSec !== agent.intervalSec;
                    const saving = heartbeatMutation.isPending && heartbeatMutation.variables?.agentRow.id === agent.id;
                    return (
                      <div
                        key={agent.id}
                        className="flex flex-col gap-2 px-3 py-2 text-sm md:flex-row md:items-center"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <Badge
                            variant={agent.schedulerActive ? "default" : "outline"}
                            className="shrink-0 text-[10px] px-1.5 py-0"
                          >
                            {agent.schedulerActive ? "On" : "Off"}
                          </Badge>
                          <Link
                            to={buildAgentHref(agent)}
                            className="font-medium truncate hover:underline"
                          >
                            {agent.agentName}
                          </Link>
                          <span className="hidden sm:inline text-muted-foreground truncate">
                            {humanize(agent.title ?? agent.role)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 md:ml-auto md:shrink-0">
                          <span className="text-muted-foreground tabular-nums shrink-0">
                            {formatHeartbeatInterval(agent.intervalSec)}
                          </span>
                          <span
                            className="hidden lg:inline text-muted-foreground truncate"
                            title={agent.lastHeartbeatAt ? formatDateTime(agent.lastHeartbeatAt) : undefined}
                          >
                            {agent.lastHeartbeatAt
                              ? relativeTime(agent.lastHeartbeatAt)
                              : "never"}
                          </span>
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="hidden lg:inline">Interval</span>
                            <Input
                              aria-label={`${agent.agentName} heartbeat interval minutes`}
                              aria-invalid={intervalInvalid}
                              className="h-7 w-20 px-2 text-right text-xs"
                              min={1}
                              step={1}
                              type="number"
                              value={draftValue}
                              onChange={(event) =>
                                setIntervalDrafts((current) => ({
                                  ...current,
                                  [agent.id]: event.currentTarget.value,
                                }))}
                            />
                            <span>min</span>
                          </label>
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={saving || intervalInvalid || !intervalDirty}
                            onClick={() => {
                              if (parsedIntervalSec === null) {
                                setActionError("Heartbeat interval must be at least 1 minute.");
                                return;
                              }
                              heartbeatMutation.mutate({
                                agentRow: agent,
                                patch: { intervalSec: parsedIntervalSec },
                              });
                            }}
                          >
                            Save
                          </Button>
                          <Link
                            to={buildAgentHref(agent)}
                            className="text-muted-foreground hover:text-foreground"
                            title="Full agent config"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            disabled={saving}
                            onClick={() =>
                              heartbeatMutation.mutate({
                                agentRow: agent,
                                patch: { enabled: !agent.heartbeatEnabled },
                              })}
                          >
                            {saving ? "..." : agent.heartbeatEnabled ? "Disable Timer Heartbeat" : "Enable Timer Heartbeat"}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
