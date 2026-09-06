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
import { eq } from "drizzle-orm";
import { workflowWebhookConfigs, workflowWebhookDeliveries } from "@paperclipai/db";
import { logActivity } from "../services/activity-log.js";
import { workflowService } from "../services/workflow/engine.js";
import { applyRunInputDerivations } from "../services/workflow/run-input-derivations.js";
import {
  WebhookQuotaExceededError,
  admitWebhookDelivery,
  resolveWorkflowWebhookSecret,
  validateRequiredRunInputs,
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

    let delivery;
    let replay: boolean;
    try {
      const admitted = await admitWebhookDelivery(db, {
        companyId: config.companyId,
        workflowId,
        idempotencyKey,
        quota: { max: 60, windowMs: 3_600_000 },
      });
      delivery = admitted.delivery;
      replay = admitted.replay;
    } catch (error) {
      if (error instanceof WebhookQuotaExceededError) {
        res.status(429).json({ error: error.message });
        return;
      }
      throw error;
    }

    if (replay && delivery.runId) {
      res.status(202).json({ runId: delivery.runId, idempotencyKey });
      return;
    }

    const requiredError = validateRequiredRunInputs(definition.runInputs, payload);
    if (requiredError) {
      throw badRequest(requiredError);
    }
    const derivation = applyRunInputDerivations(definition.runInputs, payload);
    if (derivation.status === "error") {
      throw badRequest(derivation.message);
    }

    let result;
    try {
      result = await workflowService.trigger(db, {
        workflowId,
        companyId: config.companyId,
        triggerSource: "webhook",
        triggeredBy: "webhook",
        metadata: derivation.metadata,
      });
    } catch (error) {
      translateWorkflowDomainError(error);
    }

    await db
      .update(workflowWebhookDeliveries)
      .set({ runId: result.runId })
      .where(eq(workflowWebhookDeliveries.id, delivery.id));

    await logActivity(db, {
      companyId: config.companyId,
      actorType: "system",
      actorId: "webhook",
      action: "workflow_run.created",
      entityType: "workflow_run",
      entityId: result.runId,
      details: { triggerSource: "webhook", idempotencyKey },
    });

    res.status(202).json({ runId: result.runId, idempotencyKey });
  });

  return router;
}
