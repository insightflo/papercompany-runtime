/**
 * Workflow Webhook Route (public)
 *
 * POST /webhooks/workflows/:workflowId
 *
 * Public ingress for n8n-style workflow triggers. Mounted with a 64KiB
 * express.raw parser BEFORE the global 10MB json parser (see app.ts) so
 * oversized bodies are rejected before any larger limit applies.
 *
 * Headers:
 * - X-Timestamp:        unix seconds, ±300s skew
 * - X-Idempotency-Key:  1-200 chars, replay protection (covered by signature)
 * - X-Signature:        HMAC-SHA256("${timestamp}.${rawBody}") hex
 *
 * Body: UTF-8 JSON object only. triggerSource "webhook" is additive.
 */

import type { ErrorRequestHandler, Request, Response } from "express";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { workflowRuns, workflowWebhookConfigs, workflowWebhookDeliveries } from "@paperclipai/db";
import { logActivity } from "../services/activity-log.js";
import { logger } from "../middleware/logger.js";
import { ensureMissionWorkingNote } from "../services/missions/mission-working-note.js";
import { workflowService } from "../services/workflow/engine.js";
import { WorkflowRunInputValidationError } from "../services/workflow/run-input-normalization.js";
import {
  WebhookQuotaExceededError,
  admitWebhookDelivery,
  resolveWorkflowWebhookSecret,
  verifyWebhookSignature,
} from "../services/workflow/workflow-webhook.js";
import { badRequest, conflict, notFound, unauthorized } from "../errors.js";

const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rawBodyOf(req: Request): Buffer | null {
  const raw = (req as unknown as { body?: unknown }).body;
  return Buffer.isBuffer(raw) ? raw : null;
}

/**
 * Maps body-parser errors from the 64KiB raw parser to JSON error responses.
 * Mounted next to the raw parser in app.ts, before the global errorHandler.
 */
export const webhookRawBodyErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const bodyParserError = err as { type?: string; statusCode?: number; status?: number };
  if (bodyParserError?.type === "entity.too.large") {
    res.status(413).json({ error: "Webhook body exceeds the 64KiB limit" });
    return;
  }
  if (typeof bodyParserError?.statusCode === "number" && bodyParserError.statusCode < 500) {
    res.status(bodyParserError.statusCode).json({ error: "Invalid webhook request body" });
    return;
  }
  next(err);
};

function translateWorkflowDomainError(error: unknown): never {
  // [typed run-input error] 엔진 정규화 실패(웹훅은 legacy text required 정책 포함)를
  // 구조화 details를 담아 400으로 번역한다. 기존 매핑(정의 없음 → 404, DAG/runInputs → 409)은 유지.
  if (error instanceof WorkflowRunInputValidationError) {
    throw badRequest(error.message, error.details);
  }
  if (error instanceof Error) {
    if (error.message.startsWith("Workflow definition not found:")) {
      throw notFound("Workflow definition not found");
    }
    if (error.message.startsWith("Workflow does not belong to company:")) {
      throw notFound("Workflow definition not found");
    }
    if (error.message.startsWith("Invalid workflow DAG:") || error.message.startsWith("Invalid workflow runInputs:")) {
      throw conflict(error.message);
    }
  }
  throw error;
}

