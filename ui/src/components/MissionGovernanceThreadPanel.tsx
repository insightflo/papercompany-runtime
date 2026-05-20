import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, History, ShieldCheck } from "lucide-react";
import { missionsApi, type MissionGovernanceThreadEvent } from "../api/missions";
import { queryKeys } from "../lib/queryKeys";

interface MissionGovernanceThreadPanelProps {
  missionId: string;
}

function formatThreadDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function sourceLabel(event: MissionGovernanceThreadEvent) {
  const { type, id, externalId } = event.sourceRef;
  return `${type}:${externalId ?? id}`;
}

function actorLabel(event: MissionGovernanceThreadEvent) {
  if (!event.actor) return "System evidence";
  const role = event.actor.authorityRole ?? event.actor.role;
  const actorId = event.actor.id ? ` · ${event.actor.id}` : "";
  return `${event.actor.type}${role ? `/${role}` : ""}${actorId}`;
}

function severityClass(severity: MissionGovernanceThreadEvent["severity"]) {
  switch (severity) {
    case "blocked":
    case "failed":
      return "text-destructive";
    case "approved":
    case "completed":
      return "text-emerald-600";
    case "attention":
      return "text-amber-600";
    default:
      return "text-muted-foreground";
  }
}

function CountCard({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="rounded border border-border/70 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function EventList({ title, events, emptyText }: { title: string; events: MissionGovernanceThreadEvent[]; emptyText: string }) {
  return (
    <section className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
      {events.length > 0 ? (
        <ul className="space-y-2">
          {events.slice(0, 5).map((event) => (
            <li key={event.id} className="rounded border border-border/70 p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{event.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{event.summary}</p>
                </div>
                <span className={`text-xs ${severityClass(event.severity)}`}>{event.severity ?? event.eventType}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{formatThreadDate(event.timestamp)}</span>
                <span>{sourceLabel(event)}</span>
                <span>{actorLabel(event)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      )}
    </section>
  );
}

export function MissionGovernanceThreadPanel({ missionId }: MissionGovernanceThreadPanelProps) {
  const { data: thread, isLoading, error } = useQuery({
    queryKey: queryKeys.missions.governanceThread(missionId),
    queryFn: () => missionsApi.getGovernanceThread(missionId),
    enabled: !!missionId,
  });

  if (isLoading) {
    return (
      <section className="rounded-md border border-border p-4" aria-label="Governance Thread">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Governance Thread</h3>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">Loading governance thread…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-md border border-border p-4" aria-label="Governance Thread">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <h3 className="text-sm font-medium">Governance Thread</h3>
        </div>
        <p className="mt-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load governance thread."}
        </p>
      </section>
    );
  }

  const totalEventCount = thread?.summary.totalEventCount ?? thread?.events.length ?? 0;
  const latestEvents = thread?.summary.latestEvents ?? [];
  const openDecisions = thread?.summary.openDecisions ?? [];
  const hasEvents = totalEventCount > 0 || latestEvents.length > 0 || openDecisions.length > 0;

  return (
    <section className="rounded-md border border-border p-4 space-y-4" aria-label="Governance Thread">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-medium">Governance Thread</h3>
            <p className="text-xs text-muted-foreground">Diagnostic evidence and decision history only</p>
          </div>
        </div>
        <span className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">read-only</span>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <CountCard label="Events" value={totalEventCount} detail={`${totalEventCount} total events`} />
        <CountCard label="Latest" value={latestEvents.length} detail={`${latestEvents.length} latest events`} />
        <CountCard label="Open decisions" value={openDecisions.length} detail={`${openDecisions.length} open decisions`} />
      </div>

      {!hasEvents ? (
        <p className="rounded border border-border/70 p-3 text-sm text-muted-foreground">No governance events observed yet.</p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <EventList title="Latest events" events={latestEvents} emptyText="No latest governance events summarized yet." />
          <EventList title="Open decisions" events={openDecisions} emptyText="No open governance decisions." />
        </div>
      )}
    </section>
  );
}
