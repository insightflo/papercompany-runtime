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
