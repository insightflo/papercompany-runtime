import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { worktreeRules } from "@paperclipai/db";

export type MissionRuleMode = "guidance" | "observation" | "soft_gate" | "approval_gate" | "hard_gate";

export type MissionRuleRef = {
  id: string;
  key: string;
  name: string;
  mode: MissionRuleMode;
  severity: string;
  action: string;
  source: "worktree_rule";
  reason: string;
  excerpt: string;
};

type WorktreeRuleLike = {
  id: string;
  name: string;
  severity: string;
  action: string;
  decisionMap: Record<string, unknown>;
  message: string;
  enabled?: boolean;
};

const RULE_LIMIT = 10;
const VALID_MODES = new Set<MissionRuleMode>(["guidance", "observation", "soft_gate", "approval_gate", "hard_gate"]);
const SEVERITY_RANK: Record<string, number> = { MUST: 0, SHOULD: 1, MAY: 2 };

export async function buildMissionRuleContext(db: Db, input: { companyId: string; limit?: number }): Promise<{ ruleRefs: MissionRuleRef[] }> {
  const rows = await db
    .select()
    .from(worktreeRules)
    .where(and(eq(worktreeRules.companyId, input.companyId), eq(worktreeRules.enabled, true)));

  return buildMissionRuleContextFromRows(rows, { limit: input.limit });
}

export function buildMissionRuleContextFromRows(
  rows: WorktreeRuleLike[],
  input: { limit?: number } = {},
): { ruleRefs: MissionRuleRef[] } {
  const limit = Math.max(0, Math.min(input.limit ?? RULE_LIMIT, RULE_LIMIT));
  const ruleRefs = rows
    .filter((row) => row.enabled !== false)
    .slice()
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((row) => toMissionRuleRef(row));

  return { ruleRefs };
}

function toMissionRuleRef(row: WorktreeRuleLike): MissionRuleRef {
  const mode = modeForRule(row);
  const reason = reasonForRule(row, mode);
  const excerpt = truncate(row.message || `${row.severity} ${row.action}`, 220);
  return {
    id: row.id,
    key: `worktree_rule:${row.id}`,
    name: row.name,
    mode,
    severity: row.severity,
    action: row.action,
    source: "worktree_rule",
    reason,
    excerpt,
  };
}

function modeForRule(row: WorktreeRuleLike): MissionRuleMode {
  const explicitMode = readRuleMode(row.decisionMap.mode) ?? readRuleMode(row.decisionMap.ruleMode);
  if (explicitMode) return explicitMode;

  if (row.decisionMap.requiresApproval === true || /approval|approve|승인/i.test(row.action)) {
    return "approval_gate";
  }

  const severity = row.severity.trim().toUpperCase();
  if (severity === "MUST") return "soft_gate";
  if (severity === "SHOULD") return "observation";
  return "guidance";
}

function readRuleMode(value: unknown): MissionRuleMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return VALID_MODES.has(normalized as MissionRuleMode) ? normalized as MissionRuleMode : null;
}

function reasonForRule(row: WorktreeRuleLike, mode: MissionRuleMode) {
  if (mode === "hard_gate" && readRuleMode(row.decisionMap.mode) !== "hard_gate" && readRuleMode(row.decisionMap.ruleMode) !== "hard_gate") {
    return "Explicit hard gate required; falling back to rule guidance.";
  }
  return `Mapped ${row.severity || "unspecified"} worktree rule to ${mode} for mission planning context.`;
}

function truncate(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
}
