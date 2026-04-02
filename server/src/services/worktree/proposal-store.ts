/**
 * Worktree Proposal Store
 *
 * Manages the agent proposal flow for worktree rules.
 * - Agents can propose new rules or changes to existing rules
 * - OQ-5: Each agent is limited to 3 proposals per company per day
 * - Proposals go through review before becoming active rules
 *
 * Usage:
 *   const store = proposalStore(db);
 *   const proposal = await store.create({ companyId, proposedByAgentId, ... });
 *   await store.review(proposalId, { status: "approved", reviewedByAgentId, reviewNote });
 */

import { and, eq, gte, lt, desc, asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { worktreeRuleProposals } from "@paperclipai/db";
import { notFound, forbidden } from "../../errors.js";
import type { Predicate } from "./predicate-eval.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum proposals an agent can create per company per day.
 * Enforced server-side per OQ-5.
 */
export const MAX_PROPOSALS_PER_AGENT_PER_DAY = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Severity levels for worktree rules (mirrors RuleSeverity).
 */
export type RuleSeverity = "MUST" | "SHOULD" | "MAY";

/**
 * Proposal status lifecycle.
 */
export type ProposalStatus = "proposed" | "approved" | "rejected";

/**
 * The proposed rule change embedded in a proposal's JSONB field.
 */
export interface ProposedRuleChange {
  name: string;
  severity: RuleSeverity;
  action: string;
  predicate: Predicate;
  decisionMap: Record<string, unknown>;
  message?: string;
}

/**
 * Input to create a new proposal.
 */
export interface CreateProposalInput {
  companyId: string;
  proposedByAgentId: string;
  /** Reference to an existing rule being amended (optional) */
  ruleId?: string;
  /** The proposed rule change */
  proposedChange: ProposedRuleChange;
  /** Why this change is being proposed */
  rationale: string;
}

/**
 * Input to review a proposal.
 */
export interface ReviewProposalInput {
  status: "approved" | "rejected";
  reviewedByAgentId: string;
  reviewNote?: string;
}

/**
 * Sort field for listing proposals.
 */
export type ProposalSortField = "createdAt" | "status";

/**
 * Sort order.
 */
export type SortOrder = "asc" | "desc";

/**
 * Filter options for listing proposals.
 */
export interface ListProposalsFilter {
  status?: ProposalStatus;
  proposedByAgentId?: string;
  ruleId?: string;
  sortBy?: ProposalSortField;
  sortOrder?: SortOrder;
  limit?: number;
  offset?: number;
}

/**
 * A proposal row as returned from the database.
 */
export type WorktreeProposalRow = typeof worktreeRuleProposals.$inferSelect;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_SEVERITIES: RuleSeverity[] = ["MUST", "SHOULD", "MAY"];
const VALID_STATUSES: ProposalStatus[] = ["proposed", "approved", "rejected"];

function validateSeverity(severity: string): asserts severity is RuleSeverity {
  if (!VALID_SEVERITIES.includes(severity as RuleSeverity)) {
    throw new Error(`Invalid severity: ${severity}. Must be one of: ${VALID_SEVERITIES.join(", ")}`);
  }
}

function validateStatus(status: string): asserts status is ProposalStatus {
  if (!VALID_STATUSES.includes(status as ProposalStatus)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Get start and end of today in UTC.
 */
function getTodayBounds(): { dayStart: Date; dayEnd: Date } {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  return { dayStart, dayEnd };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Factory function to create a worktree proposal store.
 *
 * @param db - Database instance
 * @returns Proposal store with create, review, and list operations
 */
export function proposalStore(db: Db) {
  /**
   * countTodayByAgent — count proposals created by an agent today for a company.
   */
  async function countTodayByAgent(companyId: string, agentId: string): Promise<number> {
    const { dayStart, dayEnd } = getTodayBounds();

    const rows = await db
      .select()
      .from(worktreeRuleProposals)
      .where(
        and(
          eq(worktreeRuleProposals.companyId, companyId),
          eq(worktreeRuleProposals.proposedBy, agentId),
          gte(worktreeRuleProposals.createdAt, dayStart),
          lt(worktreeRuleProposals.createdAt, dayEnd),
        ),
      );

    return rows.length;
  }

  /**
   * create — submit a new proposal.
   *
   * OQ-5: Each agent is limited to 3 proposals per company per day.
   * Throws ForbiddenError if the limit is exceeded.
   */
  async function create(input: CreateProposalInput): Promise<WorktreeProposalRow> {
    const count = await countTodayByAgent(input.companyId, input.proposedByAgentId);

    if (count >= MAX_PROPOSALS_PER_AGENT_PER_DAY) {
      throw forbidden(
        `Proposal limit reached: agent ${input.proposedByAgentId} has ${count}/${MAX_PROPOSALS_PER_AGENT_PER_DAY} proposals today for company ${input.companyId}`,
      );
    }

    // Validate severity in proposedChange
    validateSeverity(input.proposedChange.severity);

    const [proposal] = await db
      .insert(worktreeRuleProposals)
      .values({
        ruleId: input.ruleId ?? null,
        companyId: input.companyId,
        proposedBy: input.proposedByAgentId,
        proposedChange: input.proposedChange as unknown as Record<string, unknown>,
        rationale: input.rationale,
        status: "proposed",
      })
      .returning();

    return proposal;
  }

  /**
   * getById — fetch a single proposal by ID.
   */
  async function getById(id: string): Promise<WorktreeProposalRow> {
    const rows = await db
      .select()
      .from(worktreeRuleProposals)
      .where(eq(worktreeRuleProposals.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw notFound(`Proposal not found: ${id}`);
    }

    return rows[0];
  }

  /**
   * listByCompany — list proposals for a company with optional filters.
   */
  async function listByCompany(
    companyId: string,
    filter: ListProposalsFilter = {},
  ): Promise<WorktreeProposalRow[]> {
    const conditions = [eq(worktreeRuleProposals.companyId, companyId)];

    if (filter.status !== undefined) {
      validateStatus(filter.status);
      conditions.push(eq(worktreeRuleProposals.status, filter.status));
    }

    if (filter.proposedByAgentId !== undefined) {
      conditions.push(eq(worktreeRuleProposals.proposedBy, filter.proposedByAgentId));
    }

    if (filter.ruleId !== undefined) {
      conditions.push(eq(worktreeRuleProposals.ruleId, filter.ruleId));
    }

    const sortColumn =
      filter.sortBy === "status"
        ? worktreeRuleProposals.status
        : worktreeRuleProposals.createdAt;

    const order = filter.sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn);

    const baseQuery = db
      .select()
      .from(worktreeRuleProposals)
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
   * review — approve or reject a proposal.
   *
   * Only "proposed" proposals can be reviewed.
   */
  async function review(
    id: string,
    input: ReviewProposalInput,
  ): Promise<WorktreeProposalRow> {
    const proposal = await getById(id);

    if (proposal.status !== "proposed") {
      throw forbidden(`Proposal ${id} is already ${proposal.status}; cannot review again`);
    }

    validateStatus(input.status);

    const [updated] = await db
      .update(worktreeRuleProposals)
      .set({
        status: input.status,
        reviewedBy: input.reviewedByAgentId,
        reviewedAt: new Date(),
      })
      .where(eq(worktreeRuleProposals.id, id))
      .returning();

    return updated;
  }

  /**
   * countByCompany — count proposals for a company.
   */
  async function countByCompany(companyId: string, filter: ListProposalsFilter = {}): Promise<number> {
    const conditions = [eq(worktreeRuleProposals.companyId, companyId)];

    if (filter.status !== undefined) {
      validateStatus(filter.status);
      conditions.push(eq(worktreeRuleProposals.status, filter.status));
    }

    if (filter.proposedByAgentId !== undefined) {
      conditions.push(eq(worktreeRuleProposals.proposedBy, filter.proposedByAgentId));
    }

    const rows = await db
      .select()
      .from(worktreeRuleProposals)
      .where(and(...conditions));

    return rows.length;
  }

  return {
    create,
    getById,
    listByCompany,
    review,
    countByCompany,
    // Exposed for testing / rate-limit UI
    countTodayByAgent,
  };
}

export type ProposalStore = ReturnType<typeof proposalStore>;
