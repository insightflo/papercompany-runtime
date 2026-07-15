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
//   (b) unresolved dependency refs across ACTUAL plan dependency forms
//       (dependencies + dependsOn + after)
//   (c) bad exact-one-producer gate topology — each gate depends on exactly
//       one non-gate producer
//   (d) semantic QA that reviews a producer but omits any related structural
//       gate (the QA must depend on the producer AND every gate for it)
//
// [ external connection ] Mirrors the materialization-time alias/dependency
//   readers (selectedUnitRefIds / dependencies+dependsOn+after) so a plan that
//   passes here materializes without alias/dependency surprises.

import { isDeclaredStructuralUnit } from "./structural-materialization.js";

type PlanUnit = Record<string, unknown>;

/** Validates a declared structural plan BEFORE PLAN-QA side effects. */
export function validateDeclaredStructuralPlan(units: PlanUnit[]): string[] {
  const errors: string[] = [];
  if (units.length === 0) return errors;
  const structuralIntentUnits = units.filter((unit) => readString(unit.qaType)?.toLowerCase() === "structural");
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
  const structuralUnits = units.filter(isDeclaredStructuralUnit);
  if (structuralUnits.length === 0) return errors;

  const aliasesByUnit = units.map((unit) => ({ unit, aliases: new Set(readUnitRefIds(unit)) }));
  const depsByUnit = units.map((unit) => new Set(readUnitDeps(unit)));
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

  // (b) Unresolved dependency refs across actual plan dependency forms.
  units.forEach((unit, index) => {
    const unresolved = [...depsByUnit[index]!].filter((dep) => !allAliases.has(dep));
    if (unresolved.length > 0) {
      errors.push(`Unit "${readUnitLabel(unit)}" has unresolved dependency ref(s): ${unresolved.join(", ")}.`);
    }
  });

  // (c) Exact-one-producer gate topology (a gate may depend on exactly one
  //     non-gate producer; dependencies on other gates or unresolved refs do
  //     not count as the producer).
  structuralUnits.forEach((gate) => {
    const gateDeps = depsByUnit[units.indexOf(gate)]!;
    const nonGateDeps = [...gateDeps].filter((dep) => {
      const owner = findUnitByAlias(dep);
      return owner != null && !isDeclaredStructuralUnit(owner);
    });
    if (nonGateDeps.length !== 1) {
      errors.push(`Structural gate "${readUnitLabel(gate)}" must depend on exactly one non-gate producer, got ${nonGateDeps.length}.`);
    }
  });

  // (d) Semantic QA reviewing a producer must also depend on every structural
  //     gate declared for that producer.
  units.forEach((unit, index) => {
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
  units.forEach((unit, index) => {
    if (isDeclaredStructuralUnit(unit) || !isQaLikeUnit(unit)) return;
    const qaDeps = depsByUnit[index]!;
    for (const depId of qaDeps) {
      const gate = findUnitByAlias(depId);
      if (!gate || !isDeclaredStructuralUnit(gate)) continue;
      const gateDeps = depsByUnit[units.indexOf(gate)]!;
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
  const sourceRef = unit.sourceRef && typeof unit.sourceRef === "object" ? unit.sourceRef as PlanUnit : null;
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
