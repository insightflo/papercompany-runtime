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
      res.json({ data: await write.resolve(decision.id, req.body, userId) });
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
