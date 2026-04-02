import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { channelApi, type ChannelConfig } from "../api/channel";
import { secretsApi } from "../api/secrets";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  MessageSquare,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
  Save,
} from "lucide-react";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Query keys (local — no cross-page sharing needed)
// ---------------------------------------------------------------------------

// channelKeys are in queryKeys.channel

// ---------------------------------------------------------------------------
// Status indicator
// ---------------------------------------------------------------------------

type ConnectionStatus = "unknown" | "checking" | "connected" | "error";

interface StatusIndicatorProps {
  status: ConnectionStatus;
  errorMessage?: string;
  botUsername?: string;
}

function StatusIndicator({ status, errorMessage, botUsername }: StatusIndicatorProps) {
  if (status === "unknown") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Not tested</span>
      </div>
    );
  }

  if (status === "checking") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 shrink-0 animate-spin" />
        <span>Testing connection...</span>
      </div>
    );
  }

  if (status === "connected") {
    return (
      <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>
          Connected
          {botUsername && (
            <span className="text-muted-foreground ml-1">(@{botUsername})</span>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 text-sm text-destructive">
        <XCircle className="h-4 w-4 shrink-0" />
        <span>Connection failed</span>
      </div>
      {errorMessage && (
        <p className="text-xs text-muted-foreground pl-6">{errorMessage}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TelegramSection
// ---------------------------------------------------------------------------

interface TelegramSectionProps {
  companyId: string;
  config: ChannelConfig | null;
}

function TelegramSection({ companyId, config }: TelegramSectionProps) {
  const queryClient = useQueryClient();

  // Form state
  const [botToken, setBotToken] = useState("");
  const [botUsername, setBotUsername] = useState(config?.botUsername ?? "");
  const [secretName, setSecretName] = useState("telegram_bot_token");
  const [formError, setFormError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Connection test state
  const [testStatus, setTestStatus] = useState<ConnectionStatus>(
    config?.botTokenSecretId ? "unknown" : "unknown",
  );
  const [testBotUsername, setTestBotUsername] = useState<string | undefined>();
  const [testError, setTestError] = useState<string | undefined>();

  // Existing secrets for secret selector
  const { data: secrets } = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: !!companyId,
  });

  const createSecretMutation = useMutation({
    mutationFn: (value: string) =>
      secretsApi.create(companyId, {
        name: secretName,
        value,
        description: "Telegram bot token",
      }),
  });

  const updateConfigMutation = useMutation({
    mutationFn: (data: { botUsername: string; botTokenSecretId: string }) =>
      channelApi.updateConfig(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channel.config(companyId) });
      setSaveSuccess(true);
      setFormError(null);
      setTimeout(() => setSaveSuccess(false), 3000);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Failed to save config");
    },
  });

  const testMutation = useMutation({
    mutationFn: () => channelApi.test(companyId),
    onMutate: () => {
      setTestStatus("checking");
      setTestBotUsername(undefined);
      setTestError(undefined);
    },
    onSuccess: (result) => {
      if (result.ok) {
        setTestStatus("connected");
        setTestBotUsername(result.botUsername);
      } else {
        setTestStatus("error");
        setTestError(result.error ?? "Unknown error");
      }
    },
    onError: (err) => {
      setTestStatus("error");
      setTestError(err instanceof Error ? err.message : "Test failed");
    },
  });

  const isConfigured = !!config?.botTokenSecretId;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSaveSuccess(false);

    if (!botUsername.trim()) {
      setFormError("Bot username is required");
      return;
    }

    try {
      let secretId = config?.botTokenSecretId ?? null;

      // If a new token was entered, store it as a secret first
      if (botToken.trim()) {
        const existingSecret = secrets?.find((s) => s.name === secretName);
        if (existingSecret) {
          await secretsApi.rotate(existingSecret.id, { value: botToken });
          secretId = existingSecret.id;
        } else {
          const created = await createSecretMutation.mutateAsync(botToken);
          secretId = created.id;
        }
      }

      if (!secretId) {
        setFormError("A bot token is required to configure the channel");
        return;
      }

      updateConfigMutation.mutate({ botUsername: botUsername.trim(), botTokenSecretId: secretId });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  const isSaving =
    createSecretMutation.isPending || updateConfigMutation.isPending;

  return (
    <div className="space-y-6">
      {/* Status row */}
      <div className="flex items-center justify-between">
        <StatusIndicator
          status={testStatus}
          errorMessage={testError}
          botUsername={testBotUsername}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => testMutation.mutate()}
          disabled={!isConfigured || testMutation.isPending}
          title={!isConfigured ? "Save a configuration first" : undefined}
        >
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", testMutation.isPending && "animate-spin")} />
          Test Connection
        </Button>
      </div>

      <Separator />

      {/* Config form */}
      <form onSubmit={handleSave} className="space-y-4">
        {/* Bot username */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Bot username
          </label>
          <Input
            className="h-8 text-sm"
            value={botUsername}
            onChange={(e) => setBotUsername(e.target.value)}
            placeholder="e.g. papercompanyBot"
          />
          <p className="text-xs text-muted-foreground">
            The Telegram username of your bot (without @).
          </p>
        </div>

        {/* Bot token */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Bot token
            {isConfigured && (
              <span className="ml-2 text-green-600 dark:text-green-400 font-normal">
                (token stored — enter new value to rotate)
              </span>
            )}
          </label>
          <Input
            className="h-8 text-sm font-mono"
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={isConfigured ? "Leave blank to keep existing token" : "123456789:ABCdef..."}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Obtain from @BotFather on Telegram. Stored encrypted in company secrets.
          </p>
        </div>

        {/* Secret name (only shown when not yet configured) */}
        {!isConfigured && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Secret name
            </label>
            <Input
              className="h-8 text-sm"
              value={secretName}
              onChange={(e) => setSecretName(e.target.value)}
              placeholder="telegram_bot_token"
            />
            <p className="text-xs text-muted-foreground">
              The name under which the token will be saved in company secrets.
            </p>
          </div>
        )}

        {/* Existing secret selector (if token already stored) */}
        {isConfigured && config?.botTokenSecretId && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Stored secret
            </label>
            <p className="text-xs text-muted-foreground font-mono">
              {secrets?.find((s) => s.id === config.botTokenSecretId)?.name ?? config.botTokenSecretId}
            </p>
          </div>
        )}

        {formError && (
          <p className="text-xs text-destructive">{formError}</p>
        )}

        {saveSuccess && (
          <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Configuration saved.
          </p>
        )}

        <div className="pt-1">
          <Button
            type="submit"
            size="sm"
            className="h-7 text-xs"
            disabled={isSaving}
          >
            <Save className="h-3.5 w-3.5 mr-1.5" />
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChannelConfig page
// ---------------------------------------------------------------------------

export function ChannelConfig() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Channel" }]);
  }, [setBreadcrumbs]);

  const { data: config, isLoading, error } = useQuery({
    queryKey: queryKeys.channel.config(selectedCompanyId!),
    queryFn: () => channelApi.getConfig(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={MessageSquare} message="Select a company to configure channels." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  return (
    <div className="space-y-6 max-w-xl">
      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {/* Header */}
      <div>
        <h1 className="text-base font-semibold">Channel Configuration</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Configure external messaging channels for agent notifications.
        </p>
      </div>

      <Separator />

      {/* Telegram section */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Telegram</h2>
          {config?.enabled && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
              Enabled
            </span>
          )}
          {config && !config.enabled && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              Disabled
            </span>
          )}
        </div>

        <TelegramSection companyId={selectedCompanyId} config={config ?? null} />
      </div>
    </div>
  );
}
