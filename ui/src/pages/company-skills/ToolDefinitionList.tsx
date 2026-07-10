import type { ToolDefinition } from "@paperclipai/shared";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageSkeleton } from "../../components/PageSkeleton";
import { cn } from "../../lib/utils";
import { ToolStatus } from "./ToolDefinitionEditor";

type ToolDefinitionListProps = {
  tools: ToolDefinition[];
  filteredTools: ToolDefinition[];
  selectedToolId: string | null;
  filter: string;
  isLoading: boolean;
  error: Error | null;
  onFilterChange: (filter: string) => void;
  onSelect: (toolId: string) => void;
  onCreate: () => void;
};

export function ToolDefinitionList({
  tools,
  filteredTools,
  selectedToolId,
  filter,
  isLoading,
  error,
  onFilterChange,
  onSelect,
  onCreate,
}: ToolDefinitionListProps) {
  return (
    <aside className="border-r border-border">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-base font-semibold">Tools</h1>
            <p className="text-xs text-muted-foreground">{tools.length} registered</p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onCreate} aria-label="Create tool">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2 border-b border-border pb-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder="Filter tools"
            aria-label="Filter tools"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : error ? (
        <div className="px-4 py-6 text-sm text-destructive">{error.message}</div>
      ) : filteredTools.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">No tools match this filter.</div>
      ) : (
        <div>
          {filteredTools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className={cn(
                "flex w-full items-start justify-between gap-3 border-b border-border px-4 py-3 text-left text-sm outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                selectedToolId === tool.id && "bg-accent/40",
              )}
              onClick={() => onSelect(tool.id)}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{tool.name}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">{tool.adapterType}</span>
              </span>
              <ToolStatus enabled={tool.enabled} />
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
