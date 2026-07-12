export interface StepInputManifest {
  version: 1;
  taskKey: string | null;
  issueId: string | null;
  projectId: string | null;
  allowedContextKeys: string[];
  guardrails: {
    broadScanAllowed: boolean;
    allowedSearchScopes: string[];
  };
  inputs: {
    missionSearch: {
      available: boolean;
      allowedScopes: string[];
      guidance: string[];
    };
    qualityAssurance: {
      available: boolean;
      type: string | null;
      inputScope: string | null;
    };
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
    missionWorkingNote: {
      available: boolean;
      missionId: string | null;
      path: string | null;
      fileName: string | null;
      role: string | null;
      instructions: string[];
    };
    missionOwnerPlanningContext: {
      available: boolean;
      planningIssueId: string | null;
      missionId: string | null;
      activePlanAvailable: boolean;
      selectedExecutionUnitCount: number;
      executionSourceUnitCount: number;
      planningDossierAvailable: boolean;
      planningDossierAssetCounts: {
        workflowCandidates: number;
        tools: number;
        runtimeServices: number;
        ruleRefs: number;
        kbRefs: number;
        agentRoster: number;
        fileViews: number;
        executionSourceUnits: number;
      };
      planningDossierGapCount: number;
      planningDossierSevereGapCount: number;
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
