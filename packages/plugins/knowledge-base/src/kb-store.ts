import type { PluginContext, PluginEntityRecord } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_MAX_TOKEN_BUDGET,
  ENTITY_TYPES,
  KB_TYPES,
} from "./constants.js";

type JsonRecord = Record<string, unknown>;

type PluginEntityScopeKind =
  | "instance"
  | "company"
  | "project"
  | "issue";

type EntityQuery = Parameters<PluginContext["entities"]["list"]>[0];

type EntityCreateInput = {
  entityType: string;
  scopeKind: PluginEntityScopeKind;
  scopeId?: string;
  externalId?: string;
  title?: string;
  status?: string;
  data: JsonRecord;
};

type EntityUpdateInput = {
  externalId?: string;
  title?: string;
  status?: string;
  data?: JsonRecord;
};

export type KnowledgeBaseType = "static" | "rag" | "ontology";

export interface KnowledgeBaseData {
  name: string;
  type: KnowledgeBaseType;
  description?: string;
  companyId: string;
  maxTokenBudget: number;
  staticConfig?: {
    content: string;
  };
  ragConfig?: {
    mcpServerUrl?: string;
    topK?: number;
  };
  ontologyConfig?: {
    kgPath?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AgentKBGrantData {
  agentName: string;
  kbName: string;
  grantedBy: string;
  grantedAt: string;
}

export type KnowledgeBaseRecord = Omit<PluginEntityRecord, "data"> & {
  data: KnowledgeBaseData;
};

export type AgentKBGrantRecord = Omit<PluginEntityRecord, "data"> & {
  data: AgentKBGrantData;
};

type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];

function entities(ctx: PluginContext): PluginContext["entities"] {
  return ctx.entities;
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as JsonRecord;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  const normalized = asNonEmptyString(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }

  return normalized;
}

function normalizeKnowledgeBaseType(value: unknown): KnowledgeBaseType {
  const normalized = asNonEmptyString(value).toLowerCase();

  if (normalized === KB_TYPES.static || normalized === KB_TYPES.rag || normalized === KB_TYPES.ontology) {
    return normalized as KnowledgeBaseType;
  }

  return KB_TYPES.static;
}

function normalizeMaxTokenBudget(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_TOKEN_BUDGET;
  }

  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return DEFAULT_MAX_TOKEN_BUDGET;
  }

  return rounded;
}

function normalizeStaticConfig(value: unknown): KnowledgeBaseData["staticConfig"] {
  const config = asRecord(value);
  return {
    content: typeof config.content === "string" ? config.content : "",
  };
}

function normalizeRagConfig(value: unknown): KnowledgeBaseData["ragConfig"] {
  const config = asRecord(value);
  const mcpServerUrl = asNonEmptyString(config.mcpServerUrl);

  let topK: number | undefined;
  if (typeof config.topK === "number" && Number.isFinite(config.topK) && config.topK > 0) {
    topK = Math.floor(config.topK);
  }

  return {
    mcpServerUrl: mcpServerUrl || undefined,
    topK,
  };
}

function normalizeOntologyConfig(value: unknown): KnowledgeBaseData["ontologyConfig"] {
  const config = asRecord(value);
  const kgPath = asNonEmptyString(config.kgPath);

  return {
    kgPath: kgPath || undefined,
  };
}

