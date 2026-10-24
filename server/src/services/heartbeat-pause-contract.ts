import { z } from "zod";
import type { agentWakeupRequests } from "@paperclipai/db";
import { conflict } from "../errors.js";

/** Non-executing server records. Public wake source validators deliberately stay unchanged. */
export const PAUSE_CONTROL_COLUMNS = {
  source: "internal_agent_pause_v1",
  requestedByActorType: "system",
  requestedByActorId: "runtime:agent-pause:v1",
  requestKind: "agent_pause_control_v1",
  status: "skipped",
} as const;
export const pauseCauseSchema = z.enum(["manual_pause", "user_cancel", "terminate", "budget"]);
const id = z.string().uuid(), optionalId = id.nullable();
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ids = z.array(id).refine(values => new Set(values).size === values.length, "duplicate IDs");
export const pauseIdentitySchema = z.object({
  companyId: id, agentId: id, heartbeatRunId: id, wakeupRequestId: optionalId,
  issueId: optionalId, missionId: optionalId,
  workflow: z.object({
    workflowId: id, runId: id, stepRunId: id, stepId: z.string().min(1),
    observedAuthorityVersion: counter, executionGeneration: counter, retryCount: counter, iterationIndex: counter,
  }).strict().nullable(),
  execution: z.object({
    scopeKind: z.string().nullable(), epoch: counter.nullable(), token: optionalId,
    retryOfRunId: optionalId, processLossRetryCount: counter,
    ownerId: z.string().nullable(), ownerLeaseEpoch: counter.nullable(), ownerLeaseToken: optionalId,
  }).strict(),
  // Snapshot under the pause lock, not a reconstruction of admission-time permissions.
  observedPermissions: z.record(z.unknown()),
}).strict();
const common = z.object({ schemaVersion: z.literal(1), id, companyId: id, agentId: id });
const head = common.extend({ kind: z.literal("head"), scopeId: optionalId }).strict();
const scope = common.extend({
  kind: z.literal("scope"), previousScopeId: optionalId, cause: pauseCauseSchema, receiptIds: ids,
  observedAgent: z.object({
    status: z.string(), pausedAt: z.string().datetime().nullable(), permissions: z.record(z.unknown()),
  }).strict(),
}).strict();
const receipt = common.extend({
  kind: z.literal("receipt"), originScopeId: id, ownerScopeId: id, cause: pauseCauseSchema,
  identity: pauseIdentitySchema, resumeScopeId: optionalId,
  stopped: z.object({
    observedAt: z.string().datetime(), method: z.enum(["finalization_quiescence", "legacy_execution_cleanup"]),
    heartbeatRunId: id, executionEpoch: counter.nullable(), executionToken: optionalId,
  }).strict().nullable(),
  invalidated: z.object({
    cause: z.enum(["user_cancel", "terminate", "budget", "authority_revoked", "stale_generation"]),
    at: z.string().datetime(),
  }).strict().nullable(),
  delivery: z.object({ wakeupRequestId: id, heartbeatRunId: optionalId }).strict().nullable(),
}).strict();
export const pauseControlSchema = z.discriminatedUnion("kind", [head, scope, receipt]);
export const pauseScopeInputSchema = z.object({
  companyId: id, agentId: id, heartbeatRunIds: ids, cause: pauseCauseSchema, expectedScopeId: id.optional(),
}).strict();
export type PauseIdentity = z.infer<typeof pauseIdentitySchema>;
export type PauseControl = z.infer<typeof pauseControlSchema>;
export type PauseReceipt = Extract<PauseControl, { kind: "receipt" }>;
export type PauseScopeInput = z.infer<typeof pauseScopeInputSchema>;

/** Payload labels never establish provenance: check every persisted discriminator and typed link. */
export function readPauseControl(row: typeof agentWakeupRequests.$inferSelect): PauseControl {
  const reject = () => { throw conflict("heartbeat_pause_control_invalid"); };
  if (Object.entries(PAUSE_CONTROL_COLUMNS).some(([key, value]) =>
    row[key as keyof typeof PAUSE_CONTROL_COLUMNS] !== value) || row.runId !== null) return reject();
  const parsed = pauseControlSchema.safeParse(row.payload);
  if (!parsed.success) return reject();
  const p = parsed.data;
  if (p.id !== row.id || p.companyId !== row.companyId || p.agentId !== row.agentId) return reject();
  const identity = p.kind === "receipt" ? p.identity : null;
  if (p.kind === "receipt" && p.stopped && (p.stopped.heartbeatRunId !== p.identity.heartbeatRunId
    || p.stopped.executionEpoch !== p.identity.execution.epoch
    || p.stopped.executionToken !== p.identity.execution.token)) return reject();
  if (identity && (identity.companyId !== p.companyId || identity.agentId !== p.agentId)) return reject();
  if (row.issueId !== (identity?.issueId ?? null) || row.missionId !== (identity?.missionId ?? null)
    || row.workflowRunId !== (identity?.workflow?.runId ?? null)
    || row.workflowStepRunId !== (identity?.workflow?.stepRunId ?? null)
    || row.workflowExecutionGeneration !== (identity?.workflow?.executionGeneration ?? null)) return reject();
  return p;
}
