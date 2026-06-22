import { joinPromptSections } from "./prompt-utils.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && isFinite(value) ? value : 0;
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function truncateBriefLine(value: string, max = 260) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function stringifyBriefJson(value: unknown, max = 1_000) {
  try {
    return truncateBriefLine(JSON.stringify(value ?? {}), max);
  } catch {
    return "{}";
  }
}

function buildWorkflowToolContractBrief(contract: Record<string, unknown> | null) {
  if (!contract || Object.keys(contract).length === 0) return null;

  const tools = Array.isArray(contract.tools)
    ? contract.tools.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
  const toolNames = [
    ...asStringArray(contract.toolNames),
    ...tools.map((tool) => asString(tool.name)).filter((value): value is string => value !== null),
  ].filter((value, index, all) => all.indexOf(value) === index);
  if (toolNames.length === 0 && !asString(contract.stepName) && !asString(contract.stepId)) return null;

  const toolLines = tools.length > 0
    ? tools.slice(0, 8).map((tool) => {
        const name = asString(tool.name) ?? "unknown-tool";
        const description = asString(tool.description);
        return `- Tool: ${name}${description ? ` — ${truncateBriefLine(description, 180)}` : ""}`;
      })
    : (toolNames.length > 0 ? [`- Tools: ${toolNames.join(", ")}`] : []);
  const defaultParameters = stringifyBriefJson(contract.toolArgs ?? {});
  const primaryToolName = toolNames[0] ?? "<registered-tool-name>";

  return joinPromptSections([
    "Workflow tool-call contract:",
    asString(contract.stepName) ? `Step: ${asString(contract.stepName)}` : asString(contract.stepId) ? `Step: ${asString(contract.stepId)}` : null,
    toolNames.length > 0 ? `Allowed workflow tools: ${toolNames.join(", ")}` : null,
    ...toolLines,
    `Default parameters: ${defaultParameters}`,
    `Agent HTTP invocation: POST $PAPERCLIP_API_BASE_URL/plugins/tools/execute with Authorization: Bearer $PAPERCLIP_API_KEY and JSON {"tool":"${primaryToolName}","parameters":${defaultParameters},"runContext":{"agentId":"$PAPERCLIP_AGENT_ID","runId":"$PAPERCLIP_RUN_ID","companyId":"$PAPERCLIP_COMPANY_ID"}}.`,
  ], "\n");
}

function buildRecentIssueCommentsBrief(value: unknown) {
  const comments = Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
  const lines = comments
    .slice(0, 5)
    .map((comment) => {
      const body = asString(comment.body ?? comment.content ?? comment.text);
      if (!body) return null;
      const authorType = asString(comment.authorType) ?? (asString(comment.authorUserId) ? "controller" : asString(comment.authorAgentId) ? "agent" : "unknown");
      const commentId = asString(comment.id);
      return `- ${authorType}${commentId ? `/${commentId}` : ""}: ${truncateBriefLine(body)}`;
    })
    .filter((line): line is string => line !== null);
  if (lines.length === 0) return null;

  return joinPromptSections([
    "Recent issue comments:",
    ...lines,
  ], "\n");
}