export function workflowWebhookRoutes(db: Db) {
  const router = Router();

  router.post("/webhooks/workflows/:workflowId", async (req: Request, res: Response) => {
    const workflowId = req.params.workflowId as string;
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      res.status(415).json({ error: "Content-Type must be application/json" });
      return;
    }

    const rawBody = rawBodyOf(req);
    if (!rawBody || rawBody.length === 0) {
      res.status(400).json({ error: "Body must be a JSON object" });
      return;
    }

    const timestamp = typeof req.headers["x-timestamp"] === "string"
      ? (req.headers["x-timestamp"] as string)
      : undefined;
    const signature = typeof req.headers["x-signature"] === "string"
      ? (req.headers["x-signature"] as string)
      : undefined;
    const idempotencyKeyRaw = typeof req.headers["x-idempotency-key"] === "string"
      ? (req.headers["x-idempotency-key"] as string)
      : undefined;
    const idempotencyKey = idempotencyKeyRaw?.trim();
    if (!timestamp || !signature || !idempotencyKey || idempotencyKey.length < 1 || idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      res.status(400).json({
        error: "Missing or invalid required headers: X-Timestamp, X-Idempotency-Key (1-200 chars), X-Signature",
      });
      return;
    }

    const definition = await workflowService.getDefinition(db, workflowId);
    if (!definition) {
      throw notFound("Workflow definition not found");
    }
    const [config] = await db
      .select()
      .from(workflowWebhookConfigs)
      .where(eq(workflowWebhookConfigs.workflowId, workflowId))
      .limit(1);
    if (!config || !config.enabled || definition.status !== "active") {
      throw conflict("Workflow webhook is not enabled");
    }

    const webhookSecrets = await resolveWorkflowWebhookSecret(db, {
      companyId: config.companyId,
      secretRef: config.secretRef,
    });
    const verified = webhookSecrets
      ? verifyWebhookSignature({
        timestamp,
        rawBody,
        signature,
        secrets: webhookSecrets.previous
          ? [
            { value: webhookSecrets.current },
            { value: webhookSecrets.previous.value, expiresAt: webhookSecrets.previous.expiresAt },
          ]
          : [{ value: webhookSecrets.current }],
      })
      : false;
    if (!verified) {
      throw unauthorized("Invalid webhook signature");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw badRequest("Body must be valid JSON");
    }
    const payload = asRecord(parsed);
    if (!payload) {
      throw badRequest("Body must be a JSON object");
    }

    let binding: { runId: string; replay: boolean; missionId: string | null };
    try {
      // Admission is durable even when validation or run preparation fails: it
      // represents the delivery and its quota debit, not a successful run.
      const { delivery } = await admitWebhookDelivery(db, {
        companyId: config.companyId,
        workflowId,
        idempotencyKey,
        quota: { max: 60, windowMs: 3_600_000 },
      });
      binding = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        // Lock both new and unbound existing receipts until creation and binding
        // commit. A concurrent replay cannot create a second run.
        const [locked] = await tx.select().from(workflowWebhookDeliveries)
          .where(eq(workflowWebhookDeliveries.id, delivery.id)).for("update");
        if (!locked) throw new Error("webhook delivery receipt vanished before binding");
        if (locked.runId) return { runId: locked.runId, replay: true, missionId: null };
        const prepared = await workflowService.prepareTrigger(t, {
          workflowId,
          companyId: config.companyId,
          triggerSource: "webhook",
          triggeredBy: "webhook",
          metadata: payload,
        }, { legacyTextRequired: true }, { deferWorkingNote: true });
        await tx.update(workflowWebhookDeliveries).set({ runId: prepared.run.id })
          .where(eq(workflowWebhookDeliveries.id, locked.id));
        return { runId: prepared.run.id, replay: false, missionId: prepared.run.missionId };
      });
    } catch (error) {
      if (error instanceof WebhookQuotaExceededError) {
        res.status(429).json({ error: error.message });
        return;
      }
      translateWorkflowDomainError(error);
    }

    const [boundRun] = await db.select({ status: workflowRuns.status, missionId: workflowRuns.missionId })
      .from(workflowRuns).where(and(eq(workflowRuns.id, binding.runId),
        eq(workflowRuns.companyId, config.companyId), eq(workflowRuns.workflowId, workflowId),
        eq(workflowRuns.triggerSource, "webhook"))).limit(1);
    // A replay after a crash between commit and start may start the same pending run.
    // claimPlainWorkflowStart serializes concurrent starts of that run.
    if (!binding.replay || boundRun?.status === "pending") {
      const missionId = binding.missionId ?? boundRun?.missionId;
      if (missionId) {
        try { await ensureMissionWorkingNote({ companyId: config.companyId, missionId }); }
        catch (err) { logger.warn({ err, missionId, companyId: config.companyId }, "failed to provision mission working note at create"); }
      }
      try { await workflowService.startPreparedRun(db, binding.runId); }
      catch (error) { translateWorkflowDomainError(error); }
    }
    if (!binding.replay) {
      await logActivity(db, {
        companyId: config.companyId,
        actorType: "system",
        actorId: "webhook",
        action: "workflow_run.created",
        entityType: "workflow_run",
        entityId: binding.runId,
        details: { triggerSource: "webhook", idempotencyKey },
      });
    }

    res.status(202).json({ runId: binding.runId, idempotencyKey });
  });

  return router;
}
