import { describe, expect, it } from "vitest";

import { buildMissionRuleContextFromRows } from "../services/missions/mission-rule-context.js";

describe("mission rule context", () => {
  it("maps active worktree rules into bounded mission rule refs without hard-blocking by default", () => {
    const context = buildMissionRuleContextFromRows([
      {
        id: "rule-should",
        name: "Observe budget drift",
        severity: "SHOULD",
        action: "warn_operator",
        decisionMap: {},
        message: "If budget drift appears, surface it as observation for the owner.",
      },
      {
        id: "rule-must",
        name: "Validate deployment target",
        severity: "MUST",
        action: "require_validation",
        decisionMap: {},
        message: "Deployment target must be checked before execution.",
      },
      {
        id: "rule-approval",
        name: "Approval before publish",
        severity: "MUST",
        action: "request_approval",
        decisionMap: { requiresApproval: true },
        message: "Publishing requires owner approval.",
      },
      {
        id: "rule-may",
        name: "Prefer concise report",
        severity: "MAY",
        action: "guide_reporting",
        decisionMap: {},
        message: "Reports may be concise when no risk changed.",
      },
      {
        id: "rule-disabled",
        name: "Disabled rule",
        severity: "MUST",
        action: "request_approval",
        decisionMap: { mode: "hard_gate" },
        message: "Should be ignored.",
        enabled: false,
      },
    ]);

    expect(context.ruleRefs.map((rule) => rule.id)).toEqual([
      "rule-approval",
      "rule-must",
      "rule-should",
      "rule-may",
    ]);
    expect(context.ruleRefs.map((rule) => rule.mode)).toEqual([
      "approval_gate",
      "soft_gate",
      "observation",
      "guidance",
    ]);
    expect(context.ruleRefs.every((rule) => rule.source === "worktree_rule")).toBe(true);
    expect(context.ruleRefs.every((rule) => rule.key.startsWith("worktree_rule:"))).toBe(true);
    expect(context.ruleRefs.some((rule) => rule.mode === "hard_gate")).toBe(false);
  });

  it("honors explicit rule mode vocabulary and caps context at ten refs", () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      id: `rule-${index}`,
      name: `Rule ${String(index).padStart(2, "0")}`,
      severity: "MAY",
      action: "observe",
      decisionMap: index === 0 ? { mode: "hard_gate" } : index === 1 ? { ruleMode: "soft_gate" } : {},
      message: "x".repeat(400),
    }));

    const context = buildMissionRuleContextFromRows(rows, { limit: 20 });

    expect(context.ruleRefs).toHaveLength(10);
    expect(context.ruleRefs[0]).toMatchObject({
      id: "rule-0",
      mode: "hard_gate",
      excerpt: expect.stringMatching(/\.\.\.$/),
    });
    expect(context.ruleRefs[1]).toMatchObject({ id: "rule-1", mode: "soft_gate" });
    expect(context.ruleRefs[0].excerpt.length).toBeLessThanOrEqual(220);
  });
});
