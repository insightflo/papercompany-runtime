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
