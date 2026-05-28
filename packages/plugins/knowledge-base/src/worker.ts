import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import {
  ACTION_KEYS,
  DATA_KEYS,
  KB_TYPES,
  PLUGIN_ID,
} from "./constants.js";
import {
  deleteKnowledgeBase,
  getKnowledgeBaseById,
  getKnowledgeBaseByName,
  getKnowledgeBaseOverview,
  grantKnowledgeBase,
  listAgentKbGrants,
  listAgentNames,
  listAllKnowledgeBases,
  listKnowledgeBases,
  restoreKnowledgeBase,
  revokeKnowledgeBaseGrant,
  upsertKnowledgeBase,
  type KnowledgeBaseRecord,
  type KnowledgeBaseType,
} from "./kb-store.js";

type JsonRecord = Record<string, unknown>;

type RunEventRefs = {
  runId: string;
  issueId: string;
  agentId: string;
  agentName: string;
};

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as JsonRecord;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function getNestedString(record: JsonRecord, ...path: string[]): string {
  let cursor: unknown = record;

  for (const key of path) {
    if (!cursor || typeof cursor !== "object") {
      return "";
    }
    cursor = (cursor as JsonRecord)[key];
  }

  return asString(cursor);
}

function normalizeKnowledgeBaseType(value: unknown): KnowledgeBaseType {
  const normalized = asString(value).toLowerCase();

  if (normalized === KB_TYPES.rag) {
    return KB_TYPES.rag;
  }
  if (normalized === KB_TYPES.ontology) {
    return KB_TYPES.ontology;
  }

  return KB_TYPES.static;
}

function extractRunEventRefs(event: PluginEvent): RunEventRefs {
  const payload = asRecord(event.payload);

  const runId = asString(payload.runId)
    || asString(payload.run_id)
    || asString(payload.id)
    || asString(event.entityId);

  const issueId = asString(payload.issueId)
    || asString(payload.issue_id)
    || getNestedString(payload, "issue", "id")
    || getNestedString(payload, "context", "issueId")
    || getNestedString(payload, "context", "issue", "id");

  const agentId = asString(payload.agentId)
    || asString(payload.agent_id)
    || getNestedString(payload, "agent", "id")
    || getNestedString(payload, "context", "agentId")
    || getNestedString(payload, "run", "agentId");

  const agentName = asString(payload.agentName)
    || asString(payload.agent_name)
    || getNestedString(payload, "agent", "name")
    || getNestedString(payload, "context", "agentName");

  return {
    runId,
    issueId,
    agentId,
    agentName,
  };
}

async function resolveAgentName(
  ctx: PluginContext,
  companyId: string,
  refs: RunEventRefs,
): Promise<string> {
  if (refs.agentName) {
    return refs.agentName;
  }

  if (!refs.agentId) {
    return "";
  }

  const agent = await ctx.agents.get(refs.agentId, companyId);
  return asString(agent?.name);
}

function truncateByTokenBudget(content: string, maxTokenBudget: number): string {
  const trimmedContent = content.trim();
  if (!trimmedContent) {
    return "";
  }

  const budget = Number.isFinite(maxTokenBudget) && maxTokenBudget > 0
    ? Math.floor(maxTokenBudget)
    : 4096;

  const chunks = trimmedContent.match(/\S+\s*/g);
  if (!chunks || chunks.length <= budget) {
    return trimmedContent;
  }

  return chunks.slice(0, budget).join("").trimEnd();
}

function registerDataHandler(
  ctx: PluginContext,
  key: string,
  handler: (params: JsonRecord) => Promise<unknown>,
): void {
  const dataClient = ctx.data as PluginContext["data"] & {
    handle?: (handlerKey: string, fn: (params: JsonRecord) => Promise<unknown>) => void;
    register?: (handlerKey: string, fn: (params: JsonRecord) => Promise<unknown>) => void;
  };

  if (typeof dataClient.handle === "function") {
    dataClient.handle(key, handler);
    return;
  }

  if (typeof dataClient.register === "function") {
    dataClient.register(key, handler);
    return;
  }

  throw new Error("Plugin data client does not support handler registration");
}

function registerActionHandler(
  ctx: PluginContext,
  key: string,
  handler: (params: JsonRecord) => Promise<unknown>,
): void {
  const actionClient = ctx.actions as PluginContext["actions"] & {
    register?: (handlerKey: string, fn: (params: JsonRecord) => Promise<unknown>) => void;
  };

  if (typeof actionClient.register === "function") {
    actionClient.register(key, handler);
    return;
  }

  throw new Error("Plugin action client does not support handler registration");
}

