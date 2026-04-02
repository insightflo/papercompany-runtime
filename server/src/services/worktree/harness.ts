/**
 * Worktree Harness
 *
 * Enforces MUST/SHOULD/MAY rules on tool invocations.
 * - MUST → throw WorktreeViolation
 * - SHOULD → warning log
 * - MAY → audit only (logged)
 *
 * Usage:
 *   const harness = createWorktreeHarness(db);
 *   await harness.checkAction({ companyId, agentId, tool: "file-write", args: { path: "/etc/passwd" } });
 */

import type { Db } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { worktreeRules } from "@paperclipai/db";
import { evaluatePredicate, type Predicate } from "./predicate-eval.js";
import { logger } from "../../middleware/logger.js";
import { worktreeCheckActionLatency } from "../../routes/metrics.js";
import { withSpan } from "../../lib/tracer.js";
import { getAlertRules } from "../alert-rules.js";

type WorktreeRuleRow = typeof worktreeRules.$inferSelect;

/**
 * Severity levels — determine enforcement action.
 */
export type WorktreeSeverity = "MUST" | "SHOULD" | "MAY";

/**
 * The context passed to checkAction — describes the tool invocation being evaluated.
 */
export interface WorktreeContext {
  companyId: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Working directory if available */
  cwd?: string;
  /** File path being operated on (for file-write, command-execute, etc.) */
  filePath?: string;
  /** Command being executed (for command-execute) */
  command?: string;
}

/**
 * A loaded rule from the database.
 */
interface LoadedRule {
  id: string;
  name: string;
  severity: WorktreeSeverity;
  predicate: Predicate;
  decisionMap: Record<string, WorktreeSeverity>;
  message: string;
  enabled: boolean;
}

/**
 * WorktreeViolation — thrown when a MUST rule is violated.
 */
export class WorktreeViolation extends Error {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly severity: "MUST";
  readonly context: WorktreeContext;

  constructor(ruleId: string, ruleName: string, message: string, context: WorktreeContext) {
    super(message);
    this.name = "WorktreeViolation";
    this.ruleId = ruleId;
    this.ruleName = ruleName;
    this.severity = "MUST";
    this.context = context;
  }
}

/**
 * WorktreeHarness — evaluates tool invocations against loaded rules.
 */
export class WorktreeHarness {
  constructor(private readonly db: Db) {}

  /**
   * checkAction — evaluate a tool invocation against all enabled rules for the company.
   *
   * - MUST violation → throws WorktreeViolation
   * - SHOULD match → warning log
   * - MAY match → debug/audit log
   */
  async checkAction(ctx: WorktreeContext): Promise<void> {
    return withSpan(
      "worktree.checkAction",
      {
        "worktree.company_id": ctx.companyId,
        "worktree.agent_id": ctx.agentId,
        "worktree.tool": ctx.tool,
      },
      async (span) => {
        const checkStart = Date.now();
        const rules = await this.loadRules(ctx.companyId);
        span.setAttribute("worktree.rule_count", rules.length);

        for (const rule of rules) {
          const result = evaluatePredicate(rule.predicate, {
            ...ctx,
            // Normalize tool name for decisionMap lookup
            tool: ctx.tool,
          });

          if (!result.matches) {
            continue;
          }

          // Rule matched — determine action based on decisionMap for this tool
          const effectiveSeverity = rule.decisionMap[ctx.tool] ?? rule.severity;

          switch (effectiveSeverity) {
            case "MUST":
              // P9-T3: record latency before throwing
              worktreeCheckActionLatency.observe(
                { tier: "MUST", result: "blocked" },
                (Date.now() - checkStart) / 1000,
              );
              span.setAttribute("worktree.outcome", "blocked");
              getAlertRules().recordMustBlock();
              throw new WorktreeViolation(
                rule.id,
                rule.name,
                rule.message || `Rule "${rule.name}" prohibits this action`,
                ctx,
              );

            case "SHOULD":
              logger.warn({
                msg: "Worktree SHOULD violation",
                ruleId: rule.id,
                ruleName: rule.name,
                tool: ctx.tool,
                companyId: ctx.companyId,
                agentId: ctx.agentId,
                message: rule.message,
              });
              break;

            case "MAY":
              logger.debug({
                msg: "Worktree MAY audit",
                ruleId: rule.id,
                ruleName: rule.name,
                tool: ctx.tool,
                companyId: ctx.companyId,
                agentId: ctx.agentId,
              });
              break;
          }
        }

        // P9-T3: observe latency for allowed actions (no violations)
        worktreeCheckActionLatency.observe(
          { tier: "pass", result: "allowed" },
          (Date.now() - checkStart) / 1000,
        );
        span.setAttribute("worktree.outcome", "allowed");
      },
    );
  }

  /**
   * loadRules — fetch all enabled rules for a company from the database.
   */
  private async loadRules(companyId: string): Promise<LoadedRule[]> {
    const rows = await this.db
      .select()
      .from(worktreeRules)
      .where(and(eq(worktreeRules.companyId, companyId), eq(worktreeRules.enabled, true)));

    return rows.map((row: WorktreeRuleRow) => ({
      id: row.id,
      name: row.name,
      severity: row.severity as WorktreeSeverity,
      predicate: row.predicate as Predicate,
      decisionMap: row.decisionMap as Record<string, WorktreeSeverity>,
      message: row.message,
      enabled: row.enabled,
    }));
  }
}

/**
 * Factory to create a WorktreeHarness instance.
 */
export function createWorktreeHarness(db: Db): WorktreeHarness {
  return new WorktreeHarness(db);
}
