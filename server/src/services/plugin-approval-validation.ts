/**
 * Host-side validation for plugin-created approvals. Enforces real limits on
 * type / payload / title / summary rather than a loose cast, so a misbehaving
 * plugin cannot persist arbitrary or oversized approval content.
 */
import { APPROVAL_TYPES, type ApprovalType } from "@paperclipai/shared";

const APPROVAL_TYPE_SET: ReadonlySet<string> = new Set(APPROVAL_TYPES);
const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 1000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface ValidatedApprovalCreate {
  type: ApprovalType;
  payload: Record<string, unknown>;
  title: string | undefined;
  summary: string | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number, field: "title" | "summary"): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`approvals.create ${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > max) {
    throw new Error(`approvals.create ${field} exceeds ${max} character limit`);
  }
  return trimmed;
}

/**
 * Validate and normalize a plugin `approvals.create` request. Throws on any
 * violation (the host translates the throw into a JSON-RPC error).
 */
export function validatePluginApprovalCreate(input: {
  type: unknown;
  payload: unknown;
  title?: unknown;
  summary?: unknown;
}): ValidatedApprovalCreate {
  if (typeof input.type !== "string" || !APPROVAL_TYPE_SET.has(input.type)) {
    throw new Error(`approvals.create rejected unsupported approval type: ${String(input.type)}`);
  }
  if (!isPlainObject(input.payload)) {
    throw new Error("approvals.create payload must be a JSON object");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input.payload);
  } catch {
    throw new Error("approvals.create payload is not JSON-serializable");
  }
  if (typeof serialized !== "string") {
    throw new Error("approvals.create payload is not JSON-serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error(`approvals.create payload exceeds ${MAX_PAYLOAD_BYTES} byte limit`);
  }
  const title = boundedString(input.title, MAX_TITLE_LENGTH, "title");
  const summary = boundedString(input.summary, MAX_SUMMARY_LENGTH, "summary");
  return { type: input.type as ApprovalType, payload: input.payload, title, summary };
}
