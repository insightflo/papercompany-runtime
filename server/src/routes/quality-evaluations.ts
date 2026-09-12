// server/src/routes/quality-evaluations.ts
//
// [purpose] T6 전용 평가 API. /api/issues/:issueId/quality/candidates 와
//   /api/issues/:issueId/quality/evaluations/:evaluationId/v1 아래 open/read/results/verify.
//   인증 actor 의 회사·run binding 을 매 요청마다 서버가 다시 확인하고 board 는 검증자가 될 수 없다.
// [boundary] 이 경로의 응답만이 평가 실행·판정의 제출 창구다. generic verdict/완료 경로는 대체 아님.

import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { evaluatorCandidateRuns, heartbeatRuns, issues, qualityActions } from "@paperclipai/db";
import { uuidSchema, type QualityAgentActor } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { submitQualityCandidate } from "../services/quality/evaluation-candidates.js";
import { openQualityCase, readQualityCheck } from "../services/quality/evaluation-reader.js";
import { submitQualityCase, verifyQualityEvaluation } from "../services/quality/evaluation-submissions.js";

function agentActor(db: Db, req: Request, issueCompanyId: string, rejectionCode: string): Promise<QualityAgentActor> {
  if (req.actor.type !== "agent") throw forbidden(rejectionCode);
  const { agentId, companyId, runId } = req.actor;
  if (!agentId || !companyId || !runId) throw forbidden(rejectionCode);
  if (companyId !== issueCompanyId) throw forbidden("Agent key cannot access another company");
  return db.select({ executionEpoch: heartbeatRuns.executionEpoch }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId), eq(heartbeatRuns.agentId, agentId)))
    .limit(1).then(([run]) => {
      if (!run || run.executionEpoch === null) throw forbidden(rejectionCode);
      return { agentId: agentId, companyId: companyId, heartbeatRunId: runId, executionEpoch: run.executionEpoch };
    });
}

async function issueCompanyId(db: Db, req: Request): Promise<string> {
  const issueId = uuidSchema.parse(req.params.issueId);
  const [issue] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId)).limit(1);
  if (!issue) throw notFound("Issue not found");
  return issue.companyId;
}

export function qualityEvaluationRoutes(db: Db): Router {
  const router = Router();

  router.post("/issues/:issueId/quality/candidates", async (req, res, next) => {
    try {
      const companyId = await issueCompanyId(db, req);
      const actor = await agentActor(db, req, companyId, "quality_agent_required");
      const stored = await submitQualityCandidate(db, actor, { ...req.body, issueId: req.params.issueId });
      res.status(201).json({ data: stored });
    } catch (error) { next(error); }
  });

  router.post("/issues/:issueId/quality/evaluations/:evaluationId/v1/cases/:caseId/:variant/open", async (req, res, next) => {
    try {
      const companyId = await issueCompanyId(db, req);
      const actor = await agentActor(db, req, companyId, "quality_verifier_agent_required");
      const opened = await openQualityCase(db, actor, {
        issueId: req.params.issueId, evaluationId: req.params.evaluationId,
        caseId: req.params.caseId, variant: req.params.variant,
      });
      res.status(201).json({ data: opened });
    } catch (error) { next(error); }
  });

  router.post("/issues/:issueId/quality/evaluations/:evaluationId/v1/invocations/:invocationId/read", async (req, res, next) => {
    try {
      const companyId = await issueCompanyId(db, req);
      const actor = await agentActor(db, req, companyId, "quality_verifier_agent_required");
      const read = await readQualityCheck(db, actor, {
        invocationId: req.params.invocationId,
        checkId: req.body?.checkId, pointers: req.body?.pointers,
      });
      res.status(201).json({ data: read });
    } catch (error) { next(error); }
  });

  router.post("/issues/:issueId/quality/evaluations/:evaluationId/v1/invocations/:invocationId/results", async (req, res, next) => {
    try {
      const companyId = await issueCompanyId(db, req);
      const actor = await agentActor(db, req, companyId, "quality_verifier_agent_required");
      const submitted = await submitQualityCase(db, actor, {
        invocationId: req.params.invocationId, schemaVersion: req.body?.schemaVersion, results: req.body?.results,
      });
      const missing = (submitted as { status?: string }).status === "missing_evidence";
      res.status(missing ? 200 : 201).json({ data: submitted });
    } catch (error) { next(error); }
  });

  router.post("/issues/:issueId/quality/evaluations/:evaluationId/v1/verify", async (req, res, next) => {
    try {
      const companyId = await issueCompanyId(db, req);
      const actor = await agentActor(db, req, companyId, "quality_verifier_agent_required");
      const evaluationId = uuidSchema.parse(req.params.evaluationId);
      const [evaluation] = await db.select({ qualityActionId: evaluatorCandidateRuns.qualityActionId })
        .from(evaluatorCandidateRuns)
        .where(and(eq(evaluatorCandidateRuns.companyId, companyId), eq(evaluatorCandidateRuns.id, evaluationId))).limit(1);
      if (!evaluation?.qualityActionId) throw notFound("quality_evaluation_not_found");
      const [action] = await db.select({ currentEvaluationId: qualityActions.currentEvaluationId })
        .from(qualityActions).where(and(eq(qualityActions.companyId, companyId), eq(qualityActions.id, evaluation.qualityActionId))).limit(1);
      if (!action || action.currentEvaluationId !== evaluationId) throw conflict("quality_evaluation_not_current");
      const verdict = await verifyQualityEvaluation(db, actor, { companyId, actionId: evaluation.qualityActionId });
      res.status(200).json({ data: verdict });
    } catch (error) { next(error); }
  });

  return router;
}
