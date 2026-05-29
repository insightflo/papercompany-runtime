export type SelfImprovementCandidate = {
  assetType: unknown;
  assetRef: unknown;
  evidenceSource: unknown;
  pattern: unknown;
  proposedEdit: unknown;
  validationPlan: unknown;
  gateOwner: unknown;
  autoAdoptionResult: unknown;
};

export type AdoptionAssetRegistryEntry = {
  assetType: string;
  assetRef: string;
  resolvedRef: string;
};

export type AdoptionGateVerdict = {
  gateOwner: string;
  verdict: string;
};

export type SelfImprovementAdoptionPlanEntry = {
  candidateIndex: number;
  asset: AdoptionAssetRegistryEntry;
  proposedEdit: {
    operation: string;
    section: string;
    content?: unknown;
  };
  validationPlan: string;
  gateOwner: string;
  evidenceSource: unknown[];
  pattern: string;
};

export type SelfImprovementAdoptionPlannerDiagnostic = {
  code: "candidate_not_accepted" | "gate_not_passed" | "unresolved_asset" | "multi_asset_patch" | "invalid_candidate_contract";
  message: string;
};

export type BuildSelfImprovementAdoptionPlanInput = {
  candidates: SelfImprovementCandidate[];
  assetRegistry: AdoptionAssetRegistryEntry[];
  gateVerdicts: AdoptionGateVerdict[];
};

export type BuildSelfImprovementAdoptionPlanResult = {
  plan: SelfImprovementAdoptionPlanEntry[];
  diagnostics: SelfImprovementAdoptionPlannerDiagnostic[];
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCurrentPass(gateVerdicts: AdoptionGateVerdict[], gateOwner: string) {
  return gateVerdicts.some((gateVerdict) => gateVerdict.gateOwner === gateOwner && gateVerdict.verdict === "PASS");
}

function resolveAsset(assetRegistry: AdoptionAssetRegistryEntry[], assetType: string, assetRef: string) {
  const matches = assetRegistry.filter((entry) => entry.assetType === assetType && entry.assetRef === assetRef);
  return matches.length === 1 ? matches[0] : null;
}

function proposedEditTargetsMultipleAssets(proposedEdit: Record<string, unknown>, topLevelAssetRef: string) {
  if (Array.isArray(proposedEdit.assetRefs) && proposedEdit.assetRefs.length > 0) {
    return proposedEdit.assetRefs.length !== 1 || proposedEdit.assetRefs[0] !== topLevelAssetRef;
  }
  if (isNonEmptyString(proposedEdit.assetRef)) {
    return proposedEdit.assetRef !== topLevelAssetRef;
  }
  return false;
}

export function buildSelfImprovementAdoptionPlan({
  candidates,
  assetRegistry,
  gateVerdicts,
}: BuildSelfImprovementAdoptionPlanInput): BuildSelfImprovementAdoptionPlanResult {
  const plan: SelfImprovementAdoptionPlanEntry[] = [];
  const diagnostics: SelfImprovementAdoptionPlannerDiagnostic[] = [];

  for (const [candidateIndex, candidate] of candidates.entries()) {
    const prefix = `selfImprovementCandidates[${candidateIndex}]`;
    const assetType = isNonEmptyString(candidate.assetType) ? candidate.assetType : null;
    const assetRef = isNonEmptyString(candidate.assetRef) ? candidate.assetRef : null;
    const proposedEdit = isRecord(candidate.proposedEdit) ? candidate.proposedEdit : null;
    const gateOwner = isNonEmptyString(candidate.gateOwner) ? candidate.gateOwner : null;
    const validationPlan = isNonEmptyString(candidate.validationPlan) ? candidate.validationPlan : null;
    const pattern = isNonEmptyString(candidate.pattern) ? candidate.pattern : null;
    const evidenceSource = Array.isArray(candidate.evidenceSource) ? candidate.evidenceSource : null;

    if (!assetType || !assetRef || !proposedEdit || !gateOwner || !validationPlan || !pattern || !evidenceSource) {
      diagnostics.push({ code: "invalid_candidate_contract", message: `${prefix} is missing required adoption planner fields` });
      continue;
    }

    if (candidate.autoAdoptionResult !== "accepted") {
      diagnostics.push({
        code: "candidate_not_accepted",
        message: `${prefix} is ${String(candidate.autoAdoptionResult)} and is not selectable for dry-run adoption`,
      });
      continue;
    }

    const operation = proposedEdit.operation;
    const section = proposedEdit.section;
    if (!isNonEmptyString(operation) || !isNonEmptyString(section)) {
      diagnostics.push({ code: "invalid_candidate_contract", message: `${prefix}.proposedEdit must include operation and section` });
      continue;
    }

    const candidateDiagnosticsStart = diagnostics.length;

    if (!hasCurrentPass(gateVerdicts, gateOwner)) {
      diagnostics.push({
        code: "gate_not_passed",
        message: `${prefix} gateOwner ${gateOwner} does not have a current PASS verdict`,
      });
    }

    const asset = resolveAsset(assetRegistry, assetType, assetRef);
    if (asset === null) {
      diagnostics.push({
        code: "unresolved_asset",
        message: `${prefix} could not resolve exactly one internal asset for ${assetType}:${assetRef}`,
      });
    }

    if (proposedEditTargetsMultipleAssets(proposedEdit, assetRef)) {
      diagnostics.push({
        code: "multi_asset_patch",
        message: `${prefix} proposedEdit must target exactly one asset through top-level assetType + assetRef`,
      });
    }

    if (diagnostics.length !== candidateDiagnosticsStart || asset === null) {
      continue;
    }

    plan.push({
      candidateIndex,
      asset,
      proposedEdit: {
        operation,
        section,
        ...(Object.prototype.hasOwnProperty.call(proposedEdit, "content") ? { content: proposedEdit.content } : {}),
      },
      validationPlan,
      gateOwner,
      evidenceSource,
      pattern,
    });
  }

  return { plan, diagnostics };
}