function toKnowledgeBaseListItem(record: KnowledgeBaseRecord): {
  id: string;
  name: string;
  type: string;
  description?: string;
  maxTokenBudget: number;
  createdAt: string;
  updatedAt: string;
  __deleted?: boolean;
} {
  return {
    id: record.id,
    name: record.data.name,
    type: record.data.type,
    description: record.data.description,
    maxTokenBudget: record.data.maxTokenBudget,
    createdAt: record.data.createdAt,
    updatedAt: record.data.updatedAt,
    __deleted: record.status === "deleted" || undefined,
  };
}

function toKnowledgeBaseDetail(record: KnowledgeBaseRecord): {
  id: string;
  name: string;
  type: string;
  description?: string;
  maxTokenBudget: number;
  staticConfig?: { content: string };
  ragConfig?: { mcpServerUrl?: string; topK?: number };
  ontologyConfig?: { kgPath?: string };
  createdAt: string;
  updatedAt: string;
} {
  return {
    ...toKnowledgeBaseListItem(record),
    staticConfig: record.data.staticConfig,
    ragConfig: record.data.ragConfig,
    ontologyConfig: record.data.ontologyConfig,
  };
}

async function resolveKnowledgeBaseForUpdate(
  ctx: PluginContext,
  companyId: string,
  id: string,
  name: string,
): Promise<KnowledgeBaseRecord> {
  const record = id
    ? await getKnowledgeBaseById(ctx, id)
    : await getKnowledgeBaseByName(ctx, companyId, name);

  if (!record || record.data.companyId !== companyId) {
    throw new Error("Knowledge base not found");
  }

  return record;
}

async function createKnowledgeBaseFromParams(
  ctx: PluginContext,
  params: JsonRecord,
): Promise<ReturnType<typeof toKnowledgeBaseDetail>> {
  const companyId = asString(params.companyId);
  const name = asString(params.name);

  if (!companyId || !name) {
    throw new Error("knowledge-base.create requires companyId and name");
  }

  const type = normalizeKnowledgeBaseType(params.type);
  const description = asString(params.description);
  const maxTokenBudget = asNumber(params.maxTokenBudget);

  const record = await upsertKnowledgeBase(ctx, companyId, {
    name,
    type,
    description: description || undefined,
    maxTokenBudget,
    staticConfig: {
      content: asString(params.staticContent),
    },
    ragConfig: {
      mcpServerUrl: asString(params.ragMcpServerUrl) || undefined,
      topK: asNumber(params.ragTopK),
    },
    ontologyConfig: {
      kgPath: asString(params.ontologyKgPath) || undefined,
    },
  });

  return toKnowledgeBaseDetail(record);
}

async function updateKnowledgeBaseFromParams(
  ctx: PluginContext,
  params: JsonRecord,
): Promise<ReturnType<typeof toKnowledgeBaseDetail>> {
  const companyId = asString(params.companyId);
  const id = asString(params.id);
  const name = asString(params.name);

  if (!companyId || (!id && !name)) {
    throw new Error("knowledge-base.update requires companyId and id or name");
  }

  const baseRecord = await resolveKnowledgeBaseForUpdate(ctx, companyId, id, name);
  const nextType = hasOwn(params, "type")
    ? normalizeKnowledgeBaseType(params.type)
    : baseRecord.data.type;

  const nextDescription = hasOwn(params, "description")
    ? asString(params.description) || undefined
    : baseRecord.data.description;

  const nextMaxTokenBudget = hasOwn(params, "maxTokenBudget")
    ? asNumber(params.maxTokenBudget)
    : baseRecord.data.maxTokenBudget;

  const nextStaticContent = hasOwn(params, "staticContent")
    ? asString(params.staticContent)
    : (baseRecord.data.staticConfig?.content ?? "");

  const nextRagMcpServerUrl = hasOwn(params, "ragMcpServerUrl")
    ? asString(params.ragMcpServerUrl) || undefined
    : baseRecord.data.ragConfig?.mcpServerUrl;

  const nextRagTopK = hasOwn(params, "ragTopK")
    ? asNumber(params.ragTopK)
    : baseRecord.data.ragConfig?.topK;

  const nextOntologyKgPath = hasOwn(params, "ontologyKgPath")
    ? asString(params.ontologyKgPath) || undefined
    : baseRecord.data.ontologyConfig?.kgPath;

  const nextName = hasOwn(params, "name")
    ? asString(params.name) || baseRecord.data.name
    : baseRecord.data.name;

  const record = await upsertKnowledgeBase(ctx, companyId, {
    name: nextName,
    type: nextType,
    description: nextDescription,
    maxTokenBudget: nextMaxTokenBudget,
    staticConfig: {
      content: nextStaticContent,
    },
    ragConfig: {
      mcpServerUrl: nextRagMcpServerUrl,
      topK: nextRagTopK,
    },
    ontologyConfig: {
      kgPath: nextOntologyKgPath,
    },
  });

  return toKnowledgeBaseDetail(record);
}

