import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { hashSnapshotState, signSnapshot, verifySnapshot } from "../services/workflow/resume/snapshot.js";
import { KEY_A, NOW, signSegments, snapshotState } from "./helpers/workflow-resume-snapshot-fixture.js";

/**
 * [purpose] Task5c1 fix1 — envelope wire bytes must be exactly valid UTF8: a decoded
 *   envelope whose bytes contain invalid sequences (lone 0xFF masked as U+FFFD) must be
 *   rejected even when re-signed, while a literal U+FFFD token stays accepted. Also
 *   proves the sign-side token cap rejects a schema-valid max-steps state uniformly.
 */

const STALE = "stale_snapshot";
const REPLACEMENT_BYTES = Buffer.from([0xef, 0xbf, 0xbd]);

function envelopeBytesOf(token: string): Buffer {
  return Buffer.from(token.split(".")[0] ?? "", "base64url");
}

/** Parent-reproduced INVALID_UTF8_ACCEPTED: swap the U+FFFD status bytes for a lone 0xFF. */
function invalidUtf8Variant(token: string): string {
  const bytes = envelopeBytesOf(token);
  const first = bytes.indexOf(REPLACEMENT_BYTES);
  const last = bytes.lastIndexOf(REPLACEMENT_BYTES);
  if (first < 0 || first !== last) {
    throw new Error("fixture envelope must contain exactly one U+FFFD sequence");
  }
  const tampered = Buffer.concat([
    bytes.subarray(0, first),
    Buffer.from([0xff]),
    bytes.subarray(first + REPLACEMENT_BYTES.length),
  ]);
  expect(tampered.includes(0xff)).toBe(true);
  expect(tampered.toString("utf8")).toContain("\uFFFD"); // decoder masks 0xFF as U+FFFD
  expect(tampered.equals(bytes)).toBe(false);
  return signSegments(tampered.toString("base64url"), KEY_A);
}

describe("envelope UTF8 byte fidelity", () => {
  it("rejects a validly-signed envelope whose bytes are not valid UTF8 (lone 0xFF)", () => {
    const state = snapshotState();
    state.mission.status = "\uFFFD"; // the only non-ASCII sequence in the envelope
    const token = signSnapshot(state, KEY_A, NOW);
    expect(verifySnapshot(token, KEY_A, NOW)).toEqual(state);
    expect(() => verifySnapshot(invalidUtf8Variant(token), KEY_A, NOW)).toThrowError(STALE);
  });

  it("accepts a literal replacement-character token as valid UTF8", () => {
    const state = snapshotState();
    state.mission.status = "\uFFFD";
    const token = signSnapshot(state, KEY_A, NOW);
    expect(state.mission.status).toBe("\uFFFD");
    expect(verifySnapshot(token, KEY_A, NOW).mission.status).toBe("\uFFFD");
  });
});

describe("sign-side token cap", () => {
  it("rejects a schema-valid 10000-step state with the uniform 409 stale_snapshot", () => {
    const state = snapshotState();
    const initial = state.steps[0]; // stepId "step-1" — preserves initial start + approval ref
    state.steps = [
      { ...initial },
      ...Array.from({ length: 9999 }, (_unused, i) => ({
        id: randomUUID(),
        stepId: `s${i + 1}`, // short unique stepId keeps the state schema-valid
        status: "pending",
        executionGeneration: 0,
        statusTransitionVersion: 0,
        dispatchOwnerWakeupRequestId: null,
        dispatchOwnerHeartbeatRunId: null,
        lastDispatchRequestId: null,
      })),
    ];
    expect(state.steps).toHaveLength(10000);
    expect(hashSnapshotState(state)).toMatch(/^[0-9a-f]{64}$/); // valid state, size is the only issue
    let caught: unknown;
    try {
      signSnapshot(state, KEY_A, NOW);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const httpError = caught as HttpError;
    expect(httpError.status).toBe(409);
    expect(httpError.message).toBe(STALE);
  });
});