function buildHermesChatBrief(value: unknown) {
  const chat = asRecord(value);
  if (!chat) return null;

  const currentMessage = asString(chat.currentMessage);
  const sessionId = asString(chat.sessionId);
  const sessionTitle = asString(chat.sessionTitle);
  const recentMessages = Array.isArray(chat.recentMessages)
    ? chat.recentMessages.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];
  const instructions = Array.isArray(chat.instructions)
    ? chat.instructions.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const currentPage = asRecord(chat.currentPage);
  const attachments = Array.isArray(chat.attachments)
    ? chat.attachments.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    : [];

  if (!currentMessage && recentMessages.length === 0) return null;

  const messageLines = recentMessages.slice(-14).map((message) => {
    const role = asString(message.role) ?? "message";
    const body = asString(message.body);
    if (!body) return null;
    return `- ${role}: ${truncateBriefLine(body, 420)}`;
  }).filter((line): line is string => line !== null);
  const currentPageFacts = asRecord(currentPage?.facts);
  const currentPageFactsLine = currentPageFacts && Object.keys(currentPageFacts).length > 0
    ? truncateBriefLine(JSON.stringify(currentPageFacts), 4_000)
    : null;
  const attachmentLines = attachments.slice(0, 6).flatMap((attachment) => {
    const name = asString(attachment.name) ?? "attachment";
    const contentType = asString(attachment.contentType) ?? "application/octet-stream";
    const kind = asString(attachment.kind) ?? (contentType.startsWith("image/") ? "image" : "file");
    const size = typeof attachment.size === "number" ? attachment.size : null;
    const text = asString(attachment.text);
    return [
      `- ${kind}: ${name} (${contentType}${size !== null ? `, ${size} bytes` : ""})`,
      text ? `  Content excerpt: ${truncateBriefLine(text, 1_500)}` : null,
    ].filter((line): line is string => line !== null);
  });

  return joinPromptSections([
    "Hermes web chat:",
    sessionId ? `- Session: ${sessionId}` : null,
    sessionTitle ? `- Title: ${sessionTitle}` : null,
    instructions.length > 0 ? "Instructions:" : null,
    ...instructions.slice(0, 8).map((instruction) => `- ${instruction}`),
    currentPage ? "Current Paperclip page:" : null,
    asString(currentPage?.kind) ? `- Kind: ${asString(currentPage?.kind)}` : null,
    asString(currentPage?.path) ? `- Path: ${asString(currentPage?.path)}` : null,
    asString(currentPage?.title) ? `- Title: ${asString(currentPage?.title)}` : null,
    asString(currentPage?.status) ? `- Status: ${asString(currentPage?.status)}` : null,
    asString(currentPage?.summary) ? `- Summary: ${truncateBriefLine(asString(currentPage?.summary)!, 420)}` : null,
    currentPageFactsLine ? `- Facts: ${currentPageFactsLine}` : null,
    attachmentLines.length > 0 ? "Current operator attachments:" : null,
    ...attachmentLines,
    messageLines.length > 0 ? "Recent conversation:" : null,
    ...messageLines,
    currentMessage ? "Current operator message:" : null,
    currentMessage ? currentMessage : null,
  ], "\n");
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