async function deleteKnowledgeBaseFromParams(ctx: PluginContext, params: JsonRecord): Promise<{ ok: true }> {
  const companyId = asString(params.companyId);
  const id = asString(params.id);
  const name = asString(params.name);

  if (!companyId || (!id && !name)) {
    throw new Error("knowledge-base.delete requires companyId and id or name");
  }

  await deleteKnowledgeBase(ctx, companyId, id || name);
  return { ok: true };
}

async function createGrantFromParams(
  ctx: PluginContext,
  params: JsonRecord,
): Promise<{
  id: string;
  agentName: string;
  kbName: string;
  grantedBy: string;
  grantedAt: string;
}> {
  const companyId = asString(params.companyId);
  const agentName = asString(params.agentName);
  const kbName = asString(params.kbName);
  const grantedBy = asString(params.grantedBy) || "knowledge-base-ui";

  if (!companyId || !agentName || !kbName) {
    throw new Error("knowledge-base.grant.create requires companyId, agentName, kbName");
  }

  const record = await grantKnowledgeBase(ctx, companyId, {
    agentName,
    kbName,
    grantedBy,
  });

  return {
    id: record.id,
    agentName: record.data.agentName,
    kbName: record.data.kbName,
    grantedBy: record.data.grantedBy,
    grantedAt: record.data.grantedAt,
  };
}

async function deleteGrantFromParams(ctx: PluginContext, params: JsonRecord): Promise<{ ok: true }> {
  const companyId = asString(params.companyId);
  const grantId = asString(params.grantId);
  const agentName = asString(params.agentName);
  const kbName = asString(params.kbName);

  if (!companyId || (!grantId && (!agentName || !kbName))) {
    throw new Error("knowledge-base.grant.delete requires companyId and grantId or (agentName, kbName)");
  }

  await revokeKnowledgeBaseGrant(ctx, companyId, {
    grantId: grantId || undefined,
    agentName: agentName || undefined,
    kbName: kbName || undefined,
  });

  return { ok: true };
}

async function registerKnowledgeBaseDataHandlers(ctx: PluginContext): Promise<void> {
  registerDataHandler(ctx, DATA_KEYS.overview, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return {
        knowledgeBases: [],
        grants: [],
        agents: [],
      };
    }

    const [allKbs, grants, agents] = await Promise.all([
      listAllKnowledgeBases(ctx, companyId),
      listAgentKbGrants(ctx, companyId),
      listAgentNames(ctx, companyId),
    ]);

    return {
      knowledgeBases: allKbs.map(toKnowledgeBaseListItem),
      grants: grants.map((grant) => ({
        id: grant.id,
        agentName: grant.data.agentName,
        kbName: grant.data.kbName,
        grantedBy: grant.data.grantedBy,
        grantedAt: grant.data.grantedAt,
      })),
      agents,
    };
  });

  registerDataHandler(ctx, DATA_KEYS.kbList, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return [];
    }

    const records = await listKnowledgeBases(ctx, companyId);
    return records.map(toKnowledgeBaseListItem);
  });

  registerDataHandler(ctx, DATA_KEYS.kbGet, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return null;
    }

    const id = asString(params.id);
    const name = asString(params.name);

    const record = id
      ? await getKnowledgeBaseById(ctx, id)
      : name
        ? await getKnowledgeBaseByName(ctx, companyId, name)
        : null;

    if (!record || record.data.companyId !== companyId) {
      return null;
    }

    return toKnowledgeBaseDetail(record);
  });

  registerDataHandler(ctx, DATA_KEYS.grantList, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return [];
    }

    const agentName = asString(params.agentName);
    const kbName = asString(params.kbName);
    const grants = await listAgentKbGrants(ctx, companyId, {
      agentName: agentName || undefined,
      kbName: kbName || undefined,
    });

    return grants.map((grant) => ({
      id: grant.id,
      agentName: grant.data.agentName,
      kbName: grant.data.kbName,
      grantedBy: grant.data.grantedBy,
      grantedAt: grant.data.grantedAt,
    }));
  });

  registerDataHandler(ctx, DATA_KEYS.agentList, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return [];
    }

    return await listAgentNames(ctx, companyId);
  });

  registerDataHandler(ctx, DATA_KEYS.kbCreate, async (params) => {
    return await createKnowledgeBaseFromParams(ctx, params);
  });

  registerDataHandler(ctx, DATA_KEYS.kbUpdate, async (params) => {
    return await updateKnowledgeBaseFromParams(ctx, params);
  });

  registerDataHandler(ctx, DATA_KEYS.kbDelete, async (params) => {
    return await deleteKnowledgeBaseFromParams(ctx, params);
  });

  registerDataHandler(ctx, DATA_KEYS.grantCreate, async (params) => {
    return await createGrantFromParams(ctx, params);
  });

  registerDataHandler(ctx, DATA_KEYS.grantDelete, async (params) => {
    return await deleteGrantFromParams(ctx, params);
  });
}

