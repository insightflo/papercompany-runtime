/**
 * Tool Registry Service
 *
 * Manages tool definitions, audit logging, and tool dispatch with worktree integration.
 */

import type { Db } from "../../packages/db/src/client.js";
import { toolDefinitions, toolAuditLog, agents, issues } from "../../packages/db/src/schema/index.js";
import { eq, and, desc } from "drizzle-orm";
import crypto from "node:crypto";
import type {
  ToolDefinition,
  CreateToolDefinitionInput,
  ToolInvocationResult,
  ToolAuditLogEntry,
  ToolDispatchContext,
} from "./types.js";

/**
 * Computes SHA-256 hash of arguments for audit logging.
 */
function hashArgs(args: Record<string, unknown>): string {
  const str = JSON.stringify(args, Object.keys(args).sort());
  return crypto.createHash("sha256").update(str).digest("hex");
}

/**
 * Tool registry service.
 */
export const toolService = {
  /**
   * Create a new tool definition.
   */
  async createDefinition(
    db: Db,
    input: CreateToolDefinitionInput,
  ): Promise<ToolDefinition> {
    const id = crypto.randomUUID();
    const now = new Date();

    await db.insert(toolDefinitions).values({
      id,
      companyId: input.companyId,
      name: input.name,
      description: input.description ?? "",
      inputSchema: input.inputSchema ?? {},
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    });

    return this.getDefinitionById(db, id) as Promise<ToolDefinition>;
  },

  /**
   * Get a tool definition by ID.
   */
  async getDefinitionById(db: Db, id: string): Promise<ToolDefinition | null> {
    const result = await db
      .select()
      .from(toolDefinitions)
      .where(eq(toolDefinitions.id, id))
      .limit(1);

    if (!result[0]) return null;
    return result[0] as ToolDefinition;
  },

  /**
   * Get a tool definition by name and company.
   */
  async getDefinitionByName(
    db: Db,
    companyId: string,
    name: string,
  ): Promise<ToolDefinition | null> {
    const result = await db
      .select()
      .from(toolDefinitions)
      .where(
        and(
          eq(toolDefinitions.companyId, companyId),
          eq(toolDefinitions.name, name),
        ),
      )
      .limit(1);

    if (!result[0]) return null;
    return result[0] as ToolDefinition;
  },

  /**
   * List tool definitions for a company.
   */
  async listDefinitions(
    db: Db,
    filters: { companyId?: string; enabled?: boolean } = {},
  ): Promise<ToolDefinition[]> {
    let query = db.select().from(toolDefinitions);

    if (filters.companyId) {
      query = query.where(eq(toolDefinitions.companyId, filters.companyId));
    }
    if (filters.enabled !== undefined) {
      query = query.where(eq(toolDefinitions.enabled, filters.enabled));
    }

    return query.orderBy(desc(toolDefinitions.createdAt)) as Promise<ToolDefinition[]>;
  },

  /**
   * Update a tool definition.
   */
  async updateDefinition(
    db: Db,
    id: string,
    updates: Partial<Omit<ToolDefinition, "id" | "createdAt" | "updatedAt">>,
  ): Promise<ToolDefinition | null> {
    await db
      .update(toolDefinitions)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(toolDefinitions.id, id));

    return this.getDefinitionById(db, id);
  },

  /**
   * Delete a tool definition.
   */
  async deleteDefinition(db: Db, id: string): Promise<boolean> {
    const result = await db
      .delete(toolDefinitions)
      .where(eq(toolDefinitions.id, id));

    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Check if a tool invocation is allowed and log the result.
   */
  async checkInvocation(
    db: Db,
    context: ToolDispatchContext,
  ): Promise<ToolInvocationResult> {
    // Get the tool definition
    const tool = await this.getDefinitionByName(db, context.companyId, context.toolName);
    if (!tool) {
      return {
        allowed: false,
        blockedReason: `Tool "${context.toolName}" not found`,
      };
    }

    if (!tool.enabled) {
      return {
        allowed: false,
        blockedReason: `Tool "${context.toolName}" is disabled`,
      };
    }

    // Check worktree constraints if provided
    if (context.worktreeCheck && !context.worktreeCheck.allowed) {
      const tier = context.worktreeCheck.tier;
      if (tier === "MUST") {
        await this.logInvocation(db, {
          companyId: context.companyId,
          toolId: tool.id,
          issueId: context.issueId,
          agentId: context.agentId,
          argsHash: hashArgs(context.args),
          result: "blocked_must",
        });

        return {
          allowed: false,
          blockedReason: context.worktreeCheck.message ?? "Blocked by worktree rule",
        };
      }

      if (tier === "SHOULD") {
        await this.logInvocation(db, {
          companyId: context.companyId,
          toolId: tool.id,
          issueId: context.issueId,
          agentId: context.agentId,
          argsHash: hashArgs(context.args),
          result: "blocked_should",
        });
        // SHOULD is a warning, but allows execution
      }
    }

    // Allowed
    await this.logInvocation(db, {
      companyId: context.companyId,
      toolId: tool.id,
      issueId: context.issueId,
      agentId: context.agentId,
      argsHash: hashArgs(context.args),
      result: "allowed",
    });

    return { allowed: true };
  },

  /**
   * Log a tool invocation to the audit log.
   */
  async logInvocation(
    db: Db,
    entry: {
      companyId: string;
      toolId: string;
      issueId: string | null;
      agentId: string | null;
      argsHash: string;
      result: "allowed" | "blocked_must" | "blocked_should";
    },
  ): Promise<void> {
    await db.insert(toolAuditLog).values({
      id: crypto.randomUUID(),
      toolId: entry.toolId,
      companyId: entry.companyId,
      issueId: entry.issueId,
      agentId: entry.agentId,
      argsHash: entry.argsHash,
      result: entry.result,
      createdAt: new Date(),
    });
  },

  /**
   * Get audit log entries for a tool.
   */
  async getAuditLog(
    db: Db,
    filters: { toolId?: string; companyId?: string; limit?: number },
  ): Promise<ToolAuditLogEntry[]> {
    let query = db.select().from(toolAuditLog);

    if (filters.toolId) {
      query = query.where(eq(toolAuditLog.toolId, filters.toolId));
    }
    if (filters.companyId) {
      query = query.where(eq(toolAuditLog.companyId, filters.companyId));
    }

    query = query.orderBy(desc(toolAuditLog.createdAt));

    if (filters.limit) {
      query = query.limit(filters.limit);
    }

    return query as Promise<ToolAuditLogEntry[]>;
  },
};

// Re-export types
export type {
  ToolDefinition,
  CreateToolDefinitionInput,
  ToolInvocationResult,
  ToolAuditLogEntry,
  ToolDispatchContext,
};
