import type { ResumeExecutionHistory } from "../../services/workflow/resume/read-model.js";
import type { ObservedWakeupConflictsInput } from "../../services/workflow/resume/observed-wakeup-conflicts.js";
import { settlementHeartbeatRow, type SettlementHeartbeatRow } from "./workflow-resume-settlement-fixture.js";

/**
 * [purpose] Task5c4a observed wakeup-conflict pure test fixture. Reuses ONLY the accepted
 *   settlement fixture (`settlementHeartbeatRow`) by import (never edits it) and adds the
 *   full-column typed wakeup-row factory plus a whole-typed-input builder for the pure
 *   wakeup/heartbeat conflict filter. No DB seeding, no mocks, no `as any`/partial-row casts.
 * [pure-test contract] Factories build fresh objects and fresh Date instances on every call so
 *   caller mutations never leak into later calls (same convention as the settlement fixture).
 *   Defaults describe a healthy producer record: wake id `wake-1`, company `company-1`,
 *   agent `agent-1`, null mission (legacy-allowed), status `completed`, null runId, fixed equal
 *   finite requestedAt/finishedAt, every nullable column explicit null, counter zero, source
 *   `on_demand`. The plain-string ids are intentional: the pure filter never touches the DB,
 *   so tests stay readable while the scope still satisfies the snapshot scope TYPE exactly.
 */

export { settlementHeartbeatRow };
export type { SettlementHeartbeatRow };

export type WakeRow = ResumeExecutionHistory["wakeups"][number];
export type HeartbeatRow = ResumeExecutionHistory["heartbeats"][number];
export type WakeupScope = ResumeExecutionHistory["scope"];

export const WAKEUP_COMPANY = "company-1";
export const WAKEUP_OTHER_COMPANY = "company-2";
export const WAKEUP_AGENT = "agent-1";
export const WAKEUP_MISSION = "mission-1";
export const WAKEUP_OTHER_MISSION = "mission-2";
export const WAKEUP_RUN = "run-1";
export const WAKEUP_START_STEP = "resume-step-a";
export const WAKEUP_T0_ISO = "2024-06-01T00:00:00.000Z";
export const WAKEUP_T1_ISO = "2024-06-01T01:00:00.000Z";

/** snapshot-scope-typed scope for `wakeupInput()` — same four keys as read-model fixtures. */
export function wakeupScope(): WakeupScope {
  return {
    companyId: WAKEUP_COMPANY,
    missionId: WAKEUP_MISSION,
    workflowRunId: WAKEUP_RUN,
    startStepId: WAKEUP_START_STEP,
  };
}

/** Full typed input (scope + empty arrays) — tests append rows by mutating the arrays. */
export function wakeupInput(): ObservedWakeupConflictsInput {
  return { scope: wakeupScope(), wakeups: [], heartbeats: [] };
}

/** Full-column agent_wakeup_requests row — every call gets fresh Date objects. */
export function wakeupRow(overrides: Partial<WakeRow> = {}): WakeRow {
  return {
    id: "wake-1",
    companyId: WAKEUP_COMPANY,
    agentId: WAKEUP_AGENT,
    source: "on_demand",
    triggerDetail: null,
    reason: null,
    payload: null,
    status: "completed",
    coalescedCount: 0,
    requestedByActorType: null,
    requestedByActorId: null,
    idempotencyKey: null,
    runId: null,
    requestedAt: new Date(WAKEUP_T0_ISO),
    claimedAt: null,
    finishedAt: new Date(WAKEUP_T0_ISO),
    error: null,
    requestKind: null,
    issueId: null,
    missionId: null,
    workflowRunId: null,
    workflowStepRunId: null,
    workflowExecutionGeneration: null,
    createdAt: new Date(WAKEUP_T0_ISO),
    updatedAt: new Date(WAKEUP_T0_ISO),
    ...overrides,
  };
}
