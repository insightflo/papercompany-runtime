// Versioned persistence contract for C08 lifetimes; existing transition-event storage is reused.
import type { Db } from "@paperclipai/db";
import { missionOwnerDecisionSubmitSchema } from "@paperclipai/shared";
import { z } from "zod";
export { MISSION_OWNER_RECOVERY_LAYER as OWNER_HUMAN_LAYER } from "./mission-owner-decision-contract.js";

export type OwnerHumanTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export const OWNER_HUMAN_SOURCE = "owner_human_request_v1";
const uuid = z.string().uuid();
const requestKey = z.string().min(1).refine((value) => value.trim().length > 0);

// Callers supply the normalized submission used by the existing decision writer.
// Text is retained for replay/conflict checking, never for selecting a logical target.
export const ownerHumanSubmissionSchema = z.object({
  decision: z.enum(["request_input", "escalate"]),
  recoveryTarget: missionOwnerDecisionSubmitSchema.innerType().shape.recoveryTarget,
  sourceIssueRef: z.string().optional(),
  reworkTargetRef: z.string().optional(),
  targetAgentId: uuid.optional(),
  reason: z.string().max(2000).optional(),
  nextAction: z.string().max(2000).optional(),
  evidence: z.string().max(4000).optional(),
}).strict();
export type OwnerHumanSubmission = z.infer<typeof ownerHumanSubmissionSchema>;

export const ownerHumanScopeSchema = z.object({
  companyId: uuid,
  missionId: uuid,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("source_issue"), issueId: uuid }).strict(),
    z.object({ kind: z.literal("tool_step"), workflowRunId: uuid, stepRunId: uuid }).strict(),
    // Existing oversight is mission-scoped; its mutable issue is an anchor, not its identity.
    z.object({ kind: z.literal("oversight") }).strict(),
  ]),
}).strict();
export type OwnerHumanScope = z.infer<typeof ownerHumanScopeSchema>;

const cardInputSchema = z.object({
  companyId: uuid, missionId: uuid, decisionEventId: uuid,
  decision: z.enum(["request_input", "escalate"]),
  ownerActionIssueId: uuid, ownerActionIssueStatus: z.string().min(1), requestedByAgentId: uuid,
  reason: z.string().optional(), nextAction: z.string().optional(), evidence: z.string().optional(),
  issueTitle: z.string().nullable(), issueIdentifier: z.string().nullable(),
  sourceIssueId: uuid.nullable(), workflowRunId: uuid.nullable(),
}).strict();

export const ownerHumanLifetimeSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("owner_human_lifetime_v1"),
  lifetimeId: uuid, scope: ownerHumanScopeSchema, requestKey,
  identityMode: z.enum(["keyed", "legacy_exact"]),
  decisionEventId: uuid, anchorIssueId: uuid, sourceIssueId: uuid.nullable(),
  authorAgentId: uuid, heartbeatRunId: uuid,
  submission: ownerHumanSubmissionSchema,
  cardInput: cardInputSchema,
}).strict();
export type OwnerHumanLifetime = z.infer<typeof ownerHumanLifetimeSchema>;

const endReason = z.enum(["replaced", "source_settled", "mission_cancelled", "mission_completed"]);
export const ownerHumanEndSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("owner_human_end_v1"),
  scope: ownerHumanScopeSchema, lifetimeId: uuid, reason: endReason, nextLifetimeId: uuid.nullable(),
}).strict();
export type OwnerHumanEnd = z.infer<typeof ownerHumanEndSchema>;

export const ownerHumanCurrentSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("owner_human_current_v1"),
  scope: ownerHumanScopeSchema, lifetimeId: uuid, requestKey, anchorIssueId: uuid,
  revision: z.number().int().positive(), recoveryNeeded: z.boolean(),
  closure: z.object({ eventId: uuid, reason: endReason.exclude(["replaced"]) }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.recoveryNeeded !== (value.closure === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "recoveryNeeded and closure disagree" });
  }
});
export type OwnerHumanCurrent = z.infer<typeof ownerHumanCurrentSchema>;

// Arrays and JSON escaping make these exact keys unambiguous without a content hash.
export function ownerHumanCurrentKey(scope: OwnerHumanScope): string {
  const target = scope.target;
  const parts = target.kind === "source_issue" ? [target.kind, target.issueId]
    : target.kind === "tool_step" ? [target.kind, target.workflowRunId, target.stepRunId] : [target.kind];
  return `owner-human-current:v1:${JSON.stringify([scope.missionId, parts])}`;
}
export const ownerHumanLifetimeKey = (key: string) => `owner-human-lifetime:v1:${JSON.stringify(key)}`;
export const ownerHumanEndKey = (id: string) => `owner-human-end:v1:${id}`;

// Object property order is irrelevant; values, including text and request-key bytes, are exact.
// This comparison detects key misuse. It does not invent request identity.
export function sameOwnerHumanValue(left: unknown, right: unknown): boolean {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]));
    }
    return value;
  };
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}