function toKnowledgeBaseData(
  input: Partial<KnowledgeBaseData>,
  nowIso: string,
  fallback?: KnowledgeBaseData,
): KnowledgeBaseData {
  const type = normalizeKnowledgeBaseType(input.type ?? fallback?.type);
  const name = normalizeRequiredString(input.name ?? fallback?.name, "name");
  const companyId = normalizeRequiredString(input.companyId ?? fallback?.companyId, "companyId");
  const description = asNonEmptyString(input.description ?? fallback?.description);
  const maxTokenBudget = normalizeMaxTokenBudget(input.maxTokenBudget ?? fallback?.maxTokenBudget);
  const createdAt = asNonEmptyString(input.createdAt ?? fallback?.createdAt) || nowIso;
  const updatedAt = asNonEmptyString(input.updatedAt) || nowIso;

  const staticConfig = type === KB_TYPES.static
    ? normalizeStaticConfig(input.staticConfig ?? fallback?.staticConfig)
    : normalizeStaticConfig(input.staticConfig ?? fallback?.staticConfig ?? {});

  const ragConfig = normalizeRagConfig(input.ragConfig ?? fallback?.ragConfig);
  const ontologyConfig = normalizeOntologyConfig(input.ontologyConfig ?? fallback?.ontologyConfig);

  return {
    name,
    type,
    description: description || undefined,
    companyId,
    maxTokenBudget,
    staticConfig: type === KB_TYPES.static ? staticConfig : undefined,
    ragConfig: type === KB_TYPES.rag ? ragConfig : undefined,
    ontologyConfig: type === KB_TYPES.ontology ? ontologyConfig : undefined,
    createdAt,
    updatedAt,
  };
}

function toGrantData(
  input: Partial<AgentKBGrantData>,
  nowIso: string,
  fallback?: AgentKBGrantData,
): AgentKBGrantData {
  return {
    agentName: normalizeRequiredString(input.agentName ?? fallback?.agentName, "agentName"),
    kbName: normalizeRequiredString(input.kbName ?? fallback?.kbName, "kbName"),
    grantedBy: normalizeRequiredString(input.grantedBy ?? fallback?.grantedBy, "grantedBy"),
    grantedAt: asNonEmptyString(input.grantedAt ?? fallback?.grantedAt) || nowIso,
  };
}

function asDataRecord<T extends object>(value: T): JsonRecord {
  return value as unknown as JsonRecord;
}

function toScopeKind(value: unknown): PluginEntityScopeKind {
  if (value === "instance" || value === "company" || value === "project" || value === "issue") {
    return value;
  }

  return "company";
}

async function listByType(
  ctx: PluginContext,
  entityType: string,
  companyId: string,
): Promise<PluginEntityRecord[]> {
  const pageSize = 500;
  let offset = 0;
  const all: PluginEntityRecord[] = [];

  while (true) {
    const listed = await entities(ctx).list({
      entityType,
      scopeKind: "company",
      scopeId: companyId,
      limit: pageSize,
      offset,
    } as EntityQuery);

    const filtered = listed
      .filter((record: PluginEntityRecord) => record.entityType === entityType)
      .filter((record: PluginEntityRecord) => asRecord(record.data).__deleted !== true)
      .filter((record: PluginEntityRecord) => {
        const raw = asRecord(record.data).companyId;
        const dataCompanyId = typeof raw === "string" ? raw.trim() : "";
        return !dataCompanyId || dataCompanyId === companyId;
      });
    all.push(...filtered);

    if (listed.length < pageSize) {
      return all;
    }

    offset += listed.length;
  }
}

async function listAllByType(
  ctx: PluginContext,
  entityType: string,
  companyId: string,
): Promise<PluginEntityRecord[]> {
  const pageSize = 500;
  let offset = 0;
  const all: PluginEntityRecord[] = [];

  while (true) {
    const listed = await entities(ctx).list({
      entityType,
      scopeKind: "company",
      scopeId: companyId,
      limit: pageSize,
      offset,
    } as EntityQuery);

    const filtered = listed
      .filter((record: PluginEntityRecord) => record.entityType === entityType)
      .filter((record: PluginEntityRecord) => {
        const raw = asRecord(record.data).companyId;
        const dataCompanyId = typeof raw === "string" ? raw.trim() : "";
        return !dataCompanyId || dataCompanyId === companyId;
      });
    all.push(...filtered);

    if (listed.length < pageSize) {
      return all;
    }

    offset += listed.length;
  }
}

async function findByExternalId(
  ctx: PluginContext,
  entityType: string,
  companyId: string,
  externalId: string,
): Promise<PluginEntityRecord | null> {
  const fallback = await listByType(ctx, entityType, companyId);
  return fallback.find((record: PluginEntityRecord) => record.externalId === externalId) ?? null;
}

