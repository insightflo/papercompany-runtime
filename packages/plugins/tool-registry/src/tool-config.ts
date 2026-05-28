import type { PluginContext, PluginEntityRecord } from "@paperclipai/plugin-sdk";
import { ENTITY_TYPES } from "./constants.js";

export type JsonRecord = Record<string, unknown>;

type PluginEntityScopeKind = "instance" | "company" | "project" | "issue";

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

export interface ToolConfig {
  name: string;
  command: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  requiresApproval: boolean;
  description?: string;
  instructions?: string;
  argsSchema?: JsonRecord;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentToolGrant {
  agentName: string;
  toolName: string;
  grantedBy: string;
  grantedAt: string;
}

export interface ToolConfigRecord {
  id: string;
  entityType: string;
  scopeKind: string;
  scopeId: string | null;
  externalId: string | null;
  title: string | null;
  status: string | null;
  data: ToolConfig;
  createdAt: string;
  updatedAt: string;
}

export interface AgentToolGrantRecord {
  id: string;
  entityType: string;
  scopeKind: string;
  scopeId: string | null;
  externalId: string | null;
  title: string | null;
  status: string | null;
  data: AgentToolGrant;
  createdAt: string;
  updatedAt: string;
}

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

function normalizeName(value: unknown, fieldName: string): string {
  const normalized = asNonEmptyString(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }

  return normalized;
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return fallback;
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
    .map(([key, raw]) => [key.trim(), raw] as const)
    .filter(([key, raw]) => key.length > 0 && raw.length > 0);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function normalizeArgsSchema(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return value as JsonRecord;
}

function toToolConfigData(input: Partial<ToolConfig>, nowIso: string): ToolConfig {
  return {
    name: normalizeName(input.name, "name"),
    command: normalizeName(input.command, "command"),
    workingDirectory: asNonEmptyString(input.workingDirectory) || undefined,
    env: normalizeEnv(input.env),
    requiresApproval: normalizeBoolean(input.requiresApproval, false),
    description: asNonEmptyString(input.description) || undefined,
    instructions: asNonEmptyString(input.instructions) || undefined,
    argsSchema: normalizeArgsSchema(input.argsSchema),
    createdBy: asNonEmptyString(input.createdBy) || undefined,
    createdAt: asNonEmptyString(input.createdAt) || nowIso,
    updatedAt: asNonEmptyString(input.updatedAt) || nowIso,
  };
}

function toGrantData(input: Partial<AgentToolGrant>, nowIso: string): AgentToolGrant {
  return {
    agentName: normalizeName(input.agentName, "agentName"),
    toolName: normalizeName(input.toolName, "toolName"),
    grantedBy: normalizeName(input.grantedBy, "grantedBy"),
    grantedAt: asNonEmptyString(input.grantedAt) || nowIso,
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

function buildToolExternalId(companyId: string, toolName: string): string {
  return `${companyId}::${toolName}`;
}

function buildGrantExternalId(companyId: string, agentName: string, toolName: string): string {
  return `${companyId}::${agentName}::${toolName}`;
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
        const sid = typeof record.scopeId === "string" ? record.scopeId.trim() : "";
        return !sid || sid === companyId;
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
        const sid = typeof record.scopeId === "string" ? record.scopeId.trim() : "";
        return !sid || sid === companyId;
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
  const all = await listByType(ctx, entityType, companyId);
  return all.find((record: PluginEntityRecord) => record.externalId === externalId) ?? null;
}

async function findToolByName(
  ctx: PluginContext,
  companyId: string,
  toolName: string,
): Promise<PluginEntityRecord | null> {
  const normalizedToolName = normalizeName(toolName, "toolName");
  const scopedExternalId = buildToolExternalId(companyId, normalizedToolName);
  const all = await listAllByType(ctx, ENTITY_TYPES.toolConfig, companyId);

  return all.find((record: PluginEntityRecord) => {
    const data = asRecord(record.data);
    const recordName = asNonEmptyString(data.name);
    return record.externalId === scopedExternalId
      || record.externalId === normalizedToolName
      || recordName === normalizedToolName;
  }) ?? null;
}

async function findGrantRecord(
  ctx: PluginContext,
  companyId: string,
  agentName: string,
  toolName: string,
): Promise<PluginEntityRecord | null> {
  const normalizedAgentName = normalizeName(agentName, "agentName");
  const normalizedToolName = normalizeName(toolName, "toolName");
  const scopedExternalId = buildGrantExternalId(companyId, normalizedAgentName, normalizedToolName);
  const legacyExternalId = `${normalizedAgentName}::${normalizedToolName}`;
  const all = await listAllByType(ctx, ENTITY_TYPES.agentToolGrant, companyId);

  return all.find((record: PluginEntityRecord) => {
    const data = asRecord(record.data);
    const recordAgent = asNonEmptyString(data.agentName);
    const recordTool = asNonEmptyString(data.toolName);
    return record.externalId === scopedExternalId
      || record.externalId === legacyExternalId
      || (recordAgent === normalizedAgentName && recordTool === normalizedToolName);
  }) ?? null;
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

function toToolConfigRecord(record: PluginEntityRecord): ToolConfigRecord {
  return {
    ...record,
    data: toToolConfigData(asRecord(record.data) as Partial<ToolConfig>, record.updatedAt),
  };
}

function toGrantRecord(record: PluginEntityRecord): AgentToolGrantRecord {
  return {
    ...record,
    data: toGrantData(asRecord(record.data) as Partial<AgentToolGrant>, record.updatedAt),
  };
}

export async function createTool(
  ctx: PluginContext,
  companyId: string,
  input: Partial<ToolConfig>,
): Promise<ToolConfigRecord> {
  const nowIso = new Date().toISOString();
  const data = toToolConfigData(input, nowIso);
  const existing = await findToolByName(ctx, companyId, data.name);
  if (existing) {
    throw new Error(`Tool already exists: ${data.name}`);
  }

  const created = await createEntity(ctx, {
    entityType: ENTITY_TYPES.toolConfig,
    scopeKind: "company",
    scopeId: companyId,
    externalId: buildToolExternalId(companyId, data.name),
    title: data.name,
    status: "active",
    data: asDataRecord(data),
  });

  return toToolConfigRecord(created);
}

export async function updateTool(
  ctx: PluginContext,
  companyId: string,
  toolName: string,
  patch: Partial<ToolConfig>,
): Promise<ToolConfigRecord> {
  const normalizedToolName = normalizeName(toolName, "toolName");
  const existing = await findToolByName(ctx, companyId, normalizedToolName);
  if (!existing) {
    throw new Error(`Tool not found: ${normalizedToolName}`);
  }

  const current = toToolConfigRecord(existing);
  const merged = toToolConfigData(
    {
      ...current.data,
      ...patch,
      name: current.data.name,
      createdAt: current.data.createdAt,
      updatedAt: new Date().toISOString(),
    },
    new Date().toISOString(),
  );

  const updated = await updateEntity(ctx, ENTITY_TYPES.toolConfig, existing.id, {
    title: merged.name,
    status: "active",
    externalId: buildToolExternalId(companyId, merged.name),
    data: asDataRecord(merged),
  });

  return toToolConfigRecord(updated);
}

export async function deleteTool(
  ctx: PluginContext,
  companyId: string,
  toolName: string,
): Promise<void> {
  const normalizedToolName = normalizeName(toolName, "toolName");
  const existing = await findToolByName(ctx, companyId, normalizedToolName);
  if (!existing) {
    return;
  }

  await deleteEntity(ctx, ENTITY_TYPES.toolConfig, existing.id);
}

export async function getToolByName(
  ctx: PluginContext,
  companyId: string,
  toolName: string,
): Promise<ToolConfigRecord | null> {
  const found = await findToolByName(ctx, companyId, toolName);
  return found ? toToolConfigRecord(found) : null;
}

export async function listTools(
  ctx: PluginContext,
  companyId: string,
): Promise<ToolConfigRecord[]> {
  const records = await listByType(ctx, ENTITY_TYPES.toolConfig, companyId);
  return records
    .map((record) => toToolConfigRecord(record))
    .sort((left, right) => left.data.name.localeCompare(right.data.name));
}

export async function listAllTools(
  ctx: PluginContext,
  companyId: string,
): Promise<ToolConfigRecord[]> {
  const records = await listAllByType(ctx, ENTITY_TYPES.toolConfig, companyId);
  return records
    .map((record) => toToolConfigRecord(record))
    .sort((left, right) => left.data.name.localeCompare(right.data.name));
}

export async function restoreTool(
  ctx: PluginContext,
  companyId: string,
  toolName: string,
): Promise<ToolConfigRecord> {
  const normalizedToolName = normalizeName(toolName, "toolName");
  const existing = await findToolByName(ctx, companyId, normalizedToolName);

  if (!existing) {
    throw new Error(`Tool not found: ${normalizedToolName}`);
  }

  const currentData = asRecord(existing.data);
  const { __deleted, deletedAt, ...cleanData } = currentData;

  const updated = await entities(ctx).upsert({
    entityType: existing.entityType,
    scopeKind: toScopeKind(existing.scopeKind),
    scopeId: existing.scopeId ?? undefined,
    externalId: buildToolExternalId(companyId, normalizedToolName),
    title: existing.title ?? undefined,
    status: "active",
    data: {
      ...cleanData,
      updatedAt: new Date().toISOString(),
    },
  });

  return toToolConfigRecord(updated);
}

export async function grantTool(
  ctx: PluginContext,
  companyId: string,
  input: Partial<AgentToolGrant>,
): Promise<AgentToolGrantRecord> {
  const nowIso = new Date().toISOString();
  const data = toGrantData(input, nowIso);
  const grantExternalId = buildGrantExternalId(companyId, data.agentName, data.toolName);

  const tool = await getToolByName(ctx, companyId, data.toolName);
  if (!tool) {
    throw new Error(`Tool not found: ${data.toolName}`);
  }

  const existing = await findGrantRecord(ctx, companyId, data.agentName, data.toolName);
  if (existing) {
    return toGrantRecord(existing);
  }

  const created = await createEntity(ctx, {
    entityType: ENTITY_TYPES.agentToolGrant,
    scopeKind: "company",
    scopeId: companyId,
    externalId: grantExternalId,
    title: `${data.agentName} -> ${data.toolName}`,
    status: "active",
    data: asDataRecord(data),
  });

  return toGrantRecord(created);
}

export async function revokeTool(
  ctx: PluginContext,
  companyId: string,
  agentName: string,
  toolName: string,
): Promise<void> {
  const normalizedAgentName = normalizeName(agentName, "agentName");
  const normalizedToolName = normalizeName(toolName, "toolName");
  const existing = await findGrantRecord(ctx, companyId, normalizedAgentName, normalizedToolName);

  if (!existing) {
    return;
  }

  await deleteEntity(ctx, ENTITY_TYPES.agentToolGrant, existing.id);
}

export async function listAgentGrants(
  ctx: PluginContext,
  companyId: string,
  filters?: { agentName?: string; toolName?: string },
): Promise<AgentToolGrantRecord[]> {
  const normalizedAgentName = asNonEmptyString(filters?.agentName);
  const normalizedToolName = asNonEmptyString(filters?.toolName);

  const records = await listByType(ctx, ENTITY_TYPES.agentToolGrant, companyId);
  const typed = records
    .map((record) => toGrantRecord(record))
    .filter((record) => {
      if (normalizedAgentName && record.data.agentName !== normalizedAgentName) {
        return false;
      }

      if (normalizedToolName && record.data.toolName !== normalizedToolName) {
        return false;
      }

      return true;
    })
    .sort((left, right) => {
      const byAgent = left.data.agentName.localeCompare(right.data.agentName);
      if (byAgent !== 0) {
        return byAgent;
      }

      return left.data.toolName.localeCompare(right.data.toolName);
    });

  return typed;
}

export async function isToolGrantedToAgent(
  ctx: PluginContext,
  companyId: string,
  agentName: string,
  toolName: string,
): Promise<boolean> {
  const grants = await listAgentGrants(ctx, companyId, {
    agentName,
    toolName,
  });

  return grants.length > 0;
}

export async function getEntityRecordById(
  ctx: PluginContext,
  entityType: string,
  id: string,
): Promise<PluginEntityRecord | null> {
  return await getById(ctx, entityType, id);
}
