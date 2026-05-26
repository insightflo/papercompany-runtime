import { parseObject } from "../adapters/utils.js";

export interface StepInputManifest {
  version: 1;
  taskKey: string | null;
  issueId: string | null;
  projectId: string | null;
  allowedContextKeys: string[];
  guardrails: {
    broadScanAllowed: boolean;
  };
  inputs: {
    workspace: {
      available: boolean;
      source: string | null;
      workspaceId: string | null;
      projectId: string | null;
    };
    workspaceHints: {
      available: boolean;
      count: number;
    };
    runtimeServiceIntents: {
      available: boolean;
      count: number;
    };
    runtimeServices: {
      available: boolean;
      count: number;
      primaryUrl: string | null;
    };
    tools: {
      available: boolean;
      count: number;
      names: string[];
    };
    knowledge: {
      available: boolean;
      count: number;
      names: string[];
    };
    maintenanceGuidance: {
      available: boolean;
      ruleCount: number;
      knowledgeCount: number;
      ruleNames: string[];
      knowledgeNames: string[];
      ruleExcerpts: string[];
      knowledgeExcerpts: string[];
    };
    maintenanceDecision: {
      available: boolean;
      recommendedNextAction: string | null;
      suggestedStatus: string | null;
      requiredInputs: string[];
      warnings: string[];
      handoffTarget: string | null;
      roleContext: Record<string, unknown> | null;
    };
    missionPlan: {
      available: boolean;
      missionPlanId: string | null;
      revision: number | null;
      status: string | null;
      missionGoal: string | null;
      requiredInputsCount: number;
      openRequiredInputs: string[];
      successCriteriaCount: number;
      riskCount: number;
      stepCount: number;
      stepSummary: string[];
      executionUnitCount: number;
      blockedOrFailedUnitCount: number;
      selectedExecutionUnitCount: number;
      selectedExecutionUnitSelectionStateCounts: {
        selected: number;
        excluded: number;
        satisfied: number;
        candidate: number;
      };
      selectedExecutionUnitExecutionStateCounts: {
        blocked: number;
        failed: number;
        cancelled: number;
      };
      selectedExecutionUnitLabels: string[];
      ruleRefCount: number;
      ruleNames: string[];
      ruleModes: string[];
      refs: Record<string, unknown> | null;
    };
    missionOwnerPlanningContext: {
      available: boolean;
      planningIssueId: string | null;
      missionId: string | null;
      activePlanAvailable: boolean;
      selectedExecutionUnitCount: number;
      executionSourceUnitCount: number;
    };
    fileViews: {
      available: boolean;
      count: number;
      source: string | null;
    };
    sessionHandoff: {
      available: boolean;
      previousSessionId: string | null;
      rotationReason: string | null;
    };
  };
}

