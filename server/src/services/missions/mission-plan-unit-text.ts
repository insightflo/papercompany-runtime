export function missionPlanUnitText(unit: Record<string, unknown>): string {
  const parts: string[] = [];
  const pushIfString = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) parts.push(value);
  };
  pushIfString(unit.title);
  pushIfString(unit.name);
  pushIfString(unit.kind);
  pushIfString(unit.reason);
  pushIfString(unit.description);
  if (unit.sourceRef && typeof unit.sourceRef === "object") {
    const sourceRef = unit.sourceRef as Record<string, unknown>;
    pushIfString(sourceRef.type);
    pushIfString(sourceRef.kind);
  }
  pushIfString(unit.toolName);
  if (Array.isArray(unit.toolNames)) {
    for (const toolName of unit.toolNames) pushIfString(toolName);
  }
  return parts.join("\n");
}
