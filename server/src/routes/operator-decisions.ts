import { eq } from "drizzle-orm";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import {
  cancelOperatorDecisionSchema,
  createOperatorDecisionSchema,
  operatorDecisionListQuerySchema,
  operatorDecisionResolveInputSchema,
  retryOperatorDecisionContinuationSchema,
} from "@paperclipai/shared/validators/operator-decision";
import { forbidden, unauthorized } from "../errors.js";
import { heartbeatService } from "../services/heartbeat.js";
import { logActivity } from "../services/activity-log.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { operatorDecisionReadService } from "../services/operator-decisions-read.js";
import {
  operatorDecisionWriteService,
  type OperatorDecisionActor,
} from "../services/operator-decisions-write.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function requestActor(req: Request): OperatorDecisionActor {
  if (req.actor.type === "agent") {
    if (!req.actor.agentId) throw unauthorized();
    return { type: "agent", id: req.actor.agentId };
  }
  if (req.actor.type === "board") return { type: "user", id: req.actor.userId ?? "board" };
  throw unauthorized();
}

function boardUserId(req: Request): string {
  assertBoard(req);
  return req.actor.type === "board" ? req.actor.userId ?? "board" : "board";
}

export function operatorDecisionRoutes(db: Db) {
  const router = Router();
  const read = operatorDecisionReadService(db);
  const write = operatorDecisionWriteService(db);
  const heartbeat = heartbeatService(db);

  router.post(
    "/companies/:companyId/operator-decisions",
    validate(createOperatorDecisionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await write.create(companyId, req.body, requestActor(req));
      res.status(result.replayed ? 200 : 201).json({ data: result.decision, replayed: result.replayed });
    },
  );

  router.get("/companies/:companyId/operator-decisions", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = operatorDecisionListQuerySchema.parse(req.query);
    res.json(await read.list(companyId, parsed));
  });

  router.get("/operator-decisions/:id", async (req, res) => {
    const decision = await read.getRequired(req.params.id as string);
    assertCompanyAccess(req, decision.companyId);
    if (req.actor.type === "agent") {
      const requester = decision.requestedBy?.type === "agent" && decision.requestedBy.id === req.actor.agentId;
      const currentAssignee = decision.issueId
        ? await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues)
          .where(eq(issues.id, decision.issueId)).then((rows) => rows[0]?.assigneeAgentId ?? null)
        : null;
      if (!requester && currentAssignee !== req.actor.agentId) {
        throw forbidden("Agent cannot view this operator decision");
      }
    }
    res.json({ data: decision });
  });

  router.post(
    "/operator-decisions/:id/resolve",
    validate(operatorDecisionResolveInputSchema),
    async (req, res) => {
      const decision = await read.getRequired(req.params.id as string);
      assertCompanyAccess(req, decision.companyId);
      const userId = boardUserId(req);
      const result = await write.resolve(decision.id, req.body, userId);
      // 즉시 assignee 웨이크업 — 승인 즉시 후속 완료 처리가 이어지도록 한다.
      // (operator_decision_continuations 재시도 스케줄은 안전망으로 유지 — 백오프 지연 방지)
      if (result.decision.issueId) {
        const assignee = await db
          .select({ assigneeAgentId: issues.assigneeAgentId })
          .from(issues)
          .where(eq(issues.id, result.decision.issueId))
          .then((rows) => rows[0]?.assigneeAgentId ?? null);
        if (assignee) {
          try {
            const wake = await heartbeat.wakeup(assignee, {
              source: "automation",
              triggerDetail: "system",
              reason: "operator_decision_resolved_assignee_wakeup",
              payload: {
                operatorDecisionId: result.decision.id,
                issueId: result.decision.issueId,
                mutation: "operator_decision_resolved",
              },
              idempotencyKey: `operator-decision-resolved:${result.decision.id}`,
            });
            await logActivity(db, {
              companyId: decision.companyId,
              actorType: "user",
              actorId: userId,
              action: "operator_decision.assignee_wakeup_queued",
              entityType: "operator_decision",
              entityId: result.decision.id,
              details: {
                schemaVersion: 1,
                operatorDecisionId: result.decision.id,
                issueId: result.decision.issueId,
                assigneeAgentId: assignee,
                wakeupId: wake?.id ?? null,
              },
            });
          } catch (err) {
            logger.warn({ err, operatorDecisionId: result.decision.id }, "assignee wakeup after operator decision resolve failed — continuation retry remains");
            await logActivity(db, {
              companyId: decision.companyId,
              actorType: "user",
              actorId: userId,
              action: "operator_decision.assignee_wakeup_failed",
              entityType: "operator_decision",
              entityId: result.decision.id,
              details: {
                schemaVersion: 1,
                operatorDecisionId: result.decision.id,
                issueId: result.decision.issueId,
                error: String((err as any)?.message ?? err).slice(0, 200),
              },
            });
          }
        }
      }
      res.json({ data: result });
    },
  );

  router.post(
    "/operator-decisions/:id/cancel",
    validate(cancelOperatorDecisionSchema),
    async (req, res) => {
      const decision = await read.getRequired(req.params.id as string);
      assertCompanyAccess(req, decision.companyId);
      res.json({ data: await write.cancel(decision.id, requestActor(req)) });
    },
  );

  router.post(
    "/operator-decisions/:id/retry-continuation",
    validate(retryOperatorDecisionContinuationSchema),
    async (req, res) => {
      const decision = await read.getRequired(req.params.id as string);
      assertCompanyAccess(req, decision.companyId);
      const userId = boardUserId(req);
      res.json({ data: await write.retryContinuation(decision.id, userId) });
    },
  );

  return router;
}