export function buildStepInputManifest(input: {
  taskKey: string | null;
  context: Record<string, unknown>;
}): StepInputManifest {
  const { context, taskKey } = input;
  const workspace = parseObject(context.paperclipWorkspace);
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const toolContract = parseObject(context.paperclipWorkflowStepToolContract);
  const toolEntries = Array.isArray(toolContract.tools)
    ? toolContract.tools.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const knowledgeContract = parseObject(context.paperclipWorkflowStepKnowledgeContext);
  const knowledgeEntries = Array.isArray(knowledgeContract.entries)
    ? knowledgeContract.entries.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const maintenanceGuidance = parseObject(context.paperclipMaintenanceGuidance);
  const maintenanceRules = Array.isArray(maintenanceGuidance.rules)
    ? maintenanceGuidance.rules.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const maintenanceKnowledge = Array.isArray(maintenanceGuidance.knowledge)
    ? maintenanceGuidance.knowledge.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const maintenanceDecision = parseObject(context.paperclipMaintenanceDecision);
  const missionPlan = parseObject(context.paperclipMissionPlan);
  const missionOwnerPlanningContext = parseObject(context.paperclipMissionOwnerPlanningContext);
  const missionOwnerPlanningMission = parseObject(missionOwnerPlanningContext.mission);
  const missionOwnerPlanningActivePlan = parseObject(missionOwnerPlanningContext.activePlan);
  const missionOwnerPlanningExecutionSourceSnapshot = parseObject(missionOwnerPlanningContext.executionSourceSnapshot);
  const missionOwnerPlanningExecutionUnits = Array.isArray(missionOwnerPlanningExecutionSourceSnapshot.units)
    ? missionOwnerPlanningExecutionSourceSnapshot.units.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const maintenanceRequiredInputs = Array.isArray(maintenanceDecision.requiredInputs)
    ? maintenanceDecision.requiredInputs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const maintenanceWarnings = Array.isArray(maintenanceDecision.warnings)
    ? maintenanceDecision.warnings.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const missionPlanOpenRequiredInputs = Array.isArray(missionPlan.openRequiredInputs)
    ? missionPlan.openRequiredInputs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const missionPlanStepSummary = Array.isArray(missionPlan.stepSummary)
    ? missionPlan.stepSummary.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const fileViews = Array.isArray(context.paperclipFileViews)
    ? context.paperclipFileViews.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const allowedContextKeys = Object.keys(context)
    .filter((key) => key !== "paperclipStepInputManifest")
    .sort();

  const workspaceSource = readString(workspace.source) || null;
  const workspaceId = readString(workspace.workspaceId) || null;
  const workspaceProjectId = readString(workspace.projectId) || null;
  const hasProjectPrimaryWorkspace = workspaceSource === "project_primary" && workspaceId !== null;

  return {
    version: 1,
    taskKey,
    issueId: readString(context.issueId) || null,
    projectId: readString(context.projectId) || null,
    allowedContextKeys,
    guardrails: {
      broadScanAllowed: hasProjectPrimaryWorkspace,
    },
    inputs: {
      workspace: {
        available: Object.keys(workspace).length > 0,
        source: workspaceSource,
        workspaceId,
        projectId: workspaceProjectId,
      },
      workspaceHints: {
        available: workspaceHints.length > 0,
        count: workspaceHints.length,
      },
      runtimeServiceIntents: {
        available: runtimeServiceIntents.length > 0,
        count: runtimeServiceIntents.length,
      },
      runtimeServices: {
        available: runtimeServices.length > 0,
        count: runtimeServices.length,
        primaryUrl: readString(context.paperclipRuntimePrimaryUrl) || null,
      },
      tools: {
        available: toolEntries.length > 0,
        count: toolEntries.length,
        names: toolEntries
          .map((entry) => readString(entry.name))
          .filter((value): value is string => value.length > 0),
      },
      knowledge: {
        available: knowledgeEntries.length > 0,
        count: knowledgeEntries.length,
        names: knowledgeEntries
          .map((entry) => readString(entry.name))
          .filter((value): value is string => value.length > 0),
      },
      maintenanceGuidance: {
        available: maintenanceRules.length > 0 || maintenanceKnowledge.length > 0,
        ruleCount: maintenanceRules.length,
        knowledgeCount: maintenanceKnowledge.length,
        ruleNames: maintenanceRules
          .map((entry) => readString(entry.name))
          .filter((value): value is string => value.length > 0),
        knowledgeNames: maintenanceKnowledge
          .map((entry) => readString(entry.name))
          .filter((value): value is string => value.length > 0),
        ruleExcerpts: maintenanceRules
          .map((entry) => readString(entry.excerpt) || readString(entry.message))
          .filter((value): value is string => value.length > 0)
          .map(truncateBriefExcerpt),
        knowledgeExcerpts: maintenanceKnowledge
          .map((entry) => readString(entry.content))
          .filter((value): value is string => value.length > 0)
          .map(truncateBriefExcerpt),
      },
      maintenanceDecision: {
        available: Object.keys(maintenanceDecision).length > 0,
        recommendedNextAction: readString(maintenanceDecision.recommendedNextAction) || null,
        suggestedStatus: readString(maintenanceDecision.suggestedStatus) || null,
        requiredInputs: maintenanceRequiredInputs,
        warnings: maintenanceWarnings,
        handoffTarget: readString(maintenanceDecision.handoffTarget) || null,
        roleContext: parseObject(maintenanceDecision.roleContext),
      },
      missionPlan: {
        available: missionPlan.available === true,
        missionPlanId: readString(missionPlan.missionPlanId) || null,
        revision: readNumber(missionPlan.revision),
        status: readString(missionPlan.status) || null,
        missionGoal: readString(missionPlan.missionGoal) || null,
        requiredInputsCount: readNumber(missionPlan.requiredInputsCount) ?? 0,
        openRequiredInputs: missionPlanOpenRequiredInputs,
        successCriteriaCount: readNumber(missionPlan.successCriteriaCount) ?? 0,
        riskCount: readNumber(missionPlan.riskCount) ?? 0,
        stepCount: readNumber(missionPlan.stepCount) ?? 0,
        stepSummary: missionPlanStepSummary,
        executionUnitCount: readNumber(missionPlan.executionUnitCount) ?? 0,
        blockedOrFailedUnitCount: readNumber(missionPlan.blockedOrFailedUnitCount) ?? 0,
        selectedExecutionUnitCount: readNumber(missionPlan.selectedExecutionUnitCount) ?? 0,
        selectedExecutionUnitSelectionStateCounts: {
          selected: readNumber(parseObject(missionPlan.selectedExecutionUnitSelectionStateCounts).selected) ?? 0,
          excluded: readNumber(parseObject(missionPlan.selectedExecutionUnitSelectionStateCounts).excluded) ?? 0,
          satisfied: readNumber(parseObject(missionPlan.selectedExecutionUnitSelectionStateCounts).satisfied) ?? 0,
          candidate: readNumber(parseObject(missionPlan.selectedExecutionUnitSelectionStateCounts).candidate) ?? 0,
        },
        selectedExecutionUnitExecutionStateCounts: {
          blocked: readNumber(parseObject(missionPlan.selectedExecutionUnitExecutionStateCounts).blocked) ?? 0,
          failed: readNumber(parseObject(missionPlan.selectedExecutionUnitExecutionStateCounts).failed) ?? 0,
          cancelled: readNumber(parseObject(missionPlan.selectedExecutionUnitExecutionStateCounts).cancelled) ?? 0,
        },
        selectedExecutionUnitLabels: readStringArray(missionPlan.selectedExecutionUnitLabels),
        ruleRefCount: readNumber(missionPlan.ruleRefCount) ?? 0,
        ruleNames: readStringArray(missionPlan.ruleNames),
        ruleModes: readStringArray(missionPlan.ruleModes),
        refs: parseObject(missionPlan.refs),
      },
      missionOwnerPlanningContext: {
        available: Object.keys(missionOwnerPlanningContext).length > 0,
        planningIssueId: readString(missionOwnerPlanningContext.planningIssueId) || null,
        missionId: readString(missionOwnerPlanningMission.id) || readString(missionOwnerPlanningContext.missionId) || null,
        activePlanAvailable: missionOwnerPlanningActivePlan.available === true,
        selectedExecutionUnitCount: readNumber(missionOwnerPlanningActivePlan.selectedExecutionUnitCount) ?? 0,
        executionSourceUnitCount: missionOwnerPlanningExecutionUnits.length,
      },
      fileViews: {
        available: fileViews.length > 0,
        count: fileViews.length,
        source: readString(fileViews[0]?.source) || null,
      },
      sessionHandoff: {
        available: readString(context.paperclipSessionHandoffMarkdown).length > 0,
        previousSessionId: readString(context.paperclipPreviousSessionId) || null,
        rotationReason: readString(context.paperclipSessionRotationReason) || null,
      },
    },
  };
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function truncateBriefExcerpt(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}
