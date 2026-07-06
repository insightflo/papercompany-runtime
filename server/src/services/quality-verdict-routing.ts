export type QualityVerdictRouting =
  | { kind: "none" }
  | { kind: "evidence"; reason: string | null; requiredEvidenceSurfaces: string[] }
  | {
      kind: "correction";
      verdict: "fail" | "request_changes";
      reason: string | null;
      failureType: string | null;
    };

function normalizeRequiredEvidenceSurfaces(surfaces: readonly string[] | undefined): string[] {
  if (!surfaces) return [];
  return surfaces.map((surface) => surface.trim()).filter(Boolean);
}

export function resolveQualityVerdictRouting(input: {
  verdict: string;
  reason?: string | null;
  failureType?: string | null;
  requiredEvidenceSurfaces?: readonly string[];
}): QualityVerdictRouting {
  if (input.verdict === "needs_evidence") {
    return {
      kind: "evidence",
      reason: input.reason ?? null,
      requiredEvidenceSurfaces: normalizeRequiredEvidenceSurfaces(input.requiredEvidenceSurfaces),
    };
  }

  if (input.verdict === "fail" || input.verdict === "request_changes") {
    return {
      kind: "correction",
      verdict: input.verdict,
      reason: input.reason ?? null,
      failureType: input.failureType ?? null,
    };
  }

  return { kind: "none" };
}
