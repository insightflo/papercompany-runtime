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
  const planningDossierState = missionOwnerPlanningContext.planningDossierAvailable === true ? "available" : "unavailable";
  const assetCountsLine = planningDossierAssetCounts
    ? `- Planning dossier asset-count summary: workflows ${asNumber(planningDossierAssetCounts.workflowCandidates)}, tools ${asNumber(planningDossierAssetCounts.tools)}, runtime services ${asNumber(planningDossierAssetCounts.runtimeServices)}, rules ${asNumber(planningDossierAssetCounts.ruleRefs)}, KB ${asNumber(planningDossierAssetCounts.kbRefs)}, agents ${asNumber(planningDossierAssetCounts.agentRoster)}, files ${asNumber(planningDossierAssetCounts.fileViews)}, execution source units ${asNumber(planningDossierAssetCounts.executionSourceUnits)}.`
    : "- Planning dossier asset-count summary: unavailable.";

  return joinPromptSections([
    `Mission owner planning context: mission ${missionId}, planning issue ${planningIssueId}, active plan ${activePlanState}, selected units ${asNumber(missionOwnerPlanningContext.selectedExecutionUnitCount)}, execution source units ${asNumber(missionOwnerPlanningContext.executionSourceUnitCount)}.`,
    "Owner planning protocol:",
    "Before executing, produce a Mission Planning Assessment.",
    "You must inspect: objective; available workflows, tools, runtime services, rules, KB, agents, and files; active plan and prior execution refs; gaps and todo markers.",
    `Planning dossier summary is ${planningDossierState}. Asset counts and severe gap count are summaries only; tools/runtimeServices/fileViews may be bounded unavailable summaries, not actual discovery.`,
    assetCountsLine,
    `- Planning dossier gaps: ${asNumber(missionOwnerPlanningContext.planningDossierGapCount)} total, ${asNumber(missionOwnerPlanningContext.planningDossierSevereGapCount)} severe/blocking-or-research gaps.`,
    "Dynamic mission planning protocol:",
    "Dynamic workflow means reducing uncertainty with evidence gates, not adding subagents or parallelism by default.",
    "Mission Invariant: name the product, safety, and operating principles that must remain true across the mission.",
    "Scope Hypothesis: state what this execution slice proves, disproves, or unblocks.",
    "Execution Slice: list in-scope and out-of-scope work, including side-effect, push, deploy, and external publish approval boundaries.",
    "Evidence Required: list concrete evidence needed before PASS; ACKs and self-reported completion are not evidence.",
    "Gate: define PASS / REQUEST_CHANGES / BLOCKED criteria and the validator or gate owner.",
    "Promotion / Asset Update: promote repeatable judgments into workflow/tool/rule/KB/role harness/skill assets only. Do not promote stale session outcomes, PR numbers, issue IDs, commit hashes, or one-off logs.",
    "SkillOpt-lite self-improvement: when evidence shows a repeatable failure or success pattern, propose a bounded add/delete/replace candidate for one asset with evidence source, validation plan, rejected-edit note, and agent/peer gate owner; bounded internal asset adoption is automatic after evidence, bounded patch, and validation gate pass; do not wait for user approval, and do not silently mutate skills/rules/KB/workflows/role harnesses outside the current issue scope.",
    "Self-improvement candidate contract: assetType must be skill/rule/kb/workflow/role_harness; proposedEdit.operation must be add/delete/replace; autoAdoptionResult must be accepted/rejected/queued_for_validation/repair_needed; required fields are assetType, assetRef, evidenceSource, pattern, proposedEdit, validationPlan, gateOwner, and autoAdoptionResult.",
    "Report slice completion separately from end-to-end completion.",
    "Choose exactly one branch:",
    "1. `research_needed`: list missing evidence and create/request research/delegation steps.",
    "2. `blocked`: list required user input/approval.",
    "3. `ready_to_plan`: emit the structured JSON block below.",
    "Fail-open policy: do not mark the planning issue done until a structured plan decision has been posted and materialized, or the mission is explicitly completed with evidence and a final completion comment. This brief does not impose a hard completion block.",
    "If you must execute directly in this run, still post the structured plan decision first unless the mission is trivial and explicitly marked `direct_execution_with_plan_comment`; prefer the structured artifact.",
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
    missionOwnerPlanningContextLine,
    fileViewsLine,
    guardrailLine,
    handoffSummary,
  ], "\n");

  return brief;
}
