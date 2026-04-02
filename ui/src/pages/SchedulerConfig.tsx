import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { schedulerApi, type Schedule, type CreateScheduleInput } from "../api/scheduler";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Clock, Plus, Trash2, CalendarClock, ToggleLeft, ToggleRight } from "lucide-react";
import { cn } from "../lib/utils";

// scheduleKeys are in queryKeys.scheduler — aliased here for brevity


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

const CRON_PRESETS = [
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Weekly (Mon 9am)", value: "0 9 * * 1" },
];

// ---------------------------------------------------------------------------
// CreateScheduleForm
// ---------------------------------------------------------------------------

interface CreateScheduleFormProps {
  companyId: string;
  onCreated: () => void;
  onCancel: () => void;
}

function CreateScheduleForm({ companyId, onCreated, onCancel }: CreateScheduleFormProps) {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState("");
  const [cronExpression, setCronExpression] = useState("0 * * * *");
  const [timezone, setTimezone] = useState("UTC");
  const [formError, setFormError] = useState<string | null>(null);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateScheduleInput) => schedulerApi.create(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list(companyId) });
      onCreated();
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Failed to create schedule");
    },
  });

  function handlePreset(value: string) {
    if (value !== "__custom__") setCronExpression(value);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!agentId) { setFormError("Agent is required"); return; }
    if (!cronExpression.trim()) { setFormError("Cron expression is required"); return; }
    createMutation.mutate({ agentId, cronExpression: cronExpression.trim(), timezone });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border border-border rounded-md p-4 space-y-4 bg-card"
    >
      <p className="text-sm font-medium">New Schedule</p>

      {/* Agent */}
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Agent</label>
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder="Select agent..." />
          </SelectTrigger>
          <SelectContent>
            {(agents ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Cron preset */}
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Preset</label>
        <Select onValueChange={handlePreset} defaultValue="__custom__">
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder="Choose preset..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__custom__">Custom</SelectItem>
            {CRON_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Cron expression */}
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Cron expression</label>
        <Input
          className="h-8 text-sm font-mono"
          value={cronExpression}
          onChange={(e) => setCronExpression(e.target.value)}
          placeholder="* * * * *"
        />
        <p className="text-xs text-muted-foreground">
          Format: minute hour day-of-month month day-of-week
        </p>
      </div>

      {/* Timezone */}
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Timezone</label>
        <Input
          className="h-8 text-sm"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          placeholder="UTC"
        />
      </div>

      {formError && (
        <p className="text-xs text-destructive">{formError}</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" size="sm" className="h-7 text-xs" disabled={createMutation.isPending}>
          {createMutation.isPending ? "Creating..." : "Create"}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// ScheduleRow
// ---------------------------------------------------------------------------

interface ScheduleRowProps {
  schedule: Schedule;
  agentName: string;
  companyId: string;
}

function ScheduleRow({ schedule, agentName, companyId }: ScheduleRowProps) {
  const queryClient = useQueryClient();

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      schedulerApi.update(schedule.id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list(companyId) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => schedulerApi.remove(schedule.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduler.list(companyId) });
    },
  });

  return (
    <div className={cn(
      "flex items-center gap-3 px-4 py-3 text-sm border-b border-border last:border-b-0",
      !schedule.enabled && "opacity-60",
    )}>
      {/* Icon */}
      <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />

      {/* Cron + agent */}
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="font-mono text-xs font-medium truncate">{schedule.cronExpression}</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{agentName}</span>
          <span>·</span>
          <span>{schedule.timezone}</span>
        </div>
      </div>

      {/* Next run */}
      <div className="shrink-0 text-right hidden sm:block">
        <p className="text-xs text-muted-foreground">Next run</p>
        <p className="text-xs font-medium">{formatDate(schedule.nextRunAt)}</p>
      </div>

      {/* Last run */}
      <div className="shrink-0 text-right hidden md:block">
        <p className="text-xs text-muted-foreground">Last run</p>
        <p className="text-xs">{formatDate(schedule.lastRunAt)}</p>
      </div>

      {/* Toggle */}
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn("shrink-0", schedule.enabled ? "text-green-600" : "text-muted-foreground")}
        onClick={() => toggleMutation.mutate(!schedule.enabled)}
        disabled={toggleMutation.isPending}
        title={schedule.enabled ? "Disable schedule" : "Enable schedule"}
      >
        {schedule.enabled
          ? <ToggleRight className="h-4 w-4" />
          : <ToggleLeft className="h-4 w-4" />}
      </Button>

      {/* Delete */}
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => deleteMutation.mutate()}
        disabled={deleteMutation.isPending}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SchedulerConfig page
// ---------------------------------------------------------------------------

export function SchedulerConfig() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Scheduler" }]);
  }, [setBreadcrumbs]);

  const { data: schedules, isLoading, error } = useQuery({
    queryKey: queryKeys.scheduler.list(selectedCompanyId!),
    queryFn: () => schedulerApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = agents
    ? Object.fromEntries(agents.map((a) => [a.id, a.name]))
    : {};

  if (!selectedCompanyId) {
    return <EmptyState icon={CalendarClock} message="Select a company to view schedules." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">Scheduler</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Cron-based agent wakeup schedules
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => setShowForm((v) => !v)}
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Schedule
        </Button>
      </div>

      {/* Create form */}
      {showForm && (
        <CreateScheduleForm
          companyId={selectedCompanyId}
          onCreated={() => setShowForm(false)}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* Empty state */}
      {schedules && schedules.length === 0 && !showForm && (
        <EmptyState
          icon={CalendarClock}
          message="No schedules yet."
          action="New Schedule"
          onAction={() => setShowForm(true)}
        />
      )}

      {/* Schedule list */}
      {schedules && schedules.length > 0 && (
        <div className="border border-border">
          {schedules.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              agentName={agentMap[schedule.agentId] ?? schedule.agentId}
              companyId={selectedCompanyId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
