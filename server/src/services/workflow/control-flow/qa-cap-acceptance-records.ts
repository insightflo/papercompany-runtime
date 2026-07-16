// server/src/services/workflow/control-flow/qa-cap-acceptance-records.ts
//
// [ purpose ] Shared, dependency-free readers/types/constants for qa-cap acceptance.
//   Kept separate so the cap pass (qa-cap-acceptance.ts) and the downstream-context
//   loader stay well under 300 lines and do not duplicate validation of the persisted
//   acceptance record shape.

/** Bounded acceptance record persisted under producer metadata + QA sentinel. */
export interface AcceptanceRecord {
  readonly classification: "nonblocking";
  readonly limitations: readonly string[];
  readonly acceptedAt: string;
  readonly producerStepId: string;
  readonly producerIteration: number;
  readonly heartbeatRunId: string | null;
  readonly verdictWorkflowStepRunId: string | null;
}

/** Producer step-run metadata key holding the bounded per-QA acceptance record. */
export const QA_CAP_ACCEPTANCE_KEY = "qaCapAcceptance";
/** QA step-run metadata sentinel marking a cap-accepted step (anti-flap guard). */
export const QA_CAP_ACCEPTED_SENTINEL = "qaCapAccepted";

export function readMeta(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? { ...(meta as Record<string, unknown>) }
    : {};
}

/** Parse + validate a single acceptance record from untrusted JSON metadata. */
export function readAcceptanceRecord(value: unknown): AcceptanceRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.classification !== "nonblocking") return null;
  if (!Array.isArray(v.limitations)) return null;
  const limitations = v.limitations.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  if (limitations.length === 0 || limitations.length !== v.limitations.length) return null;
  return {
    classification: "nonblocking",
    limitations,
    acceptedAt: typeof v.acceptedAt === "string" ? v.acceptedAt : "",
    producerStepId: typeof v.producerStepId === "string" ? v.producerStepId : "",
    producerIteration: typeof v.producerIteration === "number" ? v.producerIteration : 0,
    heartbeatRunId: typeof v.heartbeatRunId === "string" ? v.heartbeatRunId : null,
    verdictWorkflowStepRunId: typeof v.verdictWorkflowStepRunId === "string" ? v.verdictWorkflowStepRunId : null,
  };
}

/** Parse the producer metadata map keyed by qaStepId into validated records. */
export function readAcceptanceRecords(value: unknown): Record<string, AcceptanceRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: Record<string, AcceptanceRecord> = {};
  for (const [key, val] of Object.entries(raw)) {
    const rec = readAcceptanceRecord(val);
    if (rec) out[key] = rec;
  }
  return out;
}
