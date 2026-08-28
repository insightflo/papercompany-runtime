export const PLUGIN_ID = "pc-bridge";
export const PLUGIN_VERSION = "0.1.0";

export const PAGE_ROUTE = "pc-bridge";

export const SLOT_IDS = {
  page: "pc-bridge-page",
  sidebar: "pc-bridge-sidebar",
} as const;

export const EXPORT_NAMES = {
  page: "PcBridgePage",
  sidebar: "PcBridgeSidebarLink",
} as const;

export const TOOL_NAMES = {
  publish: "pc-bridge-publish",
} as const;

export const DATA_KEYS = {
  status: "status",
} as const;

export const ACTION_KEYS = {
  publish: "publish",
} as const;

export const WEBHOOK_ENDPOINT_KEYS = {
  publish: "publish",
} as const;

/**
 * Operator PC (mac) bridge base URL. The A1 SSH reverse tunnel (-R) exposes the
 * mac bridge listener on the A1 loopback, so the default is a loopback address.
 */
export const DEFAULT_BRIDGE_BASE_URL = "http://127.0.0.1:8930";

export const HEALTH_PATH = "/health";
export const PUBLISH_PATH = "/naver-publish";

/** Header the mac bridge requires on POST /naver-publish. */
export const WEBHOOK_KEY_HEADER = "x-papercompany-webhook-key";

/** Browser-side publishing is slow; give the mac bridge plenty of room. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
export const MIN_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_REQUEST_TIMEOUT_MS = 900_000;

export const HEALTH_TIMEOUT_MS = 5_000;

export const DEFAULT_HISTORY_LIMIT = 50;
export const MIN_HISTORY_LIMIT = 1;
export const MAX_HISTORY_LIMIT = 500;

/**
 * workflow key -> Naver blog category. These six workflows are the only
 * accepted publish targets.
 */
export const WORKFLOW_CATEGORY_MAP = {
  "tech-ai-news": "AI뉴스",
  "tech-ai-scout": "AI소프트웨어",
  "agent-team-concept-radar": "AI개념",
  "youtube-report": "AI유투브요약",
  "gazua-morning": "한국증시",
  "gazua-evening": "미국증시",
} as const;

export type WorkflowKey = keyof typeof WORKFLOW_CATEGORY_MAP;

export const ALLOWED_URL_HOSTS = [
  "manual-onboarding.pages.dev",
  "gazua.showk.ing",
] as const;