function buildMissionOwnerPlanningProtocol(missionOwnerPlanningContext: Record<string, unknown> | null) {
  if (missionOwnerPlanningContext?.available !== true) return null;

  const planningDossierAssetCounts = asRecord(missionOwnerPlanningContext.planningDossierAssetCounts);
  const missionId = asString(missionOwnerPlanningContext.missionId) ?? "unknown";
  const planningIssueId = asString(missionOwnerPlanningContext.planningIssueId) ?? "none";
  const activePlanState = missionOwnerPlanningContext.activePlanAvailable === true ? "yes" : "no";
  const assetCountsLine = planningDossierAssetCounts
    ? `- Planning dossier asset-count summary: workflows ${asNumber(planningDossierAssetCounts.workflowCandidates)}, tools ${asNumber(planningDossierAssetCounts.tools)}, runtime service assets ${asNumber(planningDossierAssetCounts.runtimeServices)}, rules ${asNumber(planningDossierAssetCounts.ruleRefs)}, KB ${asNumber(planningDossierAssetCounts.kbRefs)}, agents ${asNumber(planningDossierAssetCounts.agentRoster)}, files ${asNumber(planningDossierAssetCounts.fileViews)}, execution source units ${asNumber(planningDossierAssetCounts.executionSourceUnits)}.`
    : "- Planning dossier asset-count summary: unavailable.";

  return joinPromptSections([
    `Mission owner planning context: mission ${missionId}, planning issue ${planningIssueId}, active plan ${activePlanState}, selected units ${asNumber(missionOwnerPlanningContext.selectedExecutionUnitCount)}, execution source units ${asNumber(missionOwnerPlanningContext.executionSourceUnitCount)}.`,
    "Owner planning protocol:",
    "Produce a Mission Planning Assessment before acting beyond status discovery.",
    "Use dossier asset counts as pointers only. Missing tool/runtime-service assets do not prove that the Paperclip worker runtime is down.",
    assetCountsLine,
    `- Planning dossier gaps: ${asNumber(missionOwnerPlanningContext.planningDossierGapCount)} total, ${asNumber(missionOwnerPlanningContext.planningDossierSevereGapCount)} severe/blocking-or-research gaps.`,
    "Common operating boundary:",
    "Stay within your assigned role, authority, and issue scope. Do not perform work that belongs to another role just because you can reach a tool.",
    "When required work is outside your scope, escalate to the appropriate owner/director/mission controller if one is available, leave a concise status or handoff, and stop this run within your own scope.",
    "If there is no valid escalation path, end blocked/error with the missing path or authority. Do not replace escalation with improvised execution.",
    "Director boundary:",
    "A director or mission owner plans, delegates, reviews, and decides gates; it is not a source-research or report-production worker.",
    "Mission issue grouping is WBS-style: `[PLAN]` issues produce the work structure and then close; `[ACTION]`, `[QA]`, and `[OVERSIGHT]` issues are mission-level siblings by default, not children of the PLAN issue.",
    "When materializing plan output, create `[ACTION] ...`, `[QA] ...`, and `[OVERSIGHT] ...` issues with missionId set and parentId empty. Use parent-child only to decompose a single ACTION into smaller action sub-issues.",
    "After handing off bounded mission-level ACTION/QA work, do not wait by doing the child work yourself. If child runtime health is unclear or unavailable, escalate or block via OVERSIGHT instead of using internal Agent/Task/WebSearch/WebFetch/Bash as a source-research or report-production substitute.",
    "Bash remains for in-scope Paperclip API/status/file inspection only; do not use it to bypass role boundaries.",
    "Dynamic workflow means reducing uncertainty with evidence gates, not adding subagents or parallelism by default.",
    "Paperclip child issues are the delegation mechanism for mission work; internal local-agent delegation is not a replacement for out-of-scope work.",
    "Report slice completion separately from end-to-end completion.",
    "Choose exactly one branch:",
    "1. `research_needed`: name missing evidence and the intended delegation/escalation path.",
    "2. `blocked`: name the missing input, authority, runtime path, or escalation path.",
    "3. `ready_to_plan`: emit the structured JSON block below.",
    "Do not mark the planning issue done until a structured plan decision has been posted and materialized as mission-level sibling issues, or the mission is explicitly completed with evidence and a final completion comment.",
    "Accepted marker and JSON block:",
    "### Mission owner plan decision",
    "```json",
    JSON.stringify(
      {
        decisionType: "mission_owner_plan",
        missionId,
        summary: "...",
        missionInvariant: [],
        scopeHypothesis: "...",
        executionSlice: {
          inScope: [],
          outOfScope: [],
          approvalGates: [],
        },
        evidenceRequired: [],
        gate: {
          validator: "...",
          pass: [],
          requestChanges: [],
          blocked: [],
        },
        promotion: {
          promote: [],
          doNotPromote: [],
        },
        selfImprovementCandidates: [],
        assessment: {
          objectiveRestatement: "...",
          availableAssetsReviewed: [],
          assetEvaluation: [],
          gaps: [],
          researchPerformed: [],
        },
        steps: [],
        requiredInputs: [],
        successCriteria: [],
        risks: [],
        selectedExecutionUnits: [],
        ruleRefs: [],
        kbRefs: [],
      },
      null,
      2,
    ),
    "```",
  ], "\n");
}

