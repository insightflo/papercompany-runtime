import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret } from "@paperclipai/shared";
import type { CompanyWorkProductStorageConfig } from "@paperclipai/shared/validators/company-work-product-storage";
import { CheckCircle2, Database, Plus, XCircle } from "lucide-react";
import { workProductStorageApi, type WorkProductStorageConnectionTest } from "../api/company-work-product-storage";
import { secretsApi } from "../api/secrets";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type StorageForm = {
  provider: "local_disk" | "s3";
  endpoint: string;
  region: string;
  bucket: string;
  keyPrefix: string;
  forcePathStyle: boolean;
  accessKeySecretId: string;
  secretAccessKeySecretId: string;
};
type SecretTarget = "access" | "secret";

const LOCAL_DISK_CONFIG: CompanyWorkProductStorageConfig = { provider: "local_disk" };

function formFromConfig(config?: CompanyWorkProductStorageConfig): StorageForm {
  if (config?.provider === "s3") {
    return {
      provider: "s3", endpoint: config.endpoint, region: config.region, bucket: config.bucket,
      keyPrefix: config.keyPrefix ?? "", forcePathStyle: Boolean(config.forcePathStyle),
      accessKeySecretId: config.accessKeySecretId, secretAccessKeySecretId: config.secretAccessKeySecretId,
    };
  }
  return {
    provider: "local_disk", endpoint: "", region: "us-east-1", bucket: "", keyPrefix: "",
    forcePathStyle: false, accessKeySecretId: "", secretAccessKeySecretId: "",
  };
}

function configFromForm(form: StorageForm): CompanyWorkProductStorageConfig {
  if (form.provider === "local_disk") return LOCAL_DISK_CONFIG;
  return {
    provider: "s3", endpoint: form.endpoint.trim(), region: form.region.trim(), bucket: form.bucket.trim(),
    keyPrefix: form.keyPrefix.trim() || undefined, forcePathStyle: form.forcePathStyle,
    accessKeySecretId: form.accessKeySecretId, secretAccessKeySecretId: form.secretAccessKeySecretId,
  };
}

function SecretSelect({ label, value, onChange, secrets, disabled }: {
  label: string; value: string; onChange: (value: string) => void; secrets: CompanySecret[]; disabled: boolean;
}) {
  return <label className="space-y-1.5 text-sm"><span className="text-muted-foreground">{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}
      className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
      <option value="">Select a saved secret</option>
      {secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.name}</option>)}
    </select>
  </label>;
}