function registerKnowledgeBaseActionHandlers(ctx: PluginContext): void {
  registerActionHandler(ctx, ACTION_KEYS.kbCreate, async (params) => {
    return await createKnowledgeBaseFromParams(ctx, params);
  });

  registerActionHandler(ctx, ACTION_KEYS.kbUpdate, async (params) => {
    return await updateKnowledgeBaseFromParams(ctx, params);
  });

  registerActionHandler(ctx, ACTION_KEYS.kbDelete, async (params) => {
    return await deleteKnowledgeBaseFromParams(ctx, params);
  });

  registerActionHandler(ctx, ACTION_KEYS.kbRestore, async (params) => {
    const companyId = asString(params.companyId);
    const id = asString(params.id);
    const name = asString(params.name);

    if (!companyId || (!id && !name)) {
      throw new Error("knowledge-base.restore requires companyId and id or name");
    }

    const record = await restoreKnowledgeBase(ctx, companyId, id || name);
    return toKnowledgeBaseDetail(record);
  });

  registerActionHandler(ctx, ACTION_KEYS.grantCreate, async (params) => {
    return await createGrantFromParams(ctx, params);
  });

  registerActionHandler(ctx, ACTION_KEYS.grantDelete, async (params) => {
    return await deleteGrantFromParams(ctx, params);
  });
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    await registerKnowledgeBaseDataHandlers(ctx);
    registerKnowledgeBaseActionHandlers(ctx);

    ctx.tools.register(
      "kb-search",
      {
        displayName: "Knowledge Base Search",
        description: "Search the company knowledge base for articles matching a query.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search keyword or article name" },
            kbName: { type: "string", description: "Specific KB name (optional)" },
          },
          required: ["query"],
        },
      },
      async (params, runCtx) => {
        const p = (params ?? {}) as Record<string, unknown>;
        const query = typeof p.query === "string" ? p.query.trim() : "";
        const kbName = typeof p.kbName === "string" ? p.kbName.trim() : "";

        if (!query) return { error: "query is required" };

        const agent = await ctx.agents.get(runCtx.agentId, runCtx.companyId);
        const agentName = agent?.name ?? "";

        if (kbName) {
          const grants = await listAgentKbGrants(ctx, runCtx.companyId, { agentName });
          if (!grants.some((g) => g.data.kbName === kbName)) {
            return { error: `KB access denied: ${kbName}` };
          }
          const kb = await getKnowledgeBaseByName(ctx, runCtx.companyId, kbName);
          if (!kb) return { error: `KB not found: ${kbName}` };
          return {
            content: `Found KB: ${kb.data.name}`,
            data: { name: kb.data.name, type: kb.data.type, description: kb.data.description, content: kb.data.staticConfig?.content ?? "(no static content)" },
          };
        }

        const grants = await listAgentKbGrants(ctx, runCtx.companyId, { agentName });
        const grantedNames = new Set(grants.map((g) => g.data.kbName));
        const allKbs = await listKnowledgeBases(ctx, runCtx.companyId);
        const queryLower = query.toLowerCase();

        const matches = allKbs
          .filter((kb) => grantedNames.has(kb.data.name))
          .filter((kb) =>
            kb.data.name.toLowerCase().includes(queryLower) ||
            (kb.data.description ?? "").toLowerCase().includes(queryLower) ||
            (kb.data.staticConfig?.content ?? "").toLowerCase().includes(queryLower),
          );

        if (matches.length === 0) {
          return { content: "No matching KB articles found", data: { results: [] } };
        }

        return {
          content: `Found ${matches.length} KB article(s)`,
          data: {
            results: matches.map((kb) => ({
              name: kb.data.name,
              type: kb.data.type,
              description: kb.data.description,
              content: (kb.data.staticConfig?.content ?? "").slice(0, 3000),
            })),
          },
        };
      },
    );

    ctx.logger.info("Knowledge Base plugin worker initialized", {
      pluginId: PLUGIN_ID,
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Knowledge Base worker ready",
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
