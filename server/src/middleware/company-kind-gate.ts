/**
 * Company Kind Gate Middleware
 *
 * CRITICAL: Single app.use("/maintenance", ...) only — per-route禁止
 *
 * Blocks all routes under /maintenance/* when the company's company_kind
 * is NOT 'maintenance'. Used to gate maintenance-mode endpoints.
 *
 * This is a middleware factory that returns a standard Express middleware.
 * Mount ONCE at the /maintenance prefix in your Express app.
 *
 * @example
 * // CORRECT — single mount point
 * app.use("/maintenance", requireMaintenanceCompany());
 *
 * // WRONG — per-route (will be ignored)
 * app.get("/maintenance/foo", requireMaintenanceCompany()); // Don't do this
 * app.get("/maintenance/bar", requireMaintenanceCompany()); // Don't do this
 */

import type { Request, RequestHandler } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { forbidden } from "../errors.js";

function requestCompanyId(req: Request): string | undefined {
  const raw = req.params.companyId ?? (req as unknown as Record<string, unknown>).companyId;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

interface CompanyKindGateOptions {
  /**
   * The company_kind value that is considered "maintenance".
   * Defaults to "maintenance".
   */
  maintenanceKind?: string;
}

/**
 * Creates middleware that blocks requests when the company's company_kind
 * is not the maintenance kind.
 *
 * @param db - Database instance
 * @param opts - Options
 * @returns Express middleware
 */
export function requireMaintenanceCompany(db: Db, opts: CompanyKindGateOptions = {}): RequestHandler {
  const maintenanceKind = opts.maintenanceKind ?? "maintenance";

  return async (req: Request, _res, next) => {
    const companyId = requestCompanyId(req);

    if (!companyId) {
      // No company context — let auth handle it
      return next();
    }

    const rows = await db
      .select({ companyKind: companies.companyKind })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    const companyKind = rows[0]?.companyKind;

    if (companyKind !== maintenanceKind) {
      return next(
        forbidden(
          `Maintenance mode is not active for this company. company_kind=${companyKind}`,
        ),
      );
    }

    next();
  };
}

/**
 * Creates middleware that allows requests ONLY when the company's company_kind
 * is the maintenance kind. Inverse of requireMaintenanceCompany.
 *
 * @param db - Database instance
 * @param opts - Options
 * @returns Express middleware
 */
export function requireNormalCompany(db: Db, opts: CompanyKindGateOptions = {}): RequestHandler {
  const maintenanceKind = opts.maintenanceKind ?? "maintenance";

  return async (req: Request, _res, next) => {
    const companyId = requestCompanyId(req);

    if (!companyId) {
      return next();
    }

    const rows = await db
      .select({ companyKind: companies.companyKind })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    const companyKind = rows[0]?.companyKind;

    if (companyKind === maintenanceKind) {
      return next(
        forbidden(
          `This endpoint is not available during maintenance mode.`,
        ),
      );
    }

    next();
  };
}
