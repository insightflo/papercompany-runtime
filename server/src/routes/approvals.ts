import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  agentService,
  approvalService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import { forbidden, notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";
import { shouldEmitApprovalDecided, buildApprovalDecidedDetails } from "../services/approval-decision-event.js";
import { cardSummaryService, type CardSummaryRow } from "../services/card-summaries.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

/** 결정 대기 중인 카드 상태 — 이 카드들만 해석 자동 생성 대상. */
const DECISION_PENDING_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);

/** 표시용 해석 스냅숋(원문 폴백 판단은 UI 책임 — null이면 원문만). */
function serializeSummary(row: CardSummaryRow | null | undefined) {
  if (!row) return null;
  return {
    status: row.status,
    adapterType: row.adapterType,
    model: row.model,
    summary: row.summaryJson ?? null,
    error: row.error ?? null,
    updatedAt: row.updatedAt,
  };
}

/** 해석 입력은 운영자가 보는 것과 동일한 재편집본만 쓴다(비밀 원본 미전달). */
function buildApprovalSourceView(approval: { type: string; status: string; payload: Record<string, unknown> }) {
  const redacted = redactApprovalPayload(approval);
  return { kind: "approval" as const, type: redacted.type, status: redacted.status, payload: redacted.payload };
}

/** 조회 후킹(표시 전용): 결정 대기 카드의 해석을 늦은 생성/재기동하고 응답에 스냅숋만 붙인다. 응답을 막지 않는다. */
function attachApprovalSummaries(
  svc: ReturnType<typeof cardSummaryService>,
  companyId: string,
  approvals: Array<{ id: string; type: string; status: string; payload: Record<string, unknown> }>,
): Promise<Array<ReturnType<typeof serializeSummary>>> {
  return svc.getRows(companyId, "approval", approvals.map((a) => a.id)).then((rows) =>
    approvals.map((approval) => {
      const row = rows.get(approval.id);
      if (DECISION_PENDING_APPROVAL_STATUSES.has(approval.status)) {
        const view = buildApprovalSourceView(approval);
        if (!row || row.status !== "done") {
          void svc.ensureSummary(companyId, "approval", approval.id, view).catch((err) =>
            logger.error({ err: String(err), approvalId: approval.id }, "approval summary ensure failed"),
          );
        }
      }
      return serializeSummary(row);
    }),
  );
}

async function assertCanResolveApproval(
  req: Request,
  approval: { companyId: string },
  agentsSvc: ReturnType<typeof agentService>,
) {
  if (req.actor.type === "board") {
    assertCompanyAccess(req, approval.companyId);
    return;
  }

  assertCompanyAccess(req, approval.companyId);
  if (req.actor.type !== "agent" || !req.actor.agentId) {
    assertBoard(req);
    return;
  }

  const resolver = await agentsSvc.getById(req.actor.agentId);
  if (
    !resolver ||
    resolver.companyId !== approval.companyId ||
    resolver.reportsTo !== null ||
    resolver.status === "terminated"
  ) {
    throw forbidden("Root CEO agent access required");
  }
}

function getApprovalDecisionActor(req: Request) {
  const actor = getActorInfo(req);
  return {
    ...actor,
    decisionId: actor.actorType === "agent" ? `agent:${actor.actorId}` : actor.actorId,
  };
}

async function logApprovalDecidedEvent(
  db: Db,
  approval: { id: string; companyId: string; type: string; status: string; requestedByPluginId: string | null },
  actor: { actorType: "agent" | "user" | "system"; actorId: string; agentId?: string | null },
  decision: "approved" | "rejected",
) {
  // Only plugin-requested approvals get a resolution broadcast, and only the
  // minimal metadata the originating plugin needs to react. The full approval
  // payload is never included in the broadcast; the originating plugin already
  // holds the commit identity it recorded when creating the approval.
  if (!shouldEmitApprovalDecided(approval)) return;
  await logActivity(db, {
    companyId: approval.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    action: "approval.decided",
    entityType: "approval",
    entityId: approval.id,
    details: buildApprovalDecidedDetails(approval, decision),
  });
}

export function approvalRoutes(db: Db) {
  const router = Router();
  const svc = approvalService(db);
  const heartbeat = heartbeatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const agentsSvc = agentService(db);
  const summariesSvc = cardSummaryService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    const redacted = result.map((approval) => redactApprovalPayload(approval));
    const summaries = await attachApprovalSummaries(summariesSvc, companyId, redacted);
    res.json(redacted.map((approval, i) => ({ ...approval, humanSummary: summaries[i] ?? null })));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const redacted = redactApprovalPayload(approval);
    const [summary] = await attachApprovalSummaries(summariesSvc, approval.companyId, [redacted]);
    res.json({ ...redacted, humanSummary: summary ?? null });
  });

  /** [휴먼카드 해석] 화면의 '다시 해석' — 표시 전용. board 권한만. */
  router.post("/approvals/:id/summary/retranslate", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, approval.companyId);
    const adapterType = typeof req.body?.adapterType === "string" ? req.body.adapterType : undefined;
    const model = typeof req.body?.model === "string" ? req.body.model : undefined;
    const row = await summariesSvc.retranslate(approval.companyId, "approval", approval.id, {
      adapterType,
      model,
      view: buildApprovalSourceView(approval),
    });
    res.json({ id: approval.id, humanSummary: serializeSummary(row) });
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) throw notFound("Approval not found");
    await assertCanResolveApproval(req, existing, agentsSvc);
    const actor = getApprovalDecisionActor(req);
    const { approval, applied } = await svc.approve(
      id,
      actor.actorType === "agent" ? actor.decisionId : req.body.decidedByUserId,
      req.body.decisionNote,
    );

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      await logApprovalDecidedEvent(db, approval, actor, "approved");

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) throw notFound("Approval not found");
    await assertCanResolveApproval(req, existing, agentsSvc);
    const actor = getApprovalDecisionActor(req);
    const { approval, applied } = await svc.reject(
      id,
      actor.actorType === "agent" ? actor.decisionId : req.body.decidedByUserId,
      req.body.decisionNote,
    );

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      await logApprovalDecidedEvent(db, approval, actor, "rejected");
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) throw notFound("Approval not found");
      await assertCanResolveApproval(req, existing, agentsSvc);
      const actor = getApprovalDecisionActor(req);
      const approval = await svc.requestRevision(
        id,
        actor.actorType === "agent" ? actor.decisionId : req.body.decidedByUserId,
        req.body.decisionNote,
      );

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
