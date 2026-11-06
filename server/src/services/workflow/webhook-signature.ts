import crypto from "node:crypto";

export const WEBHOOK_MAX_CLOCK_SKEW_SECONDS = 300;
export type WebhookSecretCandidate = { value: string; expiresAt?: Date | string | null };

const V2_DOMAIN = Buffer.from("papercompany-webhook-v2\0", "utf8");

/** v2 signs length-prefixed UTF-8 timestamp/key and the exact request bytes. */
function v2Message(timestamp: string, idempotencyKey: string, rawBody: Buffer | string): Buffer {
  const fields = [Buffer.from(timestamp, "utf8"), Buffer.from(idempotencyKey.trim(), "utf8"),
    Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8")];
  return Buffer.concat([V2_DOMAIN, ...fields.flatMap((field) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(field.length);
    return [length, field];
  })]);
}

/** Internal sender and public signature format: v2= followed by the HMAC hex. */
export function signWorkflowWebhook(secret: string, timestamp: string, idempotencyKey: string, rawBody: Buffer | string): string {
  return `v2=${crypto.createHmac("sha256", secret).update(v2Message(timestamp, idempotencyKey, rawBody)).digest("hex")}`;
}

/** Hash exactly the UTF-8-decoded message accepted by the legacy verifier. */
export function legacyWebhookMessageHash(timestamp: string, rawBody: Buffer | string): string {
  return crypto.createHash("sha256").update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex");
}

function isExpired(candidate: WebhookSecretCandidate, now: number): boolean {
  if (candidate.expiresAt == null) return false;
  const expiry = candidate.expiresAt instanceof Date
    ? candidate.expiresAt.getTime()
    : Date.parse(candidate.expiresAt);
  return Number.isFinite(expiry) && expiry <= now;
}

/** Verify v2 and, during migration, the legacy timestamp/body HMAC. */
export function verifyWebhookSignature(input: {
  timestamp: string;
  rawBody: Buffer | string;
  signature: string;
  idempotencyKey?: string;
  secrets: readonly WebhookSecretCandidate[];
}): boolean {
  const { timestamp, rawBody, signature, idempotencyKey, secrets } = input;
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > WEBHOOK_MAX_CLOCK_SKEW_SECONDS) return false;

  const isV2 = signature.startsWith("v2=");
  if (isV2 && (!idempotencyKey || !/^v2=[0-9a-f]{64}$/i.test(signature))) return false;
  const message = isV2
    ? v2Message(timestamp, idempotencyKey!, rawBody)
    : `${timestamp}.${rawBody.toString("utf8")}`;
  const provided = isV2 ? signature.slice(3) : signature;
  const now = Date.now();
  for (const candidate of secrets) {
    if (isExpired(candidate, now)) continue;
    const expected = crypto.createHmac("sha256", candidate.value).update(message).digest("hex");
    try {
      if (crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"))) return true;
    } catch {
      // Length-mismatched or non-hex signature — keep trying remaining secrets.
    }
  }
  return false;
}
