import { createHash } from "node:crypto";

/** Shadow-only DTOs. The reader supplies scoped, current-attempt facts, never prose.
 * A running workflow container alone is not evidence of executing work.
 * Historical failures remain progress history, not unresolved current failures.
 */
export interface CadenceSnapshot {
  mission: { id: string; companyId: string; status: string; createdAt: Date };
  runs: Array<{ id: string; status: string; version: number; current: boolean;
    createdAt: Date; startedAt: Date | null; completedAt: Date | null; readySince?: Date | null }>;
  steps: Array<{ id: string; status: string; version: number; generation: number; retryCount: number;
    iterationIndex: number; current: boolean; startedAt: Date | null; completedAt: Date | null;
    readySince: Date | null; waiting?: boolean }>;
  heartbeats: Array<{ id: string; stepId: string | null; status: string; current: boolean;
    observedAt: Date; allowedIntervalMs: number; startedAt: Date | null; finishedAt: Date | null;
    waiting?: boolean }>;
  events: Array<{ id: string; at: Date; type: string; layer: string;
    fromStatus: string | null; toStatus: string | null }>;
  waits: Array<{ id: string; kind: "retry_backoff" | "approval" | "operator_decision" | "control_node_grace" | "child_start";
    until: Date | null; satisfiedAt: Date | null }>;
}
export type CadenceState = "FAILURE_OR_RECOVERY_NEEDED" | "RUNNING" | "READY_NOT_STARTED" | "WAITING_EXPLICIT" | "IDLE_QUIET";
export type CadenceTrigger = "immediate_failure" | "stall_idle" | "ready_not_started" | "liveness_ghost" | "wait_overdue" | "none";
export interface CadenceVerdict {
  schemaVersion: 1;
  state: CadenceState;
  wouldTrigger: boolean;
  triggerKind: CadenceTrigger;
  reasonCode: string;
  computedTimestamps: { last_event_at: string | null; last_progress_at: string | null;
    last_observed_at: string | null; oldest_running_heartbeat_at: string | null };
  inputGeneration: { schemaVersion: 1; fingerprint: string; runs: Array<{ id: string; version: number }>;
    steps: Array<{ id: string; version: number; generation: number; retryCount: number; iterationIndex: number }> };
}
const WINDOW_MS = 5 * 60_000;
const FAILURE = new Set(["failed", "timed_out", "recovery_pending"]);
const PROGRESS_EVENTS = new Set(["workflow_step_status_transition", "workflow_step_retry_scheduled",
  "workflow_run_status_transition", "queue_run_started", "queue_run_completed", "tool_result"]);
const OBSERVATION_LAYERS = new Set(["mission_owner_recovery", "mission_owner_authority", "mission_owner_supervision"]);
const OBSERVATION_EVENTS = new Set(["owner_diagnosis", "mission_owner_periodic_review_wake", "qa_cap_oversight_claim", "qa_cap_oversight_wake"]);
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  return value;
}
function latest(dates: Array<Date | null>): Date | null {
  const valid = dates.filter((date): date is Date => date !== null && Number.isFinite(date.getTime()));
  return valid.length ? new Date(Math.max(...valid.map((date) => date.getTime()))) : null;
}
const iso = (date: Date | null) => date?.toISOString() ?? null;

/** Deterministic policy: no timers, writes, wakes, cards, or execution authority.
 * Precedence: current failure > executing work/ghost > ready work > explicit wait > idle.
 * Deadline-free human waits have no invented expiry. Unrelated waits cannot exempt work.
 * Survival (observed heartbeat) and progress (physical transitions/results) are disjoint.
 */
