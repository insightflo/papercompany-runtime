/**
 * Field-level controls for AgentConfigForm: adapter environment results, adapter and
 * provider pickers, model/thinking-effort dropdowns, and the environment variable editor.
 *
 * Extracted from AgentConfigForm.tsx so the form's state orchestration stays readable.
 * Rendering behaviour is unchanged.
 */

import {
  useState,
  useEffect,
  useRef,
  useMemo,
} from "react";
import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import type {
  AdapterEnvironmentTestResult,
  CompanySecret,
  EnvBinding,
} from "@paperclipai/shared";
import type { AdapterModel } from "../api/agents";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ChevronDown,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import {
  extractModelName,
  extractProviderId,
} from "../lib/model-utils";
import {
  Field,
  help,
  adapterLabels,
} from "./agent-config-primitives";
import { getCustomModelCandidate } from "../lib/model-dropdown";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";
import { isAdapterTypeEnabled } from "./agent-config-adapter-types";

/* ---- Shared input class ---- */
export const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function AdapterEnvironmentResult({ result }: { result: AdapterEnvironmentTestResult }) {
  const statusLabel =
    result.status === "pass" ? "Passed" : result.status === "warn" ? "Warnings" : "Failed";
  const statusClass =
    result.status === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : result.status === "warn"
        ? "text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10"
        : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{statusLabel}</span>
        <span className="text-[11px] opacity-80">
          {new Date(result.testedAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        {result.checks.map((check, idx) => (
          <div key={`${check.code}-${idx}`} className="text-[11px] leading-relaxed break-words">
            <span className="font-medium uppercase tracking-wide opacity-80">
              {check.level}
            </span>
            <span className="mx-1 opacity-60">·</span>
            <span>{check.message}</span>
            {check.detail && <span className="block opacity-75 break-all">({check.detail})</span>}
            {check.hint && <span className="block opacity-90 break-words">Hint: {check.hint}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- Internal sub-components ---- */

/** Display list includes all real adapter types plus UI-only coming-soon entries. */
export function AdapterTypeDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (type: string) => void;
}) {
  const adapterDisplayList = AGENT_ADAPTER_TYPES
    .map((type) => ({
      value: type,
      label: adapterLabels[type] ?? type,
      comingSoon: !isAdapterTypeEnabled(type),
    }));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
          <span className="inline-flex items-center gap-1.5">
            {value === "opencode_local" ? <OpenCodeLogoIcon className="h-3.5 w-3.5" /> : null}
            <span>{adapterLabels[value] ?? value}</span>
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
        {adapterDisplayList.map((item) => (
          <button
            key={item.value}
            disabled={item.comingSoon}
            className={cn(
              "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded",
              item.comingSoon
                ? "opacity-40 cursor-not-allowed"
                : "hover:bg-accent/50",
              item.value === value && !item.comingSoon && "bg-accent",
            )}
            onClick={() => {
              if (!item.comingSoon) onChange(item.value);
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              {item.value === "opencode_local" ? <OpenCodeLogoIcon className="h-3.5 w-3.5" /> : null}
              <span>{item.label}</span>
            </span>
            {item.comingSoon && (
              <span className="text-[10px] text-muted-foreground">Coming soon</span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function EnvVarEditor({
  value,
  secrets,
  onCreateSecret,
  onChange,
}: {
  value: Record<string, EnvBinding>;
  secrets: CompanySecret[];
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  onChange: (env: Record<string, EnvBinding> | undefined) => void;
}) {
  type Row = {
    key: string;
    source: "plain" | "secret";
    plainValue: string;
    secretId: string;
  };

  function toRows(rec: Record<string, EnvBinding> | null | undefined): Row[] {
    if (!rec || typeof rec !== "object") {
      return [{ key: "", source: "plain", plainValue: "", secretId: "" }];
    }
    const entries = Object.entries(rec).map(([k, binding]) => {
      if (typeof binding === "string") {
        return {
          key: k,
          source: "plain" as const,
          plainValue: binding,
          secretId: "",
        };
      }
      if (
        typeof binding === "object" &&
        binding !== null &&
        "type" in binding &&
        (binding as { type?: unknown }).type === "secret_ref"
      ) {
        const recBinding = binding as { secretId?: unknown };
        return {
          key: k,
          source: "secret" as const,
          plainValue: "",
          secretId: typeof recBinding.secretId === "string" ? recBinding.secretId : "",
        };
      }
      if (
        typeof binding === "object" &&
        binding !== null &&
        "type" in binding &&
        (binding as { type?: unknown }).type === "plain"
      ) {
        const recBinding = binding as { value?: unknown };
        return {
          key: k,
          source: "plain" as const,
          plainValue: typeof recBinding.value === "string" ? recBinding.value : "",
          secretId: "",
        };
      }
      return {
        key: k,
        source: "plain" as const,
        plainValue: "",
        secretId: "",
      };
    });
    return [...entries, { key: "", source: "plain", plainValue: "", secretId: "" }];
  }

  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const [sealError, setSealError] = useState<string | null>(null);
  const valueRef = useRef(value);

  // Sync when value identity changes (overlay reset after save)
  useEffect(() => {
    if (value !== valueRef.current) {
      valueRef.current = value;
      setRows(toRows(value));
    }
  }, [value]);

  function emit(nextRows: Row[]) {
    const rec: Record<string, EnvBinding> = {};
    for (const row of nextRows) {
      const k = row.key.trim();
      if (!k) continue;
      if (row.source === "secret") {
        if (!row.secretId) continue;
        rec[k] = { type: "secret_ref", secretId: row.secretId, version: "latest" };
      } else {
        rec[k] = { type: "plain", value: row.plainValue };
      }
    }
    onChange(Object.keys(rec).length > 0 ? rec : undefined);
  }

  function updateRow(i: number, patch: Partial<Row>) {
    const withPatch = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    if (
      withPatch[withPatch.length - 1].key ||
      withPatch[withPatch.length - 1].plainValue ||
      withPatch[withPatch.length - 1].secretId
    ) {
      withPatch.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(withPatch);
    emit(withPatch);
  }

  function removeRow(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    if (
      next.length === 0 ||
      next[next.length - 1].key ||
      next[next.length - 1].plainValue ||
      next[next.length - 1].secretId
    ) {
      next.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(next);
    emit(next);
  }

  function defaultSecretName(key: string): string {
    return key
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
  }

  async function sealRow(i: number) {
    const row = rows[i];
    if (!row) return;
    const key = row.key.trim();
    const plain = row.plainValue;
    if (!key || plain.length === 0) return;

    const suggested = defaultSecretName(key) || "secret";
    const name = window.prompt("Secret name", suggested)?.trim();
    if (!name) return;

    try {
      setSealError(null);
      const created = await onCreateSecret(name, plain);
      updateRow(i, {
        source: "secret",
        secretId: created.id,
      });
    } catch (err) {
      setSealError(err instanceof Error ? err.message : "Failed to create secret");
    }
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => {
        const isTrailing =
          i === rows.length - 1 &&
          !row.key &&
          !row.plainValue &&
          !row.secretId;
        return (
          <div key={i} className="flex items-center gap-1.5">
            <input
              className={cn(inputClass, "flex-[2]")}
              placeholder="KEY"
              value={row.key}
              onChange={(e) => updateRow(i, { key: e.target.value })}
            />
            <select
              className={cn(inputClass, "flex-[1] bg-background")}
              value={row.source}
              onChange={(e) =>
                updateRow(i, {
                  source: e.target.value === "secret" ? "secret" : "plain",
                  ...(e.target.value === "plain" ? { secretId: "" } : {}),
                })
              }
            >
              <option value="plain">Plain</option>
              <option value="secret">Secret</option>
            </select>
            {row.source === "secret" ? (
              <>
                <select
                  className={cn(inputClass, "flex-[3] bg-background")}
                  value={row.secretId}
                  onChange={(e) => updateRow(i, { secretId: e.target.value })}
                >
                  <option value="">Select secret...</option>
                  {secrets.map((secret) => (
                    <option key={secret.id} value={secret.id}>
                      {secret.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
                  onClick={() => sealRow(i)}
                  disabled={!row.key.trim() || !row.plainValue}
                  title="Create secret from current plain value"
                >
                  New
                </button>
              </>
            ) : (
              <>
                <input
                  className={cn(inputClass, "flex-[3]")}
                  placeholder="value"
                  value={row.plainValue}
                  onChange={(e) => updateRow(i, { plainValue: e.target.value })}
                />
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
                  onClick={() => sealRow(i)}
                  disabled={!row.key.trim() || !row.plainValue}
                  title="Store value as secret and replace with reference"
                >
                  Seal
                </button>
              </>
            )}
            {!isTrailing ? (
              <button
                type="button"
                className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                onClick={() => removeRow(i)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <div className="w-[26px] shrink-0" />
            )}
          </div>
        );
      })}
      {sealError && <p className="text-[11px] text-destructive">{sealError}</p>}
      <p className="text-[11px] text-muted-foreground/60">
        PAPERCLIP_* variables are injected automatically at runtime.
      </p>
    </div>
  );
}

export function ProviderDropdown({
  providers,
  value,
  onChange,
  open,
  onOpenChange,
  hint = "Provider passed to Hermes for this model run.",
}: {
  providers: ReadonlyArray<{ id: string; label: string; modelCount: number }>;
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hint?: string;
}) {
  const selected = providers.find((provider) => provider.id === value);
  const disabled = providers.length === 0;

  return (
    <Field label="Provider" hint={hint}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between",
              disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
            )}
          >
            <span className={cn(!selected && "text-muted-foreground")}>
              {selected ? selected.label : disabled ? "No providers found" : "Select provider"}
            </span>
            <span className="flex items-center gap-2 text-muted-foreground">
              {selected && (
                <span className="text-[10px] uppercase tracking-wide">
                  {selected.modelCount} models
                </span>
              )}
              <ChevronDown className="h-3 w-3" />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className={cn(
                "flex items-center justify-between gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                provider.id === value && "bg-accent",
              )}
              onClick={() => {
                onChange(provider.id);
                onOpenChange(false);
              }}
            >
              <span className="min-w-0 truncate text-left" title={provider.id}>
                {provider.label}
              </span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                {provider.modelCount}
              </span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </Field>
  );
}

export function ModelDropdown({
  label = "Model",
  hint = help.model,
  models,
  value,
  onChange,
  open,
  onOpenChange,
  allowDefault,
  required,
  groupByProvider,
}: {
  label?: string;
  hint?: string;
  models: AdapterModel[];
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allowDefault: boolean;
  required: boolean;
  groupByProvider: boolean;
}) {
  const [modelSearch, setModelSearch] = useState("");
  const selected = models.find((m) => m.id === value);
  const customModelCandidate = getCustomModelCandidate(models, modelSearch);
  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      if (!modelSearch.trim()) return true;
      const q = modelSearch.toLowerCase();
      const provider = extractProviderId(m.id) ?? "";
      return (
        m.id.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q) ||
        provider.toLowerCase().includes(q)
      );
    });
  }, [models, modelSearch]);
  const groupedModels = useMemo(() => {
    if (!groupByProvider) {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id)),
        },
      ];
    }
    const map = new Map<string, AdapterModel[]>();
    for (const model of filteredModels) {
      const provider = extractProviderId(model.id) ?? "other";
      const group = map.get(provider) ?? [];
      group.push(model);
      map.set(provider, group);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)),
      }));
  }, [filteredModels, groupByProvider]);

  return (
    <Field label={label} hint={hint}>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          onOpenChange(nextOpen);
          if (!nextOpen) setModelSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
            <span className={cn(!value && "text-muted-foreground")}>
              {selected
                ? selected.label
                : value || (allowDefault ? "Default" : required ? "Select model (required)" : "Select model")}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
          <input
            className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
            placeholder="Search models..."
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            autoFocus
          />
          <div className="max-h-[240px] overflow-y-auto">
            {allowDefault && (
              <button
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                  !value && "bg-accent",
                )}
                onClick={() => {
                  onChange("");
                  onOpenChange(false);
                }}
              >
                Default
              </button>
            )}
            {customModelCandidate && (
              <button
                className="flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50 border-b border-border/60 mb-1"
                onClick={() => {
                  onChange(customModelCandidate);
                  onOpenChange(false);
                }}
              >
                <span className="block min-w-0 truncate text-left" title={customModelCandidate}>
                  Use custom model “{customModelCandidate}”
                </span>
                <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                  custom
                </span>
              </button>
            )}
            {groupedModels.map((group) => (
              <div key={group.provider} className="mb-1 last:mb-0">
                {groupByProvider && (
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {group.provider} ({group.entries.length})
                  </div>
                )}
                {group.entries.map((m) => (
                  <button
                    key={m.id}
                    className={cn(
                      "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                      m.id === value && "bg-accent",
                    )}
                    onClick={() => {
                      onChange(m.id);
                      onOpenChange(false);
                    }}
                  >
                    <span className="block w-full text-left truncate" title={m.id}>
                      {groupByProvider ? extractModelName(m.id) : m.label}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {filteredModels.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No models found.</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  );
}

export function ThinkingEffortDropdown({
  value,
  options,
  onChange,
  open,
  onOpenChange,
}: {
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const selected = options.find((option) => option.id === value) ?? options[0];

  return (
    <Field label="Thinking effort" hint={help.thinkingEffort}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
            <span className={cn(!value && "text-muted-foreground")}>{selected?.label ?? "Auto"}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
          {options.map((option) => (
            <button
              key={option.id || "auto"}
              className={cn(
                "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                option.id === value && "bg-accent",
              )}
              onClick={() => {
                onChange(option.id);
                onOpenChange(false);
              }}
            >
              <span>{option.label}</span>
              {option.id ? <span className="text-xs text-muted-foreground font-mono">{option.id}</span> : null}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </Field>
  );
}
