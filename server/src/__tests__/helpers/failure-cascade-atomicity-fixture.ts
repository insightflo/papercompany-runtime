import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  activityLog, agentWakeupRequests, createDb, heartbeatRuns, issueComments, issues,
  missionAgentRuntimes, missions, workflowRuns, workflowStepRuns, workflowTerminalDecisions,
  workflowTerminalEffectIntents, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { seedBoundaryIntegrationRun } from "./run-terminal-boundary-integration-fixtures.js";
import { waitForHeartbeatExecutionsToDrain } from "../../services/heartbeat-execution-tracker.js";
import { settleDeadlockFailureCascade, settleStuckFailureCascade } from "../../services/workflow/failure-cascade-finalization.js";
import type { FinalizeRunTerminalInput } from "../../services/workflow/run-terminal-boundary.js";

export type Scope = { companyId: string; runId: string };
export type Mode = "stuck-on" | "stuck-off" | "deadlock-on" | "deadlock-off" | "hold-on" | "hold-off";
export const modes: Mode[] = ["stuck-on", "stuck-off", "deadlock-on", "deadlock-off", "hold-on", "hold-off"];
export const staleReason = "Failure cascade discarded: run or step observation changed";
export const isStuck = (mode: Mode) => mode.startsWith("stuck");
export const enabled = (mode: Mode) => mode.endsWith("-on");

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export async function createCascadeHarness() {
  const temporary = await startEmbeddedPostgresTestDatabase("failure-cascade-atomicity-");
  const url = new URL(temporary.connectionString);
  if (url.hostname !== "127.0.0.1" || [54329, 55432].includes(Number(url.port))) throw Error("Expected owned test PostgreSQL");
  const db = createDb(temporary.connectionString), peer = createDb(temporary.connectionString);
  const observer = createDb(temporary.connectionString), clients = [db, peer, observer];
  const [location] = await db.execute(sql`SELECT current_setting('data_directory') AS dir`);
  const directory = String(location!.dir), pidFile = path.join(directory, "postmaster.pid");
  if (!path.basename(directory).startsWith("failure-cascade-atomicity-")) throw Error("Unexpected owned directory");
  const pid = Number((await readFile(pidFile, "utf8")).split("\n")[0]);
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) throw Error("Cannot establish PostgreSQL ownership");
  // Simultaneously open transactions prove distinct physical PostgreSQL sessions.
  await db.transaction(async left => {
    const [a] = await left.execute(sql`SELECT pg_backend_pid() AS pid`);
    await peer.transaction(async right => {
      const [b] = await right.execute(sql`SELECT pg_backend_pid() AS pid`);
      if (Number(a!.pid) === Number(b!.pid)) throw Error("Independent sessions required");
    });
  });
  return { db, peer, observer, close: async () => {
    const errors: unknown[] = [];
    const attempt = async (work: () => Promise<unknown>) => {
      try { await work(); } catch (error) { errors.push(error); }
    };
    for (const client of clients) await attempt(() => waitForHeartbeatExecutionsToDrain(client));
    await Promise.all(clients.map(client => attempt(() => client.$client.end({ timeout: 5 }))));
    await attempt(async () => {
      if (alive(pid)) {
        if (Number((await readFile(pidFile, "utf8")).split("\n")[0]) !== pid) throw Error("PostgreSQL owner changed");
        process.kill(pid, "SIGTERM");
      }
      const deadline = Date.now() + 15000;
      while (alive(pid)) {
        if (Date.now() >= deadline) throw Error("Owned PostgreSQL did not exit; preserve directory");
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    });
    if (alive(pid) || errors.length) throw new AggregateError(errors, "Owned DB teardown incomplete; directory preserved");
    // Avoid the installed helper's second stop after physical process exit.
    await rm(directory, { recursive: true, force: false });
  } };
}

export async function seedCascade(db: Db, hold = false) {
  return seedBoundaryIntegrationRun(db, {
    steps: [
      { stepId: "upstream", status: "failed", issueStatus: hold ? "done" : "blocked" },
      { stepId: "after", status: "pending", dependencies: ["upstream"],
        ...(hold ? {} : { issueStatus: "todo" }), metadata: { keep: "original" } },
      ...(hold ? [{ stepId: "held", status: "pending", issueStatus: "blocked", dependencies: ["upstream"] }] : []),
    ],
    runtimeOnStepIssue: "upstream",
  });
}

