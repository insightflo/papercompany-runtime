import type { Db } from "@paperclipai/db";
import { agentToolGrants, agents, pluginEntities, plugins, toolDefinitions } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { toolService } from "../tools/registry.js";
import { notFound } from "../../errors.js";
import type { WorkflowStep } from "./dag-engine.js";

const TOOL_REGISTRY_PLUGIN_KEY = "insightflo.tool-registry";
const TOOL_CONFIG_ENTITY_TYPE = "tool-config";
const AGENT_TOOL_GRANT_ENTITY_TYPE = "agent-tool-grant";

export type WorkflowToolCatalogTool = {
  name: string;
  displayName: string;
  description: string;
  source: "core" | "tool-registry";
  enabled: boolean;
  pluginId?: string;
  unavailableReason?: string;
};

export type WorkflowToolCatalogGrant = {
  agentName: string;
  toolName: string;
  source?: "core" | "tool-registry";
};

export type WorkflowToolCatalog = {
  tools: WorkflowToolCatalogTool[];
  grants: WorkflowToolCatalogGrant[];
  sources: {
    core: {
      available: boolean;
      count: number;
      grantCount?: number;
      unavailableReason?: string;
    };
    toolRegistry: {
      available: boolean;
      installed: boolean;
      status?: string;
      pluginId?: string;
      count: number;
      unavailableReason?: string;
    };
  };
};

export type WorkflowToolRegistrySyncResult = {
  createdTools: number;
  updatedTools: number;
  createdGrants: number;
  skippedGrants: number;
};

export type WorkflowToolGrantMutationInput = {
  companyId: string;
  agentId: string;
  toolName: string;
  grantedBy?: string;
};

