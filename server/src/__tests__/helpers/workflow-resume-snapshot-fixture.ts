import { createHash, createHmac, randomUUID } from "node:crypto";
import { stableStringify } from "../../services/issue-execution-cards/hash.js";
import type { SnapshotState } from "../../services/workflow/resume/snapshot-state.js";

/**
 * [purpose] Task5c1 signed snapshot test fixture — valid SnapshotState builder, wire
 *   segment helpers (base64url + domain-separated HMAC re-signing) for tamper tests.
 * [invariants] Real crypto only; fixtures are pure inputs, no engine/DB/reader access.
 */

export const SNAPSHOT_HMAC_DOMAIN = "papercompany.workflow-resume.snapshot.v1.";
export const KEY_A = Buffer.alloc(32, 0x11);
export const KEY_B = Buffer.alloc(32, 0x22);
export const FIXED_DATE = "2024-01-15T10:30:00.000Z";
export const OTHER_DATE = "2024-02-20T08:00:00.000Z";
export const NOW = new Date("2024-01-15T10:30:01.000Z");
export const HASH_A = createHash("sha256").update("a").digest("hex");
export const HASH_B = createHash("sha256").update("b").digest("hex");

export function snapshotState(): SnapshotState {
  return {
    schemaVersion: 1,
    scope: {
      companyId: randomUUID(),
      missionId: randomUUID(),
      workflowRunId: randomUUID(),
      startStepId: "step-1",
    },
    definitionHash: HASH_A,
    mission: { status: "running", updatedAt: FIXED_DATE },
    run: { status: "running", dispatchAuthorityVersion: 1, startedAt: FIXED_DATE, completedAt: null },
    steps: [
      {
        id: randomUUID(),
        stepId: "step-1",
        status: "pending",
        executionGeneration: 0,
        statusTransitionVersion: 0,
        dispatchOwnerWakeupRequestId: null,
        dispatchOwnerHeartbeatRunId: null,
        lastDispatchRequestId: "req-1",
      },
      {
        id: randomUUID(),
        stepId: "step-2",
        status: "completed",
        executionGeneration: 1,
        statusTransitionVersion: 2,
        dispatchOwnerWakeupRequestId: null,
        dispatchOwnerHeartbeatRunId: null,
        lastDispatchRequestId: null,
      },
    ],
    evidence: [{ id: randomUUID(), sha256: HASH_A }],
    approvals: [{ stepId: "step-1", executionGeneration: 0, bindingHash: null }],
    resumeEpoch: 0,
    factsHash: HASH_A,
  };
}

/** Deep-clones a fresh fixture then applies one mutation (values may be contract-invalid). */
export function stateWith(mutate: (state: SnapshotState) => void): SnapshotState {
  const state = snapshotState();
  mutate(state);
  return state;
}

export function encodeText(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

export function signSegments(envelopeSegment: string, key: Buffer): string {
  const signature = createHmac("sha256", key)
    .update(SNAPSHOT_HMAC_DOMAIN + envelopeSegment)
    .digest("base64url");
  return envelopeSegment + "." + signature;
}

export function envelopeText(token: string): string {
  return Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8");
}

export function parseEnvelope(token: string): Record<string, unknown> {
  return JSON.parse(envelopeText(token)) as Record<string, unknown>;
}

/** Decodes the envelope of a token, mutates it, and re-signs with the (correct) key. */
export function reSign(
  token: string,
  key: Buffer,
  mutate: (envelope: Record<string, unknown>) => void,
): string {
  const envelope = parseEnvelope(token);
  mutate(envelope);
  return signSegments(encodeText(stableStringify(envelope)), key);
}

/** First-character flip that stays inside the base64url alphabet. */
export function flipped(segment: string): string {
  return (segment[0] === "A" ? "B" : "A") + segment.slice(1);
}

/** Alternate base64url spelling of the same bytes (nonzero padding bits), if one exists. */
export function nonCanonicalEncoding(segment: string): string {
  const bytes = Buffer.from(segment, "base64url");
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") {
    const candidate = segment.slice(0, -1) + ch;
    if (candidate !== segment && Buffer.from(candidate, "base64url").equals(bytes)) return candidate;
  }
  throw new Error("no non-canonical variant exists for this segment");
}

/** Rebuilds every object with reversed key insertion order (arrays keep element order). */
export function reverseKeyOrder<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeyOrder) as unknown as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, v]) => [key, reverseKeyOrder(v)]),
    ) as unknown as T;
  }
  return value;
}
