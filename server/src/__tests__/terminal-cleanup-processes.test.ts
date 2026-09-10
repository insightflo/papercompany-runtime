import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { runMissionTerminalCleanup } from "../services/missions/terminal-cleanup-fence.js";
import { captureMissionTerminalAuthority } from "../services/missions/terminal-cleanup-authority.js";
import { childEntry, readTerminal, runningProcesses, schema, seedTerminal, terminalDatabase, terminalState } from "./helpers/terminal-cleanup-fixture.js";

describe("terminal cleanup exact-child postcommit effects", () => {
  let db: Db;
  let close: () => Promise<void>;
  let transactionOpen: () => boolean;
  beforeAll(async () => { ({ db, close, transactionOpen } = await terminalDatabase()); }, 60_000);
  afterAll(async () => { await close?.(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); runningProcesses.clear(); });

  it("TERM reads committed terminal state through root db, not a locked transaction", async () => {
    const f = await seedTerminal(db);
    const { child, entry } = childEntry();
    let readback: ReturnType<typeof readTerminal> | undefined;
    let signalledInsideTransaction: boolean | undefined;
    child.kill.mockImplementation(() => {
      signalledInsideTransaction = transactionOpen(); // Real PGlite state, not a transaction double.
      readback = readTerminal(db, f); child.killed = true; return true;
    });
    runningProcesses.set(f.heartbeat.id, entry);
    vi.useFakeTimers();
    const result = await runMissionTerminalCleanup(db, f.input);
    expect(result).toEqual({ aborted: false, reason: null, stoppedRuntimeIds: [f.runtime.id] });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(signalledInsideTransaction).toBe(false);
    expect(await readback).toMatchObject({ mission: { status: "completed" }, heartbeat: { status: "cancelled" }, runtime: { status: "stopped" } });
    expect(f.input.cancelHeartbeatRun).not.toHaveBeenCalled();
    expect(runningProcesses.has(f.heartbeat.id)).toBe(false);
  });

  it("oversight throw rolls back DB with no signal, timer or map deletion", async () => {
    const f = await seedTerminal(db);
    const { child, entry } = childEntry();
    runningProcesses.set(f.heartbeat.id, entry);
    const before = await terminalState(db);
    vi.useFakeTimers();
    await expect(runMissionTerminalCleanup(db, { ...f.input, completeOpenMissionOversightIfSettled: async (_mission, _now, executor) => {
      expect(executor).not.toBe(db);
      const [row] = await executor.select().from(schema.missions).where(eq(schema.missions.id, f.mission.id));
      expect(row.status).toBe("completed");
      throw new Error("oversight rollback");
    } })).rejects.toThrow("oversight rollback");
    expect(await terminalState(db)).toEqual(before);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(runningProcesses.get(f.heartbeat.id)).toBe(entry);
    expect(f.input.cancelHeartbeatRun).not.toHaveBeenCalled();
  });

  it("stale captured epoch leaves all DB state and process handles untouched", async () => {
    const f = await seedTerminal(db);
    const capturedAuthority = await captureMissionTerminalAuthority(db, f.company.id, f.mission.id);
    await db.update(schema.missions).set({ updatedAt: new Date(Date.now() + 1000) }).where(eq(schema.missions.id, f.mission.id));
    const { child, entry } = childEntry();
    runningProcesses.set(f.heartbeat.id, entry);
    const before = await terminalState(db);
    vi.useFakeTimers();
    expect(await runMissionTerminalCleanup(db, { ...f.input, capturedAuthority })).toEqual({ aborted: true, reason: "resume_reactivated", stoppedRuntimeIds: [] });
    expect(await terminalState(db)).toEqual(before);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(runningProcesses.get(f.heartbeat.id)).toBe(entry);
  });

  it("captures old child and grace once; replacement map entry survives TERM and KILL", async () => {
    const f = await seedTerminal(db);
    const old = childEntry(12345, 2);
    const replacement = childEntry(12346);
    runningProcesses.set(f.heartbeat.id, old.entry);
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, "setTimeout");
    await runMissionTerminalCleanup(db, { ...f.input, completeOpenMissionOversightIfSettled: async () => {
      old.entry.child = replacement.entry.child;
      old.entry.graceSec = 99;
      runningProcesses.set(f.heartbeat.id, replacement.entry);
    } });
    expect(old.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(old.child.killed).toBe(true); // signal sent, not exit evidence
    expect(timers).toHaveBeenCalledWith(expect.any(Function), 2000);
    expect(timers.mock.results.at(-1)?.value.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(old.child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(old.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(replacement.child.kill).not.toHaveBeenCalled();
    expect(runningProcesses.get(f.heartbeat.id)).toBe(replacement.entry);
  });

  it.each(["missing", "mismatch"])("%s handle does not signal or fall back to a raw PID/callback", async (mode) => {
    const f = await seedTerminal(db);
    const { child, entry } = childEntry(54321);
    if (mode === "mismatch") runningProcesses.set(f.heartbeat.id, entry);
    const rawKill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.useFakeTimers();
    expect((await runMissionTerminalCleanup(db, f.input)).aborted).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    expect(rawKill).not.toHaveBeenCalled();
    expect(f.input.cancelHeartbeatRun).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect((await readTerminal(db, f)).heartbeat.status).toBe("cancelled");
    if (mode === "mismatch") expect(runningProcesses.get(f.heartbeat.id)).toBe(entry);
  });

  it.each(["exitCode", "signalCode"] as const)("%s before TERM prevents both signals", async (field) => {
    const f = await seedTerminal(db);
    const { child, entry } = childEntry();
    if (field === "exitCode") child.exitCode = 0; else child.signalCode = "SIGTERM";
    runningProcesses.set(f.heartbeat.id, entry);
    vi.useFakeTimers();
    await runMissionTerminalCleanup(db, f.input);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["exitCode", "signalCode"] as const)("%s after TERM prevents escalation", async (field) => {
    const f = await seedTerminal(db);
    const { child, entry } = childEntry();
    runningProcesses.set(f.heartbeat.id, entry);
    vi.useFakeTimers();
    await runMissionTerminalCleanup(db, f.input);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    if (field === "exitCode") child.exitCode = 0; else child.signalCode = "SIGTERM";
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it.each(["SIGTERM", "SIGKILL"])("%s error cannot fail committed success or touch replacement/other child", async (signal) => {
    const f = await seedTerminal(db);
    const second = await db.insert(schema.heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, issueId: f.issue.id, status: "queued" }).returning();
    const old = childEntry();
    const replacement = childEntry(45678);
    const other = childEntry();
    old.child.kill.mockImplementation((sent) => { if (sent === signal) throw new Error("signal error"); return true; });
    runningProcesses.set(f.heartbeat.id, old.entry);
    runningProcesses.set(second[0].id, other.entry);
    vi.useFakeTimers();
    expect((await runMissionTerminalCleanup(db, { ...f.input, completeOpenMissionOversightIfSettled: async () => {
      runningProcesses.set(f.heartbeat.id, replacement.entry);
    } })).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await readTerminal(db, f)).mission.status).toBe("completed");
    expect(old.child.kill).toHaveBeenCalledWith(signal);
    expect(other.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(replacement.child.kill).not.toHaveBeenCalled();
    expect(runningProcesses.get(f.heartbeat.id)).toBe(replacement.entry);
  });
});
