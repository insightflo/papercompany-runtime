import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret } from "@paperclipai/shared";
import { KeyRound, Plus } from "lucide-react";
import { secretsApi } from "../../api/secrets";
import { useToast } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readAdapterAuth, writeAdapterAuth } from "./toolAdminModel";

type ToolAuthSelectorProps = {
  companyId: string;
  adapterConfigJson: string;
  onAdapterConfigChange: (json: string) => void;
  disabled?: boolean;
};

/**
 * Secret-by-name selector for HTTP/MCP tool authentication. Loads company
 * secrets, lets the operator pick one by name (never typing a raw secretId),
 * and offers an inline New secret flow that creates via the company Secrets
 * API then auto-selects the returned secret. Writes the selected id into
 * adapterConfig.auth.secretId with version "latest", preserving all other
 * adapterConfig fields. The raw Adapter config JSON remains the source of
 * truth and stays editable as the Advanced escape hatch.
 */
export function ToolAuthSelector({
  companyId,
  adapterConfigJson,
  onAdapterConfigChange,
  disabled,
}: ToolAuthSelectorProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");

  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
  });

  const secrets = secretsQuery.data ?? [];
  const authState = readAdapterAuth(adapterConfigJson);
  const invalid = authState.kind === "invalid";
  const headerName = authState.kind === "ok" ? authState.headerName : "";
  const selectedSecretId = authState.kind === "ok" ? authState.secretId : null;
  const isDisabled = Boolean(disabled) || invalid;
  const secretSelectDisabled = isDisabled || secretsQuery.isPending || secretsQuery.isError;

  function applyAuth(patch: { headerName?: string; secretId?: string | null }) {
    try {
      onAdapterConfigChange(writeAdapterAuth(adapterConfigJson, { ...patch, version: "latest" }));
    } catch {
      // Invalid JSON is guarded by the disabled state; ignore write failures.
    }
  }

  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) =>
      secretsApi.create(companyId, { name: input.name, value: input.value }),
    onSuccess: async (secret: CompanySecret) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      setNewName("");
      setNewValue("");
      setShowCreate(false);
      applyAuth({ secretId: secret.id });
      pushToast({ tone: "success", title: "Secret created", body: secret.name });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Secret creation failed",
        body: error instanceof Error ? error.message : "Failed to create secret.",
      });
    },
  });

  function handleCreate() {
    const name = newName.trim();
    if (!name || !newValue) return;
    createSecret.mutate({ name, value: newValue });
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
        Authentication
      </div>
      {invalid ? (
        <p className="text-xs text-muted-foreground">
          Fix the Advanced adapter config JSON to edit authentication.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="text-muted-foreground">Header name</span>
          <Input
            value={headerName}
            onChange={(event) => applyAuth({ headerName: event.target.value })}
            placeholder="Authorization"
            aria-label="Auth header name"
            disabled={isDisabled}
          />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="text-muted-foreground">Secret</span>
          <select
            value={selectedSecretId ?? ""}
            onChange={(event) => applyAuth({ secretId: event.target.value || null })}
            aria-label="Auth secret"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            disabled={secretSelectDisabled}
          >
            <option value="">
              {secretsQuery.isPending ? "Loading secrets…" : "— Select a secret —"}
            </option>
            {secrets.map((secret) => (
              <option key={secret.id} value={secret.id}>
                {secret.name}
              </option>
            ))}
          </select>
          {secretsQuery.isError ? (
            <span className="block text-xs text-destructive">
              Secret list could not be loaded.
            </span>
          ) : null}
        </label>
      </div>

      {showCreate ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Secret name"
              aria-label="New secret name"
              disabled={createSecret.isPending}
            />
            <Input
              type="password"
              value={newValue}
              onChange={(event) => setNewValue(event.target.value)}
              placeholder="Secret value"
              aria-label="New secret value"
              autoComplete="new-password"
              disabled={createSecret.isPending}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={createSecret.isPending || !newName.trim() || !newValue}
            >
              {createSecret.isPending ? "Creating…" : "Create secret"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowCreate(false);
                setNewName("");
                setNewValue("");
              }}
              disabled={createSecret.isPending}
            >
              Cancel
            </Button>
            <span className="text-xs text-muted-foreground">
              Values are masked and never shown after creation.
            </span>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setShowCreate(true)} disabled={isDisabled}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New secret
        </Button>
      )}
    </div>
  );
}
