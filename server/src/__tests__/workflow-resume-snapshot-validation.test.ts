import { describe, expect, it } from "vitest";
import { hashSnapshotState, signSnapshot, verifySnapshot } from "../services/workflow/resume/snapshot.js";
import type { SnapshotState } from "../services/workflow/resume/snapshot-state.js";
import {
  HASH_A,
  HASH_B,
  KEY_A,
  KEY_B,
  NOW,
  encodeText,
  envelopeText,
  flipped,
  nonCanonicalEncoding,
  reSign,
  signSegments,
  snapshotState,
  stateWith,
} from "./helpers/workflow-resume-snapshot-fixture.js";

/**
 * [purpose] Task5c1 signed snapshot rejection contract — uniform public `stale_snapshot`
 *   error for bad runtime inputs (key/now), malformed/noncanonical tokens, tampered or
 *   re-signed-but-inconsistent envelopes, and schema-invalid snapshot state values.
 *   Real crypto only; no engine/DB/reader involvement.
 */

const STALE = "stale_snapshot";
const validToken = signSnapshot(snapshotState(), KEY_A, NOW);
function stale(fn: () => unknown): void {
  expect(fn).toThrowError(STALE);
}

/** Type-loose field write — rejection tests intentionally violate declared TS types. */
function set(target: object, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

function reVerified(mutate: (envelope: Record<string, unknown>) => void): () => unknown {
  return () => verifySnapshot(reSign(validToken, KEY_A, mutate), KEY_A, NOW);
}

describe("runtime inputs — key and now", () => {
  it.each([0, 31, 33, 64])("rejects Buffer key of %d bytes", (length) => {
    const key = Buffer.alloc(length, 7);
    stale(() => signSnapshot(snapshotState(), key, NOW));
    stale(() => verifySnapshot(validToken, key, NOW));
  });
  it.each([
    ["string", "a".repeat(32)],
    ["Uint8Array", new Uint8Array(32)],
    ["null", null],
    ["undefined", undefined],
    ["number", 123],
  ])("rejects non-Buffer key (%s)", (_name, key) => {
    stale(() => signSnapshot(snapshotState(), key as Buffer, NOW));
    stale(() => verifySnapshot(validToken, key as Buffer, NOW));
  });
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["invalid Date", new Date("not-a-date")],
    ["number", 0],
    ["string", "2024-01-15T10:30:01.000Z"],
  ])("rejects invalid now (%s)", (_name, now) => {
    stale(() => signSnapshot(snapshotState(), KEY_A, now as Date));
    stale(() => verifySnapshot(validToken, KEY_A, now as Date));
  });
});
describe("token envelope format", () => {
  it.each(["", ".", "..", "a", "a.b.c", ".a", "a.", "a..b"])("rejects malformed segment structure %j", (token) => {
    stale(() => verifySnapshot(token, KEY_A, NOW));
  });
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["object", {}],
    ["array", []],
    ["boolean", true],
  ])("rejects non-string token (%s)", (_name, token) => {
    stale(() => verifySnapshot(token as string, KEY_A, NOW));
  });
  it("rejects oversize tokens before decode/parse", () => {
    stale(() => verifySnapshot("a".repeat(17_000), KEY_A, NOW));
    const [envSeg, sigSeg] = validToken.split(".");
    const grown = envSeg + "A".repeat(17_000);
    expect(grown.length + sigSeg.length + 1).toBeGreaterThan(16_384);
    stale(() => verifySnapshot(grown + "." + sigSeg, KEY_A, NOW));
  });
  it("rejects base64url padding in either segment", () => {
    const [envSeg, sigSeg] = validToken.split(".");
    stale(() => verifySnapshot(envSeg + "=" + "." + sigSeg, KEY_A, NOW));
    stale(() => verifySnapshot(envSeg + "." + sigSeg + "==", KEY_A, NOW));
  });
  it("rejects noncanonical base64url encoding", () => {
    const [envSeg, sigSeg] = validToken.split(".");
    const nonCanonical = nonCanonicalEncoding(envSeg);
    expect(nonCanonical).not.toBe(envSeg);
    stale(() => verifySnapshot(nonCanonical + "." + sigSeg, KEY_A, NOW));
  });
  it("rejects wrong-size or tampered signatures", () => {
    const [envSeg, sigSeg] = validToken.split(".");
    stale(() => verifySnapshot(envSeg + "." + sigSeg.slice(0, -1), KEY_A, NOW));
    stale(() => verifySnapshot(envSeg + "." + sigSeg + "A", KEY_A, NOW));
    stale(() => verifySnapshot(envSeg + "." + flipped(sigSeg), KEY_A, NOW));
    stale(() => verifySnapshot(flipped(envSeg) + "." + sigSeg, KEY_A, NOW));
  });
});
describe("signature and integrity (re-signed with the correct key)", () => {
  it("rejects a tampered stateHash", () => {
    stale(reVerified((e) => { set(e, "stateHash", HASH_B); }));
  });
  it("rejects a tampered keyId", () => {
    stale(reVerified((e) => { set(e, "keyId", "f".repeat(16)); }));
  });
  it("rejects a token signed with a different key even when re-signed", () => {
    const otherKeyToken = reSign(validToken, KEY_B, () => {});
    stale(() => verifySnapshot(otherKeyToken, KEY_A, NOW));
  });
});
describe("envelope and state schema (re-signed, missing/unknown/wrong keys)", () => {
  it.each(["schemaVersion", "keyId", "stateHash", "issuedAt", "expiresAt", "state"])(
    "rejects envelope missing %s",
    (key) => stale(reVerified((e) => { delete (e as Record<string, unknown>)[key]; })),
  );

  it("rejects unknown envelope key", () => {
    stale(reVerified((e) => { set(e, "extra", true); }));
  });
  it("rejects wrong envelope schemaVersion", () => {
    stale(reVerified((e) => { set(e, "schemaVersion", 2); }));
  });
  it("rejects wrong state schemaVersion", () => {
    stale(reVerified((e) => { set((e as { state: object }).state, "schemaVersion", 2); }));
  });
  it.each([
    ["state.scope.companyId", (s: SnapshotState) => { delete (s.scope as Record<string, unknown>).companyId; }],
    ["state.run.status", (s: SnapshotState) => { delete (s.run as Record<string, unknown>).status; }],
    ["state.steps[0].executionGeneration", (s: SnapshotState) => { delete (s.steps[0] as Record<string, unknown>).executionGeneration; }],
    ["state.mission", (s: SnapshotState) => { delete (s as Record<string, unknown>).mission; }],
    ["state.factsHash", (s: SnapshotState) => { delete (s as Record<string, unknown>).factsHash; }],
  ])("rejects state missing %s", (_name, mutate) => {
    stale(reVerified((e) => { mutate((e as { state: SnapshotState }).state); }));
  });
  it("rejects unknown nested state keys", () => {
    stale(reVerified((e) => { set((e as { state: object }).state, "extra", 1); }));
    stale(reVerified((e) => {
      const state = (e as { state: SnapshotState }).state;
      set(state.scope, "extra", 1);
    }));
    stale(reVerified((e) => { set((e as { state: SnapshotState }).state.steps[0], "extra", 1); }));
  });
});
describe("canonical envelope text (re-signed)", () => {
  it("rejects malformed JSON", () => {
    stale(() => verifySnapshot(signSegments(encodeText("not-json{{"), KEY_A), KEY_A, NOW));
  });
  it("rejects duplicate JSON keys", () => {
    const text = envelopeText(validToken);
    const duplicated = text.replace('"schemaVersion":1,', '"schemaVersion":1,"schemaVersion":1,');
    expect(duplicated).not.toBe(text);
    stale(() => verifySnapshot(signSegments(encodeText(duplicated), KEY_A), KEY_A, NOW));
  });
  it("rejects noncanonical whitespace", () => {
    const spaced = envelopeText(validToken).replace(":", ": ");
    stale(() => verifySnapshot(signSegments(encodeText(spaced), KEY_A), KEY_A, NOW));
  });
  it("rejects noncanonical key order", () => {
    const parsed = JSON.parse(envelopeText(validToken)) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(parsed).reverse());
    stale(() => verifySnapshot(signSegments(encodeText(JSON.stringify(reversed)), KEY_A), KEY_A, NOW));
  });
});
describe("time window (re-signed)", () => {
  it("rejects expiry mismatch against issuedAt+300000", () => {
    stale(reVerified((e) => { set(e, "expiresAt", (e.issuedAt as number) + 600_000); }));
    stale(reVerified((e) => { set(e, "expiresAt", (e.issuedAt as number) + 299_999); }));
  });
  it("rejects future issuedAt re-signed token", () => {
    stale(reVerified((e) => {
      set(e, "issuedAt", (e.issuedAt as number) + 1);
      set(e, "expiresAt", (e.expiresAt as number) + 1);
    }));
  });
  it("rejects non-integer timestamps", () => {
    stale(reVerified((e) => { set(e, "issuedAt", 1.5); }));
  });
});
describe("state value validation via signSnapshot", () => {
  const badInt = (mutate: (s: SnapshotState) => void) => () =>
    stale(() => signSnapshot(stateWith(mutate), KEY_A, NOW));

  it.each([Number.NaN, Infinity, -Infinity, -1, 1.5, 2 ** 53])(
    "rejects dispatchAuthorityVersion %s",
    (v) => badInt((s) => { s.run.dispatchAuthorityVersion = v; })(),
  );
  it.each([Number.NaN, -1, 0.5])("rejects executionGeneration %s", (v) => badInt((s) => { s.steps[0].executionGeneration = v; })());
  it.each([-1, 2.5])("rejects statusTransitionVersion %s", (v) => badInt((s) => { s.steps[0].statusTransitionVersion = v; })());
  it.each([Number.NaN, -1, 0.25])("rejects resumeEpoch %s", (v) => badInt((s) => { s.resumeEpoch = v; })());

  it.each([
    ["not-a-date"],
    ["2024-01-15T10:30:00Z"],
    ["2024-01-15T10:30:00.000+00:00"],
    [""],
    ["2024-13-40T00:00:00.000Z"],
  ])("rejects noncanonical/invalid updatedAt %j", (value) => {
    stale(() => signSnapshot(stateWith((s) => { set(s.mission, "updatedAt", value); }), KEY_A, NOW));
  });
  it.each([
    ["accepts canonical null-run-date state", (s: SnapshotState) => { s.run.startedAt = null; s.run.completedAt = null; }],
    ["accepts 100-char status", (s: SnapshotState) => { s.mission.status = "x".repeat(100); }],
    ["accepts 200-char stepId", (s: SnapshotState) => { s.steps[1].stepId = "y".repeat(200); }],
    ["accepts 500-char lastDispatchRequestId", (s: SnapshotState) => { s.steps[0].lastDispatchRequestId = "z".repeat(500); }],
  ])("%s", (_name, mutate) => {
    const state = stateWith(mutate);
    expect(verifySnapshot(signSnapshot(state, KEY_A, NOW), KEY_A, NOW)).toEqual(state);
  });
  it.each(["nope", "", 42, null, "12345678-1234-1234-1234-123456789abcg"])(
    "rejects invalid scope.companyId %j",
    (value) => stale(() => signSnapshot(stateWith((s) => { set(s.scope, "companyId", value); }), KEY_A, NOW)),
  );

  it("rejects invalid dispatchOwnerWakeupRequestId", () => {
    stale(() => signSnapshot(stateWith((s) => { set(s.steps[0], "dispatchOwnerWakeupRequestId", "x"); }), KEY_A, NOW));
  });
  it("rejects startStepId absent from steps", () => {
    stale(() => signSnapshot(stateWith((s) => { s.scope.startStepId = "step-9"; }), KEY_A, NOW));
  });
  it("rejects duplicate stepId and duplicate step id", () => {
    stale(() => signSnapshot(stateWith((s) => { s.steps[1].stepId = s.steps[0].stepId; }), KEY_A, NOW));
    stale(() => signSnapshot(stateWith((s) => { s.steps[1].id = s.steps[0].id; }), KEY_A, NOW));
  });
  it("rejects duplicate evidence id and duplicate approval stepId", () => {
    stale(() => signSnapshot(stateWith((s) => { s.evidence.push({ id: s.evidence[0].id, sha256: HASH_B }); }), KEY_A, NOW));
    stale(() => signSnapshot(stateWith((s) => { s.approvals.push({ stepId: "step-1", executionGeneration: 1, bindingHash: null }); }), KEY_A, NOW));
  });
  it("rejects approval referencing a nonexistent step", () => {
    stale(() => signSnapshot(stateWith((s) => { s.approvals.push({ stepId: "step-zz", executionGeneration: 1, bindingHash: null }); }), KEY_A, NOW));
  });
  it("rejects empty steps array", () => {
    stale(() => signSnapshot(stateWith((s) => { s.steps = []; }), KEY_A, NOW));
  });
  it("rejects undefined required fields", () => {
    stale(() => signSnapshot(stateWith((s) => { set(s, "factsHash", undefined); }), KEY_A, NOW));
    stale(() => signSnapshot(stateWith((s) => { set(s.steps[0], "id", undefined); }), KEY_A, NOW));
  });
  it.each([
    ["uppercase", () => HASH_A.toUpperCase()],
    ["63 chars", () => HASH_A.slice(1)],
    ["65 chars", () => HASH_A + "a"],
    ["non-hex", () => "z".repeat(64)],
    ["null", () => null],
  ])("rejects %s definitionHash", (_name, make) => {
    stale(() => signSnapshot(stateWith((s) => { set(s, "definitionHash", make()); }), KEY_A, NOW));
  });
  it("rejects out-of-bounds strings", () => {
    stale(() => signSnapshot(stateWith((s) => { s.mission.status = ""; }), KEY_A, NOW));
    stale(() => signSnapshot(stateWith((s) => { s.mission.status = "x".repeat(101); }), KEY_A, NOW));
    stale(() => signSnapshot(stateWith((s) => { s.steps[0].stepId = ""; }), KEY_A, NOW));
    stale(() => signSnapshot(stateWith((s) => { s.steps[0].stepId = "y".repeat(201); }), KEY_A, NOW));
    stale(() => signSnapshot(stateWith((s) => { s.steps[0].lastDispatchRequestId = "z".repeat(501); }), KEY_A, NOW));
  });
});
describe("verify rejects schema-invalid state even when re-signed", () => {
  it.each([
    ["negative int", (s: SnapshotState) => { s.run.dispatchAuthorityVersion = -1; }],
    ["duplicate stepId", (s: SnapshotState) => { s.steps[1].stepId = s.steps[0].stepId; }],
    ["orphan startStepId", (s: SnapshotState) => { s.scope.startStepId = "step-9"; }],
    ["bad hash", (s: SnapshotState) => { set(s, "factsHash", "nope"); }],
  ])("rejects re-signed envelope with %s", (_name, mutate) => {
    stale(reVerified((e) => { mutate((e as { state: SnapshotState }).state); }));
  });
});
describe("hashSnapshotState validation", () => {
  it("rejects invalid input with the uniform error", () => {
    stale(() => hashSnapshotState(stateWith((s) => { set(s, "factsHash", "nope"); })));
    stale(() => hashSnapshotState(undefined as unknown as SnapshotState));
  });
});