async function getById(
  ctx: PluginContext,
  entityType: string,
  id: string,
): Promise<PluginEntityRecord | null> {
  const pageSize = 200;
  let offset = 0;

  while (true) {
    const page = await entities(ctx).list({
      entityType,
      limit: pageSize,
      offset,
    } as EntityQuery);

    const matched = page.find(
      (record: PluginEntityRecord) =>
        record.id === id
        && record.entityType === entityType
        && asRecord(record.data).__deleted !== true,
    ) ?? null;

    if (matched) {
      return matched;
    }

    if (page.length < pageSize) {
      return null;
    }

    offset += page.length;
  }
}

async function createEntity(ctx: PluginContext, input: EntityCreateInput): Promise<PluginEntityRecord> {
  return await entities(ctx).upsert(input);
}

async function updateEntity(
  ctx: PluginContext,
  entityType: string,
  id: string,
  patch: EntityUpdateInput,
): Promise<PluginEntityRecord> {
  const current = await getById(ctx, entityType, id);
  if (!current) {
    throw new Error(`Entity not found: ${id}`);
  }

  const currentData = asRecord(current.data);
  const nextData = patch.data ? { ...currentData, ...patch.data } : currentData;

  return await entities(ctx).upsert({
    entityType: current.entityType,
    scopeKind: toScopeKind(current.scopeKind),
    scopeId: current.scopeId ?? undefined,
    externalId: current.externalId ?? patch.externalId ?? `${current.entityType}:${current.id}`,
    title: patch.title ?? current.title ?? undefined,
    status: patch.status ?? current.status ?? undefined,
    data: nextData,
  });
}

async function deleteEntity(ctx: PluginContext, entityType: string, id: string): Promise<void> {
  const current = await getById(ctx, entityType, id);
  if (!current) {
    return;
  }

  await entities(ctx).upsert({
    entityType: current.entityType,
    scopeKind: toScopeKind(current.scopeKind),
    scopeId: current.scopeId ?? undefined,
    externalId: current.externalId ?? `${current.entityType}:${current.id}`,
    title: current.title ?? undefined,
    status: "deleted",
    data: {
      ...asRecord(current.data),
      __deleted: true,
      deletedAt: new Date().toISOString(),
    },
  });
}

function toKnowledgeBaseRecord(record: PluginEntityRecord): KnowledgeBaseRecord {
  return {
    ...record,
    data: toKnowledgeBaseData(asRecord(record.data) as Partial<KnowledgeBaseData>, record.updatedAt),
  };
}

function toGrantRecord(record: PluginEntityRecord): AgentKBGrantRecord {
  return {
    ...record,
    data: toGrantData(asRecord(record.data) as Partial<AgentKBGrantData>, record.updatedAt),
  };
}

function normalizeGrantExternalId(agentName: string, kbName: string): string {
  return `${agentName}::${kbName}`;
}

async function resolveKnowledgeBaseRecord(
  ctx: PluginContext,
  companyId: string,
  kbNameOrId: string,
): Promise<KnowledgeBaseRecord | null> {
  const trimmed = asNonEmptyString(kbNameOrId);
  if (!trimmed) {
    return null;
  }

  const byId = await getById(ctx, ENTITY_TYPES.knowledgeBase, trimmed);
  if (byId) {
    const typed = toKnowledgeBaseRecord(byId);
    if (typed.data.companyId === companyId) {
      return typed;
    }
  }

  const byName = await findByExternalId(ctx, ENTITY_TYPES.knowledgeBase, companyId, trimmed);
  return byName ? toKnowledgeBaseRecord(byName) : null;
}

export async function listKnowledgeBases(
  ctx: PluginContext,
  companyId: string,
): Promise<KnowledgeBaseRecord[]> {
  const listed = await listByType(ctx, ENTITY_TYPES.knowledgeBase, companyId);

  return listed
    .map(toKnowledgeBaseRecord)
    .sort((left, right) => left.data.name.localeCompare(right.data.name));
}

export async function listAllKnowledgeBases(
  ctx: PluginContext,
  companyId: string,
): Promise<KnowledgeBaseRecord[]> {
  const listed = await listAllByType(ctx, ENTITY_TYPES.knowledgeBase, companyId);

  return listed
    .map(toKnowledgeBaseRecord)
    .sort((left, right) => left.data.name.localeCompare(right.data.name));
}

