import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret } from "@paperclipai/shared";
import { KeyRound } from "lucide-react";
import { secretsApi } from "../../api/secrets";
import { useToast } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { formatDateTime } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type SecretManageDialogProps = {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type RowAction = "none" | "rotate" | "edit" | "delete";

/**
 * Company secret manager: lists secrets with tool usage, and supports
 * rename/description edit, value rotation, and delete. Delete is blocked
 * client-side while a secret is referenced by a tool; the server also
 * rejects referenced deletes with 409 and the error is surfaced here.
 */
export function SecretManageDialog({ companyId, open, onOpenChange }: SecretManageDialogProps) {
  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: open,
  });
  const secrets = secretsQuery.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Manage secrets</DialogTitle>
          <DialogDescription>
            Rename, rotate, or delete company secrets. Values are never shown after creation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {secretsQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Loading secrets…</p>
          ) : null}
          {secretsQuery.isError ? (
            <p className="text-sm text-destructive">Secret list could not be loaded.</p>
          ) : null}
          {secretsQuery.isSuccess && secrets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No secrets yet.</p>
          ) : null}
          {secrets.map((secret) => (
            <SecretRow key={secret.id} companyId={companyId} secret={secret} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SecretRow({ companyId, secret }: { companyId: string; secret: CompanySecret }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [action, setAction] = useState<RowAction>("none");
  const [rotateValue, setRotateValue] = useState("");
  const [editName, setEditName] = useState(secret.name);
  const [editDescription, setEditDescription] = useState(secret.description ?? "");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const usedByTools = secret.usedByTools ?? [];

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
  }

  function mutationError(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback;
  }

  const rotate = useMutation({
    mutationFn: (input: { value: string }) => secretsApi.rotate(secret.id, input),
    onSuccess: async () => {
      setRotateValue("");
      setAction("none");
      await invalidate();
      pushToast({ tone: "success", title: "Secret rotated", body: secret.name });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Rotation failed", body: mutationError(error, "Failed to rotate secret.") });
    },
  });

  const update = useMutation({
    mutationFn: (input: { name: string; description: string | null }) =>
      secretsApi.update(secret.id, input),
    onSuccess: async () => {
      setAction("none");
      await invalidate();
      pushToast({ tone: "success", title: "Secret updated", body: editName });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Update failed", body: mutationError(error, "Failed to update secret.") });
    },
  });

  const remove = useMutation({
    mutationFn: () => secretsApi.remove(secret.id),
    onSuccess: async () => {
      setAction("none");
      await invalidate();
      pushToast({ tone: "success", title: "Secret deleted", body: secret.name });
    },
    onError: (error) => {
      setDeleteError(mutationError(error, "Failed to delete secret."));
      pushToast({ tone: "error", title: "Delete failed", body: mutationError(error, "Failed to delete secret.") });
    },
  });

  const anyPending = rotate.isPending || update.isPending || remove.isPending;

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="truncate">{secret.name}</span>
          </div>
          {secret.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{secret.description}</p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            Version {secret.latestVersion} · Updated {formatDateTime(secret.updatedAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setAction(action === "rotate" ? "none" : "rotate")} disabled={anyPending}>
            Rotate
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAction(action === "edit" ? "none" : "edit")} disabled={anyPending}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() => {
              setDeleteError(null);
              setAction(action === "delete" ? "none" : "delete");
            }}
            disabled={anyPending}
          >
            Delete
          </Button>
        </div>
      </div>

      {usedByTools.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Used by {usedByTools.length} tool{usedByTools.length === 1 ? "" : "s"}: {usedByTools.join(", ")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Not used by any tool</p>
      )}

      {action === "rotate" ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <Input
            type="password"
            value={rotateValue}
            onChange={(event) => setRotateValue(event.target.value)}
            placeholder="New secret value"
            aria-label={`New value for ${secret.name}`}
            autoComplete="new-password"
            disabled={rotate.isPending}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => rotate.mutate({ value: rotateValue })}
              disabled={rotate.isPending || !rotateValue}
            >
              {rotate.isPending ? "Rotating…" : "Rotate secret"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setAction("none"); setRotateValue(""); }} disabled={rotate.isPending}>
              Cancel
            </Button>
            <span className="text-xs text-muted-foreground">
              Tools using this secret pick up the new value on their next call (version: latest).
            </span>
          </div>
        </div>
      ) : null}

      {action === "edit" ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              placeholder="Secret name"
              aria-label={`Name for ${secret.name}`}
              disabled={update.isPending}
            />
            <Input
              value={editDescription}
              onChange={(event) => setEditDescription(event.target.value)}
              placeholder="Description (optional)"
              aria-label={`Description for ${secret.name}`}
              disabled={update.isPending}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => update.mutate({ name: editName.trim(), description: editDescription.trim() || null })}
              disabled={update.isPending || !editName.trim()}
            >
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditName(secret.name);
                setEditDescription(secret.description ?? "");
                setAction("none");
              }}
              disabled={update.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {action === "delete" ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-sm">
            Delete <span className="font-medium">{secret.name}</span>? This cannot be undone.
          </p>
          {usedByTools.length > 0 ? (
            <p className="text-xs text-destructive">
              This secret is used by {usedByTools.length} tool{usedByTools.length === 1 ? "" : "s"} ({usedByTools.join(", ")}).
              Detach it from those tools before deleting.
            </p>
          ) : null}
          {deleteError ? <p className="text-xs text-destructive">{deleteError}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => remove.mutate()}
              disabled={remove.isPending || usedByTools.length > 0}
            >
              {remove.isPending ? "Deleting…" : "Delete secret"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setAction("none"); setDeleteError(null); }} disabled={remove.isPending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
