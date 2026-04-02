/**
 * Worktree Rule Store
 *
 * CRUD operations for worktree_rules table.
 * Each rule belongs to a company and defines MUST/SHOULD/MAY enforcement predicates.
 */

import { and, eq, asc, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { worktreeRules } from "@paperclipai/db";
import { notFound, badRequest } from "../../errors.js";
import type { Predicate } from "./predicate-eval.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Severity levels for worktree rules.
 * MUST: violation throws WorktreeViolation
 * SHOULD: violation logs warning
 * MAY: violation only audits
 */
export type RuleSeverity = "MUST" | "SHOULD" | "MAY";

/**
 * Input for creating a new rule.
 */
export interface CreateRuleInput {
  companyId: string;
  name: string;
  severity: RuleSeverity;
  action: string;
  predicate: Predicate;
  decisionMap: Record<string, unknown>;
  message?: string;
  enabled?: boolean;
  createdBy: string;
}

/**
 * Input for updating an existing rule.
 */
export interface UpdateRuleInput {
  name?: string;
  severity?: RuleSeverity;
  action?: string;
  predicate?: Predicate;
  decisionMap?: Record<string, unknown>;
  message?: string;
  enabled?: boolean;
}

/**
 * Rule sort field.
 */
export type RuleSortField = "createdAt" | "updatedAt" | "name" | "severity";

/**
 * Sort order.
 */
export type SortOrder = "asc" | "desc";

/**
 * Filter options for listing rules.
 */
export interface ListRulesFilter {
  enabled?: boolean;
  severity?: RuleSeverity;
  sortBy?: RuleSortField;
  sortOrder?: SortOrder;
  limit?: number;
  offset?: number;
}

/**
 * WorktreeRule table row type (inferred).
 */
export type WorktreeRuleRow = typeof worktreeRules.$inferSelect;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_SEVERITIES: RuleSeverity[] = ["MUST", "SHOULD", "MAY"];

function validateSeverity(severity: string): asserts severity is RuleSeverity {
  if (!VALID_SEVERITIES.includes(severity as RuleSeverity)) {
    throw badRequest(`Invalid severity: ${severity}. Must be one of: ${VALID_SEVERITIES.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Factory function to create a worktree rule store.
 *
 * @param db - Database instance
 * @returns Rule store with CRUD operations
 */
export function ruleStore(db: Db) {
  /**
   * Create a new rule.
   */
  async function create(input: CreateRuleInput): Promise<WorktreeRuleRow> {
    validateSeverity(input.severity);

    const [rule] = await db
      .insert(worktreeRules)
      .values({
        companyId: input.companyId,
        name: input.name,
        severity: input.severity,
        action: input.action,
        predicate: input.predicate as Record<string, unknown>,
        decisionMap: input.decisionMap,
        message: input.message ?? "",
        enabled: input.enabled ?? true,
        createdBy: input.createdBy,
      })
      .returning();

    return rule;
  }

  /**
   * Get a rule by ID.
   */
  async function getById(id: string): Promise<WorktreeRuleRow> {
    const rows = await db
      .select()
      .from(worktreeRules)
      .where(eq(worktreeRules.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw notFound(`Rule not found: ${id}`);
    }

    return rows[0];
  }

  /**
   * List rules for a company with optional filters.
   */
  async function listByCompany(
    companyId: string,
    filter: ListRulesFilter = {},
  ): Promise<WorktreeRuleRow[]> {
    const conditions = [eq(worktreeRules.companyId, companyId)];

    if (filter.enabled !== undefined) {
      conditions.push(eq(worktreeRules.enabled, filter.enabled));
    }

    if (filter.severity !== undefined) {
      validateSeverity(filter.severity);
      conditions.push(eq(worktreeRules.severity, filter.severity));
    }

    const sortColumn =
      filter.sortBy === "name"
        ? worktreeRules.name
        : filter.sortBy === "severity"
          ? worktreeRules.severity
          : filter.sortBy === "updatedAt"
            ? worktreeRules.updatedAt
            : worktreeRules.createdAt;

    const order = filter.sortOrder === "desc" ? desc(sortColumn) : asc(sortColumn);

    const baseQuery = db
      .select()
      .from(worktreeRules)
      .where(and(...conditions))
      .orderBy(order);

    if (filter.limit !== undefined && filter.offset !== undefined) {
      return await baseQuery.limit(filter.limit).offset(filter.offset);
    }
    if (filter.limit !== undefined) {
      return await baseQuery.limit(filter.limit);
    }
    if (filter.offset !== undefined) {
      return await baseQuery.offset(filter.offset);
    }

    return await baseQuery;
  }

  /**
   * List only enabled rules for a company.
   * Convenience method for the harness which only needs active rules.
   */
  async function listEnabledByCompany(companyId: string): Promise<WorktreeRuleRow[]> {
    return listByCompany(companyId, { enabled: true });
  }

  /**
   * Update a rule.
   */
  async function update(id: string, input: UpdateRuleInput): Promise<WorktreeRuleRow> {
    // First check the rule exists
    await getById(id);

    if (input.severity !== undefined) {
      validateSeverity(input.severity);
    }

    const updates: Partial<WorktreeRuleRow> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) updates.name = input.name;
    if (input.severity !== undefined) updates.severity = input.severity;
    if (input.action !== undefined) updates.action = input.action;
    if (input.predicate !== undefined) updates.predicate = input.predicate as Record<string, unknown>;
    if (input.decisionMap !== undefined) updates.decisionMap = input.decisionMap;
    if (input.message !== undefined) updates.message = input.message;
    if (input.enabled !== undefined) updates.enabled = input.enabled;

    // Increment version on update
    const current = await getById(id);
    updates.version = current.version + 1;

    const [updated] = await db
      .update(worktreeRules)
      .set(updates)
      .where(eq(worktreeRules.id, id))
      .returning();

    return updated;
  }

  /**
   * Delete a rule.
   */
  async function deleteRule(id: string): Promise<void> {
    // Check it exists first
    await getById(id);

    await db
      .delete(worktreeRules)
      .where(eq(worktreeRules.id, id));
  }

  /**
   * Toggle rule enabled state.
   */
  async function toggleEnabled(id: string): Promise<WorktreeRuleRow> {
    const rule = await getById(id);
    return update(id, { enabled: !rule.enabled });
  }

  /**
   * Count rules for a company.
   */
  async function countByCompany(companyId: string, filter: ListRulesFilter = {}): Promise<number> {
    const conditions = [eq(worktreeRules.companyId, companyId)];

    if (filter.enabled !== undefined) {
      conditions.push(eq(worktreeRules.enabled, filter.enabled));
    }

    if (filter.severity !== undefined) {
      validateSeverity(filter.severity);
      conditions.push(eq(worktreeRules.severity, filter.severity));
    }

    const rows = await db
      .select()
      .from(worktreeRules)
      .where(and(...conditions));

    return rows.length;
  }

  return {
    create,
    getById,
    listByCompany,
    listEnabledByCompany,
    update,
    delete: deleteRule,
    toggleEnabled,
    countByCompany,
  };
}

export type RuleStore = ReturnType<typeof ruleStore>;