export async function restoreKnowledgeBase(
  ctx: PluginContext,
  companyId: string,
  kbNameOrId: string,
): Promise<KnowledgeBaseRecord> {
  const trimmed = asNonEmptyString(kbNameOrId);
  if (!trimmed) {
    throw new Error("id or name is required for restore");
  }

  const allRecords = await listAllByType(ctx, ENTITY_TYPES.knowledgeBase, companyId);

  const target = allRecords.find(
    (record: PluginEntityRecord) => record.id === trimmed || record.externalId === trimmed,
  );

  if (!target) {
    throw new Error(`Knowledge base not found: ${trimmed}`);
  }

  const currentData = asRecord(target.data);
  const { __deleted, deletedAt, ...cleanData } = currentData;

  const updated = await entities(ctx).upsert({
    entityType: target.entityType,
    scopeKind: toScopeKind(target.scopeKind),
    scopeId: target.scopeId ?? undefined,
    externalId: target.externalId ?? `${target.entityType}:${target.id}`,
    title: target.title ?? undefined,
    status: "active",
    data: {
      ...cleanData,
      updatedAt: new Date().toISOString(),
    },
  });

  return toKnowledgeBaseRecord(updated);
}

export async function getKnowledgeBaseByName(
  ctx: PluginContext,
  companyId: string,
  kbName: string,
): Promise<KnowledgeBaseRecord | null> {
  const normalizedName = asNonEmptyString(kbName);
  if (!normalizedName) {
    return null;
  }

  const found = await findByExternalId(ctx, ENTITY_TYPES.knowledgeBase, companyId, normalizedName);
  return found ? toKnowledgeBaseRecord(found) : null;
}

export async function getKnowledgeBaseById(
  ctx: PluginContext,
  id: string,
): Promise<KnowledgeBaseRecord | null> {
  const found = await getById(ctx, ENTITY_TYPES.knowledgeBase, asNonEmptyString(id));
  return found ? toKnowledgeBaseRecord(found) : null;
}

export async function upsertKnowledgeBase(
  ctx: PluginContext,
  companyId: string,
  input: Partial<KnowledgeBaseData> & { name: string; type?: KnowledgeBaseType },
): Promise<KnowledgeBaseRecord> {
  const nowIso = new Date().toISOString();
  const name = normalizeRequiredString(input.name, "name");
  const existing = await getKnowledgeBaseByName(ctx, companyId, name);
  const data = toKnowledgeBaseData(
    {
      ...input,
      companyId,
      name,
      updatedAt: nowIso,
    },
    nowIso,
    existing?.data,
  );

  if (!existing) {
    const created = await createEntity(ctx, {
      entityType: ENTITY_TYPES.knowledgeBase,
      scopeKind: "company",
      scopeId: companyId,
      externalId: data.name,
      title: data.name,
      status: "active",
      data: asDataRecord(data),
    });

    return toKnowledgeBaseRecord(created);
  }

  const updated = await updateEntity(ctx, ENTITY_TYPES.knowledgeBase, existing.id, {
    externalId: data.name,
    title: data.name,
    status: "active",
    data: asDataRecord(data),
  });

  return toKnowledgeBaseRecord(updated);
}

export async function deleteKnowledgeBase(
  ctx: PluginContext,
  companyId: string,
  kbNameOrId: string,
): Promise<void> {
  const record = await resolveKnowledgeBaseRecord(ctx, companyId, kbNameOrId);
  if (!record) {
    return;
  }

  const grants = await listAgentKbGrants(ctx, companyId, {
    kbName: record.data.name,
  });

  await Promise.all(grants.map(async (grant) => {
    await deleteEntity(ctx, ENTITY_TYPES.agentKbGrant, grant.id);
  }));

  await deleteEntity(ctx, ENTITY_TYPES.knowledgeBase, record.id);
}

