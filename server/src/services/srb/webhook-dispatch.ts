import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { srbWebhookDeliveries } from "../../routes/metrics.js";
import { getAlertRules } from "../alert-rules.js";
import { secretService } from "../secrets.js";
import { createSRBRouter, type SRBRoutingInput } from "./router.js";
import {
  buildSrbHeaders,
  buildSrbHmacSignature,
  buildSrbWebhookBody,
  insertSrbDeliveryLog,
  sendSrbWebhookRequest,
  updateSrbDeliveryLog,
} from "./shared.js";
import { computeNextRetryAt } from "./delivery-retry-worker.js";

export interface SRBWebhookDispatchResult {
  path: "webhook";
  deliveryId: string;
  status: "delivered" | "failed";
  httpStatus: number | null;
  nextRetryAt: Date | null;
}

export function createWebhookDispatch(
  db: Db,
  deps?: { fetchImpl?: typeof fetch },
) {
  const router = createSRBRouter(db);
  const secrets = secretService(db);

  return {
    async dispatch(input: SRBRoutingInput): Promise<SRBWebhookDispatchResult> {
      const route = await router.route(input);
      if (route.path !== "webhook" || !route.remoteServerUrl) {
        throw new Error(`SRB link ${input.linkId} does not route to the webhook path`);
      }

      const body = buildSrbWebhookBody(input.event, input.payload);
      const delivery = await insertSrbDeliveryLog(db, {
        linkId: route.linkId,
        event: input.event,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        status: "pending",
        attemptCount: 0,
      });

      const lastAttemptAt = new Date();
      let httpStatus: number | null = null;

      try {
        if (!route.sharedSecretId) {
          throw new Error(`SRB link ${route.linkId} has no shared secret configured`);
        }

        const timestamp = Math.floor(Date.now() / 1000);
        const secretValue = await secrets.resolveSecretValue(
          route.localCompanyId,
          route.sharedSecretId,
          "latest",
        );
        const signature = buildSrbHmacSignature(body, timestamp, secretValue);
        const headers = buildSrbHeaders({
          linkId: route.linkId,
          timestamp,
          idempotencyKey: input.idempotencyKey,
          signature,
        });

        const response = await sendSrbWebhookRequest({
          url: route.remoteServerUrl,
          body,
          headers,
          fetchImpl: deps?.fetchImpl,
        });
        httpStatus = response.status;

        if (response.ok || response.status === 409) {
          await updateSrbDeliveryLog(db, delivery.id, {
            status: "delivered",
            attemptCount: 1,
            lastAttemptAt,
            nextRetryAt: null,
          });
          srbWebhookDeliveries.inc({ status: "delivered" });
          getAlertRules().recordSrbSuccess();
          return {
            path: "webhook",
            deliveryId: delivery.id,
            status: "delivered",
            httpStatus,
            nextRetryAt: null,
          };
        }
      } catch (err) {
        logger.warn({ err, linkId: route.linkId }, "SRB webhook dispatch failed");
      }

      const nextRetryAt = computeNextRetryAt(1);
      await updateSrbDeliveryLog(db, delivery.id, {
        status: "failed",
        attemptCount: 1,
        lastAttemptAt,
        nextRetryAt,
      });
      srbWebhookDeliveries.inc({ status: "failed" });
      getAlertRules().recordSrbFailure();
      return {
        path: "webhook",
        deliveryId: delivery.id,
        status: "failed",
        httpStatus,
        nextRetryAt,
      };
    },
  };
}
