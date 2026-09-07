import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateWebhookSecret,
  verifyWebhookSignature,
  webhookSecretLast4,
} from "../services/workflow/workflow-webhook.js";

function sign(secret: string, timestamp: string, rawBody: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}

const RAW_BODY = JSON.stringify({ event: "test", value: 1 });

describe("generateWebhookSecret / webhookSecretLast4", () => {
  it("generates urlsafe 32-byte secrets with distinct values", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("derives last4 helper", () => {
    expect(webhookSecretLast4("abcdefgh")).toBe("efgh");
  });
});

describe("verifyWebhookSignature", () => {
  const secret = generateWebhookSecret();
  const nowSeconds = Math.floor(Date.now() / 1000);

  it("accepts a valid signature inside the ±300s window", () => {
    const ts = String(nowSeconds);
    expect(
      verifyWebhookSignature({
        timestamp: ts,
        rawBody: RAW_BODY,
        signature: sign(secret, ts, RAW_BODY),
        secrets: [{ value: secret }],
      }),
    ).toBe(true);
  });

  it("rejects a stale timestamp outside ±300s", () => {
    const ts = String(nowSeconds - 301);
    expect(
      verifyWebhookSignature({
        timestamp: ts,
        rawBody: RAW_BODY,
        signature: sign(secret, ts, RAW_BODY),
        secrets: [{ value: secret }],
      }),
    ).toBe(false);
  });

  it("rejects a wrong signature", () => {
    const ts = String(nowSeconds);
    expect(
      verifyWebhookSignature({
        timestamp: ts,
        rawBody: RAW_BODY,
        signature: sign("other-secret", ts, RAW_BODY),
        secrets: [{ value: secret }],
      }),
    ).toBe(false);
  });

  it("rejects a malformed signature (not hex / wrong length)", () => {
    const ts = String(nowSeconds);
    expect(
      verifyWebhookSignature({
        timestamp: ts,
        rawBody: RAW_BODY,
        signature: "not-hex",
        secrets: [{ value: secret }],
      }),
    ).toBe(false);
  });

  it("rejects a body/timestamp mismatch (idempotency key covered by signature)", () => {
    const ts = String(nowSeconds);
    const tampered = RAW_BODY.replace("test", "evil");
    expect(
      verifyWebhookSignature({
        timestamp: ts,
        rawBody: tampered,
        signature: sign(secret, ts, RAW_BODY),
        secrets: [{ value: secret }],
      }),
    ).toBe(false);
  });

  it("accepts a signature made with the previous secret inside the rotation window", () => {
    const ts = String(nowSeconds);
    expect(
      verifyWebhookSignature({
        timestamp: ts,
        rawBody: RAW_BODY,
        signature: sign("previous-secret", ts, RAW_BODY),
        secrets: [
          { value: secret },
          { value: "previous-secret", expiresAt: new Date(Date.now() + 60_000) },
        ],
      }),
    ).toBe(true);
  });

  it("rejects a signature made with an expired previous secret", () => {
    const ts = String(nowSeconds);
    expect(
      verifyWebhookSignature({
        timestamp: ts,
        rawBody: RAW_BODY,
        signature: sign("previous-secret", ts, RAW_BODY),
        secrets: [
          { value: secret },
          { value: "previous-secret", expiresAt: new Date(Date.now() - 60_000) },
        ],
      }),
    ).toBe(false);
  });

  it("rejects an empty secrets list", () => {
    const ts = String(nowSeconds);
    expect(
      verifyWebhookSignature({
        timestamp: ts,
        rawBody: RAW_BODY,
        signature: sign(secret, ts, RAW_BODY),
        secrets: [],
      }),
    ).toBe(false);
  });
});
