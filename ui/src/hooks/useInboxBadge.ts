import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { approvalsApi } from "../api/approvals";
import { dashboardApi } from "../api/dashboard";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import {
  computeInboxBadgeData,
  getRecentTouchedIssues,
  loadDismissedInboxItems,
  saveDismissedInboxItems,
  getUnreadTouchedIssues,
} from "../lib/inbox";

const INBOX_ISSUE_STATUSES = "backlog,todo,in_progress,in_review,blocked,done";

const MAX_DISMISSED_RUN_IDS = 200;
const RUN_DISMISS_PREFIX = "run:";

/**
 * Extract bare run ids from the local dismissal set. Only `run:`-prefixed
 * keys map to heartbeat runs; other keys (alerts, approvals, ...) are
 * ignored. The result is sorted and capped so the URL/query key stays
 * bounded and stable regardless of insertion order.
 */
export function dismissedRunIdList(dismissed: Set<string>): string[] {
  const ids: string[] = [];
  for (const key of dismissed) {
    if (!key.startsWith(RUN_DISMISS_PREFIX)) continue;
    const runId = key.slice(RUN_DISMISS_PREFIX.length);
    if (runId.length > 0) ids.push(runId);
  }
  return Array.from(new Set(ids)).sort().slice(0, MAX_DISMISSED_RUN_IDS);
}

export function useDismissedInboxItems() {
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissedInboxItems);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "paperclip:inbox:dismissed") return;
      setDismissed(loadDismissedInboxItems());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissedInboxItems(next);
      return next;
    });
  };

  return { dismissed, dismiss };
}

export function useInboxBadge(companyId: string | null | undefined) {
  const { dismissed } = useDismissedInboxItems();
  const dismissedRunIds = useMemo(() => dismissedRunIdList(dismissed), [dismissed]);

  const { data: approvals = [] } = useQuery({
    queryKey: queryKeys.approvals.list(companyId!),
    queryFn: () => approvalsApi.list(companyId!),
    enabled: !!companyId,
  });

  const { data: joinRequests = [] } = useQuery({
    queryKey: queryKeys.access.joinRequests(companyId!),
    queryFn: async () => {
      try {
        return await accessApi.listJoinRequests(companyId!, "pending_approval");
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return [];
        }
        throw err;
      }
    },
    enabled: !!companyId,
    retry: false,
  });

  const { data: dashboard } = useQuery({
    queryKey: queryKeys.dashboard(companyId!),
    queryFn: () => dashboardApi.summary(companyId!),
    enabled: !!companyId,
  });

  const { data: touchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.listTouchedByMe(companyId!),
    queryFn: () =>
      issuesApi.list(companyId!, {
        touchedByUserId: "me",
        status: INBOX_ISSUE_STATUSES,
      }),
    enabled: !!companyId,
  });

  const { data: issues = [] } = useQuery({
    queryKey: queryKeys.issues.list(companyId!),
    queryFn: () => issuesApi.list(companyId!),
    enabled: !!companyId,
  });

  const unreadIssues = useMemo(
    () => getUnreadTouchedIssues(getRecentTouchedIssues(touchedIssues)),
    [touchedIssues],
  );

  // Bounded attention summary (latest failed/timed_out/cancelled run per
  // agent, unresolved issues only) instead of full run history. The server
  // summary is exact across all agents AND already excludes the locally
  // dismissed run ids (server-side membership check), so refresh keeps
  // page-2 dismissals applied.
  const { data: attention = { summary: { failed: 0, timedOut: 0, cancelled: 0, agents: 0 }, items: [], nextCursor: null } } = useQuery({
    queryKey: queryKeys.heartbeatAttention(companyId!, dismissedRunIds.join(",")),
    queryFn: () =>
      heartbeatsApi.attention(companyId!, {
        limit: 50,
        dismissedRunIds,
      }),
    enabled: !!companyId,
  });

  // Match the legacy FAILED_RUN_STATUSES semantics: only failed and
  // timed_out runs count toward the badge; cancelled runs are not inbox
  // failures. The summary already reflects server-side dismissal.
  const failedRuns = attention.summary.failed + attention.summary.timedOut;

  return useMemo(
    () =>
      computeInboxBadgeData({
        approvals,
        joinRequests,
        dashboard,
        heartbeatRuns: [],
        failedRuns,
        issues,
        unreadIssues,
        dismissed,
      }),
    [approvals, joinRequests, dashboard, failedRuns, issues, unreadIssues, dismissed],
  );
}
