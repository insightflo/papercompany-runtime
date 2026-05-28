export const PLUGIN_ID = "insightflo.knowledge-base";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "knowledge-base";

export const SLOT_IDS = {
  page: "knowledge-base-page",
  sidebar: "knowledge-base-sidebar",
} as const;

export const EXPORT_NAMES = {
  page: "KnowledgeBasePage",
  sidebar: "KnowledgeBaseSidebarLink",
} as const;

export const ENTITY_TYPES = {
  knowledgeBase: "knowledge-base",
  agentKbGrant: "agent-kb-grant",
} as const;

export const KB_TYPES = {
  static: "static",
  rag: "rag",
  ontology: "ontology",
} as const;

export const DEFAULT_MAX_TOKEN_BUDGET = 4096;

export const DATA_KEYS = {
  overview: "knowledge-base.overview",
  kbList: "knowledge-base.list",
  kbGet: "knowledge-base.get",
  grantList: "knowledge-base.grant.list",
  agentList: "knowledge-base.agent.list",
  kbCreate: "knowledge-base.create",
  kbUpdate: "knowledge-base.update",
  kbDelete: "knowledge-base.delete",
  grantCreate: "knowledge-base.grant.create",
  grantDelete: "knowledge-base.grant.delete",
} as const;

export const ACTION_KEYS = {
  kbCreate: DATA_KEYS.kbCreate,
  kbUpdate: DATA_KEYS.kbUpdate,
  kbDelete: DATA_KEYS.kbDelete,
  kbRestore: "knowledge-base.restore",
  grantCreate: DATA_KEYS.grantCreate,
  grantDelete: DATA_KEYS.grantDelete,
} as const;