type WorkflowStepWithToolSelection = WorkflowStep & {
  type?: unknown;
  agentName?: unknown;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sortTools(tools: WorkflowToolCatalogTool[]): WorkflowToolCatalogTool[] {
  return [...tools].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function sortAndDedupeGrants(grants: WorkflowToolCatalogGrant[]): WorkflowToolCatalogGrant[] {
  const byAgentAndTool = new Map<string, WorkflowToolCatalogGrant>();
  for (const grant of grants) {
    byAgentAndTool.set(`${grant.agentName}:${grant.toolName}`, grant);
  }
  return Array.from(byAgentAndTool.values())
    .sort((a, b) => `${a.agentName}:${a.toolName}`.localeCompare(`${b.agentName}:${b.toolName}`));
}

function booleanValue(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

async function resolveCoreGrantSubjects(
  db: Db,
  input: Pick<WorkflowToolGrantMutationInput, "companyId" | "agentId" | "toolName">,
): Promise<{
  agent: { id: string; name: string };
  tool: { id: string; name: string };
}> {
  const toolName = input.toolName.trim();
  if (!toolName) throw notFound("Workflow tool not found");

  const [agent] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(
      eq(agents.id, input.agentId),
      eq(agents.companyId, input.companyId),
    ))
    .limit(1);
  if (!agent) throw notFound("Workflow tool agent not found");

  const [tool] = await db
    .select({ id: toolDefinitions.id, name: toolDefinitions.name })
    .from(toolDefinitions)
    .where(and(
      eq(toolDefinitions.companyId, input.companyId),
      eq(toolDefinitions.name, toolName),
    ))
    .limit(1);
  if (!tool) throw notFound("Workflow tool not found");

  return { agent, tool };
}

export async function grantWorkflowToolToAgent(
  db: Db,
  input: WorkflowToolGrantMutationInput,
): Promise<WorkflowToolCatalogGrant> {
  const { agent, tool } = await resolveCoreGrantSubjects(db, input);

  const [existing] = await db
    .select({ id: agentToolGrants.id })
    .from(agentToolGrants)
    .where(and(
      eq(agentToolGrants.companyId, input.companyId),
      eq(agentToolGrants.agentId, agent.id),
      eq(agentToolGrants.toolId, tool.id),
    ))
    .limit(1);

  if (!existing) {
    await db.insert(agentToolGrants).values({
      companyId: input.companyId,
      agentId: agent.id,
      toolId: tool.id,
      grantedBy: input.grantedBy?.trim() || "board",
    });
  }

  return {
    agentName: agent.name,
    toolName: tool.name,
    source: "core",
  };
}

export async function revokeWorkflowToolFromAgent(
  db: Db,
  input: Pick<WorkflowToolGrantMutationInput, "companyId" | "agentId" | "toolName">,
): Promise<boolean> {
  const { agent, tool } = await resolveCoreGrantSubjects(db, input);
  const rows = await db
    .delete(agentToolGrants)
    .where(and(
      eq(agentToolGrants.companyId, input.companyId),
      eq(agentToolGrants.agentId, agent.id),
      eq(agentToolGrants.toolId, tool.id),
    ))
    .returning({ id: agentToolGrants.id });
  return rows.length > 0;
}

export async function syncToolRegistryToolsToCore(
  db: Db,
  companyId: string,
): Promise<WorkflowToolRegistrySyncResult> {
  const [toolRegistryPlugin] = await db
    .select({ id: plugins.id })
    .from(plugins)
    .where(eq(plugins.pluginKey, TOOL_REGISTRY_PLUGIN_KEY))
    .limit(1);
  if (!toolRegistryPlugin) {
    return { createdTools: 0, updatedTools: 0, createdGrants: 0, skippedGrants: 0 };
  }

  const [toolRows, grantRows, agentRows] = await Promise.all([
    db
      .select({
        id: pluginEntities.id,
        title: pluginEntities.title,
        status: pluginEntities.status,
        data: pluginEntities.data,
      })
      .from(pluginEntities)
      .where(and(
        eq(pluginEntities.pluginId, toolRegistryPlugin.id),
        eq(pluginEntities.entityType, TOOL_CONFIG_ENTITY_TYPE),
        eq(pluginEntities.scopeKind, "company"),
        eq(pluginEntities.scopeId, companyId),
      )),
    db
      .select({
        status: pluginEntities.status,
        data: pluginEntities.data,
      })
      .from(pluginEntities)
      .where(and(
        eq(pluginEntities.pluginId, toolRegistryPlugin.id),
        eq(pluginEntities.entityType, AGENT_TOOL_GRANT_ENTITY_TYPE),
        eq(pluginEntities.scopeKind, "company"),
        eq(pluginEntities.scopeId, companyId),
      )),
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, companyId)),
  ]);

  let createdTools = 0;
  let updatedTools = 0;
  let createdGrants = 0;
  let skippedGrants = 0;
  const toolIdByName = new Map<string, string>();

  for (const row of toolRows) {
    const data = recordValue(row.data);
    const name = stringValue(data.name) || stringValue(row.title);
    if (!name || row.status === "deleted" || data.__deleted === true) continue;

    const description = stringValue(data.description);
    const argsSchema = recordValue(data.argsSchema);
    const adapterConfig = {
      source: "tool-registry",
      legacyPluginEntityId: row.id,
      command: stringValue(data.command),
      workingDirectory: stringValue(data.workingDirectory) || undefined,
      env: recordValue(data.env),
      requiresApproval: booleanValue(data.requiresApproval),
      instructions: stringValue(data.instructions) || undefined,
    };
    const [existing] = await db
      .select({ id: toolDefinitions.id })
      .from(toolDefinitions)
      .where(and(
        eq(toolDefinitions.companyId, companyId),
        eq(toolDefinitions.name, name),
      ))
      .limit(1);

    if (existing) {
      await db
        .update(toolDefinitions)
        .set({
          description,
          inputSchema: argsSchema,
          adapterType: "builtin",
          adapterConfig,
          enabled: true,
          updatedAt: new Date(),
        })
        .where(eq(toolDefinitions.id, existing.id));
      toolIdByName.set(name, existing.id);
      updatedTools += 1;
    } else {
      const [created] = await db
        .insert(toolDefinitions)
        .values({
          companyId,
          name,
          description,
          inputSchema: argsSchema,
          adapterType: "builtin",
          adapterConfig,
          enabled: true,
        })
        .returning({ id: toolDefinitions.id });
      if (created) {
        toolIdByName.set(name, created.id);
        createdTools += 1;
      }
    }
  }

  const agentIdByName = new Map(agentRows.map((agent) => [agent.name.trim(), agent.id]));
  for (const row of grantRows) {
    if (row.status === "deleted") continue;
    const data = recordValue(row.data);
    if (data.__deleted === true) continue;
    const agentName = stringValue(data.agentName);
    const toolName = stringValue(data.toolName);
    const agentId = agentIdByName.get(agentName);
    const toolId = toolIdByName.get(toolName);
    if (!agentId || !toolId) {
      skippedGrants += 1;
      continue;
    }
    const [existing] = await db
      .select({ id: agentToolGrants.id })
      .from(agentToolGrants)
      .where(and(
        eq(agentToolGrants.companyId, companyId),
        eq(agentToolGrants.agentId, agentId),
        eq(agentToolGrants.toolId, toolId),
      ))
      .limit(1);
    if (existing) {
      skippedGrants += 1;
      continue;
    }
    await db.insert(agentToolGrants).values({
      companyId,
      agentId,
      toolId,
      grantedBy: stringValue(data.grantedBy) || "tool-registry-sync",
    });
    createdGrants += 1;
  }

  return { createdTools, updatedTools, createdGrants, skippedGrants };
}