export async function listAgentKbGrants(
  ctx: PluginContext,
  companyId: string,
  filters?: {
    agentName?: string;
    kbName?: string;
  },
): Promise<AgentKBGrantRecord[]> {
  const listed = await listByType(ctx, ENTITY_TYPES.agentKbGrant, companyId);
  const agentName = asNonEmptyString(filters?.agentName);
  const kbName = asNonEmptyString(filters?.kbName);

  return listed
    .map(toGrantRecord)
    .filter((record) => (agentName ? record.data.agentName === agentName : true))
    .filter((record) => (kbName ? record.data.kbName === kbName : true))
    .sort((left, right) => {
      const agentOrder = left.data.agentName.localeCompare(right.data.agentName);
      if (agentOrder !== 0) {
        return agentOrder;
      }
      return left.data.kbName.localeCompare(right.data.kbName);
    });
}

export async function grantKnowledgeBase(
  ctx: PluginContext,
  companyId: string,
  input: Partial<AgentKBGrantData>,
): Promise<AgentKBGrantRecord> {
  const nowIso = new Date().toISOString();
  const draft = toGrantData(input, nowIso);
  const kb = await getKnowledgeBaseByName(ctx, companyId, draft.kbName);

  if (!kb) {
    throw new Error(`Knowledge base not found: ${draft.kbName}`);
  }

  const externalId = normalizeGrantExternalId(draft.agentName, draft.kbName);
  const existing = await findByExternalId(ctx, ENTITY_TYPES.agentKbGrant, companyId, externalId);
  const data = toGrantData(
    {
      ...draft,
      kbName: kb.data.name,
      grantedAt: nowIso,
    },
    nowIso,
    existing ? toGrantRecord(existing).data : undefined,
  );

  if (!existing) {
    const created = await createEntity(ctx, {
      entityType: ENTITY_TYPES.agentKbGrant,
      scopeKind: "company",
      scopeId: companyId,
      externalId,
      title: `${data.agentName} -> ${data.kbName}`,
      status: "active",
      data: asDataRecord(data),
    });

    return toGrantRecord(created);
  }

  const updated = await updateEntity(ctx, ENTITY_TYPES.agentKbGrant, existing.id, {
    externalId,
    title: `${data.agentName} -> ${data.kbName}`,
    status: "active",
    data: asDataRecord(data),
  });

  return toGrantRecord(updated);
}

export async function revokeKnowledgeBaseGrant(
  ctx: PluginContext,
  companyId: string,
  input: {
    grantId?: string;
    agentName?: string;
    kbName?: string;
  },
): Promise<void> {
  const grantId = asNonEmptyString(input.grantId);

  if (grantId) {
    const found = await getById(ctx, ENTITY_TYPES.agentKbGrant, grantId);
    if (found && found.scopeId === companyId) {
      await deleteEntity(ctx, ENTITY_TYPES.agentKbGrant, found.id);
    }
    return;
  }

  const agentName = normalizeRequiredString(input.agentName, "agentName");
  const kbName = normalizeRequiredString(input.kbName, "kbName");
  const externalId = normalizeGrantExternalId(agentName, kbName);
  const found = await findByExternalId(ctx, ENTITY_TYPES.agentKbGrant, companyId, externalId);

  if (found) {
    await deleteEntity(ctx, ENTITY_TYPES.agentKbGrant, found.id);
  }
}

export async function listAgentNames(
  ctx: PluginContext,
  companyId: string,
): Promise<string[]> {
  const agents = await ctx.agents.list({ companyId, limit: 500, offset: 0 });
  const names: string[] = [];

  for (const agent of agents as AgentRecord[]) {
    const name = asNonEmptyString((agent as { name?: unknown }).name);
    if (name) {
      names.push(name);
    }
  }

  return Array.from(new Set(names)).sort((left, right) => left.localeCompare(right));
}

export async function getKnowledgeBaseOverview(
  ctx: PluginContext,
  companyId: string,
): Promise<{
  knowledgeBases: KnowledgeBaseRecord[];
  grants: AgentKBGrantRecord[];
  agents: string[];
}> {
  const [knowledgeBases, grants, agents] = await Promise.all([
    listKnowledgeBases(ctx, companyId),
    listAgentKbGrants(ctx, companyId),
    listAgentNames(ctx, companyId),
  ]);

  return {
    knowledgeBases,
    grants,
    agents,
  };
}
