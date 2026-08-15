import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, ne, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentConfigRevisions,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  costEvents,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { isUuidLike, normalizeAgentUrlKey } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { normalizeAgentPermissions } from "./agent-permissions.js";
import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";
import {
  requireAgentApiKeyResponsibleUserBinding,
  type AgentApiKeyResponsibilityContext,
} from "./agent-api-key-policy.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

const CONFIG_REVISION_FIELDS = [
  "name",
  "role",
  "title",
  "reportsTo",
  "capabilities",
  "adapterType",
  "adapterConfig",
  "agentConfig",
  "runtimeConfig",
  "budgetMonthlyCents",
  "metadata",
] as const;

type ConfigRevisionField = (typeof CONFIG_REVISION_FIELDS)[number];
type AgentConfigSnapshot = Pick<typeof agents.$inferSelect, ConfigRevisionField>;

interface RevisionMetadata {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  source?: string;
  rolledBackFromRevisionId?: string | null;
}

interface UpdateAgentOptions {
  recordRevision?: RevisionMetadata;
}

interface AgentShortnameRow {
  id: string;
  name: string;
  status: string;
}

interface AgentShortnameCollisionOptions {
  excludeAgentId?: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const AGENT_LEVEL_CONFIG_KEYS = [
  "cwd",
  "instructionsFilePath",
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "promptTemplate",
  "bootstrapPromptTemplate",
  "paperclipSkillSync",
  "agentsMdPath",
] as const;

// Engine-routing/system env keys that must stay in adapterConfig so adapter
// switches reset them. Everything else inside `env` is agent intent.
export const ENGINE_ENV_KEYS = ["HOME", "CODEX_HOME", "HERMES_HOME", "PATH"] as const;

function isEngineEnvKey(key: string): boolean {
  return (ENGINE_ENV_KEYS as readonly string[]).includes(key);
}

export function mergeAgentConfig(
  agent: { adapterConfig: unknown; agentConfig?: unknown },
): Record<string, unknown> {
  const adapterConfig = isPlainRecord(agent.adapterConfig) ? agent.adapterConfig : {};
  const agentConfig = isPlainRecord(agent.agentConfig) ? agent.agentConfig : {};
  const merged = { ...adapterConfig, ...agentConfig };
  const adapterEnv = isPlainRecord(adapterConfig.env) ? adapterConfig.env : {};
  const agentEnv = isPlainRecord(agentConfig.env) ? agentConfig.env : {};
  if (Object.keys(adapterEnv).length > 0 || Object.keys(agentEnv).length > 0) {
    merged.env = { ...adapterEnv, ...agentEnv };
  }
  return merged;
}

export function splitAgentLevelKeys(input: unknown): {
  adapterConfig: Record<string, unknown>;
  agentConfig: Record<string, unknown>;
} {
  const source = isPlainRecord(input) ? input : {};
  const adapterConfig: Record<string, unknown> = {};
  const agentConfig: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === "env") {
      // Special case: env is partitioned key-wise, not owned wholesale.
      // Engine-routing keys stay in adapterConfig; intent keys move to agentConfig.
      if (isPlainRecord(value)) {
        const adapterEnv: Record<string, unknown> = {};
        const agentEnv: Record<string, unknown> = {};
        for (const [envKey, envValue] of Object.entries(value)) {
          if (isEngineEnvKey(envKey)) {
            adapterEnv[envKey] = envValue;
          } else {
            agentEnv[envKey] = envValue;
          }
        }
        if (Object.keys(adapterEnv).length > 0) adapterConfig.env = adapterEnv;
        if (Object.keys(agentEnv).length > 0) agentConfig.env = agentEnv;
      } else {
        adapterConfig.env = value;
      }
    } else if ((AGENT_LEVEL_CONFIG_KEYS as readonly string[]).includes(key)) {
      agentConfig[key] = value;
    } else {
      adapterConfig[key] = value;
    }
  }

  return { adapterConfig, agentConfig };
}

