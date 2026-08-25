type PlanUnit = Record<string, unknown>;
type DraftStep = string | Record<string, unknown>;
export type MissionPlanDependencyDiagnostic = {
  code:
    | "missing_unit_id" | "duplicate_unit_id" | "invalid_dependency_shape"
    | "ambiguous_dependency_ref" | "unresolved_dependency_ref"
    | "ambiguous_dependency_target_ref" | "unresolved_dependency_target_ref"
    | "self_dependency" | "dependency_cycle" | "materialized_dependency_on_filtered_unit";
  message: string;
};

export type CanonicalMissionPlanDependencyGraph = {
  units: PlanUnit[];
  draftSteps: DraftStep[];
  dependencyIndex: number[][];
  materializedUnits: PlanUnit[];
  materializedDependencyIndex: number[][];
};

export type NormalizeMissionPlanDependencyGraphResult = { ok: true; graph: CanonicalMissionPlanDependencyGraph }
  | { ok: false; diagnostics: MissionPlanDependencyDiagnostic[] };

const CROSS_COMPANY_SOURCE_TYPES = new Set([
  "cross_company_mission", "cross_company_mission_request", "company_mission", "external_company_mission",
]);
const UNIT_ALIAS_KEYS = ["id", "unitId", "stepId", "executionUnitId", "selectedExecutionUnitId"] as const;
const SOURCE_ALIAS_KEYS = ["id", "issueId", "stepId", "unitId", "executionUnitId", "selectedExecutionUnitId"] as const;

// Metadata/delegation units may depend on executable work, but not the reverse.
export const FILTERED_UNIT_DEPENDENCY_POLICY = "reject-materialized-to-filtered-allow-reverse" as const;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(readString).filter((value): value is string => value !== null);
}