export async function observe(db: Db, scope: Scope, mode: Mode) {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, scope.runId));
  if (!run) throw Error("Fixture run missing");
  const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, scope.runId));
  const pending = steps.filter(step => step.status === "pending");
  return { run, steps, pending, selected: mode.startsWith("hold") ? pending.filter(step => step.stepId === "after") : pending };
}
export type Observed = Awaited<ReturnType<typeof observe>>;

export function settle(db: Db, observed: Observed, mode: Mode) {
  if (isStuck(mode)) return settleStuckFailureCascade(db, {
    run: observed.run, pendingSteps: observed.pending,
    boundaryStepRuns: enabled(mode) ? observed.steps : [], boundaryEnabled: enabled(mode),
  });
  return settleDeadlockFailureCascade(db, {
    run: observed.run, runSteps: observed.steps, stepsToSkip: observed.selected,
    boundaryEnabled: enabled(mode), now: new Date(), mayFinalize: !mode.startsWith("hold"),
  });
}

// Full raw rows: expected rollback is equality to independently committed state,
// including timestamps, versions, generations, metadata, effects and execution state.
export async function cascadeState(db: Pick<Db, "select">, scope: Scope) {
  const { companyId, runId } = scope;
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  return {
    run: run!,
    steps: await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId)).orderBy(workflowStepRuns.id),
    issues: await db.select().from(issues).where(eq(issues.companyId, companyId)).orderBy(issues.id),
    comments: await db.select().from(issueComments).where(eq(issueComments.companyId, companyId)).orderBy(issueComments.id),
    transitions: await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowRunId, runId)).orderBy(workflowTransitionEvents.id),
    decisions: await db.select().from(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.workflowRunId, runId)).orderBy(workflowTerminalDecisions.id),
    effects: await db.select().from(workflowTerminalEffectIntents).where(eq(workflowTerminalEffectIntents.companyId, companyId)).orderBy(workflowTerminalEffectIntents.id),
    heartbeats: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(heartbeatRuns.id),
    wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)).orderBy(agentWakeupRequests.id),
    runtimes: await db.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.companyId, companyId)).orderBy(missionAgentRuntimes.id),
    missions: await db.select().from(missions).where(eq(missions.companyId, companyId)).orderBy(missions.id),
    activities: await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(activityLog.id),
  };
}
export function snapshot(db: Db, scope: Scope) {
  return db.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    return cascadeState(tx, scope);
  });
}

export function terminalInput(observed: Observed, decision: "completed" | "failed" = "failed"): FinalizeRunTerminalInput {
  return {
    runId: observed.run.id, companyId: observed.run.companyId,
    expectedAuthorityVersion: observed.run.dispatchAuthorityVersion, decision,
    cause: { policy: "outcome_convergence", discovery: "engine_recompute", origin: "dag_engine" },
    gatePolicy: "immediate", now: new Date(), stepRuns: observed.steps,
  };
}

/** Real PostgreSQL trigger: inject a precise failure or suspend a physical UPDATE. */
export async function trigger(db: Db, table: string, operation: string, predicate: string, body: string) {
  const name = "c04_" + randomUUID().replaceAll("-", "");
  await db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $c04$
    BEGIN IF ${predicate} THEN ${body} END IF; RETURN NEW; END; $c04$`));
  await db.execute(sql.raw(`CREATE TRIGGER ${name} ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`));
  return async () => {
    await db.execute(sql.raw(`DROP TRIGGER ${name} ON ${table}`));
    await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
  };
}

export async function waitForSkipLock(observer: Db, holder: number) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const waiting = await observer.execute(sql`SELECT pid, query FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
      AND ${holder} = ANY(pg_blocking_pids(pid))`);
    if (waiting.some(row => /update\s+"workflow_step_runs"/i.test(String(row.query)) && Number(row.pid) !== holder)) return;
    if (Date.now() >= deadline) throw Error("Physical skip UPDATE lock wait not observed");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

export async function insertUnblock(db: Pick<Db, "insert">, scope: Scope & { missionId: string }, sourceIssueId: string) {
  await db.insert(issues).values({
    companyId: scope.companyId, missionId: scope.missionId, title: "Late unblock", status: "todo",
    originKind: "mission_main_executor_unblock", originId: sourceIssueId,
    // Deliberately no originRunId: no FK acquisition on the cascade's locked run.
  });
}

export function errorMessages(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message + ("cause" in error ? "\n" + errorMessages(error.cause) : "");
}