export async function listWorkflowToolCatalog(db: Db, companyId: string): Promise<WorkflowToolCatalog> {
  const [toolRegistryPlugin] = await db
    .select({
      id: plugins.id,
      status: plugins.status,
    })
    .from(plugins)
    .where(eq(plugins.pluginKey, TOOL_REGISTRY_PLUGIN_KEY))
    .limit(1);

  const toolRegistryInstalled = Boolean(toolRegistryPlugin);
  const toolRegistryAvailable = toolRegistryPlugin?.status === "ready";
  const toolRegistryUnavailableReason = toolRegistryAvailable
    ? undefined
    : toolRegistryPlugin
      ? `Tool Registry plugin is not ready (current status: ${toolRegistryPlugin.status}).`
      : "Tool Registry plugin is not installed.";

  const coreDefinitions = await toolService.listDefinitions(db, { companyId });
  const coreTools: WorkflowToolCatalogTool[] = coreDefinitions
    .map((definition) => ({
      name: definition.name,
      displayName: definition.name,
      description: definition.description ?? "",
      source: "core" as const,
      enabled: toolRegistryAvailable && definition.enabled !== false,
      ...(toolRegistryUnavailableReason ? { unavailableReason: toolRegistryUnavailableReason } : {}),
    }))
    .filter((tool) => tool.name.trim().length > 0);
  const coreGrants = await db
    .select({
      agentName: agents.name,
      toolName: toolDefinitions.name,
    })
    .from(agentToolGrants)
    .innerJoin(agents, and(
      eq(agents.id, agentToolGrants.agentId),
      eq(agents.companyId, companyId),
    ))
    .innerJoin(toolDefinitions, and(
      eq(toolDefinitions.id, agentToolGrants.toolId),
      eq(toolDefinitions.companyId, companyId),
    ))
    .where(eq(agentToolGrants.companyId, companyId));
  const coreGrantItems: WorkflowToolCatalogGrant[] = coreGrants
    .map((grant) => ({
      agentName: grant.agentName.trim(),
      toolName: grant.toolName.trim(),
      source: "core" as const,
    }))
    .filter((grant) => grant.agentName.length > 0 && grant.toolName.length > 0);

  const registryTools: WorkflowToolCatalogTool[] = [];
  let registryGrants: WorkflowToolCatalogGrant[] = [];

  if (toolRegistryPlugin) {
    const [toolRows, grantRows] = await Promise.all([
      db
        .select({
          id: pluginEntities.id,
          title: pluginEntities.title,
          status: pluginEntities.status,
          data: pluginEntities.data,
        })
        .from(pluginEntities)
        .where(and(
          eq(pluginEntities.pluginId, toolRegistryPlugin.id),
          eq(pluginEntities.entityType, TOOL_CONFIG_ENTITY_TYPE),
          eq(pluginEntities.scopeKind, "company"),
          eq(pluginEntities.scopeId, companyId),
        )),
      db
        .select({
          status: pluginEntities.status,
          data: pluginEntities.data,
        })
        .from(pluginEntities)
        .where(and(
          eq(pluginEntities.pluginId, toolRegistryPlugin.id),
          eq(pluginEntities.entityType, AGENT_TOOL_GRANT_ENTITY_TYPE),
          eq(pluginEntities.scopeKind, "company"),
          eq(pluginEntities.scopeId, companyId),
        )),
    ]);

    for (const row of toolRows) {
      const data = recordValue(row.data);
      const name = stringValue(data.name) || stringValue(row.title);
      if (!name) continue;
      const deleted = row.status === "deleted" || data.__deleted === true;
      registryTools.push({
        name,
        displayName: name,
        description: stringValue(data.description),
        source: "tool-registry",
        enabled: toolRegistryAvailable && !deleted,
        pluginId: toolRegistryPlugin.id,
        ...(toolRegistryUnavailableReason ? { unavailableReason: toolRegistryUnavailableReason } : {}),
      });
    }

    registryGrants = grantRows
      .filter((row) => row.status !== "deleted")
      .map((row) => {
        const data = recordValue(row.data);
        return {
          agentName: stringValue(data.agentName),
          toolName: stringValue(data.toolName),
          source: "tool-registry" as const,
        };
      })
      .filter((grant) => grant.agentName.length > 0 && grant.toolName.length > 0);
  }

  const toolByName = new Map<string, WorkflowToolCatalogTool>();
  for (const tool of registryTools) {
    toolByName.set(tool.name, tool);
  }
  for (const tool of coreTools) {
    toolByName.set(tool.name, tool);
  }

  return {
    tools: sortTools(Array.from(toolByName.values())),
    grants: sortAndDedupeGrants([...registryGrants, ...coreGrantItems]),
    sources: {
      core: {
        available: toolRegistryAvailable,
        count: coreTools.length,
        grantCount: coreGrantItems.length,
        ...(toolRegistryUnavailableReason ? { unavailableReason: toolRegistryUnavailableReason } : {}),
      },
      toolRegistry: {
        available: toolRegistryAvailable,
        installed: toolRegistryInstalled,
        status: toolRegistryPlugin?.status,
        pluginId: toolRegistryPlugin?.id,
        count: registryTools.filter((tool) => tool.enabled).length,
        ...(toolRegistryUnavailableReason ? { unavailableReason: toolRegistryUnavailableReason } : {}),
      },
    },
  };
}

