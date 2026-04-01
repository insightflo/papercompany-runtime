export const PLUGIN_ID = "paperclipai.system-garden";
export const PLUGIN_VERSION = "0.1.0";
export const PLUGIN_DISPLAY_NAME = "System Garden";
export const PAGE_ROUTE = "system-garden";

export const SLOT_IDS = {
  page: "system-garden-page",
  sidebar: "system-garden-sidebar-link",
} as const;

export const EXPORT_NAMES = {
  page: "SystemGardenPage",
  sidebar: "SystemGardenSidebarLink",
} as const;

export const NODE_COLORS = {
  agent: "#22c55e",
  schedule: "#3b82f6",
  data: "#f59e0b",
  output: "#a855f7",
  issue: "#f97316",
  module: "#3b82f6",
  file: "#3b82f6",
  function: "#a855f7",
  class: "#f97316",
  default: "#64748b",
} as const;

export const HEALTH_THRESHOLDS = {
  good: 80,
  warning: 50,
} as const;

export const HEALTH_LABELS = {
  good: "울창",
  warning: "성장 중",
  bad: "시듦",
} as const;
