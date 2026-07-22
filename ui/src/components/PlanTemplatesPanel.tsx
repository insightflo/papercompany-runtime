import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FilePlus2, RefreshCw, Save, Trash } from "lucide-react";
import type { MissionPlanTemplate } from "@paperclipai/shared";
import { missionPlanTemplatesApi } from "../api/companyInstructions";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

type Draft = Pick<MissionPlanTemplate, "name" | "selectionDescription" | "instructions" | "enabled">;

const EMPTY_DRAFT: Draft = { name: "", selectionDescription: "", instructions: "", enabled: true };

export function PlanTemplatesPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const listQuery = useQuery({
    queryKey: queryKeys.missionPlanTemplates.list(companyId),
    queryFn: () => missionPlanTemplatesApi.list(companyId),
  });
  const templates = listQuery.data?.templates ?? [];
  const selected = templates.find((template) => template.id === selectedId) ?? null;

  useEffect(() => {
    if (!creating && !selectedId && templates[0]) setSelectedId(templates[0].id);
  }, [creating, selectedId, templates]);

  useEffect(() => {
    if (selected && !creating) {
      setDraft({
        name: selected.name,
        selectionDescription: selected.selectionDescription,
        instructions: selected.instructions,
        enabled: selected.enabled,
      });
    }
  }, [creating, selected]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.missionPlanTemplates.list(companyId) });
  };

  const saveMutation = useMutation({
    mutationFn: () => creating
      ? missionPlanTemplatesApi.create(companyId, {
          name: draft.name,
          selectionDescription: draft.selectionDescription,
          instructions: draft.instructions,
        })
      : missionPlanTemplatesApi.update(companyId, selected!.id, selected?.origin === "system_default"
          ? { enabled: draft.enabled }
          : draft),
    onSuccess: async (template) => {
      setCreating(false);
      setSelectedId(template.id);
      await refresh();
      pushToast({ tone: "success", title: creating ? "Plan template created" : "Plan template saved", body: template.name });
    },
    onError: (error) => pushToast({ tone: "error", title: "Save failed", body: error instanceof Error ? error.message : "Unable to save plan template." }),
  });

  const duplicateMutation = useMutation({
    mutationFn: () => missionPlanTemplatesApi.duplicate(companyId, selected!.id),
    onSuccess: async (template) => {
      setSelectedId(template.id);
      await refresh();
      pushToast({ tone: "success", title: "Plan template duplicated", body: template.name });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => missionPlanTemplatesApi.remove(companyId, selected!.id),
    onSuccess: async () => {
      setSelectedId(null);
      await refresh();
      pushToast({ tone: "success", title: "Plan template deleted" });
    },
    onError: (error) => pushToast({ tone: "error", title: "Delete failed", body: error instanceof Error ? error.message : "Unable to delete plan template." }),
  });

  const readOnly = selected?.origin === "system_default" && !creating;
  const canSave = draft.name.trim() && draft.selectionDescription.trim() && draft.instructions.trim() && (creating || Boolean(selected));

  return (
    <div className="grid min-h-[calc(100vh-15rem)] gap-0 xl:grid-cols-[19rem_minmax(0,1fr)]">
      <aside className="border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-base font-semibold">Plan templates</h2>
            <p className="text-xs text-muted-foreground">{templates.length} templates</p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => listQuery.refetch()} title="Refresh plan templates">
            <RefreshCw className={cn("h-4 w-4", listQuery.isFetching && "animate-spin")} />
          </Button>
        </div>
        <div className="border-b border-border p-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => { setCreating(true); setSelectedId(null); setDraft(EMPTY_DRAFT); }}
          >
            <FilePlus2 className="mr-2 h-4 w-4" />New custom template
          </Button>
        </div>
        {listQuery.isLoading ? <div className="p-4 text-sm text-muted-foreground">Loading templates…</div> : (
          <div className="py-2">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => { setCreating(false); setSelectedId(template.id); }}
                className={cn(
                  "flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-accent/50",
                  template.id === selectedId && !creating ? "bg-accent" : "",
                )}
              >
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", template.enabled ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{template.name}</span>
                  <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">{template.selectionDescription}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <main className="min-w-0 space-y-5 pl-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{creating ? "New plan template" : selected?.name ?? "Select a plan template"}</h2>
              {selected && <Badge variant="outline">{selected.origin === "system_default" ? "Default" : "Custom"}</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Agents see the name and selection guidance, then fetch the full template when it applies.</p>
          </div>
          <div className="flex items-center gap-2">
            {selected && !creating && (
              <Button variant="outline" size="sm" onClick={() => duplicateMutation.mutate()} disabled={duplicateMutation.isPending}>
                <Copy className="mr-2 h-4 w-4" />Duplicate
              </Button>
            )}
            {selected?.origin === "custom" && !creating && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (window.confirm(`Delete custom plan template “${selected.name}”?`)) deleteMutation.mutate();
                }}
                disabled={deleteMutation.isPending}
              >
                <Trash className="mr-2 h-4 w-4" />Delete
              </Button>
            )}
            {(creating || selected) && (
              <Button size="sm" onClick={() => saveMutation.mutate()} disabled={!canSave || saveMutation.isPending}>
                <Save className="mr-2 h-4 w-4" />Save
              </Button>
            )}
          </div>
        </div>

        {(creating || selected) ? (
          <div className="max-w-4xl space-y-5">
            <div className="flex items-center gap-2">
              <Checkbox
                id="plan-template-enabled"
                checked={draft.enabled}
                onCheckedChange={(checked) => setDraft((value) => ({ ...value, enabled: checked === true }))}
              />
              <label htmlFor="plan-template-enabled" className="text-sm">Available to planning agents</label>
            </div>
            <label className="block space-y-2">
              <span className="text-sm font-medium">Name</span>
              <Input value={draft.name} disabled={readOnly} maxLength={120} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} />
            </label>
            <label className="block space-y-2">
              <span className="text-sm font-medium">When agents should select it</span>
              <Textarea value={draft.selectionDescription} disabled={readOnly} maxLength={500} className="min-h-24" onChange={(event) => setDraft((value) => ({ ...value, selectionDescription: event.target.value }))} />
            </label>
            <label className="block space-y-2">
              <span className="text-sm font-medium">Template instructions</span>
              <Textarea value={draft.instructions} disabled={readOnly} maxLength={16000} spellCheck={false} className="min-h-72 font-mono text-xs leading-5" onChange={(event) => setDraft((value) => ({ ...value, instructions: event.target.value }))} />
            </label>
            {readOnly && <p className="text-xs text-muted-foreground">Default template text is maintained by the runtime. You can disable it or duplicate it into an editable custom template.</p>}
          </div>
        ) : <div className="rounded-md border border-border p-8 text-sm text-muted-foreground">Select a template or create a custom one.</div>}
      </main>
    </div>
  );
}
