import type { InstanceExperimentalSettings, PatchInstanceExperimentalSettings } from "@paperclipai/shared";
import { cn } from "../lib/utils";

const toggles = [
  {
    field: "enableIsolatedWorkspaces",
    title: "Enable Isolated Workspaces",
    description: "Show execution workspace controls in project configuration and allow isolated workspace behavior for new and existing issue runs.",
    label: "Toggle isolated workspaces experimental setting",
  },
  {
    field: "autoRestartDevServerWhenIdle",
    title: "Auto-Restart Dev Server When Idle",
    description: "In `pnpm dev:once`, wait for all queued and running local agent runs to finish, then restart the server automatically when backend changes or migrations make the current boot stale.",
    label: "Toggle guarded dev-server auto-restart",
  },
  {
    field: "enableHeartbeatFinalizationV1",
    title: "Heartbeat Finalization V1 Shadow Writes",
    description: "Record experimental heartbeat authority, generation, lease, and outcome fields without changing runtime behavior.",
    label: "Toggle heartbeat finalization v1 shadow writes",
  },
  {
    field: "enableRunTerminalBoundaryV1",
    title: "Run Terminal Boundary V1",
    description: "Finalize workflow runs through the terminal boundary: cause-stamped decisions with authority-version CAS, a narrow recovery-channel gate before failure, scoped stop targets, and an effect-intent outbox with periodic reprocessing. Default off keeps the legacy finalization path.",
    label: "Toggle run terminal boundary v1",
  },
  {
    field: "enableRunReopenGuardV1",
    title: "Run Reopen Guard V1",
    description: "Reopen paths require status CAS + authority version bump; terminal runs cannot be revived by observation.",
    label: "Toggle run reopen guard v1",
  },
  {
    field: "enableRunRecoveryServiceV1",
    title: "Run Recovery Service V1",
    description: "Terminal-run recovery goes through one-time authority consumption with decision/version validation (resume, supervision retry, unblock resolution). Requires Run Reopen Guard V1 to be enabled.",
    label: "Toggle run recovery service v1",
  },
  {
    field: "enableWorkProductBindingV1",
    title: "Work-Product Binding V1",
    description: "Tool-step workProduct references pin the producer artifact per execution (run + step) instead of re-resolving the current primary.",
    label: "Toggle work-product binding v1",
  },
  {
    field: "enableKnowledgePatternInjection",
    title: "Knowledge Pattern Injection",
    description: "Inject matching company knowledge patterns into agent heartbeat context before each run.",
    label: "Toggle knowledge pattern injection",
  },
  {
    field: "enableQaRebindRecoveryV1",
    title: "QA Rebind Recovery V1",
    description: "Automatically recover QA steps whose reviewed work product was regenerated, distinguishing generation-only rebinds from material content changes. Applies to all companies on this instance.",
    label: "Toggle QA rebind recovery v1",
  },
] as const;

interface Props {
  settings: InstanceExperimentalSettings | undefined;
  pending: boolean;
  onToggle: (patch: PatchInstanceExperimentalSettings) => void;
}

export function InstanceExperimentalToggles({ settings, pending, onToggle }: Props) {
  return toggles.map(({ field, title, description, label }) => {
    const enabled = settings?.[field] === true;
    const hasPressedState = field === "enableKnowledgePatternInjection" || field === "enableQaRebindRecoveryV1";
    return (
      <section key={field} className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
          </div>
          <button
            type="button"
            aria-label={label}
            aria-pressed={hasPressedState ? enabled : undefined}
            disabled={pending}
            className={cn(
              "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              enabled ? "bg-green-600" : "bg-muted",
            )}
            onClick={() => onToggle({ [field]: !enabled })}
          >
            <span className={cn(
              "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
              enabled ? "translate-x-4.5" : "translate-x-0.5",
            )} />
          </button>
        </div>
      </section>
    );
  });
}
