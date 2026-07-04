function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function readUnitIdRefs(unit: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ["id", "unitId", "executionUnitId", "selectedExecutionUnitId"]) {
    const value = unit[key];
    if (typeof value === "string" && value.trim().length > 0) ids.push(value.trim());
  }
  if (unit.sourceRef && typeof unit.sourceRef === "object" && !Array.isArray(unit.sourceRef)) {
    const sourceRef = unit.sourceRef as Record<string, unknown>;
    for (const key of ["id", "issueId", "stepId", "unitId"]) {
      const value = sourceRef[key];
      if (typeof value === "string" && value.trim().length > 0) ids.push(value.trim());
    }
  }
  return Array.from(new Set(ids));
}

function readUnitDependencyRefs(unit: Record<string, unknown>): string[] {
  return Array.from(new Set([
    ...readStringArray(unit.dependsOn),
    ...readStringArray(unit.dependencies),
    ...readStringArray(unit.after),
  ]));
}

export function buildDependencyIndex(selectedExecutionUnits: ReadonlyArray<Record<string, unknown>>): number[][] {
  const idToIndex = new Map<string, number>();
  selectedExecutionUnits.forEach((unit, index) => {
    for (const id of readUnitIdRefs(unit)) {
      idToIndex.set(id, index);
    }
  });

  return selectedExecutionUnits.map((unit, index) => {
    const dependencyIndexes = readUnitDependencyRefs(unit)
      .map((ref) => idToIndex.get(ref))
      .filter((target): target is number => target !== undefined && target !== index);
    return Array.from(new Set(dependencyIndexes));
  });
}

export function unitDependsOn(dependencyIndex: number[][], fromIndex: number, targetIndex: number): boolean {
  const visited = new Set<number>();
  const stack = [...(dependencyIndex[fromIndex] ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) return false;
    if (current === targetIndex) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(dependencyIndex[current] ?? []));
  }
  return false;
}