export function CompanyWorkProductStorageSettings({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const storageKey = ["company-work-product-storage", companyId] as const;
  const storageQuery = useQuery({ queryKey: storageKey, queryFn: () => workProductStorageApi.get(companyId) });
  const secretsQuery = useQuery({ queryKey: queryKeys.secrets.list(companyId), queryFn: () => secretsApi.list(companyId) });
  const [form, setForm] = useState(() => formFromConfig(storageQuery.data));
  const [createTarget, setCreateTarget] = useState<SecretTarget | null>(null);
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [testResult, setTestResult] = useState<WorkProductStorageConnectionTest | null>(null);
  const loadedConfigRef = useRef<string | null>(null);

  useEffect(() => {
    const loadedConfigKey = `${companyId}:${JSON.stringify(storageQuery.data ?? LOCAL_DISK_CONFIG)}`;
    if (loadedConfigRef.current !== loadedConfigKey) {
      loadedConfigRef.current = loadedConfigKey;
      setForm(formFromConfig(storageQuery.data));
      setTestResult(null);
    }
  }, [companyId, storageQuery.data]);

  const createSecret = useMutation({
    mutationFn: (input: { target: SecretTarget; name: string; value: string }) =>
      secretsApi.create(companyId, { name: input.name, value: input.value }),
    onSuccess: async (secret, input) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      setForm((current) => input.target === "access"
        ? { ...current, accessKeySecretId: secret.id }
        : { ...current, secretAccessKeySecretId: secret.id });
      setCreateTarget(null); setNewSecretName(""); setNewSecretValue("");
      pushToast({ tone: "success", title: "Secret created", body: secret.name });
    },
    onError: (error) => pushToast({ tone: "error", title: "Secret creation failed", body: error instanceof Error ? error.message : "Failed to create secret." }),
  });

  const saveStorage = useMutation({
    mutationFn: () => workProductStorageApi.save(companyId, configFromForm(form)),
    onSuccess: (config) => {
      queryClient.setQueryData(storageKey, config); setForm(formFromConfig(config)); setTestResult(null);
      pushToast({ tone: "success", title: "Storage settings saved", body: config.provider === "s3" ? "S3-compatible storage is selected." : "Local disk storage is selected." });
    },
    onError: (error) => pushToast({ tone: "error", title: "Storage settings could not be saved", body: error instanceof Error ? error.message : "Please review the settings." }),
  });

  const testConnection = useMutation({
    mutationFn: () => workProductStorageApi.test(companyId),
    onSuccess: (result) => {
      setTestResult(result);
      pushToast({ tone: result.ok ? "success" : "error", title: result.ok ? "Storage connection verified" : "Storage connection failed", body: result.error });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Unable to test the saved connection.";
      setTestResult({ ok: false, provider: "s3", error: message });
      pushToast({ tone: "error", title: "Storage connection failed", body: message });
    },
  });

  const currentConfig = configFromForm(form);
  const savedConfig = storageQuery.data ?? LOCAL_DISK_CONFIG;
  const isSaved = JSON.stringify(currentConfig) === JSON.stringify(savedConfig);
  const s3Complete = Boolean(form.endpoint.trim() && form.region.trim() && form.bucket.trim() && form.accessKeySecretId && form.secretAccessKeySecretId);
  const secrets = secretsQuery.data ?? [];
  const secretSelectDisabled = secretsQuery.isPending || secretsQuery.isError || createSecret.isPending;

  function beginSecret(target: SecretTarget) {
    setCreateTarget(target); setNewSecretName(target === "access" ? "S3 access key" : "S3 secret access key"); setNewSecretValue("");
  }

  return <section className="space-y-4">
    <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Work-product storage</div>
    <div className="space-y-4 rounded-md border border-border px-4 py-4">
      <div className="flex items-start gap-2"><Database className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Local disk is the default. Select an S3-compatible store for private object storage such as MinIO or AWS S3.</p>
      </div>
      <label className="space-y-1.5 text-sm"><span className="text-muted-foreground">Storage provider</span>
        <select value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value === "s3" ? "s3" : "local_disk" })}
          className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
          <option value="local_disk">Local disk (default)</option><option value="s3">S3-compatible storage</option>
        </select>
      </label>
      {storageQuery.isError ? <p className="text-xs text-destructive">Current storage settings could not be loaded.</p> : null}
      {form.provider === "local_disk" ? <p className="text-xs text-muted-foreground">Workflow outputs remain on the configured local disk path.</p> : <div className="space-y-3 border-t border-border pt-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm"><span className="text-muted-foreground">Endpoint</span><Input value={form.endpoint} onChange={(event) => setForm({ ...form, endpoint: event.target.value })} placeholder="https://storage.example.com" /></label>
          <label className="space-y-1.5 text-sm"><span className="text-muted-foreground">Region</span><Input value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} placeholder="us-east-1" /></label>
          <label className="space-y-1.5 text-sm"><span className="text-muted-foreground">Bucket</span><Input value={form.bucket} onChange={(event) => setForm({ ...form, bucket: event.target.value })} placeholder="work-products" /></label>
          <label className="space-y-1.5 text-sm"><span className="text-muted-foreground">Key prefix (optional)</span><Input value={form.keyPrefix} onChange={(event) => setForm({ ...form, keyPrefix: event.target.value })} placeholder="research-company" /></label>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.forcePathStyle} onChange={(event) => setForm({ ...form, forcePathStyle: event.target.checked })} />Use path-style addressing</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <SecretSelect label="Access key secret" value={form.accessKeySecretId} onChange={(accessKeySecretId) => setForm({ ...form, accessKeySecretId })} secrets={secrets} disabled={secretSelectDisabled} />
          <SecretSelect label="Secret access key secret" value={form.secretAccessKeySecretId} onChange={(secretAccessKeySecretId) => setForm({ ...form, secretAccessKeySecretId })} secrets={secrets} disabled={secretSelectDisabled} />
        </div>
        {secretsQuery.isError ? <p className="text-xs text-destructive">Saved secrets could not be loaded.</p> : null}
        {createTarget ? <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">Create a new {createTarget === "access" ? "access key" : "secret access key"} secret. Its value is masked and never shown again.</p>
          <div className="grid gap-2 sm:grid-cols-2"><Input value={newSecretName} onChange={(event) => setNewSecretName(event.target.value)} placeholder="Secret name" /><Input type="password" value={newSecretValue} onChange={(event) => setNewSecretValue(event.target.value)} placeholder="Secret value" autoComplete="new-password" /></div>
          <div className="flex gap-2"><Button size="sm" onClick={() => createTarget && createSecret.mutate({ target: createTarget, name: newSecretName.trim(), value: newSecretValue })} disabled={createSecret.isPending || !newSecretName.trim() || !newSecretValue}>Create secret</Button><Button size="sm" variant="ghost" onClick={() => setCreateTarget(null)} disabled={createSecret.isPending}>Cancel</Button></div>
        </div> : <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={() => beginSecret("access")}><Plus className="h-3.5 w-3.5" />New access-key secret</Button><Button size="sm" variant="ghost" onClick={() => beginSecret("secret")}><Plus className="h-3.5 w-3.5" />New secret-access-key secret</Button></div>}
      </div>}
      <div className="flex flex-wrap items-center gap-2"><Button size="sm" onClick={() => saveStorage.mutate()} disabled={saveStorage.isPending || (form.provider === "s3" && !s3Complete)}>{saveStorage.isPending ? "Saving…" : "Save storage settings"}</Button>
        {form.provider === "s3" ? <Button size="sm" variant="outline" onClick={() => testConnection.mutate()} disabled={!isSaved || testConnection.isPending}>{testConnection.isPending ? "Testing…" : "Test saved connection"}</Button> : null}
      </div>
      {form.provider === "s3" && !isSaved ? <p className="text-xs text-muted-foreground">Save changes before testing the connection.</p> : null}
      {saveStorage.isError ? <p className="text-xs text-destructive">{saveStorage.error instanceof Error ? saveStorage.error.message : "Storage settings could not be saved."}</p> : null}
      {testResult ? <p className={`flex items-center gap-1.5 text-xs ${testResult.ok ? "text-green-600" : "text-destructive"}`}>{testResult.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}{testResult.ok ? "Connection verified." : testResult.error ?? "Storage connection failed."}</p> : null}
    </div>
  </section>;
}