export async function assertWorkflowToolReferencesSelectable(
  db: Db,
  input: { companyId: string; steps: WorkflowStep[] },
): Promise<void> {
  const references = input.steps.flatMap((step) => {
    const names = Array.isArray(step.toolNames)
      ? step.toolNames.map((toolName) => toolName.trim()).filter(Boolean)
      : [];
    return names
      .filter((toolName) => toolName !== "delegate_to_company")
      .map((toolName) => ({
        toolName,
        step: step as WorkflowStepWithToolSelection,
      }));
  });
  if (references.length === 0) return;

  const catalog = await listWorkflowToolCatalog(db, input.companyId);
  const enabledToolNames = new Set(
    catalog.tools
      .filter((tool) => tool.enabled)
      .map((tool) => tool.name.trim())
      .filter(Boolean),
  );
  const firstUnavailable = references.find((reference) => !enabledToolNames.has(reference.toolName));
  if (firstUnavailable) {
    throw new Error(`Workflow tool "${firstUnavailable.toolName}" is unavailable.`);
  }

  const grants = new Set(catalog.grants.map((grant) => `${grant.agentName}:${grant.toolName}`));
  const missingAgentGrant = references.find((reference) => {
    const stepType = typeof reference.step.type === "string" ? reference.step.type.trim().toLowerCase() : "";
    const agentName = typeof reference.step.agentName === "string" ? reference.step.agentName.trim() : "";
    if (stepType !== "agent" && !agentName) return false;
    if (!agentName) return false;
    return !grants.has(`${agentName}:${reference.toolName}`);
  });
  if (missingAgentGrant) {
    const agentName = typeof missingAgentGrant.step.agentName === "string" ? missingAgentGrant.step.agentName.trim() : "";
    throw new Error(`Workflow tool "${missingAgentGrant.toolName}" is not granted to agent "${agentName}".`);
  }
}
