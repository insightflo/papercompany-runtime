import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { isHeartbeatPageScopeCurrent } from "../lib/inbox";
import { queryKeys } from "../lib/queryKeys";
import type {
  HeartbeatRun,
  HeartbeatRunAttentionItem,
  HeartbeatRunCursor,
} from "@paperclipai/shared";

const ATTENTION_PAGE_SIZE = 50;

/**
 * Adapt an attention item (bounded lightweight shape) into a HeartbeatRun so
 * existing inbox rows keep working. Retry semantics are preserved: the issue
 * id is carried in contextSnapshot.issueId, matching what the retry mutation
 * reads.
 */
export function attentionItemToRun(
  item: HeartbeatRunAttentionItem,
  companyId: string,
): HeartbeatRun {
  return {
    id: item.runId,
    companyId,
    agentId: item.agentId,
    status: item.status,
    createdAt: item.createdAt,
    error: item.error,
    errorCode: item.errorCode,
    contextSnapshot: item.issueId ? { issueId: item.issueId } : null,
    invocationSource: "on_demand",
    triggerDetail: null,
    startedAt: null,
    finishedAt: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    updatedAt: item.createdAt,
  };
}

/**
 * Bounded heartbeat data for the Inbox: paged attention (latest failed /
 * timed_out / cancelled run per agent with unresolved issues) plus live runs.
 * The attention list loads 50 items at a time via a stable cursor.
 */
export function useInboxHeartbeatData(companyId: string | null | undefined) {
  const { data: attention, isLoading } = useQuery({
    queryKey: queryKeys.heartbeatAttention(companyId!),
    queryFn: () => heartbeatsApi.attention(companyId!, { limit: ATTENTION_PAGE_SIZE }),
    enabled: !!companyId,
  });
  const companyIdRef = useRef(companyId);
  companyIdRef.current = companyId;
  const [cursor, setCursor] = useState<HeartbeatRunCursor | null>(null);
  const [items, setItems] = useState<HeartbeatRunAttentionItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setItems(attention?.items ?? []);
    setCursor(attention?.nextCursor ?? null);
  }, [attention]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || !companyId) return;
    const scopeCompanyId = companyId;
    setLoadingMore(true);
    try {
      const page = await heartbeatsApi.attention(scopeCompanyId, {
        limit: ATTENTION_PAGE_SIZE,
        cursor,
      });
      if (!isHeartbeatPageScopeCurrent({ companyId: companyIdRef.current }, { companyId: scopeCompanyId })) return;
      setItems((prev) => {
        const seen = new Set(prev.map((item) => item.runId));
        return [...prev, ...page.items.filter((item) => !seen.has(item.runId))];
      });
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, companyId]);

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!),
    enabled: !!companyId,
    refetchInterval: 15_000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.status !== "running" && run.status !== "queued") continue;
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  return {
    isLoading,
    attentionItems: items,
    liveRuns: (liveRuns ?? []) as LiveRunForIssue[],
    liveIssueIds,
    hasMore: cursor !== null,
    loadingMore,
    loadMore,
  };
}
