import type {
  ToolDefinition,
  ToolDefinitionAdapterType,
} from "@paperclipai/shared";
import { Check, Pencil, Plus, Power, PowerOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "../../lib/utils";
import type { ToolFormState } from "./toolAdminModel";
import { isSourceManagedTool } from "./toolAdminModel";

function adapterTypeFromValue(value: string): ToolDefinitionAdapterType {
  switch (value) {
    case "mcp":
      return "mcp";
    case "builtin":
      return "builtin";
    default:
      return "http";
  }
}

export function ToolStatus({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
        enabled
          ? "border-green-500/20 bg-green-500/10 text-green-700 dark:text-green-300"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {enabled ? <Power className="h-3 w-3" /> : <PowerOff className="h-3 w-3" />}
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}

type ToolDefinitionEditorProps = {
  selectedTool: ToolDefinition | null;
  form: ToolFormState;
  setForm: (form: ToolFormState) => void;
  formError: string | null;
  isSaving: boolean;
  isDeleting: boolean;
  onSave: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
};

export function ToolDefinitionEditor({
  selectedTool,
  form,
  setForm,
  formError,
  isSaving,
  isDeleting,
  onSave,
  onToggleEnabled,
  onDelete,
}: ToolDefinitionEditorProps) {
  const sourceManaged = selectedTool ? isSourceManagedTool(selectedTool.adapterConfig) : false;

  return (
    <section className="max-w-3xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">{selectedTool ? selectedTool.name : "New tool"}</h2>
          {sourceManaged ? (
            <span className="border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
              Source managed
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {selectedTool ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleEnabled}
              disabled={isSaving || sourceManaged}
              aria-label={selectedTool.enabled ? `Disable ${selectedTool.name}` : `Enable ${selectedTool.name}`}
            >
              {selectedTool.enabled ? <PowerOff className="mr-1.5 h-3.5 w-3.5" /> : <Power className="mr-1.5 h-3.5 w-3.5" />}
              {selectedTool.enabled ? "Disable" : "Enable"}
            </Button>
          ) : null}
          <Button size="sm" onClick={onSave} disabled={isSaving || sourceManaged}>
            {selectedTool ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
            {selectedTool ? "Save" : "Create"}
          </Button>
          {selectedTool ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={isDeleting || sourceManaged}
              aria-label={`Delete ${selectedTool.name}`}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4">
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">Name</span>
          <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} aria-label="Tool name" disabled={sourceManaged} />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">Description</span>
          <Textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} aria-label="Tool description" disabled={sourceManaged} />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">Adapter type</span>
          <select
            value={form.adapterType}
            onChange={(event) => setForm({ ...form, adapterType: adapterTypeFromValue(event.target.value) })}
            aria-label="Tool adapter type"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            disabled={sourceManaged}
          >
            <option value="http">HTTP</option>
            <option value="mcp">MCP</option>
            <option value="builtin">Built-in</option>
          </select>
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">Input schema</span>
          <Textarea value={form.inputSchemaJson} onChange={(event) => setForm({ ...form, inputSchemaJson: event.target.value })} aria-label="Tool input schema JSON" className="min-h-36 font-mono" disabled={sourceManaged} />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">Adapter config</span>
          <Textarea value={form.adapterConfigJson} onChange={(event) => setForm({ ...form, adapterConfigJson: event.target.value })} aria-label="Tool adapter config JSON" className="min-h-36 font-mono" disabled={sourceManaged} />
        </label>
        <button
          type="button"
          role="switch"
          aria-checked={form.enabled}
          className="flex items-center justify-between border border-border px-3 py-2 text-sm"
          onClick={() => setForm({ ...form, enabled: !form.enabled })}
          disabled={sourceManaged}
        >
          <span className="flex items-center gap-2">
            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
            Enabled for invocation
          </span>
          <ToolStatus enabled={form.enabled} />
        </button>
        {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
      </div>
    </section>
  );
}
