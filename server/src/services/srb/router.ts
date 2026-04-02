/**
 * SRB Router
 *
 * Path selection for Service Request Bridge requests.
 * - remoteServerUrl === null → same-instance (local dispatch)
 * - remoteServerUrl !== null → cross-server (webhook dispatch)
 *
 * This is the entry point for all SRB processing.
 */

import type { Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { srbLinks } from "@paperclipai/db";

/**
 * Dispatch path determined by the router.
 */
export type SRBDispatchPath = "local" | "webhook";

/**
 * Input for routing an SRB request.
 */
export interface SRBRoutingInput {
  linkId: string;
  event: string;
  payload: Record<string, unknown>;
  timestamp: number;
  idempotencyKey: string;
}

/**
 * Result of routing — identifies the chosen path and outcome.
 */
export interface SRBRoutingResult {
  path: SRBDispatchPath;
  linkId: string;
  localCompanyId: string;
  remoteCompanyId: string;
  remoteServerUrl: string | null;
  sharedSecretId: string | null;
}

/**
 * Error thrown when routing fails.
 */
export class SRBRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SRBRoutingError";
  }
}

/**
 * SRBRouter — determines the dispatch path for an SRB request.
 */
export class SRBRouter {
  constructor(private readonly db: Db) {}

  /**
   * route — look up the link and return the appropriate dispatch path.
   *
   * Does NOT execute the dispatch; callers (local-dispatch or webhook-dispatch)
   * handle the actual delivery.
   *
   * @throws SRBRoutingError if the link does not exist
   */
  async route(input: SRBRoutingInput): Promise<SRBRoutingResult> {
    const link = await this.loadLink(input.linkId);

    if (!link) {
      throw new SRBRoutingError(`SRB link not found: ${input.linkId}`);
    }

    const path: SRBDispatchPath = link.remoteServerUrl === null ? "local" : "webhook";

    return {
      path,
      linkId: link.id,
      localCompanyId: link.localCompanyId,
      remoteCompanyId: link.remoteCompanyId,
      remoteServerUrl: link.remoteServerUrl,
      sharedSecretId: link.sharedSecretId,
    };
  }

  /**
   * loadLink — fetch a single SRB link by ID.
   */
  private async loadLink(linkId: string) {
    const rows = await this.db
      .select()
      .from(srbLinks)
      .where(eq(srbLinks.id, linkId))
      .limit(1);

    return rows[0] ?? null;
  }
}

/**
 * Factory to create an SRBRouter instance.
 */
export function createSRBRouter(db: Db): SRBRouter {
  return new SRBRouter(db);
}
