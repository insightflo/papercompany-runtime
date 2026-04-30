import { joinPromptSections } from "./prompt-utils.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function summarizeMarkdownHandoff(markdown: string | null) {
  const trimmed = markdown?.trim();
  if (!trimmed) return null;
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const summary = lines.join(" ");
  return summary.length > 220 ? `${summary.slice(0, 217)}...` : summary;
}

export function buildPaperclipRuntimeBrief(context: Record<string, unknown>) {
  const manifest = asRecord(context.paperclipStepInputManifest);
  const handoff = asRecord(context.paperclipSessionHandoff);

  const taskKey = asString(manifest?.taskKey ?? context.taskKey);
  const issueId = asString(manifest?.issueId ?? context.issueId);
  const projectId = asString(manifest?.projectId ?? context.projectId);
  const allowedKeys = Array.isArray(manifest?.allowedContextKeys)
    ? manifest!.allowedContextKeys.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const manifestInputs = asRecord(manifest?.inputs);
  const workspace = asRecord(manifestInputs?.workspace);
  const runtimeServices = asRecord(manifestInputs?.runtimeServices);
  const tools = asRecord(manifestInputs?.tools);
  const knowledge = asRecord(manifestInputs?.knowledge);
  const maintenanceGuidance = asRecord(manifestInputs?.maintenanceGuidance);
  const fileViews = asRecord(manifestInputs?.fileViews);
  const guardrails = asRecord(manifest?.guardrails);

  const workspaceLine =
    workspace?.available === true
      ? [
          "- Workspace: available",
          asString(workspace.source) ? `(${asString(workspace.source)})` : "",
          asString(workspace.workspaceId) ? `[${asString(workspace.workspaceId)}]` : "",
        ].filter(Boolean).join(" ")
      : "- Workspace: unavailable";

  const runtimeServicesLine =
    runtimeServices?.available === true
      ? `- Runtime services: ${Number(runtimeServices.count ?? 0)} available${asString(runtimeServices.primaryUrl) ? ` (${asString(runtimeServices.primaryUrl)})` : ""}`
      : "- Runtime services: unavailable";

  const fileViewsLine =
    fileViews?.available === true
      ? `- File views: ${Number(fileViews.count ?? 0)} available${asString(fileViews.source) ? ` (${asString(fileViews.source)})` : ""}`
      : null;

  const toolsLine =
    tools?.available === true
      ? `- Allowed tools: ${Array.isArray(tools.names) && tools.names.length > 0 ? tools.names.join(", ") : `${Number(tools.count ?? 0)} configured`}`
      : null;

  const knowledgeLine =
    knowledge?.available === true
      ? `- Knowledge: ${Array.isArray(knowledge.names) && knowledge.names.length > 0 ? knowledge.names.join(", ") : `${Number(knowledge.count ?? 0)} connected`}`
      : null;

  const maintenanceGuidanceLine =
    maintenanceGuidance?.available === true
      ? `- Maintenance guidance: ${Number(maintenanceGuidance.ruleCount ?? 0)} rules, ${Number(maintenanceGuidance.knowledgeCount ?? 0)} KB references`
      : null;

  const maintenanceRuleLine =
    maintenanceGuidance?.available === true && Array.isArray(maintenanceGuidance.ruleNames) && maintenanceGuidance.ruleNames.length > 0
      ? `- Rules: ${maintenanceGuidance.ruleNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(", ")}`
      : null;

  const maintenanceRuleExcerptLine =
    maintenanceGuidance?.available === true && Array.isArray(maintenanceGuidance.ruleExcerpts) && maintenanceGuidance.ruleExcerpts.length > 0
      ? `- Rule excerpts: ${maintenanceGuidance.ruleExcerpts.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" | ")}`
      : null;

  const maintenanceKnowledgeLine =
    maintenanceGuidance?.available === true && Array.isArray(maintenanceGuidance.knowledgeNames) && maintenanceGuidance.knowledgeNames.length > 0
      ? `- Guidance KB: ${maintenanceGuidance.knowledgeNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(", ")}`
      : null;

  const maintenanceKnowledgeExcerptLine =
    maintenanceGuidance?.available === true && Array.isArray(maintenanceGuidance.knowledgeExcerpts) && maintenanceGuidance.knowledgeExcerpts.length > 0
      ? `- Guidance KB excerpts: ${maintenanceGuidance.knowledgeExcerpts.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" | ")}`
      : null;

  const guardrailLine =
    guardrails?.broadScanAllowed === false
      ? "- Broad scans: disallowed. Stay within the manifest-provided context."
      : guardrails?.broadScanAllowed === true
        ? "- Broad scans: allowed by server policy."
        : null;

  const handoffSummary = handoff
    ? joinPromptSections([
        `- Previous session: ${asString(handoff.previousSessionId) ?? "unknown"}`,
        asString(handoff.rotationReason) ? `- Rotation reason: ${asString(handoff.rotationReason)}` : null,
        asString(handoff.lastRunSummaryText) ? `- Last run summary: ${asString(handoff.lastRunSummaryText)}` : null,
      ], "\n")
    : summarizeMarkdownHandoff(asString(context.paperclipSessionHandoffMarkdown))
      ? `- Previous handoff summary: ${summarizeMarkdownHandoff(asString(context.paperclipSessionHandoffMarkdown))}`
      : null;

  const brief = joinPromptSections([
    taskKey || issueId || projectId || allowedKeys.length > 0 || handoffSummary
      ? "Paperclip runtime brief:"
      : null,
    taskKey ? `- Task key: ${taskKey}` : null,
    issueId ? `- Issue: ${issueId}` : null,
    projectId ? `- Project: ${projectId}` : null,
    allowedKeys.length > 0 ? `- Allowed context keys: ${allowedKeys.join(", ")}` : null,
    workspaceLine,
    runtimeServicesLine,
    toolsLine,
    knowledgeLine,
    maintenanceGuidanceLine,
    maintenanceRuleLine,
    maintenanceRuleExcerptLine,
    maintenanceKnowledgeLine,
    maintenanceKnowledgeExcerptLine,
    fileViewsLine,
    guardrailLine,
    handoffSummary,
  ], "\n");

  return brief;
}
