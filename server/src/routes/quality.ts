import { Router } from "express";
import { type Db } from "@paperclipai/db";
import { QUALITY_VERDICTS } from "@paperclipai/shared";
import { qualityService } from "../services/quality.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const ALLOWED_VERDICTS = new Set<string>(QUALITY_VERDICTS);

function normalizeSurfaces(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s === "string") {
      const trimmed = s.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

export function qualityRoutes(db: Db) {
  const router = Router();
  const svc = qualityService(db);

  // GET review items + evidence refs for one company.
  router.get("/companies/:companyId/quality/review-items", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      svc
        .listCompanyQualityReviewItems(companyId)
        .then((items) => res.json(items))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  // POST human verdict. needs_evidence creates a collection issue and missing/blocking evidence refs.
  router.post("/quality/review-items/:reviewItemId/verdict", (req, res, next) => {
    try {
      assertBoard(req);
      const { reviewItemId } = req.params;
      const verdict = typeof req.body?.verdict === "string" ? req.body.verdict : "";
      if (!ALLOWED_VERDICTS.has(verdict)) {
        throw badRequest(
          `verdict must be one of: ${[...ALLOWED_VERDICTS].join(", ")}`,
        );
      }
      const reason =
        typeof req.body?.reason === "string" && req.body.reason.trim()
          ? req.body.reason.trim()
          : null;
      const failureType =
        typeof req.body?.failureType === "string" && req.body.failureType.trim()
          ? req.body.failureType.trim()
          : null;
      const requiredEvidenceSurfaces = normalizeSurfaces(req.body?.requiredEvidenceSurfaces);
      const { actorId } = getActorInfo(req);

      svc
        .getReviewItemOwnership(reviewItemId)
        .then((ownership) => {
          if (!ownership) throw notFound("Quality review item not found");
          assertCompanyAccess(req, ownership.companyId);
          return svc.recordQualityVerdict({
            reviewItemId,
            decidedByUserId: actorId,
            verdict,
            reason,
            failureType,
            requiredEvidenceSurfaces,
          });
        })
        .then((result) => res.status(201).json(result))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  // POST promote a human verdict to a company anchor case (quality precedent).
  router.post("/quality/review-items/:reviewItemId/promote-anchor", (req, res, next) => {
    try {
      assertBoard(req);
      const { reviewItemId } = req.params;
      const verdictId =
        typeof req.body?.verdictId === "string" && req.body.verdictId.trim()
          ? req.body.verdictId.trim()
          : "";
      const title =
        typeof req.body?.title === "string" && req.body.title.trim()
          ? req.body.title.trim()
          : "";
      if (!verdictId) throw badRequest("verdictId is required");
      if (!title) throw badRequest("title is required");

      svc
        .getReviewItemOwnership(reviewItemId)
        .then((ownership) => {
          if (!ownership) throw notFound("Quality review item not found");
          assertCompanyAccess(req, ownership.companyId);
          return svc.promoteVerdictToAnchor({ reviewItemId, verdictId, title });
        })
        .then((anchor) => res.status(201).json(anchor))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
