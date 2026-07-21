import type { Approval } from "@paperclipai/shared";

type CheckEntry = { name?: unknown; status?: unknown; conclusion?: unknown };

export type ExternalAutomationPayload = {
  title?: unknown;
  summary?: unknown;
  repository?: unknown;
  branch?: unknown;
  commit?: unknown;
  intendedAction?: unknown;
  checks?: unknown;
};

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function readPayload(approval: Approval): ExternalAutomationPayload {
  return approval.payload && typeof approval.payload === "object"
    ? (approval.payload as ExternalAutomationPayload)
    : {};
}

export function readChecks(value: unknown): CheckEntry[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is CheckEntry => Boolean(entry) && typeof entry === "object")
    : [];
}

export function shortSha(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
}
