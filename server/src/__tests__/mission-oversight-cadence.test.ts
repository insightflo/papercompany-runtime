import { describe, expect, it } from "vitest";
import type { CadenceSnapshot } from "../services/mission-oversight-cadence.js";
// Keep the named RED assertions runnable before the production module exists.
const { evaluateMissionOversightCadence } = await import("../services/mission-oversight-cadence.js")
  .catch((error: unknown) => ({ evaluateMissionOversightCadence: (_s: CadenceSnapshot, _now: Date): never => { throw error; } }));

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 14, 0, minutes));
function snapshot(): CadenceSnapshot {
  return {
    mission: { id: "mission", companyId: "company", status: "active", createdAt: at(0) },
    runs: [], steps: [], heartbeats: [], events: [], waits: [],
  };
}
function running(valid = true): CadenceSnapshot {
  const s = snapshot();
  s.runs.push({ id: "run", status: "running", version: 4, createdAt: at(0), startedAt: at(0), completedAt: null, current: true });
  s.heartbeats.push({ id: "hb", status: "running", observedAt: at(valid ? 25 : 1), startedAt: at(0), finishedAt: null,
    allowedIntervalMs: 5 * 60_000, stepId: null, current: true });
  return s;
}
const event = (id: string, minute: number, type: string, layer = "workflow_sync", fromStatus: string | null = null, toStatus: string | null = null) =>
  ({ id, at: at(minute), type, layer, fromStatus, toStatus });

