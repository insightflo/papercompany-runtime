import type { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { proposeReplacement, approveReplacement, resolveReplacement, resubmitReplacement } from "../services/workflow/replacement-approval.js";

export function mountWorkflowReplacementRoutes(router: Router, db: Db) {
  router.post("/companies/:companyId/workflow-replacements", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.status(201).json(await proposeReplacement(db, companyId, req.actor, req.body));
  });
  router.post("/companies/:companyId/workflow-replacements/:approvalId/approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await approveReplacement(db, companyId, req.params.approvalId as string, req.actor, req.body));
  });
  for (const [action, status] of [["reject", "rejected"], ["request-revision", "revision_requested"]] as const) {
    router.post(`/companies/:companyId/workflow-replacements/:approvalId/${action}`, async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await resolveReplacement(db, companyId, req.params.approvalId as string, req.actor, status, req.body));
    });
  }
  router.post("/companies/:companyId/workflow-replacements/:approvalId/resubmit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await resubmitReplacement(db, companyId, req.params.approvalId as string, req.actor, req.body));
  });
}
