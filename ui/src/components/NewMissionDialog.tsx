import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { missionsApi, type MissionStatus } from "../api/missions";
import { agentsApi } from "../api/agents";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Maximize2, Minimize2, Rocket, User } from "lucide-react";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { StatusBadge } from "./StatusBadge";

const statusOptions: { value: MissionStatus; label: string }[] = [
  { value: "planning", label: "Planning" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
];

export function NewMissionDialog() {
  const { newMissionOpen, closeNewMission } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<MissionStatus>("planning");
  const [ownerAgentId, setOwnerAgentId] = useState("");
  const [expanded, setExpanded] = useState(false);

  const [statusOpen, setStatusOpen] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newMissionOpen,
  });

  useEffect(() => {
    if (!newMissionOpen || ownerAgentId || !agents || agents.length === 0) return;
    setOwnerAgentId(agents[0]!.id);
  }, [agents, newMissionOpen, ownerAgentId]);

  const createMission = useMutation({
    mutationFn: (data: { title: string; description?: string; status: MissionStatus; ownerAgentId: string }) =>
      missionsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.list(selectedCompanyId!) });
      reset();
      closeNewMission();
    },
  });

  function reset() {
    setTitle("");
    setDescription("");
    setStatus("planning");
    setOwnerAgentId("");
    setExpanded(false);
  }

  function handleSubmit() {
    if (!selectedCompanyId || !title.trim()) return;
    createMission.mutate({
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      ownerAgentId: ownerAgentId || (agents?.[0]?.id ?? ""),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const selectedOwner = agents?.find((a) => a.id === ownerAgentId);

  return (
    <Dialog
      open={newMissionOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewMission();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn("p-0 gap-0", expanded ? "sm:max-w-2xl" : "sm:max-w-lg")}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {selectedCompany && (
              <span className="bg-muted px-1.5 py-0.5 rounded text-xs font-medium">
                {selectedCompany.name.slice(0, 3).toUpperCase()}
              </span>
            )}
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>New Mission</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => { reset(); closeNewMission(); }}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        {/* Title */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder="Mission title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                descriptionEditorRef.current?.focus();
              }
            }}
            autoFocus
          />
        </div>

        {/* Description */}
        <div className="px-4 pb-2">
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder="Add description..."
            bordered={false}
            contentClassName={cn(
              "text-sm text-muted-foreground",
              expanded ? "min-h-[220px]" : "min-h-[120px]"
            )}
          />
        </div>

        {/* Property chips */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap">
          {/* Status */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <StatusBadge status={status} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="start">
              {statusOptions.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 capitalize",
                    s.value === status && "bg-accent"
                  )}
                  onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                >
                  {s.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Owner Agent */}
          <Popover open={ownerOpen} onOpenChange={setOwnerOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <User className="h-3 w-3 text-muted-foreground" />
                {selectedOwner ? selectedOwner.name : "Owner agent"}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-1" align="start">
              {(agents ?? []).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 truncate",
                    a.id === ownerAgentId && "bg-accent"
                  )}
                  onClick={() => { setOwnerAgentId(a.id); setOwnerOpen(false); }}
                >
                  {a.name}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-4 py-2.5 border-t border-border">
          <Button
            size="sm"
            disabled={!title.trim() || createMission.isPending || (agents ?? []).length === 0}
            onClick={handleSubmit}
          >
            {createMission.isPending ? "Creating…" : "Create mission"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
