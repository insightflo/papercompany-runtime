import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileText, Plus, RefreshCw, Save, Trash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { companyInstructionsApi } from "../api/companyInstructions";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

const DEFAULT_FILE_PATH = "company-common.md";

function normalizeDraftPath(value: string) {
  return value.trim().replace(/^\/+/, "");
}

export function CompanyInstructions() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [newPath, setNewPath] = useState(DEFAULT_FILE_PATH);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Instructions" }]);
  }, [setBreadcrumbs]);

  const bundleQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.companyInstructions.bundle(selectedCompanyId) : ["company-instructions", "none"],
    queryFn: () => companyInstructionsApi.bundle(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const files = bundleQuery.data?.files ?? [];
  const activePath = selectedPath ?? files[0]?.path ?? null;

  useEffect(() => {
    if (!selectedPath && files[0]?.path) {
      setSelectedPath(files[0].path);
    }
  }, [files, selectedPath]);

  const fileQuery = useQuery({
    queryKey: selectedCompanyId && activePath
      ? queryKeys.companyInstructions.file(selectedCompanyId, activePath)
      : ["company-instructions", "file", "none"],
    queryFn: () => companyInstructionsApi.file(selectedCompanyId!, activePath!),
    enabled: Boolean(selectedCompanyId && activePath),
  });

  useEffect(() => {
    if (fileQuery.data && !dirty) {
      setDraft(fileQuery.data.content);
    }
  }, [dirty, fileQuery.data]);

  const selectedFile = fileQuery.data;
  const rootPath = bundleQuery.data?.rootPath ?? "";

  const saveFile = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId || !activePath) throw new Error("Select a company instruction file first.");
      return companyInstructionsApi.updateFile(selectedCompanyId, activePath, draft);
    },
    onSuccess: async (file) => {
      setDirty(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companyInstructions.bundle(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companyInstructions.file(selectedCompanyId!, file.path) }),
      ]);
      pushToast({ tone: "success", title: "Instruction saved", body: file.path });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Save failed",
        body: error instanceof Error ? error.message : "Failed to save company instruction.",
      });
    },
  });

  const createFile = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("Select a company first.");
      const path = normalizeDraftPath(newPath);
      if (!path) throw new Error("Enter a file path.");
      return companyInstructionsApi.updateFile(
        selectedCompanyId,
        path,
        `# ${path.replace(/\.md$/i, "").replaceAll("-", " ")}\n\n`,
      );
    },
    onSuccess: async (file) => {
      setSelectedPath(file.path);
      setDraft(file.content);
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.companyInstructions.bundle(selectedCompanyId!) });
      pushToast({ tone: "success", title: "Instruction file created", body: file.path });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Create failed",
        body: error instanceof Error ? error.message : "Failed to create company instruction.",
      });
    },
  });

  const deleteFile = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId || !activePath) throw new Error("Select a company instruction file first.");
      return companyInstructionsApi.deleteFile(selectedCompanyId, activePath);
    },
    onSuccess: async () => {
      setSelectedPath(null);
      setDraft("");
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.companyInstructions.bundle(selectedCompanyId!) });
      pushToast({ tone: "success", title: "Instruction file deleted" });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Delete failed",
        body: error instanceof Error ? error.message : "Failed to delete company instruction.",
      });
    },
  });

  const statusText = useMemo(() => {
    if (saveFile.isPending) return "Saving...";
    if (dirty) return "Unsaved changes";
    if (selectedFile) return `${selectedFile.size.toLocaleString()} bytes`;
    return "No file selected";
  }, [dirty, saveFile.isPending, selectedFile]);

  if (!selectedCompanyId) {
    return <EmptyState icon={BookOpen} message="Select a company to manage instructions." />;
  }

  return (
    <div className="grid min-h-[calc(100vh-12rem)] gap-0 xl:grid-cols-[19rem_minmax(0,1fr)]">
      <aside className="border-r border-border">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h1 className="text-base font-semibold">Instructions</h1>
              <p className="text-xs text-muted-foreground">{files.length} company files</p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => bundleQuery.refetch()}
              disabled={bundleQuery.isFetching}
              title="Refresh company instructions"
            >
              <RefreshCw className={cn("h-4 w-4", bundleQuery.isFetching && "animate-spin")} />
            </Button>
          </div>
          <p className="mt-2 truncate text-xs text-muted-foreground" title={rootPath}>
            {rootPath || selectedCompany?.name}
          </p>
          <div className="mt-3 flex items-center gap-2 border-b border-border pb-2">
            <Input
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              placeholder="common/research.md"
              className="h-8"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => createFile.mutate()}
              disabled={createFile.isPending}
              title="Create instruction file"
            >
              {createFile.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {bundleQuery.isLoading ? (
          <PageSkeleton variant="list" />
        ) : bundleQuery.error ? (
          <div className="px-4 py-6 text-sm text-destructive">{bundleQuery.error.message}</div>
        ) : files.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">No company instructions yet.</div>
        ) : (
          <div className="py-2">
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => {
                  setSelectedPath(file.path);
                  setDirty(false);
                }}
                className={cn(
                  "flex min-h-9 w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors hover:bg-accent/50",
                  file.path === activePath ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                )}
              >
                <FileText className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <main className="min-w-0 pl-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{activePath ?? "Company instructions"}</h2>
            <p className={cn("mt-1 text-xs", dirty ? "text-amber-500" : "text-muted-foreground")}>{statusText}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => deleteFile.mutate()}
              disabled={!activePath || deleteFile.isPending}
            >
              <Trash className="mr-2 h-4 w-4" />
              Delete
            </Button>
            <Button
              size="sm"
              onClick={() => saveFile.mutate()}
              disabled={!activePath || saveFile.isPending || !dirty}
            >
              {saveFile.isPending ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save
            </Button>
          </div>
        </div>

        {fileQuery.isLoading && activePath ? (
          <PageSkeleton variant="detail" />
        ) : fileQuery.error ? (
          <div className="rounded-md border border-border px-4 py-6 text-sm text-destructive">
            {fileQuery.error.message}
          </div>
        ) : activePath ? (
          <Textarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setDirty(true);
            }}
            spellCheck={false}
            className="min-h-[calc(100vh-14rem)] resize-none font-mono text-xs leading-5"
          />
        ) : (
          <div className="rounded-md border border-border px-4 py-10 text-sm text-muted-foreground">
            Create or select a company instruction file.
          </div>
        )}
      </main>
    </div>
  );
}
