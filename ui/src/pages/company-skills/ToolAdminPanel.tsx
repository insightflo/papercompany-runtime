import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateToolDefinitionRequest,
  ToolDefinition,
  UpdateToolDefinitionRequest,
} from "@paperclipai/shared";
import { Wrench } from "lucide-react";
import { toolDefinitionsApi } from "../../api/tools";
import { EmptyState } from "../../components/EmptyState";
import { PageSkeleton } from "../../components/PageSkeleton";
import { useToast } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import {
  buildToolPayload,
  emptyToolForm,
  formFromTool,
  isSourceManagedTool,
  resolveToolSelection,
  type ToolFormState,
} from "./toolAdminModel";
import { ToolDefinitionEditor } from "./ToolDefinitionEditor";
import { ToolDefinitionList } from "./ToolDefinitionList";

export function ToolAdminPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [filter, setFilter] = useState("");
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState<ToolFormState>(emptyToolForm);
  const [formError, setFormError] = useState<string | null>(null);

  const toolsQuery = useQuery({
    queryKey: queryKeys.toolDefinitions.list(companyId),
    queryFn: () => toolDefinitionsApi.list(companyId),
  });

  const tools = toolsQuery.data ?? [];
  const selectedTool = tools.find((tool) => tool.id === selectedToolId) ?? null;
  const filteredTools = useMemo(() => {
    const normalized = filter.trim().toLowerCase();
    if (!normalized) return tools;
    return tools.filter((tool) =>
      `${tool.name} ${tool.description} ${tool.adapterType}`.toLowerCase().includes(normalized),
    );
  }, [filter, tools]);

  useEffect(() => {
    const nextToolId = resolveToolSelection({
      isCreating,
      selectedToolId,
      toolIds: tools.map((tool) => tool.id),
    });
    if (nextToolId !== selectedToolId) setSelectedToolId(nextToolId);
  }, [isCreating, selectedToolId, tools]);

  useEffect(() => {
    setForm(selectedTool ? formFromTool(selectedTool) : emptyToolForm);
    setFormError(null);
  }, [selectedTool]);

  async function refreshTools() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.toolDefinitions.list(companyId) });
  }

  const createTool = useMutation({
    mutationFn: (payload: CreateToolDefinitionRequest) => toolDefinitionsApi.create(companyId, payload),
    onSuccess: async (tool) => {
      await refreshTools();
      setIsCreating(false);
      setSelectedToolId(tool.id);
      pushToast({ tone: "success", title: "Tool created", body: tool.name });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Tool creation failed", body: error instanceof Error ? error.message : "Failed to create tool." });
    },
  });

  const updateTool = useMutation({
    mutationFn: ({ toolId, payload }: { toolId: string; payload: UpdateToolDefinitionRequest }) =>
      toolDefinitionsApi.update(companyId, toolId, payload),
    onSuccess: async (tool) => {
      await refreshTools();
      setSelectedToolId(tool.id);
      pushToast({ tone: "success", title: "Tool saved", body: tool.name });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Tool save failed", body: error instanceof Error ? error.message : "Failed to save tool." });
    },
  });

  const deleteTool = useMutation({
    mutationFn: (toolId: string) => toolDefinitionsApi.remove(companyId, toolId),
    onSuccess: async () => {
      await refreshTools();
      setSelectedToolId(null);
      pushToast({ tone: "success", title: "Tool deleted" });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Tool delete failed", body: error instanceof Error ? error.message : "Failed to delete tool." });
    },
  });

  function startCreate() {
    setSelectedToolId(null);
    setIsCreating(true);
    setForm(emptyToolForm);
    setFormError(null);
  }

  function selectTool(toolId: string) {
    setIsCreating(false);
    setSelectedToolId(toolId);
  }

  function saveForm() {
    if (selectedTool && isSourceManagedTool(selectedTool.adapterConfig)) return;
    try {
      const payload = buildToolPayload(form);
      setFormError(null);
      if (selectedTool) {
        updateTool.mutate({ toolId: selectedTool.id, payload });
        return;
      }
      createTool.mutate(payload);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Invalid tool definition.");
    }
  }

  function toggleSelectedTool() {
    if (!selectedTool || isSourceManagedTool(selectedTool.adapterConfig)) return;
    updateTool.mutate({ toolId: selectedTool.id, payload: { enabled: !selectedTool.enabled } });
  }

  function deleteSelectedTool() {
    if (!selectedTool || isSourceManagedTool(selectedTool.adapterConfig)) return;
    if (window.confirm(`Delete ${selectedTool.name}?`)) {
      deleteTool.mutate(selectedTool.id);
    }
  }

  return (
    <div className="grid min-h-[calc(100vh-12rem)] gap-0 xl:grid-cols-[19rem_minmax(0,1fr)]">
      <ToolDefinitionList
        tools={tools}
        filteredTools={filteredTools}
        selectedToolId={selectedTool?.id ?? null}
        filter={filter}
        isLoading={toolsQuery.isLoading}
        error={toolsQuery.error}
        onFilterChange={setFilter}
        onSelect={selectTool}
        onCreate={startCreate}
      />

      <div className="min-w-0 pl-6">
        {toolsQuery.isLoading ? (
          <PageSkeleton variant="detail" />
        ) : tools.length === 0 && !selectedTool && !isCreating ? (
          <EmptyState icon={Wrench} message="Create the first company tool definition." />
        ) : (
          <ToolDefinitionEditor
            companyId={companyId}
            selectedTool={selectedTool}
            form={form}
            setForm={setForm}
            formError={formError}
            isSaving={createTool.isPending || updateTool.isPending}
            isDeleting={deleteTool.isPending}
            onSave={saveForm}
            onToggleEnabled={toggleSelectedTool}
            onDelete={deleteSelectedTool}
          />
        )}
      </div>
    </div>
  );
}
