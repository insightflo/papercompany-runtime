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

  // GET quality summary (counts for header + daily report input).
  router.get("/companies/:companyId/quality/summary", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      svc.getQualitySummary(companyId).then((s) => res.json(s)).catch(next);
    } catch (err) {
      next(err);
    }
  });

  // GET single review item + evidence refs (detail panel).
  router.get("/quality/review-items/:reviewItemId", (req, res, next) => {
    try {
      const { reviewItemId } = req.params;
      svc
        .getReviewItemOwnership(reviewItemId)
        .then((ownership) => {
          if (!ownership) throw notFound("Quality review item not found");
          assertCompanyAccess(req, ownership.companyId);
          return svc.getReviewItemDetail(reviewItemId);
        })
        .then((item) => res.json(item))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  // POST create/auto review item (final QA, delivery gate, oversight, user feedback → plan 8.1).
  router.post("/companies/:companyId/quality/review-items", (req, res, next) => {
    try {
      assertBoard(req);
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      const targetType = typeof req.body?.targetType === "string" ? req.body.targetType.trim() : "";
      const triggerSource = typeof req.body?.triggerSource === "string" ? req.body.triggerSource.trim() : "";
      if (!title) throw badRequest("title is required");
      if (!targetType) throw badRequest("targetType is required");
      if (!triggerSource) throw badRequest("triggerSource is required");
      const missionId = typeof req.body?.missionId === "string" && req.body.missionId.trim() ? req.body.missionId.trim() : null;
      const targetId = typeof req.body?.targetId === "string" && req.body.targetId.trim() ? req.body.targetId.trim() : null;
      const failureType = typeof req.body?.failureType === "string" && req.body.failureType.trim() ? req.body.failureType.trim() : null;
      const priority = typeof req.body?.priority === "string" && req.body.priority.trim() ? req.body.priority.trim() : undefined;
      const triggerMetadata = req.body?.triggerMetadata && typeof req.body.triggerMetadata === "object" ? req.body.triggerMetadata : {};
      const evidenceRefs = Array.isArray(req.body?.evidenceRefs) ? req.body.evidenceRefs : undefined;

      svc
        .createReviewItem({
          companyId,
          missionId,
          title,
          targetType,
          targetId,
          triggerSource,
          triggerMetadata,
          failureType,
          priority,
          evidenceRefs,
        })
        .then((result) => res.status(201).json(result))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  // POST request evidence (standalone collection request → plan 8.3).
  router.post("/quality/review-items/:reviewItemId/request-evidence", (req, res, next) => {
    try {
      assertBoard(req);
      const { reviewItemId } = req.params;
      const requiredEvidenceSurfaces = normalizeSurfaces(req.body?.requiredEvidenceSurfaces);
      if (requiredEvidenceSurfaces.length === 0) throw badRequest("requiredEvidenceSurfaces is required");
      const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : null;
      const { actorId } = getActorInfo(req);

      svc
        .getReviewItemOwnership(reviewItemId)
        .then((ownership) => {
          if (!ownership) throw notFound("Quality review item not found");
          assertCompanyAccess(req, ownership.companyId);
          return svc.requestEvidence({
            reviewItemId,
            requestedByUserId: actorId,
            reason,
            requiredEvidenceSurfaces,
          });
        })
        .then((result) => res.status(201).json(result))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  // POST record collected evidence (closes the loop → awaiting_review when resolved).
  router.post("/quality/review-items/:reviewItemId/evidence", (req, res, next) => {
    try {
      assertBoard(req);
      const { reviewItemId } = req.params;
      const surface = typeof req.body?.surface === "string" ? req.body.surface.trim() : "";
      const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
      if (!surface) throw badRequest("surface is required");
      if (!status) throw badRequest("status is required");
      const { actorId, actorType } = getActorInfo(req);

      svc
        .getReviewItemOwnership(reviewItemId)
        .then((ownership) => {
          if (!ownership) throw notFound("Quality review item not found");
          assertCompanyAccess(req, ownership.companyId);
          return svc.recordEvidence({
            reviewItemId,
            surface,
            expected: req.body?.expected,
            actual: req.body?.actual,
            status,
            collectedByActorType: actorType,
            collectedByActorId: actorId,
            sourceRunId: typeof req.body?.sourceRunId === "string" ? req.body.sourceRunId : null,
            sourceUrl: typeof req.body?.sourceUrl === "string" ? req.body.sourceUrl : null,
            freshnessExpiresAt: typeof req.body?.freshnessExpiresAt === "string" ? req.body.freshnessExpiresAt : null,
            blocking: typeof req.body?.blocking === "boolean" ? req.body.blocking : undefined,
          });
        })
        .then((result) => res.status(201).json(result))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  // GET anchor cases.
  router.get("/companies/:companyId/quality/anchors", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      svc.listAnchorCases(companyId).then((rows) => res.json(rows)).catch(next);
    } catch (err) {
      next(err);
    }
  });

  // GET evaluator versions.
  router.get("/companies/:companyId/quality/evaluator-versions", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      svc.listEvaluatorVersions(companyId).then((rows) => res.json(rows)).catch(next);
    } catch (err) {
      next(err);
    }
  });

  // GET candidate runs (?versionId=...).
  router.get("/companies/:companyId/quality/candidate-runs", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const versionId = typeof req.query.versionId === "string" ? req.query.versionId : undefined;
      svc.listCandidateRuns(companyId, versionId).then((rows) => res.json(rows)).catch(next);
    } catch (err) {
      next(err);
    }
  });

  // POST run candidate replay (deterministic v1; passed unless regressions reported).
  router.post("/companies/:companyId/quality/candidate-runs/:runId/replay", (req, res, next) => {
    try {
      assertBoard(req);
      const { companyId, runId } = req.params;
      assertCompanyAccess(req, companyId);
      const regressions = typeof req.body?.regressions === "number" ? req.body.regressions : 0;
      const resultSummary = typeof req.body?.resultSummary === "string" ? req.body.resultSummary.trim() : undefined;
      svc.runCandidateReplay(companyId, runId, { regressions, resultSummary }).then((run) => res.json(run)).catch(next);
    } catch (err) {
      next(err);
    }
  });

  // POST promote evaluator version to production (gated on a passed replay run).
  router.post("/companies/:companyId/quality/evaluator-versions/:versionId/promote", (req, res, next) => {
    try {
      assertBoard(req);
      const { companyId, versionId } = req.params;
      assertCompanyAccess(req, companyId);
      svc.promoteEvaluatorVersion(companyId, versionId).then((version) => res.json(version)).catch(next);
    } catch (err) {
      next(err);
    }
  });

  // POST generate daily quality report (upsert by company+date).
  router.post("/companies/:companyId/quality/daily-reports/generate", (req, res, next) => {
    try {
      assertBoard(req);
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const reportDate = typeof req.body?.reportDate === "string" ? req.body.reportDate.trim() : undefined;
      svc.generateDailyReport(companyId, reportDate).then((report) => res.status(201).json({ report })).catch(next);
    } catch (err) {
      next(err);
    }
  });

  // GET daily reports list.
  router.get("/companies/:companyId/quality/daily-reports", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      svc.listDailyReports(companyId).then((rows) => res.json(rows)).catch(next);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
