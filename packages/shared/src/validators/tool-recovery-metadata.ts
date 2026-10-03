import { z } from "zod";

/**
 * Optional, tool-declared recovery hints stored at `toolDefinitions.adapterConfig.recovery`.
 * DISPLAY ONLY: shown to agents in failure briefs. Runtime code must never read these
 * fields to decide retry, branch, completion, reconcile or any next workflow step.
 */
const text = (max: number) => z.string().trim().min(1).max(max);

export const toolRecoveryMetadataV1 = z.object({
  version: z.literal(1),
  sameRunRetry: z.enum(["allowed", "forbidden", "unknown"]),
  idempotencyKey: text(300).optional(),
  statusLookup: z.object({
    instruction: text(500),
    toolName: text(120).optional(),
  }).strict().optional(),
  reconcile: z.enum(["agent", "operator"]).optional(),
  installPath: text(300).optional(),
  stateLocation: text(300).optional(),
  notes: z.array(text(200)).max(5).optional(),
}).strict();

export type ToolRecoveryMetadataV1 = z.infer<typeof toolRecoveryMetadataV1>;

export type ToolRecoveryMetadataParseResult =
  | { status: "absent" }
  | { status: "valid"; metadata: ToolRecoveryMetadataV1 }
  | { status: "invalid"; diagnostic: string };

/** Never throws. Invalid declarations yield a bounded diagnostic of issue paths/codes only. */
export function parseToolRecoveryMetadata(adapterConfig: unknown): ToolRecoveryMetadataParseResult {
  if (!adapterConfig || typeof adapterConfig !== "object" || Array.isArray(adapterConfig)) return { status: "absent" };
  if (!Object.prototype.hasOwnProperty.call(adapterConfig, "recovery")) return { status: "absent" };
  const raw = (adapterConfig as Record<string, unknown>).recovery;
  if (raw === undefined || raw === null) return { status: "absent" };
  try {
    const parsed = toolRecoveryMetadataV1.safeParse(raw);
    if (parsed.success) return { status: "valid", metadata: parsed.data };
    // Paths and codes only: never echo declared values (they may be unsafe or secret-bearing).
    const diagnostic = parsed.error.issues.slice(0, 5)
      .map(issue => `${issue.path.join(".").slice(0, 60) || "recovery"}: ${issue.code}`).join("; ");
    return { status: "invalid", diagnostic: diagnostic.slice(0, 300) || "invalid" };
  } catch {
    return { status: "invalid", diagnostic: "validation_error" };
  }
}
