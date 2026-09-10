import { Router, type Request, type RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { fail, parse, uuid } from "../services/workflow-resume-cu-contract.js";
import { authenticateCuObserver, grantCuObserver, writeCuObservation } from "../services/workflow-resume-cu-observations.js";
import { loadCuJob } from "../services/workflow-resume-cu-binding.js";
import { admitCuEvidence, readCuSubmission } from "../services/workflow-resume-cu-evidence.js";

const param = (req: Request, name: string) => parse(uuid, req.params[name]);
const safe = (run: RequestHandler): RequestHandler => async (req, res, next) => {
  try { await run(req, res, next); } catch (error) {
    // No provider errors, paths, screenshots, tokens, or validator details in public errors.
    next(error instanceof HttpError ? error : new HttpError(422, "cu_evidence_failed"));
  }
};
export function workflowResumeCuRoutes(db: Db) {
  const router = Router(), base = "/companies/:companyId/missions/:missionId";
  router.post(base + "/workflow-cu-jobs/:jobId/observations", safe(async (req, res) => {
    const principal = authenticateCuObserver(req.header("authorization"));
    const companyId = param(req, "companyId"), missionId = param(req, "missionId"), jobId = param(req, "jobId");
    // Explicit grant check before job lookup; authenticated transport is not visual truth.
    if (!principal.grants.some(g => g.companyId === companyId && g.jobId === jobId)) fail("cu_observer_forbidden", 403);
    const { job } = await loadCuJob(db, companyId, missionId, jobId);
    grantCuObserver(principal, job);
    if (req.body?.jobId !== jobId) fail("cu_scope_mismatch");
    res.status(201).json(await writeCuObservation(db, principal, { companyId, missionId }, req.body));
  }));
  router.post(base + "/workflow-late-evidence-submissions", safe(async (req, res) => {
    const companyId = param(req, "companyId");
    assertCompanyAccess(req, companyId); assertBoard(req);
    const missionId = param(req, "missionId");
    res.status(201).json(await admitCuEvidence(db, { companyId, missionId }, req.body, getActorInfo(req).actorId));
  }));
  router.get(base + "/workflow-late-evidence-submissions/:submissionId", safe(async (req, res) => {
    const companyId = param(req, "companyId");
    assertCompanyAccess(req, companyId); assertBoard(req);
    const missionId = param(req, "missionId"), id = param(req, "submissionId");
    res.json(await readCuSubmission(db, { companyId, missionId }, id));
  }));
  return router;
}