function getDefaultParentIssueId(metadata: unknown): string | null {
  if (!isPlainRecord(metadata)) return null;
  const value = metadata.defaultParentIssueId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildConfigSnapshot(
  row: Pick<typeof agents.$inferSelect, ConfigRevisionField>,
): AgentConfigSnapshot {
  const adapterConfig =
    typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
      ? sanitizeRecord(row.adapterConfig as Record<string, unknown>)
      : {};
  const agentConfig =
    typeof row.agentConfig === "object" && row.agentConfig !== null && !Array.isArray(row.agentConfig)
      ? sanitizeRecord(row.agentConfig as Record<string, unknown>)
      : {};
  const runtimeConfig =
    typeof row.runtimeConfig === "object" && row.runtimeConfig !== null && !Array.isArray(row.runtimeConfig)
      ? sanitizeRecord(row.runtimeConfig as Record<string, unknown>)
      : {};
  const metadata =
    typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
      ? sanitizeRecord(row.metadata as Record<string, unknown>)
      : row.metadata ?? null;
  return {
    name: row.name,
    role: row.role,
    title: row.title,
    reportsTo: row.reportsTo,
    capabilities: row.capabilities,
    adapterType: row.adapterType,
    adapterConfig,
    agentConfig,
    runtimeConfig,
    budgetMonthlyCents: row.budgetMonthlyCents,
    metadata,
  };
}

function containsRedactedMarker(value: unknown): boolean {
  if (value === REDACTED_EVENT_VALUE) return true;
  if (Array.isArray(value)) return value.some((item) => containsRedactedMarker(item));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((entry) => containsRedactedMarker(entry));
}

function hasConfigPatchFields(data: Partial<typeof agents.$inferInsert>) {
  return CONFIG_REVISION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

function diffConfigSnapshot(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): string[] {
  return CONFIG_REVISION_FIELDS.filter((field) => !jsonEqual(before[field], after[field]));
}

function configPatchFromSnapshot(snapshot: unknown): Partial<typeof agents.$inferInsert> {
  if (!isPlainRecord(snapshot)) throw unprocessable("Invalid revision snapshot");

  if (typeof snapshot.name !== "string" || snapshot.name.length === 0) {
    throw unprocessable("Invalid revision snapshot: name");
  }
  if (typeof snapshot.role !== "string" || snapshot.role.length === 0) {
    throw unprocessable("Invalid revision snapshot: role");
  }
  if (typeof snapshot.adapterType !== "string" || snapshot.adapterType.length === 0) {
    throw unprocessable("Invalid revision snapshot: adapterType");
  }
  if (typeof snapshot.budgetMonthlyCents !== "number" || !Number.isFinite(snapshot.budgetMonthlyCents)) {
    throw unprocessable("Invalid revision snapshot: budgetMonthlyCents");
  }

  const patch: Record<string, unknown> = {
    name: snapshot.name,
    role: snapshot.role,
    title: typeof snapshot.title === "string" || snapshot.title === null ? snapshot.title : null,
    reportsTo:
      typeof snapshot.reportsTo === "string" || snapshot.reportsTo === null ? snapshot.reportsTo : null,
    capabilities:
      typeof snapshot.capabilities === "string" || snapshot.capabilities === null
        ? snapshot.capabilities
        : null,
    adapterType: snapshot.adapterType,
    adapterConfig: isPlainRecord(snapshot.adapterConfig) ? snapshot.adapterConfig : {},
    runtimeConfig: isPlainRecord(snapshot.runtimeConfig) ? snapshot.runtimeConfig : {},
    budgetMonthlyCents: Math.max(0, Math.floor(snapshot.budgetMonthlyCents)),
    metadata: isPlainRecord(snapshot.metadata) || snapshot.metadata === null ? snapshot.metadata : null,
  };
  if (isPlainRecord(snapshot.agentConfig)) {
    patch.agentConfig = snapshot.agentConfig;
  }
  return patch as Partial<typeof agents.$inferInsert>;
}

export function hasAgentShortnameCollision(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
  options?: AgentShortnameCollisionOptions,
): boolean {
  const candidateShortname = normalizeAgentUrlKey(candidateName);
  if (!candidateShortname) return false;

  return existingAgents.some((agent) => {
    if (agent.status === "terminated") return false;
    if (options?.excludeAgentId && agent.id === options.excludeAgentId) return false;
    return normalizeAgentUrlKey(agent.name) === candidateShortname;
  });
}

export function deduplicateAgentName(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
): string {
  if (!hasAgentShortnameCollision(candidateName, existingAgents)) {
    return candidateName;
  }
  for (let i = 2; i <= 100; i++) {
    const suffixed = `${candidateName} ${i}`;
    if (!hasAgentShortnameCollision(suffixed, existingAgents)) {
      return suffixed;
    }
  }
  return `${candidateName} ${Date.now()}`;
}

// [paperclip-stuck 2026-08-06, A1] On a cold server restart every in-memory process handle is
// gone, but agents.status can still read 'running' from the DB (phantom running). The runtime
// reaper (A2/B paths) only corrects this after its staleness windows elapse, so a restart can
// leave agents pinned at 'running' and block the wakeup queue for minutes. Sweep once at
// startup: any agent still marked 'running' with NO heartbeat_runs row still marked 'running'
// cannot actually be executing (its handle is gone), so reset it to 'idle'. Agents that
// genuinely own a running heartbeat run are left untouched.
export async function reconcilePersistedAgentStatusOnStartup(db: Db) {
  const runningAgentIds = await db
    .select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.status, "running"))
    .then((rows) => [...new Set(rows.map((row) => row.agentId))]);

  // inArray with an empty list is never true, so when no agent owns a running run there is
  // nothing to exclude — match every running agent directly.
  const staleWhere =
    runningAgentIds.length > 0
      ? and(eq(agents.status, "running"), not(inArray(agents.id, runningAgentIds)))
      : eq(agents.status, "running");

  const staleAgents = await db.select({ id: agents.id }).from(agents).where(staleWhere);
  if (staleAgents.length === 0) return { reconciled: 0 };

  const now = new Date();
  await db
    .update(agents)
    .set({ status: "idle", lastHeartbeatAt: now, updatedAt: now })
    .where(staleWhere);

  return { reconciled: staleAgents.length };
}

