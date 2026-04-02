/**
 * Tool Audit Service
 *
 * Provides audit logging for tool invocations with aggregation and analysis.
 */

import type { Db } from "@paperclipai/db";
import { toolAuditLog, toolDefinitions } from "@paperclipai/db";
import { eq, and, sql, desc, gte } from "drizzle-orm";
import type { ToolAuditLogEntry } from "./types.js";

/**
 * Aggregate statistics for tool usage.
 */
export interface ToolUsageStats {
  toolId: string;
  toolName: string;
  totalInvocations: number;
  allowedCount: number;
  blockedMustCount: number;
  blockedShouldCount: number;
  lastUsedAt: Date | null;
}

/**
 * Get tool usage statistics for a company.
 */
export async function getToolUsageStats(
  db: Db,
  companyId: string,
  days: number = 30,
): Promise<ToolUsageStats[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const results = await db
    .select({
      toolId: toolAuditLog.toolId,
      toolName: toolDefinitions.name,
      totalInvocations: sql<number>`count(*)`,
      allowedCount: sql<number>`sum(case when ${toolAuditLog.result} = 'allowed' then 1 else 0 end)`,
      blockedMustCount: sql<number>`sum(case when ${toolAuditLog.result} = 'blocked_must' then 1 else 0 end)`,
      blockedShouldCount: sql<number>`sum(case when ${toolAuditLog.result} = 'blocked_should' then 1 else 0 end)`,
      lastUsedAt: sql<Date>`max(${toolAuditLog.createdAt})`,
    })
    .from(toolAuditLog)
    .innerJoin(toolDefinitions, eq(toolAuditLog.toolId, toolDefinitions.id))
    .where(
      and(
        eq(toolAuditLog.companyId, companyId),
        gte(toolAuditLog.createdAt, cutoff),
      ),
    )
    .groupBy(toolAuditLog.toolId, toolDefinitions.name)
    .orderBy(desc(sql`count(*)`));

  return results as unknown as ToolUsageStats[];
}

/**
 * Get recent audit log entries.
 */
export async function getRecentAuditLog(
  db: Db,
  filters: { companyId?: string; agentId?: string; limit?: number } = {},
): Promise<ToolAuditLogEntry[]> {
  const conditions = [];
  if (filters.companyId) conditions.push(eq(toolAuditLog.companyId, filters.companyId));
  if (filters.agentId) conditions.push(eq(toolAuditLog.agentId, filters.agentId));

  const baseQuery = db
    .select()
    .from(toolAuditLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(toolAuditLog.createdAt));

  const rows = filters.limit !== undefined ? await baseQuery.limit(filters.limit) : await baseQuery;
  return rows as ToolAuditLogEntry[];
}

/**
 * Check if an agent has exceeded tool invocation limits.
 */
export async function checkAgentInvocationLimit(
  db: Db,
  agentId: string,
  windowMinutes: number = 60,
  maxInvocations: number = 1000,
): Promise<{ withinLimit: boolean; currentCount: number }> {
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000);

  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(toolAuditLog)
    .where(
      and(
        eq(toolAuditLog.agentId, agentId),
        gte(toolAuditLog.createdAt, cutoff),
      ),
    );

  const currentCount = result[0]?.count ?? 0;

  return {
    withinLimit: currentCount < maxInvocations,
    currentCount,
  };
}
