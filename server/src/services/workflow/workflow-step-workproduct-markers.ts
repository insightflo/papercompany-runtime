function readBooleanMarker(value: unknown): boolean | null {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return null;
}

export function readWorkProductRequirementMarker(rawStep: object): boolean | null {
  return ("graphWorkProductRequired" in rawStep ? readBooleanMarker(rawStep.graphWorkProductRequired) : null)
    ?? ("workProductRequired" in rawStep ? readBooleanMarker(rawStep.workProductRequired) : null)
    ?? ("requiresWorkProduct" in rawStep ? readBooleanMarker(rawStep.requiresWorkProduct) : null);
}