export function agentService(db: Db) {
  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  function withUrlKey<T extends { id: string; name: string }>(row: T) {
    return {
      ...row,
      urlKey: normalizeAgentUrlKey(row.name) ?? row.id,
    };
  }

  function normalizeAgentRow(row: typeof agents.$inferSelect) {
    return withUrlKey({
      ...row,
      defaultParentIssueId: getDefaultParentIssueId(row.metadata),
      permissions: normalizeAgentPermissions(row.permissions, row.role),
    });
  }

  async function getMonthlySpendByAgentIds(companyId: string, agentIds: string[]) {
    if (agentIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await db
      .select({
        agentId: costEvents.agentId,
        spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          inArray(costEvents.agentId, agentIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.agentId);
    return new Map(rows.map((row) => [row.agentId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateAgentSpend<T extends { id: string; companyId: string; spentMonthlyCents: number }>(rows: T[]) {
    const agentIds = rows.map((row) => row.id);
    const companyId = rows[0]?.companyId;
    if (!companyId || agentIds.length === 0) return rows;
    const spendByAgentId = await getMonthlySpendByAgentIds(companyId, agentIds);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByAgentId.get(row.id) ?? 0,
    }));
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [hydrated] = await hydrateAgentSpend([row]);
    return normalizeAgentRow(hydrated);
  }

  async function ensureManager(companyId: string, managerId: string) {
    const manager = await getById(managerId);
    if (!manager) throw notFound("Manager not found");
    if (manager.companyId !== companyId) {
      throw unprocessable("Manager must belong to same company");
    }
    return manager;
  }

  async function assertNoCycle(agentId: string, reportsTo: string | null | undefined) {
    if (!reportsTo) return;
    if (reportsTo === agentId) throw unprocessable("Agent cannot report to itself");

    let cursor: string | null = reportsTo;
    while (cursor) {
      if (cursor === agentId) throw unprocessable("Reporting relationship would create cycle");
      const next = await getById(cursor);
      cursor = next?.reportsTo ?? null;
    }
  }

  async function assertCompanyShortnameAvailable(
    companyId: string,
    candidateName: string,
    options?: AgentShortnameCollisionOptions,
  ) {
    const candidateShortname = normalizeAgentUrlKey(candidateName);
    if (!candidateShortname) return;

    const existingAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const hasCollision = hasAgentShortnameCollision(candidateName, existingAgents, options);
    if (hasCollision) {
      throw conflict(
        `Agent shortname '${candidateShortname}' is already in use in this company`,
      );
    }
  }

  async function updateAgent(
    id: string,
    data: Partial<typeof agents.$inferInsert>,
    options?: UpdateAgentOptions,
  ) {
    const existing = await getById(id);
    if (!existing) return null;

    if (existing.status === "terminated" && data.status && data.status !== "terminated") {
      throw conflict("Terminated agents cannot be resumed");
    }
    if (
      existing.status === "pending_approval" &&
      data.status &&
      data.status !== "pending_approval" &&
      data.status !== "terminated"
    ) {
      throw conflict("Pending approval agents cannot be activated directly");
    }

    if (data.reportsTo !== undefined) {
      if (data.reportsTo) {
        await ensureManager(existing.companyId, data.reportsTo);
      }
      await assertNoCycle(id, data.reportsTo);
    }

    if (data.name !== undefined) {
      const previousShortname = normalizeAgentUrlKey(existing.name);
      const nextShortname = normalizeAgentUrlKey(data.name);
      if (previousShortname !== nextShortname) {
        await assertCompanyShortnameAvailable(existing.companyId, data.name, { excludeAgentId: id });
      }
    }

    const normalizedPatch = { ...data } as Partial<typeof agents.$inferInsert>;
    if (data.permissions !== undefined) {
      const role = (data.role ?? existing.role) as string;
      normalizedPatch.permissions = normalizeAgentPermissions(data.permissions, role);
    }

    const hasAdapterConfigKey = Object.prototype.hasOwnProperty.call(data, "adapterConfig");
    const hasAgentConfigKey = Object.prototype.hasOwnProperty.call(data, "agentConfig");
    if (hasAdapterConfigKey) {
      const hasIncomingEnvKey =
        isPlainRecord(data.adapterConfig) &&
        Object.prototype.hasOwnProperty.call(data.adapterConfig, "env");
      const split = splitAgentLevelKeys(data.adapterConfig);
      normalizedPatch.adapterConfig = split.adapterConfig;
      if (hasAgentConfigKey) {
        // Rollback and explicit dual-column patches restore agentConfig verbatim.
        normalizedPatch.agentConfig = isPlainRecord(data.agentConfig)
          ? data.agentConfig
          : {};
      } else if (hasIncomingEnvKey) {
        // (a) env-authoritative patch: the incoming env fully replaces both env
        // halves. Agent keys keep the P2 authoritative rule (merged-derived
        // patches propagate deletions).
        const splitAgentConfig = split.agentConfig;
        const nonEnvKeys = Object.keys(splitAgentConfig).filter((key) => key !== "env");
        if (nonEnvKeys.length > 0) {
          // Whole-column replace; split.agentConfig.env presence/absence is the
          // full replacement of the intent env half.
          normalizedPatch.agentConfig = splitAgentConfig;
        } else {
          // env-only patch: replace just the intent env half, keep other agent keys.
          const nextAgentConfig: Record<string, unknown> = {
            ...(isPlainRecord(existing.agentConfig) ? existing.agentConfig : {}),
          };
          if (isPlainRecord(splitAgentConfig.env) && Object.keys(splitAgentConfig.env).length > 0) {
            nextAgentConfig.env = splitAgentConfig.env;
          } else {
            delete nextAgentConfig.env;
          }
          normalizedPatch.agentConfig = nextAgentConfig;
        }
      } else if (Object.keys(split.agentConfig).length > 0) {
        // P2 authoritative merged-derived patch (agent keys, no env): whole-column
        // replace, but the intent env half is untouched (rule (b)).
        const splitAgentConfig = { ...split.agentConfig };
        if (isPlainRecord(existing.agentConfig) && isPlainRecord(existing.agentConfig.env)) {
          splitAgentConfig.env = existing.agentConfig.env;
        }
        normalizedPatch.agentConfig = splitAgentConfig;
      }
      if (!hasIncomingEnvKey) {
        // (b) env absent from the patch: both env columns are left untouched.
        // The engine-env half must be carried forward explicitly because the
        // patch replaces the whole adapterConfig column. When the adapter type
        // actually changes, engine entries are dropped instead (e.g. CODEX_HOME
        // must not survive a codex -> claude switch).
        const nextAdapterType =
          typeof data.adapterType === "string" && data.adapterType.length > 0
            ? data.adapterType
            : existing.adapterType;
        const existingAdapterEnv =
          isPlainRecord(existing.adapterConfig) && isPlainRecord(existing.adapterConfig.env)
            ? existing.adapterConfig.env
            : {};
        const adapterConfigRecord = isPlainRecord(normalizedPatch.adapterConfig)
          ? normalizedPatch.adapterConfig
          : {};
        if (nextAdapterType !== existing.adapterType) {
          const retainedEnv: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(existingAdapterEnv)) {
            if (!isEngineEnvKey(key)) retainedEnv[key] = value;
          }
          if (Object.keys(retainedEnv).length > 0) {
            normalizedPatch.adapterConfig = { ...adapterConfigRecord, env: retainedEnv };
          } else {
            const { env: _engineEnv, ...withoutEnv } = adapterConfigRecord;
            normalizedPatch.adapterConfig = withoutEnv;
          }
        } else if (Object.keys(existingAdapterEnv).length > 0) {
          normalizedPatch.adapterConfig = { ...adapterConfigRecord, env: existingAdapterEnv };
        }
      }
    } else if (hasAgentConfigKey) {
      normalizedPatch.agentConfig = isPlainRecord(data.agentConfig)
        ? data.agentConfig
        : {};
    }

    const shouldRecordRevision = Boolean(options?.recordRevision) && hasConfigPatchFields(normalizedPatch);
    const beforeConfig = shouldRecordRevision ? buildConfigSnapshot(existing) : null;

    const updated = await db
      .update(agents)
      .set({ ...normalizedPatch, updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    const normalizedUpdated = updated ? normalizeAgentRow(updated) : null;

    if (normalizedUpdated && shouldRecordRevision && beforeConfig) {
      const afterConfig = buildConfigSnapshot(normalizedUpdated);
      const changedKeys = diffConfigSnapshot(beforeConfig, afterConfig);
      if (changedKeys.length > 0) {
        await db.insert(agentConfigRevisions).values({
          companyId: normalizedUpdated.companyId,
          agentId: normalizedUpdated.id,
          createdByAgentId: options?.recordRevision?.createdByAgentId ?? null,
          createdByUserId: options?.recordRevision?.createdByUserId ?? null,
          source: options?.recordRevision?.source ?? "patch",
          rolledBackFromRevisionId: options?.recordRevision?.rolledBackFromRevisionId ?? null,
          changedKeys,
          beforeConfig: beforeConfig as unknown as Record<string, unknown>,
          afterConfig: afterConfig as unknown as Record<string, unknown>,
        });
      }
    }

    return normalizedUpdated;
  }

  return {
    list: async (companyId: string, options?: { includeTerminated?: boolean }) => {
      const conditions = [eq(agents.companyId, companyId)];
      if (!options?.includeTerminated) {
        conditions.push(ne(agents.status, "terminated"));
      }
      const rows = await db.select().from(agents).where(and(...conditions));
      const hydrated = await hydrateAgentSpend(rows);
      return hydrated.map(normalizeAgentRow);
    },

    getById,

    create: async (companyId: string, data: Omit<typeof agents.$inferInsert, "companyId">) => {
      if (data.reportsTo) {
        await ensureManager(companyId, data.reportsTo);
      }

      const existingAgents = await db
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      const uniqueName = deduplicateAgentName(data.name, existingAgents);

      const role = data.role ?? "general";
      const normalizedPermissions = normalizeAgentPermissions(data.permissions, role);
      const split = splitAgentLevelKeys(data.adapterConfig);
      const explicitAgentConfig = isPlainRecord(data.agentConfig) ? data.agentConfig : {};
      const mergedAgentConfig = { ...split.agentConfig, ...explicitAgentConfig };
      const splitEnv = isPlainRecord(split.agentConfig.env) ? split.agentConfig.env : {};
      const explicitEnv = isPlainRecord(explicitAgentConfig.env) ? explicitAgentConfig.env : {};
      if (Object.keys(splitEnv).length > 0 || Object.keys(explicitEnv).length > 0) {
        mergedAgentConfig.env = { ...splitEnv, ...explicitEnv };
      }
      const created = await db
        .insert(agents)
        .values({
          ...data,
          adapterConfig: split.adapterConfig,
          agentConfig: mergedAgentConfig,
          name: uniqueName,
          companyId,
          role,
          permissions: normalizedPermissions,
        })
        .returning()
        .then((rows) => rows[0]);

      return normalizeAgentRow(created);
    },

    update: updateAgent,

    pause: async (id: string, reason: "manual" | "budget" | "system" = "manual") => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot pause terminated agent");

      const updated = await db
        .update(agents)
        .set({
          status: "paused",
          pauseReason: reason,
          pausedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? normalizeAgentRow(updated) : null;
    },

    resume: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot resume terminated agent");
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agents cannot be resumed");
      }

      const updated = await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? normalizeAgentRow(updated) : null;
    },

    terminate: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      await db
        .update(agents)
        .set({
          status: "terminated",
          pauseReason: null,
          pausedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id));

      await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(agentApiKeys.agentId, id));

      return getById(id);
    },

    remove: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      return db.transaction(async (tx) => {
        await tx.update(agents).set({ reportsTo: null }).where(eq(agents.reportsTo, id));
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.agentId, id));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.agentId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, id));
        const deleted = await tx
          .delete(agents)
          .where(eq(agents.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return deleted ? normalizeAgentRow(deleted) : null;
      });
    },

    activatePendingApproval: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status !== "pending_approval") return existing;

      const updated = await db
        .update(agents)
        .set({ status: "idle", updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? normalizeAgentRow(updated) : null;
    },

    updatePermissions: async (id: string, permissions: { canCreateAgents: boolean }) => {
      const existing = await getById(id);
      if (!existing) return null;

      const updated = await db
        .update(agents)
        .set({
          permissions: normalizeAgentPermissions(permissions, existing.role),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? normalizeAgentRow(updated) : null;
    },

    listConfigRevisions: async (id: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(eq(agentConfigRevisions.agentId, id))
        .orderBy(desc(agentConfigRevisions.createdAt)),

    getConfigRevision: async (id: string, revisionId: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null),

    rollbackConfigRevision: async (
      id: string,
      revisionId: string,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      const revision = await db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null);
      if (!revision) return null;
      if (containsRedactedMarker(revision.afterConfig)) {
        throw unprocessable("Cannot roll back a revision that contains redacted secret values");
      }

      const patch = configPatchFromSnapshot(revision.afterConfig);
      return updateAgent(id, patch, {
        recordRevision: {
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          source: "rollback",
          rolledBackFromRevisionId: revision.id,
        },
      });
    },

    createApiKey: async (
      id: string,
      name: string,
      responsibleUserId: string | null | undefined,
      context: AgentApiKeyResponsibilityContext,
    ) => {
      const existing = await getById(id);
      if (!existing) throw notFound("Agent not found");
      if (existing.status === "pending_approval") {
        throw conflict("Cannot create keys for pending approval agents");
      }
      if (existing.status === "terminated") {
        throw conflict("Cannot create keys for terminated agents");
      }

      const normalizedResponsibleUserId = await requireAgentApiKeyResponsibleUserBinding(
        db,
        existing.companyId,
        responsibleUserId,
        context,
      );
      const token = createToken();
      const keyHash = hashToken(token);
      const created = await db
        .insert(agentApiKeys)
        .values({
          agentId: id,
          companyId: existing.companyId,
          name,
          keyHash,
          responsibleUserId: normalizedResponsibleUserId,
        })
        .returning()
        .then((rows) => rows[0]);

      return {
        id: created.id,
        name: created.name,
        token,
        createdAt: created.createdAt,
      };
    },

    listKeys: (id: string) =>
      db
        .select({
          id: agentApiKeys.id,
          name: agentApiKeys.name,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, id)),

    revokeKey: async (keyId: string) => {
      const rows = await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(agentApiKeys.id, keyId))
        .returning();
      return rows[0] ?? null;
    },

    orgForCompany: async (companyId: string) => {
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
      const normalizedRows = rows.map(normalizeAgentRow);
      const byManager = new Map<string | null, typeof normalizedRows>();
      for (const row of normalizedRows) {
        const key = row.reportsTo ?? null;
        const group = byManager.get(key) ?? [];
        group.push(row);
        byManager.set(key, group);
      }

      const build = (managerId: string | null): Array<Record<string, unknown>> => {
        const members = byManager.get(managerId) ?? [];
        return members.map((member) => ({
          ...member,
          reports: build(member.id),
        }));
      };

      return build(null);
    },

    getChainOfCommand: async (agentId: string) => {
      const chain: { id: string; name: string; role: string; title: string | null }[] = [];
      const visited = new Set<string>([agentId]);
      const start = await getById(agentId);
      let currentId = start?.reportsTo ?? null;
      while (currentId && !visited.has(currentId) && chain.length < 50) {
        visited.add(currentId);
        const mgr = await getById(currentId);
        if (!mgr) break;
        chain.push({ id: mgr.id, name: mgr.name, role: mgr.role, title: mgr.title ?? null });
        currentId = mgr.reportsTo ?? null;
      }
      return chain;
    },

    runningForAgent: (agentId: string) =>
      db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"]))),

    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { agent: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const byId = await getById(raw);
        if (!byId || byId.companyId !== companyId) {
          return { agent: null, ambiguous: false } as const;
        }
        return { agent: byId, ambiguous: false } as const;
      }

      const urlKey = normalizeAgentUrlKey(raw);
      if (!urlKey) {
        return { agent: null, ambiguous: false } as const;
      }

      const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
      const matches = rows
        .map(normalizeAgentRow)
        .filter((agent) => agent.urlKey === urlKey && agent.status !== "terminated");
      if (matches.length === 1) {
        return { agent: matches[0] ?? null, ambiguous: false } as const;
      }
      if (matches.length > 1) {
        return { agent: null, ambiguous: true } as const;
      }
      return { agent: null, ambiguous: false } as const;
    },
  };
}
