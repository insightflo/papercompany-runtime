function readBooleanMarker(value: unknown): boolean | null {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return null;
}

export function readRawWorkProductRequirementMarkers(rawSteps: unknown): Map<string, boolean | null> {
  const markers = new Map<string, boolean | null>();
  if (!Array.isArray(rawSteps)) return markers;

  for (const rawStep of rawSteps) {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) continue;
    if (!("id" in rawStep) || typeof rawStep.id !== "string" || rawStep.id.trim().length === 0) continue;
    const marker = ("graphWorkProductRequired" in rawStep ? readBooleanMarker(rawStep.graphWorkProductRequired) : null)
      ?? ("workProductRequired" in rawStep ? readBooleanMarker(rawStep.workProductRequired) : null)
      ?? ("requiresWorkProduct" in rawStep ? readBooleanMarker(rawStep.requiresWorkProduct) : null);
    markers.set(rawStep.id.trim(), marker);
  }

  return markers;
}
