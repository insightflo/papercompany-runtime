// server/src/services/missions/structural-plan-validation.ts
//
// [ purpose ] Pre-PLAN structural plan validation extracted from
//   structural-materialization.ts to keep both files under 300 lines.
//   Validates a DECLARED structural plan BEFORE PLAN-QA side effects
//   (issue/wakeup/materialization). Returns actionable diagnostics; it does
//   NOT auto-repair, silently drop, or overwrite declared invalid topology.
//
// [ rejection criteria ] (req: structural gates are opt-in; reject, don't repair)
//   (a) duplicate aliases across ALL units — id/unitId/stepId/sourceRef ids
//   (b) unresolved dependency refs across the EFFECTIVE merged dependency graph
//       (selected-unit deps + draft.steps deps; dependencies + dependsOn + after)
//   (c) bad exact-one-producer gate topology — each gate depends on exactly
//       one non-gate producer (measured on the effective merged graph)
//   (d) semantic QA that reviews a producer but omits any related structural
//       gate (the QA must depend on the producer AND every gate for it)
//
// [ external connection ] Mirrors the materialization-time merge
//   (selectedUnitRefIds / selectedUnitDependenciesByUnitId /
//    planStepDependenciesByUnitId / applyPlanStepDependencies) so a plan that
//   passes here materializes WITHOUT dependency surprises. A draft.steps that
//   adds/removes/bypasses a structural gate or its producer is rejected here,
//   before any PLAN-QA side effect, not discovered at materialization.

import { isDeclaredStructuralUnit } from "./structural-materialization.js";

type PlanUnit = Record<string, unknown>;

/** Validates a declared structural plan BEFORE PLAN-QA side effects.
 *  `draftSteps` is the plan's `steps` array — materialization merges its
 *  dependency forms into each selected unit, so validation must see the same
 *  effective merged graph. Pass `[]` when there are no draft.steps. */
