import { type JSX } from "react";
import type { PluginWidgetProps, WorkflowOverviewData } from "./workflow-page-types.js";
import { useHostContext, useWorkflowOverview } from "./workflow-page-api.js";
import { badgeRowStyle, mutedTextStyle, statusBadgeStyle, widgetCountStyle, widgetStyle, widgetTitleStyle } from "./workflow-page-styles.js";

const PLUGIN_ID = "paperclip.core-workflows";

export function countStatuses(activeRuns: WorkflowOverviewData["activeRuns"]): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>();

  for (const run of activeRuns) {
    const status = run.status.trim().toLowerCase() || "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status));
}

export function WorkflowDashboardWidget(props: PluginWidgetProps): JSX.Element {
  const hostContext = useHostContext();
  const companyId = hostContext.companyId ?? props.context?.companyId ?? "";
  const overview = useWorkflowOverview(companyId);

  if (overview.loading) {
    return (
      <div data-plugin-id={PLUGIN_ID} style={widgetStyle}>
        <h2 style={widgetTitleStyle}>Workflows</h2>
        <span style={mutedTextStyle}>Loading workflows...</span>
      </div>
    );
  }

  if (overview.error) {
    return (
      <div data-plugin-id={PLUGIN_ID} style={widgetStyle}>
        <h2 style={widgetTitleStyle}>Workflows</h2>
        <span style={mutedTextStyle}>Unable to load workflow summary.</span>
      </div>
    );
  }

  const data = {
    workflows: overview.data?.workflows ?? [],
    activeRuns: overview.data?.activeRuns ?? [],
    recentRuns: overview.data?.recentRuns ?? [],
    projects: overview.data?.projects ?? [],
    labels: overview.data?.labels ?? [],
  };
  const statusCounts = countStatuses(data.activeRuns);

  return (
    <div data-plugin-id={PLUGIN_ID} style={widgetStyle}>
      <h2 style={widgetTitleStyle}>Workflows</h2>
      <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
        <span style={widgetCountStyle}>{data.activeRuns.length}</span>
        <span style={mutedTextStyle}>active runs</span>
      </div>
      <div style={badgeRowStyle}>
        {statusCounts.length > 0 ? (
          statusCounts.map((item) => (
            <span key={item.status} style={statusBadgeStyle(item.status)}>
              {item.status}: {item.count}
            </span>
          ))
        ) : (
          <span style={mutedTextStyle}>No active runs.</span>
        )}
      </div>
    </div>
  );
}

export function WorkflowSidebarLink({ context }: { context: { companyPrefix?: string | null } }) {
  const href = context.companyPrefix ? `/${context.companyPrefix}/workflows` : "/workflows";
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      href={href}
      style={{
        display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px",
        fontSize: "13px", fontWeight: 500, textDecoration: "none",
        color: isActive ? "var(--foreground, #f8fafc)" : "color-mix(in srgb, var(--foreground, #f8fafc) 80%, transparent)",
        background: isActive ? "var(--accent, rgba(125,211,252,0.12))" : "transparent",
        borderRadius: "8px",
      }}
    >
      <span>⚡ Workflows</span>
    </a>
  );
}
