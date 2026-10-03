import { parseToolRecoveryMetadata } from "@paperclipai/shared";

/**
 * DISPLAY ONLY (AGENTS §5.8). Projects a tool's declared adapterConfig.recovery into
 * sanitized strings for the failure brief. Nothing may branch on this projection:
 * retry, completion, reconcile and next-step decisions use durable structured records.
 */
export type DeclaredToolRecoveryDisplay =
  | { status: "absent" }
  | { status: "invalid"; diagnostic: string }
  | { status: "declared"; declaration: Record<string, unknown> };

export function declaredToolRecoveryDisplay(adapterConfig: unknown, safe: (v: unknown) => string): DeclaredToolRecoveryDisplay {
  try {
    const parsed = parseToolRecoveryMetadata(adapterConfig);
    if (parsed.status === "absent") return parsed;
    if (parsed.status === "invalid") return { status: "invalid", diagnostic: safe(parsed.diagnostic) };
    const m = parsed.metadata;
    const declaration: Record<string, unknown> = { version: m.version, sameRunRetry: m.sameRunRetry };
    if (m.idempotencyKey) declaration.idempotencyKey = safe(m.idempotencyKey);
    if (m.statusLookup) declaration.statusLookup = { instruction: safe(m.statusLookup.instruction),
      ...(m.statusLookup.toolName ? { toolName: safe(m.statusLookup.toolName) } : {}) };
    if (m.reconcile) declaration.reconcile = m.reconcile;
    if (m.installPath) declaration.installPath = safe(m.installPath);
    if (m.stateLocation) declaration.stateLocation = safe(m.stateLocation);
    if (m.notes) declaration.notes = m.notes.map(note => safe(note));
    return { status: "declared", declaration };
  } catch {
    return { status: "invalid", diagnostic: "display_error" };
  }
}