export function validateDeclaredStructuralPlan(
  units: PlanUnit[],
  draftSteps: PlanUnit[] = [],
): string[] {
  const errors: string[] = [];
  if (units.length === 0) return errors;

  // [W002] Parity with materialization (buildPaqoWorkflowSteps): the effective
  //   executable unit set is the SAME filter applied at materialization. Raw
  //   non-structural oversight producers are dropped there, so they must be
  //   dropped here too — otherwise a topology that "looks valid" at pre-PLAN
  //   (because an oversight unit pretends to be a producer) vanishes at
  //   materialization and a structural gate is left without a real producer.
  //   Structural gates are ALWAYS retained (they are never oversight).
  const executableUnits = units.filter((unit) => !isNonStructuralOversightUnit(unit));

  const structuralIntentUnits = executableUnits.filter((unit) => readString(unit.qaType)?.toLowerCase() === "structural");
  if (structuralIntentUnits.length === 0) return errors;

  // Fail before PLAN-QA for malformed structural intent too. Waiting until
  // materialization would let a partial declaration create/wake a QA issue.
  for (const unit of structuralIntentUnits) {
    if (!isDeclaredStructuralUnit(unit)) {
      errors.push(`Structural unit "${readUnitLabel(unit)}" requires type:"tool".`);
      continue;
    }
    const toolNames = readUnitToolNames(unit);
    if (toolNames.length !== 1) {
      errors.push(`Structural gate "${readUnitLabel(unit)}" requires exactly one toolName, got ${toolNames.length}.`);
    } else if (toolNames[0] === "delegate_to_company") {
      errors.push(`Structural gate "${readUnitLabel(unit)}" cannot use delegate_to_company.`);
    }
  }
  const structuralUnits = executableUnits.filter(isDeclaredStructuralUnit);
  if (structuralUnits.length === 0) return errors;

  // Effective merged dependency map (alias → dependency aliases), mirroring
  // applyPlanStepDependencies: selected-unit deps keyed by every unit alias,
  // unioned with draft.steps deps keyed by units/unitId/executionUnitId/
  // selectedExecutionUnitId/id. The very same map materialization uses.
  const effectiveByAlias = buildEffectiveDependencyMap(executableUnits, draftSteps);

  // Per-unit effective dependency set (resolves each alias through the merge).
  const effectiveDepsForUnit = (unit: PlanUnit): Set<string> => {
    const set = new Set<string>();
    for (const alias of readUnitRefIds(unit)) {
      const deps = effectiveByAlias.get(alias);
      if (deps) for (const dep of deps) set.add(dep);
    }
    return set;
  };

  const aliasesByUnit = executableUnits.map((unit) => ({ unit, aliases: new Set(readUnitRefIds(unit)) }));
  const depsByUnit = executableUnits.map((unit) => effectiveDepsForUnit(unit));
  const findUnitByAlias = (alias: string): PlanUnit | null =>
    aliasesByUnit.find((entry) => entry.aliases.has(alias))?.unit ?? null;

  // (a) Duplicate aliases across ALL units (any shared alias is ambiguous).
  const ownersByAlias = new Map<string, number>();
  for (const { aliases } of aliasesByUnit) {
    for (const id of aliases) ownersByAlias.set(id, (ownersByAlias.get(id) ?? 0) + 1);
  }
  for (const [id, count] of ownersByAlias) {
    if (count > 1) errors.push(`Duplicate plan unit alias: "${id}" is declared by ${count} units.`);
  }

  // Every resolvable alias across all units and forms.
  const allAliases = new Set<string>();
  for (const { aliases } of aliasesByUnit) for (const id of aliases) allAliases.add(id);

  // (b) Unresolved dependency refs across the effective merged dependency graph.
  executableUnits.forEach((unit, index) => {
    const unresolved = [...depsByUnit[index]!].filter((dep) => !allAliases.has(dep));
    if (unresolved.length > 0) {
      errors.push(`Unit "${readUnitLabel(unit)}" has unresolved dependency ref(s): ${unresolved.join(", ")}.`);
    }
  });

  // (c) Exact-one-producer gate topology (measured on the effective merged
  //     graph). A gate must depend on exactly one non-gate producer; deps on
  //     other gates or unresolved refs do not count as the producer. This now
  //     catches a draft.steps that adds/removes/bypasses the producer link.
  structuralUnits.forEach((gate) => {
    const gateDeps = depsByUnit[executableUnits.indexOf(gate)]!;
    const nonGateDeps = [...gateDeps].filter((dep) => {
      const owner = findUnitByAlias(dep);
      return owner != null && !isDeclaredStructuralUnit(owner);
    });
    if (nonGateDeps.length !== 1) {
      errors.push(`Structural gate "${readUnitLabel(gate)}" must depend on exactly one non-gate producer, got ${nonGateDeps.length}.`);
    }
  });

  // (d) Semantic QA reviewing a producer must also depend on every structural
  //     gate declared for that producer. Measured on the effective merged graph
  //     so a draft.steps that drops the gate dependency is rejected here.
  executableUnits.forEach((unit, index) => {
    if (isDeclaredStructuralUnit(unit) || !isQaLikeUnit(unit)) return;
    const qaDeps = depsByUnit[index]!;
    for (const depId of qaDeps) {
      const producer = findUnitByAlias(depId);
      if (!producer || isDeclaredStructuralUnit(producer)) continue;
      const producerAliases = aliasesByUnit.find((entry) => entry.unit === producer)!.aliases;
      const gatesForProducer = structuralUnits.filter((gate) =>
        [...depsByUnit[units.indexOf(gate)]!].some((gateDep) => producerAliases.has(gateDep)));
      const missing = gatesForProducer.filter((gate) => {
        const gateAliases = aliasesByUnit.find((entry) => entry.unit === gate)!.aliases;
        return ![...qaDeps].some((qaDep) => gateAliases.has(qaDep));
      });
      if (missing.length > 0) {
        errors.push(
          `QA unit "${readUnitLabel(unit)}" reviews producer "${depId}" but does not depend on structural gate(s): ${missing.map(readUnitLabel).join(", ")}.`,
        );
      }
    }
  });

  // (e) Semantic QA that depends on a structural gate must also depend on that
  //     gate's producer (the artifact source the gate validates). Depending on a
  //     gate while omitting its producer leaves semantic QA without the workProduct
  //     to review — this is a declared topology defect, rejected not auto-repaired.
  //     The producer is RESOLVED to its unit, so the QA may reference it via ANY
  //     alias (unit id vs sourceRef id); only the resolved unit must be reachable.
  executableUnits.forEach((unit, index) => {
    if (isDeclaredStructuralUnit(unit) || !isQaLikeUnit(unit)) return;
    const qaDeps = depsByUnit[index]!;
    for (const depId of qaDeps) {
      const gate = findUnitByAlias(depId);
      if (!gate || !isDeclaredStructuralUnit(gate)) continue;
      const gateDeps = depsByUnit[executableUnits.indexOf(gate)]!;
      const missingProducers: string[] = [];
      for (const gateDep of gateDeps) {
        const producer = findUnitByAlias(gateDep);
        if (!producer || isDeclaredStructuralUnit(producer)) continue;
        const producerAliases = aliasesByUnit.find((entry) => entry.unit === producer)!.aliases;
        const qaReferencesProducer = [...qaDeps].some((qaDep) => producerAliases.has(qaDep));
        if (!qaReferencesProducer) missingProducers.push(readUnitLabel(producer));
      }
      if (missingProducers.length > 0) {
        errors.push(
          `QA unit "${readUnitLabel(unit)}" depends on structural gate "${depId}" but omits its producer: ${missingProducers.join(", ")}.`,
        );
      }
    }
  });

  return errors;
}

// --- readers (mirror materialization alias/dependency forms) ---

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(readString).filter((v): v is string => v !== null);
}