function isObject(value: unknown): value is PlanUnit {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function readAliases(unit: PlanUnit): string[] {
  const aliases = UNIT_ALIAS_KEYS.map((key) => readString(unit[key]));
  const sourceRef = isObject(unit.sourceRef) ? unit.sourceRef : null;
  if (sourceRef) aliases.push(...SOURCE_ALIAS_KEYS.map((key) => readString(sourceRef[key])));
  return unique(aliases.filter((alias): alias is string => alias !== null));
}

function readDependencies(value: PlanUnit, label: string, diagnostics: MissionPlanDependencyDiagnostic[]): string[] {
  const dependencies: string[] = [];
  for (const key of ["dependencies", "dependsOn", "after"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const raw = value[key];
    if (!Array.isArray(raw) || raw.some((entry) => readString(entry) === null)) {
      diagnostics.push({
        code: "invalid_dependency_shape",
        message: `${label}.${key} must be an array of non-empty strings.`,
      });
      continue;
    }
    dependencies.push(...raw.map((entry) => readString(entry)!));
  }
  return unique(dependencies);
}

function hasDependencyDeclaration(value: PlanUnit): boolean {
  return ["dependencies", "dependsOn", "after"].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function readDraftTargets(step: PlanUnit, index: number, diagnostics: MissionPlanDependencyDiagnostic[]): string[] {
  if (Object.prototype.hasOwnProperty.call(step, "units")) {
    if (!Array.isArray(step.units) || step.units.some((entry) => readString(entry) === null)) {
      diagnostics.push({
        code: "invalid_dependency_shape",
        message: `draft.steps[${index}].units must be an array of non-empty strings.`,
      });
      return [];
    }
    const units = readStringArray(step.units);
    if (units.length > 0) return unique(units);
  }
  const targets: string[] = [];
  for (const key of ["unitId", "executionUnitId", "selectedExecutionUnitId", "id"] as const) {
    if (!Object.prototype.hasOwnProperty.call(step, key)) continue;
    const target = readString(step[key]);
    if (!target) {
      diagnostics.push({
        code: "invalid_dependency_shape",
        message: `draft.steps[${index}].${key} must be a non-empty string.`,
      });
      continue;
    }
    targets.push(target);
  }
  return unique(targets);
}

function isStructural(unit: PlanUnit): boolean {
  return readString(unit.type)?.toLowerCase() === "tool" && readString(unit.qaType)?.toLowerCase() === "structural";
}

function isCrossCompany(unit: PlanUnit): boolean {
  const sourceRef = isObject(unit.sourceRef) ? unit.sourceRef : null;
  const sourceType = readString(sourceRef?.type)?.toLowerCase() ?? "";
  const kind = readString(unit.kind)?.toLowerCase() ?? "";
  return CROSS_COMPANY_SOURCE_TYPES.has(sourceType) || CROSS_COMPANY_SOURCE_TYPES.has(kind);
}

function isOversight(unit: PlanUnit): boolean {
  if (isStructural(unit)) return false;
  const title = readString(unit.title) ?? readString(unit.name) ?? readString(unit.id) ?? "";
  const prefix = /^\s*\[(action|qa|oversight)\]/iu.exec(title);
  if (prefix) return prefix[1]!.toLowerCase() === "oversight";
  return /\b(?:oversight|supervision|unblock|escalation)\b/u.test(readString(unit.kind)?.toLowerCase() ?? "");
}

/** Cross-company and non-structural oversight units are metadata/delegation units, not local workflow steps. */
export function isMissionPlanUnitMaterialized(unit: PlanUnit): boolean {
  return !isCrossCompany(unit) && !isOversight(unit);
}

function canonicalIndex(units: readonly PlanUnit[]): number[][] {
  const byId = new Map(units.map((unit, index) => [readString(unit.id)!, index]));
  return units.map((unit) => readStringArray(unit.dependencies).map((id) => byId.get(id)!).filter((index) => index !== undefined));
}

/** Remaps the canonical adjacency to generated workflow step ids without alias lookup. */
export function remapCanonicalDependenciesToStepIds(
  units: readonly PlanUnit[],
  stepIds: readonly string[],
): string[][] {
  if (units.length !== stepIds.length) throw new Error("Canonical units and workflow steps must have equal length.");
  const stepIdByUnitId = new Map(units.map((unit, index) => [readString(unit.id)!, stepIds[index]!]));
  return units.map((unit) => readStringArray(unit.dependencies).map((dependencyId) => {
    const stepId = stepIdByUnitId.get(dependencyId);
    if (!stepId) throw new Error(`Canonical dependency ${dependencyId} has no materialized workflow step.`);
    return stepId;
  }));
}

export function normalizeMissionPlanDependencyGraph(
  selectedExecutionUnits: readonly PlanUnit[],
  draftSteps: readonly DraftStep[] = [],
): NormalizeMissionPlanDependencyGraphResult {
  const diagnostics: MissionPlanDependencyDiagnostic[] = [];
  const ids = selectedExecutionUnits.map((unit, index) => {
    const id = readString(unit.id);
    if (!id) diagnostics.push({ code: "missing_unit_id", message: `selectedExecutionUnits[${index}] is missing mandatory unit.id.` });
    return id;
  });
  const idCounts = new Map<string, number>();
  for (const id of ids) if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  for (const [id, count] of idCounts) {
    if (count > 1) diagnostics.push({ code: "duplicate_unit_id", message: `Duplicate plan unit id "${id}" is declared by ${count} units.` });
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const canonicalIndexById = new Map(ids.map((id, index) => [id!, index]));
  const ownersByAlias = new Map<string, Set<number>>();
  selectedExecutionUnits.forEach((unit, index) => {
    for (const alias of readAliases(unit)) {
      const owners = ownersByAlias.get(alias) ?? new Set<number>();
      owners.add(index);
      ownersByAlias.set(alias, owners);
    }
  });
  const resolve = (ref: string, target: boolean): number | null => {
    // Canonical ids are authoritative. Only legacy/source aliases require
    // unique ownership resolution.
    const canonicalIndex = canonicalIndexById.get(ref);
    if (canonicalIndex !== undefined) return canonicalIndex;
    const owners = ownersByAlias.get(ref);
    if (!owners || owners.size === 0) {
      diagnostics.push({
        code: target ? "unresolved_dependency_target_ref" : "unresolved_dependency_ref",
        message: target
          ? `Draft dependency declaration has unresolved target ref: ${ref}.`
          : `Plan has unresolved dependency ref: ${ref}.`,
      });
      return null;
    }
    if (owners.size !== 1) {
      diagnostics.push({
        code: target ? "ambiguous_dependency_target_ref" : "ambiguous_dependency_ref",
        message: target
          ? `Draft dependency declaration has ambiguous target ref: ${ref}.`
          : `Plan has ambiguous dependency ref: ${ref}.`,
      });
      return null;
    }
    return owners.values().next().value as number;
  };

  const dependencyTargets = selectedExecutionUnits.map((unit, index) =>
    readDependencies(unit, `selectedExecutionUnits[${index}]`, diagnostics).flatMap((ref) => {
      const targetIndex = resolve(ref, false);
      return targetIndex === null ? [] : [targetIndex];
    }));
  const normalizedDraftSteps: DraftStep[] = draftSteps.map((raw, draftIndex) => {
    if (!isObject(raw) || !hasDependencyDeclaration(raw)) return typeof raw === "string" ? raw : { ...raw };
    const targets = readDraftTargets(raw, draftIndex, diagnostics);
    if (targets.length === 0) {
      diagnostics.push({
        code: "unresolved_dependency_target_ref",
        message: "Draft dependency declaration has no unit target ref.",
      });
    }
    const resolvedDependencies = readDependencies(raw, `draft.steps[${draftIndex}]`, diagnostics).flatMap((ref) => {
      const dependencyIndex = resolve(ref, false);
      return dependencyIndex === null ? [] : [dependencyIndex];
    });
    const resolvedTargets = targets.map((ref) => ({ ref, index: resolve(ref, true) }));
    for (const { index: targetIndex } of resolvedTargets) {
      if (targetIndex === null) continue;
      dependencyTargets[targetIndex] = Array.from(new Set([
        ...dependencyTargets[targetIndex]!,
        ...resolvedDependencies,
      ]));
    }
    const canonicalDraftDependencies = unique(resolvedDependencies.map((index) => ids[index]!));
    const normalized: PlanUnit = { ...raw, dependencies: canonicalDraftDependencies };
    if (readStringArray(raw.units).length > 0) {
      normalized.units = unique(resolvedTargets.flatMap(({ index }) => index === null ? [] : [ids[index]!]));
    } else {
      for (const key of ["unitId", "executionUnitId", "selectedExecutionUnitId", "id"] as const) {
        const ref = readString(raw[key]);
        const resolved = resolvedTargets.find((entry) => entry.ref === ref)?.index;
        if (ref && resolved !== null && resolved !== undefined) normalized[key] = ids[resolved]!;
      }
    }
    delete normalized.dependsOn;
    delete normalized.after;
    return normalized;
  });

  const canonicalTargets = dependencyTargets.map((targets, unitIndex) => Array.from(new Set(targets.flatMap((targetIndex) => {
    if (targetIndex === unitIndex) {
      diagnostics.push({ code: "self_dependency", message: `Unit "${ids[unitIndex]}" cannot depend on itself.` });
      return [];
    }
    return [targetIndex];
  }))));
  const canonicalDependencies = canonicalTargets.map((targets) => targets.map((targetIndex) => ids[targetIndex]!));

  const materialized = selectedExecutionUnits.map(isMissionPlanUnitMaterialized);
  canonicalTargets.forEach((targets, fromIndex) => {
    if (!materialized[fromIndex]) return;
    for (const targetIndex of targets) {
      if (!materialized[targetIndex]) {
        diagnostics.push({
          code: "materialized_dependency_on_filtered_unit",
          message: `Materialized unit "${ids[fromIndex]}" cannot depend on filtered metadata/delegation unit "${ids[targetIndex]}" (${FILTERED_UNIT_DEPENDENCY_POLICY}).`,
        });
      }
    }
  });

  const state = new Array(selectedExecutionUnits.length).fill(0) as number[];
  const visit = (index: number, path: number[]): void => {
    if (state[index] === 2) return;
    if (state[index] === 1) {
      const start = path.indexOf(index);
      const cycle = [...path.slice(start), index].map((entry) => ids[entry]).join(" -> ");
      diagnostics.push({ code: "dependency_cycle", message: `Plan dependency cycle detected: ${cycle}.` });
      return;
    }
    state[index] = 1;
    const nextPath = [...path, index];
    for (const targetIndex of canonicalTargets[index]!) visit(targetIndex, nextPath);
    state[index] = 2;
  };
  selectedExecutionUnits.forEach((_, index) => visit(index, []));
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const units = selectedExecutionUnits.map((unit, index) => {
    const normalized: PlanUnit = { ...unit, id: ids[index]!, dependencies: canonicalDependencies[index]! };
    delete normalized.dependsOn;
    delete normalized.after;
    return normalized;
  });
  const materializedUnits = units.filter(isMissionPlanUnitMaterialized);
  return {
    ok: true,
    graph: {
      units,
      draftSteps: normalizedDraftSteps,
      dependencyIndex: canonicalIndex(units),
      materializedUnits,
      materializedDependencyIndex: canonicalIndex(materializedUnits),
    },
  };
}
