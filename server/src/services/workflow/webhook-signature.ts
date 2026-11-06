import crypto from "node:crypto";

export const WEBHOOK_MAX_CLOCK_SKEW_SECONDS = 300;
export type WebhookSecretCandidate = { value: string; expiresAt?: Date | string | null };

/** Internal v1 sender: the separate idempotency key is not signed by this format. */
export function signWorkflowWebhook(secret: string, timestamp: string, _idempotencyKey: string, rawBody: Buffer | string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex");
}

function isExpired(candidate: WebhookSecretCandidate, now: number): boolean {
  if (candidate.expiresAt == null) return false;
  const expiry = candidate.expiresAt instanceof Date
    ? candidate.expiresAt.getTime()
    : Date.parse(candidate.expiresAt);
  return Number.isFinite(expiry) && expiry <= now;
}

/**
 * Verify an HMAC-SHA256 signature against the live secrets.
 * Signature format: HMAC-SHA256("${timestamp}.${body}", secret) hex digest,
 * compared with crypto.timingSafeEqual. Expired candidates are skipped.
 */
export function verifyWebhookSignature(input: {
  timestamp: string;
  rawBody: Buffer | string;
  signature: string;
  secrets: readonly WebhookSecretCandidate[];
}): boolean {
  const { timestamp, rawBody, signature, secrets } = input;
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > WEBHOOK_MAX_CLOCK_SKEW_SECONDS) return false;

  const now = Date.now();
  const message = `${timestamp}.${rawBody.toString("utf8")}`;
  for (const candidate of secrets) {
    if (isExpired(candidate, now)) continue;
    const expected = crypto
      .createHmac("sha256", candidate.value)
      .update(message)
      .digest("hex");
    try {
      if (crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) {
        return true;
      }
    } catch {
      // Length-mismatched or non-hex signature — keep trying remaining secrets.
    }
  }
  return false;
}