export function buildPaperclipRuntimeBrief(context: Record<string, unknown>) {
  const manifest = asRecord(context.paperclipStepInputManifest);
  const handoff = asRecord(context.paperclipSessionHandoff);
  const workflowToolContractLine = buildWorkflowToolContractBrief(asRecord(context.paperclipWorkflowStepToolContract));
  const recentIssueCommentsLine = buildRecentIssueCommentsBrief(context.paperclipIssueRecentComments);
  const hermesChatLine = buildHermesChatBrief(context.paperclipHermesChat);

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
  const maintenanceDecision = asRecord(manifestInputs?.maintenanceDecision);
  const fileViews = asRecord(manifestInputs?.fileViews);
  const missionPlan = asRecord(manifestInputs?.missionPlan);
  const missionWorkingNote = asRecord(manifestInputs?.missionWorkingNote);
  const missionOwnerPlanningContext = asRecord(manifestInputs?.missionOwnerPlanningContext);
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
      ? `- Runtime service assets listed in dossier: ${Number(runtimeServices.count ?? 0)}${asString(runtimeServices.primaryUrl) ? ` (${asString(runtimeServices.primaryUrl)})` : ""}. This is not a Paperclip worker-runtime health signal.`
      : "- No runtime service assets are listed in this dossier. This is not a Paperclip worker-runtime health signal.";

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

  const maintenanceDecisionLine =
    maintenanceDecision?.available === true && asString(maintenanceDecision.recommendedNextAction)
      ? `- Maintenance decision: ${asString(maintenanceDecision.recommendedNextAction)} (suggested status: ${asString(maintenanceDecision.suggestedStatus) ?? "none"})`
      : null;

  const maintenanceDecisionRequiredInputsLine =
    maintenanceDecision?.available === true && Array.isArray(maintenanceDecision.requiredInputs)
      ? `- Required inputs: ${maintenanceDecision.requiredInputs.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(", ") || "none"}`
      : null;

  const maintenanceDecisionWarningsLine =
    maintenanceDecision?.available === true && Array.isArray(maintenanceDecision.warnings)
      ? `- Decision warnings: ${maintenanceDecision.warnings.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(", ") || "none"}`
      : null;

  const maintenanceDecisionHandoffLine =
    maintenanceDecision?.available === true && asString(maintenanceDecision.handoffTarget)
      ? `- Handoff target: ${asString(maintenanceDecision.handoffTarget)}`
      : null;

  const maintenanceRoleContext = asRecord(maintenanceDecision?.roleContext);
  const maintenanceRoles = Array.isArray(maintenanceRoleContext?.roles)
    ? maintenanceRoleContext.roles.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const maintenanceRoleQuestions = Array.isArray(maintenanceRoleContext?.questions)
    ? maintenanceRoleContext.questions.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const maintenanceRoleContextLine =
    maintenanceDecision?.available === true && maintenanceRoles.length > 0
      ? `- Maintenance role context: ${maintenanceRoles
          .map((role) => {
            const metadata = asRecord(role.metadata);
            const aliases = Array.isArray(metadata?.aliases)
              ? metadata.aliases.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
              : [];
            return [
              asString(role.id),
              asString(role.kind) ? `(${asString(role.kind)})` : null,
              aliases.length > 0 ? `[aliases: ${aliases.join(", ")}]` : null,
            ].filter(Boolean).join(" ");
          })
          .filter(Boolean)
          .join(", ")}`
      : null;
  const maintenanceRoleQuestionsLine =
    maintenanceDecision?.available === true && maintenanceRoleQuestions.length > 0
      ? `- Role alignment questions: ${maintenanceRoleQuestions.join(" | ")}`
      : null;

  const missionPlanStepSummary = Array.isArray(missionPlan?.stepSummary)
    ? missionPlan.stepSummary.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const missionPlanOpenInputs = Array.isArray(missionPlan?.openRequiredInputs)
    ? missionPlan.openRequiredInputs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const missionPlanLine =
    missionPlan?.available === true && asString(missionPlan.missionGoal)
      ? `- Mission plan: rev ${Number(missionPlan.revision ?? 0)} ${asString(missionPlan.status) ?? "unknown"} — ${asString(missionPlan.missionGoal)}`
      : null;
  const missionPlanInputsLine =
    missionPlan?.available === true
      ? `- Mission plan inputs: ${Number(missionPlan.requiredInputsCount ?? 0)} required, open: ${missionPlanOpenInputs.join(", ") || "none"}`
      : null;
  const missionPlanStepsLine =
    missionPlan?.available === true
      ? `- Mission plan steps: ${Number(missionPlan.stepCount ?? 0)} total${missionPlanStepSummary.length > 0 ? ` — ${missionPlanStepSummary.join(" | ")}` : ""}`
      : null;
  const missionPlanRuleNames = Array.isArray(missionPlan?.ruleNames)
    ? missionPlan.ruleNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const missionPlanRuleModes = Array.isArray(missionPlan?.ruleModes)
    ? missionPlan.ruleModes.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const selectedUnitSelectionCounts = asRecord(missionPlan?.selectedExecutionUnitSelectionStateCounts);
  const selectedUnitExecutionCounts = asRecord(missionPlan?.selectedExecutionUnitExecutionStateCounts);
  const selectedUnitLabels = Array.isArray(missionPlan?.selectedExecutionUnitLabels)
    ? missionPlan.selectedExecutionUnitLabels.filter((value): value is string => typeof value === "string" && value.trim().length > 0).slice(0, 3)
    : [];
  const missionPlanExecutionUnitsLine =
    missionPlan?.available === true && Number(missionPlan.executionUnitCount ?? 0) > 0
      ? `- Mission execution units: ${Number(missionPlan.executionUnitCount ?? 0)} total, ${Number(missionPlan.blockedOrFailedUnitCount ?? 0)} blocked/failed`
      : null;
  const missionPlanSelectedUnitsLine =
    missionPlan?.available === true && asNumber(missionPlan.selectedExecutionUnitCount) > 0
      ? `- Mission selected units: ${asNumber(missionPlan.selectedExecutionUnitCount)} total — selected ${asNumber(selectedUnitSelectionCounts?.selected)}, candidate ${asNumber(selectedUnitSelectionCounts?.candidate)}, excluded ${asNumber(selectedUnitSelectionCounts?.excluded)}, satisfied ${asNumber(selectedUnitSelectionCounts?.satisfied)}; blocked ${asNumber(selectedUnitExecutionCounts?.blocked)}, failed ${asNumber(selectedUnitExecutionCounts?.failed)}, cancelled ${asNumber(selectedUnitExecutionCounts?.cancelled)}${selectedUnitLabels.length > 0 ? ` — ${selectedUnitLabels.join(" | ")}` : ""}`
      : null;
  const missionPlanRulesLine =
    missionPlan?.available === true && Number(missionPlan.ruleRefCount ?? 0) > 0
      ? `- Mission rules: ${Number(missionPlan.ruleRefCount ?? 0)} refs${missionPlanRuleNames.length > 0 ? ` — ${missionPlanRuleNames.join(", ")}` : ""}${missionPlanRuleModes.length > 0 ? ` (${missionPlanRuleModes.join(", ")})` : ""}`
      : null;
  const missionWorkingNotePath = asString(missionWorkingNote?.path);
  const missionWorkingNoteLine =
    missionWorkingNote?.available === true && missionWorkingNotePath
      ? `- Mission working note: ${missionWorkingNotePath} (shared scratch context; read before acting, update mission status/evidence/decisions/next steps, not a final workProduct).`
      : null;
  const missionOwnerPlanningContextLine = buildMissionOwnerPlanningProtocol(missionOwnerPlanningContext);

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
    maintenanceDecisionLine,
    maintenanceDecisionRequiredInputsLine,
    maintenanceDecisionWarningsLine,
    maintenanceDecisionHandoffLine,
    maintenanceRoleContextLine,
    maintenanceRoleQuestionsLine,
    missionPlanLine,
    missionPlanInputsLine,
    missionPlanStepsLine,
    missionPlanExecutionUnitsLine,
    missionPlanSelectedUnitsLine,
    missionPlanRulesLine,
    missionWorkingNoteLine,
    missionOwnerPlanningContextLine,
    workflowToolContractLine,
    recentIssueCommentsLine,
    hermesChatLine,
    fileViewsLine,
    guardrailLine,
    handoffSummary,
  ], "\n");

  return brief;
}