function isPlanObject(value: unknown): value is PlanUnit {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUnitLabel(unit: PlanUnit): string {
  return readString(unit.id) ?? readString(unit.unitId) ?? readString(unit.stepId) ?? "?";
}

/** All alias forms a unit exposes (matches selectedUnitRefIds). */
function readUnitRefIds(unit: PlanUnit): string[] {
  const ids = [
    readString(unit.id),
    readString(unit.unitId),
    readString(unit.stepId),
  ];
  const sourceRef = isPlanObject(unit.sourceRef) ? unit.sourceRef : null;
  if (sourceRef) {
    ids.push(readString(sourceRef.id), readString(sourceRef.issueId), readString(sourceRef.stepId));
  }
  return Array.from(new Set(ids.filter((id): id is string => id !== null)));
}

/** All dependency forms a unit declares (dependencies + dependsOn + after). */
function readUnitDeps(unit: PlanUnit): string[] {
  return Array.from(new Set([
    ...readStringArray(unit.dependencies),
    ...readStringArray(unit.dependsOn),
    ...readStringArray(unit.after),
  ]));
}

/** unit ids a draft.step is keyed by. Mirrors materialization's planStepRefIds:
 *   if a draft step carries a NONEMPTY `units` array, use ONLY that; otherwise
 *   fall back to unitId/executionUnitId/selectedExecutionUnitId/id. The two
 *   forms are NOT unioned. */
function readPlanStepUnitIds(step: PlanUnit): string[] {
  const unitArr = readStringArray(step.units);
  if (unitArr.length > 0) return unitArr;
  const ids = [
    readString(step.unitId),
    readString(step.executionUnitId),
    readString(step.selectedExecutionUnitId),
    readString(step.id),
  ];
  return Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
}

// [W002] Mirror of materialization's executable-unit filter (buildPaqoWorkflowSteps):
//   a selected unit is dropped from the executable set when it is a non-structural
//   oversight unit. Structural gates are NEVER oversight, so they are always
//   retained. Pre-PLAN validation must apply the same filter so a raw oversight
//   producer (which would vanish at materialization) cannot make topology look valid.
function isNonStructuralOversightUnit(unit: PlanUnit): boolean {
  if (isDeclaredStructuralUnit(unit)) return false; // gates always retained
  const title = readString(unit.title) ?? readString(unit.name) ?? readString(unit.id) ?? "";
  const prefixed = /^\s*\[(action|qa|oversight)\]/iu.exec(title);
  if (prefixed) return prefixed[1]!.toLowerCase() === "oversight";
  const kind = readString(unit.kind)?.toLowerCase() ?? "";
  return /\b(?:oversight|supervision|unblock|escalation)\b/u.test(kind);
}

function readUnitToolNames(unit: PlanUnit): string[] {
  return Array.from(new Set([
    ...readStringArray(unit.toolNames),
    ...readStringArray(unit.tools),
    ...(readString(unit.toolName) ? [readString(unit.toolName)!] : []),
  ]));
}

function isQaLikeUnit(unit: PlanUnit): boolean {
  const title = readString(unit.title) ?? readString(unit.name) ?? "";
  return /\[(qa|QA)\]/.test(title) || readString(unit.qaType) !== null;
}

// --- Effective merged dependency graph (mirrors applyPlanStepDependencies) ---
//
// Materialization merges two dependency sources per selected unit:
//   1. selected-unit deps (dependencies/dependsOn/after) keyed by EVERY alias
//      the unit exposes (id/unitId/stepId/sourceRef.id|issueId|stepId)
//   2. draft.steps deps (dependencies/dependsOn/after) keyed by
//      units[]/unitId/executionUnitId/selectedExecutionUnitId/id
// then unions them into one alias→deps map (mergeDependencyMaps). Pre-PLAN
// validation builds the SAME map so a draft.steps that adds/removes/bypasses a
// structural gate or its producer is rejected before any PLAN-QA side effect.

function buildEffectiveDependencyMap(
  units: PlanUnit[],
  draftSteps: PlanUnit[],
): Map<string, Set<string>> {
  const byAlias = new Map<string, string[]>();
  const add = (key: string, deps: string[]): void => {
    if (deps.length === 0) return;
    const current = byAlias.get(key) ?? [];
    byAlias.set(key, Array.from(new Set([...current, ...deps])));
  };

  // 1. selected-unit deps keyed by every unit alias.
  for (const unit of units) {
    const deps = readUnitDeps(unit);
    for (const alias of readUnitRefIds(unit)) add(alias, deps);
  }

  // 2. draft.steps deps keyed by units/unitId/executionUnitId/selectedExecutionUnitId/id.
  for (const raw of draftSteps) {
    if (!isPlanObject(raw)) continue;
    const unitIds = readPlanStepUnitIds(raw);
    const deps = readUnitDeps(raw);
    for (const id of unitIds) add(id, deps);
  }

  const merged = new Map<string, Set<string>>();
  for (const [key, deps] of byAlias) merged.set(key, new Set(deps));
  return merged;
}
