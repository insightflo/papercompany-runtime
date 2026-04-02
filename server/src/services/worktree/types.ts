/**
 * Worktree Service Types
 *
 * Defines TypeScript interfaces for worktree rules, proposals, and violations.
 */

import type { Predicate } from "./predicate-eval.js";

// ---------------------------------------------------------------------------
// WorktreeRule
// ---------------------------------------------------------------------------

/**
 * Severity levels for worktree rules.
 * MUST: violation throws WorktreeViolation
 * SHOULD: violation logs warning
 * MAY: violation only audits
 */
export type RuleSeverity = "MUST" | "SHOULD" | "MAY";

/**
 * Rule action types - describes what action triggered the rule check.
 */
export type RuleAction =
  | "tool_call"
  | "file_read"
  | "file_write"
  | "file_delete"
  | "network_request"
  | "command_execution"
  | "state_query";

/**
 * A worktree rule definition.
 * Each rule belongs to a company and defines a predicate-based enforcement.
 */
export interface WorktreeRule {
  id: string;
  companyId: string;
  name: string;
  severity: RuleSeverity;
  action: string;
  predicate: Predicate;
  decisionMap: Record<string, unknown>;
  message: string;
  enabled: boolean;
  version: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// WorktreeProposal
// ---------------------------------------------------------------------------

/**
 * Status of a worktree rule proposal.
 */
export type ProposalStatus = "pending" | "approved" | "rejected" | "superseded";

/**
 * A worktree rule proposal - created by an agent when it wants to propose a new rule.
 */
export interface WorktreeProposal {
  id: string;
  companyId: string;
  ruleName: string;
  ruleSeverity: RuleSeverity;
  ruleAction: string;
  rulePredicate: Predicate;
  ruleDecisionMap: Record<string, unknown>;
  ruleMessage: string;
  status: ProposalStatus;
  proposedByAgentId: string;
  reviewedByAgentId?: string;
  reviewNote?: string;
  supersededByProposalId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input to create a new proposal.
 */
export interface CreateProposalInput {
  companyId: string;
  ruleName: string;
  ruleSeverity: RuleSeverity;
  ruleAction: string;
  rulePredicate: Predicate;
  ruleDecisionMap?: Record<string, unknown>;
  ruleMessage?: string;
  proposedByAgentId: string;
}

/**
 * Input to review a proposal.
 */
export interface ReviewProposalInput {
  status: "approved" | "rejected";
  reviewedByAgentId: string;
  reviewNote?: string;
}

// ---------------------------------------------------------------------------
// WorktreeViolation
// ---------------------------------------------------------------------------

/**
 * WorktreeViolation is thrown when a MUST rule is violated.
 * This is a specialized error for worktree rule enforcement.
 */
export class WorktreeViolation extends Error {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly severity: RuleSeverity;
  readonly action: string;
  readonly context: Record<string, unknown>;
  readonly decision: string;

  constructor(opts: {
    ruleId: string;
    ruleName: string;
    severity: RuleSeverity;
    action: string;
    context: Record<string, unknown>;
    decision: string;
    message: string;
  }) {
    super(opts.message);
    this.name = "WorktreeViolation";
    this.ruleId = opts.ruleId;
    this.ruleName = opts.ruleName;
    this.severity = opts.severity;
    this.action = opts.action;
    this.context = opts.context;
    this.decision = opts.decision;
  }
}

/**
 * Result of a harness check operation.
 */
export interface HarnessCheckResult {
  allowed: boolean;
  severity?: RuleSeverity;
  violations: WorktreeViolation[];
  warnings: Array<{
    ruleId: string;
    ruleName: string;
    message: string;
  }>;
  auditEntries: Array<{
    ruleId: string;
    ruleName: string;
    severity: RuleSeverity;
    action: string;
    decision: string;
    timestamp: Date;
  }>;
}

/**
 * Context passed to the harness for rule evaluation.
 */
export interface HarnessContext {
  companyId: string;
  agentId: string;
  action: string;
  resource?: string;
  metadata?: Record<string, unknown>;
}
