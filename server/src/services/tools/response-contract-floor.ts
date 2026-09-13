/**
 * [purpose] Slice-3 (B) save-time assertion floor: an HTTP tool whose response contract
 *   persists an artifact (artifactField/artifactFileName configured) must declare at least
 *   one response assertion — garbage tool responses must not become persisted success
 *   artifacts by default. Applied at tool create and at adapterConfig-rewriting updates;
 *   PATCHes without adapterConfig keep legacy tools operable (registry replaces
 *   adapterConfig wholesale, so presence in the body is the mutation signal).
 * [scope] Floor only; malformed response configs stay governed by the existing
 *   execution-time resolveResponseContract 422. No reader changes, no migrations.
 */
import { unprocessable } from "../../errors.js";
import { resolveResponseContract } from "../workflow/http-tool-response.js";

export function assertHttpArtifactAssertionFloor(input: {
  adapterType?: string | null;
  adapterConfig?: unknown;
}): void {
  if (input.adapterType !== "http") return;
  const config = input.adapterConfig && typeof input.adapterConfig === "object" && !Array.isArray(input.adapterConfig)
    ? input.adapterConfig as Record<string, unknown>
    : {};
  if (config.response === undefined) return;
  const contract = resolveResponseContract(config.response);
  if (contract && contract.artifactField !== null && contract.assertions.length === 0) {
    throw unprocessable(
      "HTTP artifact tools must configure at least one response assertion (adapterConfig.response.assertions)",
    );
  }
}
