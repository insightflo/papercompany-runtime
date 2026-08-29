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
  /** [판정 실체화] 후보 해시에 묶인 판정 — 해당 해시의 후보에만 적용된다.
   *  없으면 gateOwner 전역 판정(보드 인라인 호환). */
  candidateHash?: string;
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
  /** [Phase 2] evidenceSource가 참조하는 지식 위키 패턴 카드 id — impact 원장의 adoptedFrom 원천. */
  evidencePatternIds: string[];
};

export type SelfImprovementAdoptionPlannerDiagnostic = {
  code:
    | "candidate_not_accepted"
    | "gate_not_passed"
    | "unresolved_asset"
    | "multi_asset_patch"
    | "invalid_candidate_contract"
    | "tool_gap_not_auto_adoptable"
    | "unresolved_evidence_pattern";
  message: string;
};

export type BuildSelfImprovementAdoptionPlanInput = {
  candidates: SelfImprovementCandidate[];
  assetRegistry: AdoptionAssetRegistryEntry[];
  gateVerdicts: AdoptionGateVerdict[];
  /** candidates와 평행한 후보 해시 배열(선택) — 해시 스코프 판정 매칭에 쓰인다. */
  candidateHashes?: (string | null)[];
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

function hasCurrentPass(gateVerdicts: AdoptionGateVerdict[], gateOwner: string, candidateHash: string | null) {
  return gateVerdicts.some((gateVerdict) => {
    if (gateVerdict.gateOwner !== gateOwner || gateVerdict.verdict !== "PASS") return false;
    // 해시 스코프 판정은 해시가 알려져 있고 일치할 때만 적용(실패 닫힘).
    if (typeof gateVerdict.candidateHash === "string") {
      return candidateHash !== null && gateVerdict.candidateHash === candidateHash;
    }
    return true;
  });
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

// [Phase 2 지식 위키 연결] evidenceSource에서 패턴 카드 참조를 뽑는다.
//   허용 형태: 문자열 "knowledge_pattern:<id>" 또는 객체 {type: "knowledge_pattern", id}.
//   참조가 있으면 반드시 레지스트리에서 정확히 1건으로 해석되어야 한다(fail-closed).
function extractEvidencePatternIds(evidenceSource: unknown[]): { patternIds: string[]; malformedEntry: boolean } {
  const patternIds = new Set<string>();
  let malformedEntry = false;
  for (const entry of evidenceSource) {
    if (typeof entry === "string") {
      const match = /^knowledge_pattern:(\S+)$/.exec(entry.trim());
      if (match) patternIds.add(match[1]!);
      continue;
    }
    if (isRecord(entry) && entry.type === "knowledge_pattern") {
      if (isNonEmptyString(entry.id)) patternIds.add(entry.id.trim());
      else malformedEntry = true;
    }
  }
  return { patternIds: Array.from(patternIds), malformedEntry };
}

export function buildSelfImprovementAdoptionPlan({
  candidates,
  assetRegistry,
  gateVerdicts,
  candidateHashes,
}: BuildSelfImprovementAdoptionPlanInput): BuildSelfImprovementAdoptionPlanResult {
  const plan: SelfImprovementAdoptionPlanEntry[] = [];
  const diagnostics: SelfImprovementAdoptionPlannerDiagnostic[] = [];

  for (const [candidateIndex, candidate] of candidates.entries()) {
    const prefix = `selfImprovementCandidates[${candidateIndex}]`;
    const candidateHash = candidateHashes?.[candidateIndex] ?? null;
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

    // [tool-gap] 신규 도구 제안은 유계 자동 채택 범위 밖 — accepted 로 표기돼도(계약 위반 방어)
    //   드라이런 계획에 절대 올리지 않고 명시 진단으로 제외한다(무음 생략 금지).
    if (assetType === "tool") {
      diagnostics.push({
        code: "tool_gap_not_auto_adoptable",
        message: `${prefix} is a tool-gap proposal; new tool creation requires owner/gate review and is never auto-adopted`,
      });
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

    if (!hasCurrentPass(gateVerdicts, gateOwner, candidateHash)) {
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

    // [Phase 2] 패턴 카드 참조 검증 — 지식 위키에서 온 제안은 카드 id가 회사 레지스트리에서
    //   정확히 1건으로 해석되어야 채택 계획에 오른다. 형식 하자는 계약 위반, 미해석은 fail-closed.
    const { patternIds: evidencePatternIds, malformedEntry } = extractEvidencePatternIds(evidenceSource);
    if (malformedEntry) {
      diagnostics.push({
        code: "invalid_candidate_contract",
        message: `${prefix}.evidenceSource knowledge_pattern entries require a non-empty id`,
      });
    }
    for (const patternId of evidencePatternIds) {
      const patternAsset = resolveAsset(assetRegistry, "knowledge_pattern", patternId);
      if (patternAsset === null) {
        diagnostics.push({
          code: "unresolved_evidence_pattern",
          message: `${prefix} references knowledge_pattern ${patternId} which does not resolve to exactly one registry entry`,
        });
      }
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
      evidencePatternIds,
    });
  }

  return { plan, diagnostics };
}
