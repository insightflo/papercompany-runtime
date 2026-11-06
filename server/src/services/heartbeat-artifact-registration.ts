import type { heartbeatRuns } from "@paperclipai/db";
import { stringifyRunResultJson } from "./heartbeat-run-result-text.js";
import { extractClaimedArtifactPathsFromText, isActionableClaimedArtifactPath, stripArtifactTokenPunctuation } from "./work-products/artifact-claim-paths.js";
import path from "node:path";
import { isPathInsideOrEqual } from "./work-products/output-paths.js";

export function workProductReferencesClaimedArtifact(
  product: {
    url: string | null;
    externalId: string | null;
    metadata: Record<string, unknown> | null;
    status?: string | null;
    isPrimary?: boolean | null;
  },
  claimedArtifactPaths: string[],
) {
  if (product.status && product.status !== "active") return false;

  // Some successful retry/heartbeat runs only report that the work is already complete
  // (or echo setup files from the agent prompt) rather than re-printing the actual
  // artifact path. In that case an existing active primary workProduct is already the
  // control-plane contract and should not be auto-blocked as missing registration.
  if (claimedArtifactPaths.length === 0) return product.isPrimary !== false;

  const haystack = [
    product.url,
    product.externalId,
    product.metadata ? JSON.stringify(product.metadata) : null,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  if (!haystack.trim()) return false;

  return claimedArtifactPaths.some((artifactPath) => haystack.includes(artifactPath));
}

function workProductArtifactPaths(product: {
  url: string | null;
  externalId: string | null;
  metadata: Record<string, unknown> | null;
}) {
  const paths: string[] = [];
  for (const value of [product.url, product.externalId]) {
    if (typeof value === "string" && path.isAbsolute(value)) paths.push(value);
  }
  const metadataPath = product.metadata?.path;
  if (typeof metadataPath === "string" && path.isAbsolute(metadataPath)) paths.push(metadataPath);
  return paths;
}

export function workProductWithinAllowedRoot(
  product: {
    url: string | null;
    externalId: string | null;
    metadata: Record<string, unknown> | null;
  },
  allowedArtifactRoot: string | null | undefined,
) {
  if (!allowedArtifactRoot) return true;
  const paths = workProductArtifactPaths(product);
  return paths.length > 0 && paths.some((artifactPath) => isPathInsideOrEqual(artifactPath, allowedArtifactRoot));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractIssueDeclaredArtifactTokens(text: string | null | undefined) {
  if (!text?.trim()) return [];
  const matches = text.match(
    /(?:~?\/|\.{1,2}\/|[A-Za-z0-9_{}.-]+[\\/])?[A-Za-z0-9_{}./\\@()-]+\.(?:md|markdown|html?|json|csv|pdf|txt|xlsx?|docx?|png|jpe?g|webp|ya?ml)\b/giu,
  ) ?? [];
  return Array.from(new Set(matches.map(stripArtifactTokenPunctuation).filter(Boolean)));
}

function artifactTokenRegexSource(token: string) {
  return escapeRegExp(token)
    .replace(/YYYY-MM-DD/gu, "\\d{4}-\\d{2}-\\d{2}")
    .replace(/YYYYMMDD/gu, "\\d{8}")
    .replace(/YYYYMM/gu, "\\d{6}")
    .replace(/\\\{date\\\}/giu, "\\d{4}-\\d{2}-\\d{2}")
    .replace(/\\\{runDate\\\}/gu, "\\d{4}-\\d{2}-\\d{2}");
}

function workProductSatisfiesIssueDeclaredArtifact(
  product: {
    url: string | null;
    externalId: string | null;
    metadata: Record<string, unknown> | null;
    status?: string | null;
    isPrimary?: boolean | null;
  },
  issue: { description?: string | null },
  allowedArtifactRoot?: string | null,
) {
  if (product.status && product.status !== "active") return false;
  if (product.isPrimary === false) return false;
  if (!workProductWithinAllowedRoot(product, allowedArtifactRoot)) return false;

  const declaredArtifactTokens = extractIssueDeclaredArtifactTokens(issue.description);
  if (declaredArtifactTokens.length === 0) return false;

  const haystack = [
    product.url,
    product.externalId,
    product.metadata ? JSON.stringify(product.metadata) : null,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .replace(/\\/gu, "/");
  if (!haystack.trim()) return false;

  return declaredArtifactTokens.some((token) => {
    const normalizedToken = token.replace(/\\/gu, "/");
    const basename = path.posix.basename(normalizedToken);
    const candidates = Array.from(new Set([normalizedToken, basename].filter(Boolean)));
    return candidates.some((candidate) => new RegExp(artifactTokenRegexSource(candidate), "u").test(haystack));
  });
}

export function hasSatisfiedWorkProductRegistration(input: {
  existingWorkProducts: Array<{
    url: string | null;
    externalId: string | null;
    metadata: Record<string, unknown> | null;
    status?: string | null;
    isPrimary?: boolean | null;
  }>;
  claimedArtifactPaths: string[];
  issue: { description?: string | null };
  autoRegisteredWorkProduct?: unknown | null;
  allowedArtifactRoot?: string | null;
}) {
  const effectiveClaimedArtifactPaths = input.claimedArtifactPaths
    .filter(isActionableClaimedArtifactPath)
    .filter((artifactPath) =>
      input.allowedArtifactRoot ? isPathInsideOrEqual(artifactPath, input.allowedArtifactRoot) : true,
    );
  // An active primary workProduct is the authoritative control-plane contract for the issue’s artifact. When a heartbeat/retry run succeeds and echoes input/setup/data-source paths in its stdout that do not literally match the registered deliverable URL, the existing registration must not be treated as missing. This removes the false-positive loop reported in CMPAA-163 without disabling the gate for the genuine “agent forgot to register WP” case.
  const hasActivePrimaryWorkProduct = input.existingWorkProducts.some((product) =>
    effectiveClaimedArtifactPaths.length === 0 &&
    product.status === "active" &&
    product.isPrimary === true &&
    workProductWithinAllowedRoot({
      url: product.url,
      externalId: product.externalId,
      metadata: product.metadata ?? null,
    }, input.allowedArtifactRoot)
  );
  const hasMatchingWorkProduct = input.existingWorkProducts.some((product) => workProductReferencesClaimedArtifact(
    {
      url: product.url,
      externalId: product.externalId,
      metadata: product.metadata ?? null,
      status: product.status,
      isPrimary: product.isPrimary,
    },
    effectiveClaimedArtifactPaths,
  ) && workProductWithinAllowedRoot({
    url: product.url,
    externalId: product.externalId,
    metadata: product.metadata ?? null,
  }, input.allowedArtifactRoot));
  const hasIssueDeclaredWorkProduct = input.existingWorkProducts.some((product) =>
    workProductSatisfiesIssueDeclaredArtifact({
      url: product.url,
      externalId: product.externalId,
      status: product.status,
      isPrimary: product.isPrimary,
      metadata: product.metadata ?? null,
    }, input.issue, input.allowedArtifactRoot),
  );

  return (
    hasActivePrimaryWorkProduct ||
    hasMatchingWorkProduct ||
    hasIssueDeclaredWorkProduct ||
    Boolean(input.autoRegisteredWorkProduct)
  );
}

export function extractClaimedArtifactPaths(run: Pick<typeof heartbeatRuns.$inferSelect, "resultJson" | "stdoutExcerpt" | "stderrExcerpt">): string[] {
  const text = [stringifyRunResultJson(run.resultJson), run.stdoutExcerpt, run.stderrExcerpt]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  return extractClaimedArtifactPathsFromText(text);
}
