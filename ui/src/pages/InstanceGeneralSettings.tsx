import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import type { PatchInstanceGeneralSettings } from "@paperclipai/shared";
import { Input } from "@/components/ui/input";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

export interface JudgmentConnectionDraft {
  judgmentBaseUrl: string;
  judgmentModelId: string;
}

export function toJudgmentDraft(
  settings?: { judgmentBaseUrl?: string; judgmentModelId?: string } | null,
): JudgmentConnectionDraft {
  return {
    judgmentBaseUrl: settings?.judgmentBaseUrl ?? "",
    judgmentModelId: settings?.judgmentModelId ?? "",
  };
}

export function toGeneralPatch(draft: JudgmentConnectionDraft): PatchInstanceGeneralSettings {
  const judgmentBaseUrl = draft.judgmentBaseUrl.trim();
  const judgmentModelId = draft.judgmentModelId.trim();
  return {
    judgmentBaseUrl: judgmentBaseUrl === "" ? null : judgmentBaseUrl,
    judgmentModelId: judgmentModelId === "" ? null : judgmentModelId,
  };
}

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [judgmentDraft, setJudgmentDraft] = useState<JudgmentConnectionDraft>(toJudgmentDraft());

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "General" },
    ]);
  }, [setBreadcrumbs]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });

  useEffect(() => {
    if (generalQuery.data) {
      setJudgmentDraft(toJudgmentDraft(generalQuery.data));
    }
  }, [generalQuery.data]);

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) =>
      instanceSettingsApi.updateGeneral({ censorUsernameInLogs: enabled }),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update general settings.");
    },
  });

  const judgmentMutation = useMutation({
    mutationFn: async (draft: JudgmentConnectionDraft) =>
      instanceSettingsApi.updateGeneral(toGeneralPatch(draft)),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(
        error instanceof Error ? error.message : "Failed to update judgment connection settings.",
      );
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading general settings...</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : "Failed to load general settings."}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">General</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure instance-wide defaults that affect how operator-visible logs are displayed.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Censor username in logs</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Hide the username segment in home-directory paths and similar operator-visible log output. Standalone
              username mentions outside of paths are not yet masked in the live transcript view. This is off by
              default.
            </p>
          </div>
          <button
            type="button"
            aria-label="Toggle username log censoring"
            disabled={toggleMutation.isPending}
            className={cn(
              "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              censorUsernameInLogs ? "bg-green-600" : "bg-muted",
            )}
            onClick={() => toggleMutation.mutate(!censorUsernameInLogs)}
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                censorUsernameInLogs ? "translate-x-4.5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">Judgment connection</h2>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          TypeSafe 호환 판단 API 주소(비우면 기본값)를 지정합니다. 모델 미설정 시 정의별 모델 사용.
          서버 환경의 기존 판단 API 키가 이 주소로 전송됨.
        </p>
        <div className="mt-4 grid max-w-xl gap-4">
          <div className="space-y-1.5">
            <label htmlFor="judgment-base-url" className="text-sm font-medium">
              Base URL
            </label>
            <Input
              id="judgment-base-url"
              value={judgmentDraft.judgmentBaseUrl}
              onChange={(event) =>
                setJudgmentDraft((draft) => ({ ...draft, judgmentBaseUrl: event.target.value }))
              }
              placeholder="https://api.typesafe.ai"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="judgment-model-id" className="text-sm font-medium">
              Model id
            </label>
            <Input
              id="judgment-model-id"
              value={judgmentDraft.judgmentModelId}
              onChange={(event) =>
                setJudgmentDraft((draft) => ({ ...draft, judgmentModelId: event.target.value }))
              }
              placeholder="jev-1.13.0"
              autoComplete="off"
            />
          </div>
          <button
            type="button"
            disabled={judgmentMutation.isPending}
            className="inline-flex h-9 w-fit items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => judgmentMutation.mutate(judgmentDraft)}
          >
            Save judgment connection
          </button>
        </div>
      </section>
    </div>
  );
}
