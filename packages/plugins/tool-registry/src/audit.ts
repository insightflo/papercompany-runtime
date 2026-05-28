import type { PluginContext } from "@paperclipai/plugin-sdk";

const DIRECT_SHELL_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /(^|\s)(bash|zsh|sh)\s+-[lc](\s|$)/im,
    message: "Detected shell invocation with -lc/-c",
  },
  {
    pattern: /(^|\s)(bash|zsh|sh)(\s|$)/im,
    message: "Detected direct shell binary usage",
  },
  {
    pattern: /child_process\.(exec|spawn)\s*\(/im,
    message: "Detected Node child_process exec/spawn usage",
  },
  {
    pattern: /\b(process\.)?stdin\b.*\b(bash|sh|zsh)\b/im,
    message: "Detected shell usage via stdin piping",
  },
];

export function analyzeRunLog(log: string): string[] {
  const source = typeof log === "string" ? log : "";
  if (!source.trim()) {
    return [];
  }

  const violations = new Set<string>();

  for (const detector of DIRECT_SHELL_PATTERNS) {
    if (detector.pattern.test(source)) {
      violations.add(detector.message);
    }
  }

  return Array.from(violations);
}

function formatViolations(violations: string[]): string {
  return violations
    .map((violation) => `- ${violation}`)
    .join("\n");
}

async function resolveInspectorAgentId(
  ctx: PluginContext,
  companyId: string,
): Promise<string | undefined> {
  const agents = await ctx.agents.list({ companyId, limit: 200, offset: 0 });
  const matched = agents.find((agent) => /(감찰관|inspector|auditor)/i.test(agent.name));
  return matched?.id;
}

export async function createAuditIssue(
  ctx: PluginContext,
  companyId: string,
  agentName: string,
  violations: string[],
): Promise<{ issueId: string }> {
  const inspectorAgentId = await resolveInspectorAgentId(ctx, companyId);
  const nowIso = new Date().toISOString();

  const issue = await ctx.issues.create({
    companyId,
    title: `[Tool Registry Audit] ${agentName} direct shell usage detected`,
    description: [
      "Tool Registry 감사지표에서 direct shell 실행 패턴이 감지되었습니다.",
      "",
      `- Agent: ${agentName}`,
      `- Detected At: ${nowIso}`,
      "",
      "Violations:",
      formatViolations(violations),
      "",
      "조치: allow-list 기반 plugin tool 사용으로 전환 필요",
    ].join("\n"),
    assigneeAgentId: inspectorAgentId,
  });

  return { issueId: issue.id };
}