describe("mission oversight shadow policy", () => {
  it("C1a: a 26-minute normal build with a fresh heartbeat remains RUNNING without oversight", () => {
    const verdict = evaluateMissionOversightCadence(running(), at(26));
    expect(verdict).toMatchObject({ state: "RUNNING", wouldTrigger: false, triggerKind: "none" });
    expect(verdict.computedTimestamps.last_progress_at).toBe(at(0).toISOString());
    expect(verdict.computedTimestamps.oldest_running_heartbeat_at).toBe(at(25).toISOString());
  });

  it("C1b: a current failed step requests immediate failure oversight", () => {
    const s = snapshot();
    s.steps.push({ id: "step", status: "failed", version: 2, generation: 3, retryCount: 0, iterationIndex: 0,
      startedAt: at(0), completedAt: at(1), readySince: null, current: true });
    expect(evaluateMissionOversightCadence(s, at(1))).toMatchObject({ state: "FAILURE_OR_RECOVERY_NEEDED",
      wouldTrigger: true, triggerKind: "immediate_failure", reasonCode: "failure_event_present" });
  });

  it("C1c: desigma failure history followed only by 30/60-minute review noise stays idle", () => {
    const s = snapshot();
    s.events = [event("failure", 1, "workflow_step_status_transition", "workflow_sync", "running", "failed"),
      event("review1", 31, "mission_owner_periodic_review_wake", "mission_owner_recovery"),
      event("review2", 61, "mission_owner_periodic_review_wake", "mission_owner_recovery")];
    const verdict = evaluateMissionOversightCadence(s, at(62));
    expect(verdict).toMatchObject({ state: "IDLE_QUIET", wouldTrigger: true, triggerKind: "stall_idle",
      reasonCode: "no_progress_5m_with_no_running_work" });
    expect(verdict.computedTimestamps).toMatchObject({ last_progress_at: at(1).toISOString(),
      last_event_at: at(61).toISOString(), last_observed_at: at(61).toISOString() });
  });

  it("C1d: a recorded running heartbeat outside its allowed interval is a ghost candidate", () => {
    expect(evaluateMissionOversightCadence(running(false), at(26))).toMatchObject({ state: "RUNNING",
      wouldTrigger: true, triggerKind: "liveness_ghost", reasonCode: "heartbeat_stale_while_running" });
  });

  it("C1e: actual workflowRetry backoff waits until its nextEligibleAt recheck", () => {
    const s = snapshot();
    s.waits.push({ id: "retry:step", kind: "retry_backoff", until: at(10), satisfiedAt: null });
    expect(evaluateMissionOversightCadence(s, at(9))).toMatchObject({ state: "WAITING_EXPLICIT", wouldTrigger: false });
    expect(evaluateMissionOversightCadence(s, at(10))).toMatchObject({ state: "WAITING_EXPLICIT",
      wouldTrigger: true, triggerKind: "wait_overdue" });
  });

  it("tracks ready-state age separately from unrelated progress and observation events", () => {
    const s = snapshot();
    s.steps.push({ id: "ready", status: "pending", version: 0, generation: 0, retryCount: 0, iterationIndex: 0,
      startedAt: null, completedAt: null, readySince: at(5), current: true });
    s.events = [event("review", 9, "owner_diagnosis", "mission_owner_recovery")];
    expect(evaluateMissionOversightCadence(s, at(9))).toMatchObject({ state: "READY_NOT_STARTED", wouldTrigger: false });
    expect(evaluateMissionOversightCadence(s, at(10))).toMatchObject({ state: "READY_NOT_STARTED", triggerKind: "ready_not_started" });
  });

  it.each(["completed", "cancelled"])("normal %s termination never triggers immediate failure", (status) => {
    const s = snapshot();
    s.runs.push({ id: "run", status, version: 0, current: true, createdAt: at(0), startedAt: at(0), completedAt: at(2) });
    expect(evaluateMissionOversightCadence(s, at(3))).toMatchObject({ state: "IDLE_QUIET", wouldTrigger: false });
  });

  it("ignores superseded failure states but retains their historical transition as progress", () => {
    const s = snapshot();
    s.runs.push({ id: "old", status: "failed", version: 1, current: false, createdAt: at(0), startedAt: at(0), completedAt: at(2) });
    expect(evaluateMissionOversightCadence(s, at(10))).toMatchObject({ state: "IDLE_QUIET", triggerKind: "stall_idle" });
    expect(evaluateMissionOversightCadence(s, at(10)).computedTimestamps.last_progress_at).toBe(at(2).toISOString());
  });

  it("a workflow container marked running with no executing heartbeat is not live work", () => {
    const s = snapshot();
    s.runs = running().runs;
    expect(evaluateMissionOversightCadence(s, at(10))).toMatchObject({ state: "IDLE_QUIET", triggerKind: "stall_idle" });
  });

  it("running step without any matching heartbeat is a ghost, not a blanket exemption", () => {
    const s = snapshot();
    s.steps.push({ id: "step", status: "running", version: 1, generation: 2, retryCount: 0, iterationIndex: 0,
      startedAt: at(0), completedAt: null, readySince: null, current: true });
    expect(evaluateMissionOversightCadence(s, at(26))).toMatchObject({ state: "RUNNING", triggerKind: "liveness_ghost" });
  });

  it("pending human approval has no invented timeout; another runnable unit is not exempted", () => {
    const s = snapshot();
    s.waits.push({ id: "approval", kind: "approval", until: null, satisfiedAt: null });
    expect(evaluateMissionOversightCadence(s, at(600))).toMatchObject({ state: "WAITING_EXPLICIT", wouldTrigger: false });
    s.steps.push({ id: "other", status: "pending", version: 0, generation: 0, retryCount: 0, iterationIndex: 0,
      startedAt: null, completedAt: null, readySince: at(0), current: true });
    expect(evaluateMissionOversightCadence(s, at(600))).toMatchObject({ state: "READY_NOT_STARTED", wouldTrigger: true });
  });

  it("actual wait satisfaction and retry-stage transitions count, not repeated no-change or observations", () => {
    const s = snapshot();
    s.waits.push({ id: "approval", kind: "approval", until: null, satisfiedAt: at(10) });
    s.events = [event("retry", 11, "workflow_step_retry_scheduled", "workflow_retry", "failed", "pending"),
      event("noop", 12, "workflow_step_status_transition", "workflow_sync", "pending", "pending"),
      event("card", 13, "owner_tool_recovery_target_v1", "mission_owner_recovery")];
    expect(evaluateMissionOversightCadence(s, at(14)).computedTimestamps.last_progress_at).toBe(at(11).toISOString());
  });

  it("input generation is deterministic, insensitive to row order/time, and changes with attempt versions", () => {
    const s = running();
    s.events = [event("a", 1, "workflow_step_status_transition", "workflow_sync", "pending", "running"),
      event("b", 2, "workflow_step_status_transition", "workflow_sync", "running", "completed")];
    const first = evaluateMissionOversightCadence(s, at(26));
    const reordered = { ...s, events: [...s.events].reverse() };
    expect(evaluateMissionOversightCadence(reordered, at(27)).inputGeneration).toEqual(first.inputGeneration);
    s.runs[0].version++;
    expect(evaluateMissionOversightCadence(s, at(26)).inputGeneration).not.toEqual(first.inputGeneration);
    expect(first.inputGeneration).toMatchObject({ schemaVersion: 1, runs: [{ id: "run", version: 4 }] });
  });

  it("failure wins over live work, and stale work is not hidden by unrelated explicit waits", () => {
    const s = running(false);
    s.waits.push({ id: "wait", kind: "operator_decision", until: null, satisfiedAt: null });
    expect(evaluateMissionOversightCadence(s, at(26)).triggerKind).toBe("liveness_ghost");
    s.runs[0].status = "failed";
    expect(evaluateMissionOversightCadence(s, at(26)).triggerKind).toBe("immediate_failure");
  });
});