export function evaluateMissionOversightCadence(s: CadenceSnapshot, now: Date): CadenceVerdict {
  const observed = s.events.filter((e) => OBSERVATION_LAYERS.has(e.layer) || OBSERVATION_EVENTS.has(e.type));
  const progressEvents = s.events.filter((e) => !observed.includes(e) && PROGRESS_EVENTS.has(e.type)
    && (e.type === "tool_result" || e.fromStatus !== e.toStatus));
  const lastProgress = latest([s.mission.createdAt, ...s.runs.flatMap((r) => [r.startedAt, r.completedAt]),
    ...s.steps.flatMap((step) => [step.startedAt, step.completedAt]),
    ...s.heartbeats.flatMap((hb) => [hb.startedAt, hb.finishedAt]),
    ...progressEvents.map((e) => e.at), ...s.waits.map((w) => w.satisfiedAt)]);
  const live = s.heartbeats.filter((hb) => hb.current && hb.status === "running" && !hb.waiting);
  const runningSteps = s.steps.filter((step) => step.current && step.status === "running" && !step.waiting);
  const oldestHeartbeat = live.length ? new Date(Math.min(...live.map((hb) => hb.observedAt.getTime()))) : null;
  const inputGeneration: CadenceVerdict["inputGeneration"] = {
    schemaVersion: 1, fingerprint: createHash("sha256").update(JSON.stringify(canonical(s))).digest("hex"),
    runs: s.runs.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)),
    steps: s.steps.map(({ id, version, generation, retryCount, iterationIndex }) =>
      ({ id, version, generation, retryCount, iterationIndex })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  const timestamps = {
    last_event_at: iso(latest([...s.events.map((e) => e.at), ...s.heartbeats.map((hb) => hb.observedAt), lastProgress])),
    last_progress_at: iso(lastProgress), last_observed_at: iso(latest(observed.map((e) => e.at))),
    oldest_running_heartbeat_at: iso(oldestHeartbeat),
  };
  const verdict = (state: CadenceState, triggerKind: CadenceTrigger, reasonCode: string): CadenceVerdict =>
    ({ schemaVersion: 1, state, wouldTrigger: triggerKind !== "none", triggerKind, reasonCode,
      computedTimestamps: timestamps, inputGeneration });
  if (s.runs.some((r) => r.current && FAILURE.has(r.status))
    || s.steps.some((step) => step.current && (FAILURE.has(step.status) || (step.status === "blocked" && !step.waiting)))
    || s.heartbeats.some((hb) => hb.current && FAILURE.has(hb.status))) {
    return verdict("FAILURE_OR_RECOVERY_NEEDED", "immediate_failure", "failure_event_present");
  }
  if (live.length || runningSteps.length) {
    const ghost = live.some((hb) => !(hb.allowedIntervalMs > 0) || now.getTime() - hb.observedAt.getTime() >= hb.allowedIntervalMs)
      || runningSteps.some((step) => !live.some((hb) => hb.stepId === step.id));
    return verdict("RUNNING", ghost ? "liveness_ghost" : "none",
      ghost ? "heartbeat_stale_while_running" : "running_with_fresh_heartbeat");
  }
  const ready = s.steps.filter((step) => step.current && !step.waiting && step.readySince !== null);
  const queued = s.heartbeats.filter((hb) => hb.current && hb.status === "queued" && !hb.waiting);
  const readyRuns = s.runs.filter((r) => r.current && r.readySince != null);
  if (ready.length || queued.length || readyRuns.length) {
    const since = Math.min(...ready.map((step) => step.readySince!.getTime()), ...queued.map((hb) => hb.observedAt.getTime()),
      ...readyRuns.map((r) => r.readySince!.getTime()));
    const due = now.getTime() - since >= WINDOW_MS;
    return verdict("READY_NOT_STARTED", due ? "ready_not_started" : "none", due ? "ready_not_started_5m" : "ready_within_5m");
  }
  const waiting = s.waits.filter((w) => w.satisfiedAt === null);
  if (waiting.length) {
    const overdue = waiting.some((w) => w.until !== null && now.getTime() >= w.until.getTime());
    return verdict("WAITING_EXPLICIT", overdue ? "wait_overdue" : "none", overdue ? "wait_recheck_overdue" : "explicit_wait_pending");
  }
  const idle = now.getTime() - (lastProgress ?? s.mission.createdAt).getTime() >= WINDOW_MS;
  return verdict("IDLE_QUIET", idle ? "stall_idle" : "none",
    idle ? "no_progress_5m_with_no_running_work" : "progress_within_5m");
}
