import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companies, createDb, missions, missionAgentRuntimes, workflowDefinitions, workflowRuns, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { ensureMissionAgentRuntime } from "../services/missions/mission-runtime-manager.js";
import { withResumeSerialization } from "../services/workflow/resume/serialization.js";

let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let observer: Db, resumeDb: Db, ordinaryDb: Db;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
async function waitFor<T>(read: () => Promise<T | null>, label: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function fixture() {
  const companyId = randomUUID(), missionId = randomUUID(), agentId = randomUUID();
  const workflowId = randomUUID(), workflowRunId = randomUUID();
  await observer.insert(companies).values({ id: companyId, name: "Lock order", issuePrefix: `LO${companyId.replaceAll("-", "").slice(0, 7)}` });
  await observer.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "idle" });
  await observer.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Lock order", status: "active" });
  await observer.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Lock order", stepsJson: [] });
  await observer.insert(workflowRuns).values({ id: workflowRunId, companyId, missionId, workflowId, status: "running", triggeredBy: "test" });
  return { companyId, missionId, agentId, workflowRunId, adapterType: "process", workspaceKey: "same-workspace" };
}
beforeAll(async () => {
  pg = await startEmbeddedPostgresTestDatabase("mission-runtime-lock-order-");
  observer = createDb(pg.connectionString);
  const a = new URL(pg.connectionString), b = new URL(pg.connectionString);
  a.searchParams.set("application_name", "mission-lock-resume");
  b.searchParams.set("application_name", "mission-lock-ordinary");
  resumeDb = createDb(a.toString()); ordinaryDb = createDb(b.toString());
}, 120_000);
afterAll(async () => {
  await Promise.all([observer?.$client.end({ timeout: 5 }), resumeDb?.$client.end({ timeout: 5 }), ordinaryDb?.$client.end({ timeout: 5 })]);
  await pg?.cleanup();
}, 120_000);

it("locks the mission before a competing runtime upsert and allows both callers to finish", async () => {
  const input = await fixture();
  const aLocked = deferred(), allowAInsert = deferred();
  let aPid = 0;
  const a = withResumeSerialization(resumeDb, { companyId: input.companyId, missionId: input.missionId, runId: input.workflowRunId }, async ({ tx }) => {
    const scoped = tx as unknown as Db;
    await scoped.execute(sql`set local deadlock_timeout = '8s'`);
    await scoped.execute(sql`set local statement_timeout = '20s'`);
    const rows = await scoped.execute(sql`select pg_backend_pid() as pid`);
    aPid = Number((rows as unknown as Array<{ pid: number }>)[0]!.pid);
    aLocked.resolve();
    await allowAInsert.promise;
    return ensureMissionAgentRuntime(scoped, input);
  });
  void a.catch(() => {});
  await Promise.race([aLocked.promise, a.then(() => { throw new Error("resume exited before acquiring mission lock"); })]);
  let b: ReturnType<typeof ensureMissionAgentRuntime> | undefined;
  try {
    b = ensureMissionAgentRuntime(ordinaryDb, input);
    void b.catch(() => {});
    const waiting = await waitFor(async () => {
      const rows = await observer.$client`select pid, pg_blocking_pids(pid) as blockers, query from pg_stat_activity where application_name='mission-lock-ordinary'`;
      const row = rows.find((item) => (item.blockers as number[]).includes(aPid));
      return row ? { pid: Number(row.pid), query: String(row.query), blockers: row.blockers } : null;
    }, "ordinary runtime waiting on the mission lock");
    // A waiting INSERT holds the conflicting unique-key intent and can deadlock A.
    expect(waiting.query).toMatch(/select\b[\s\S]*from\s+"missions"[\s\S]*for\s+key\s+share/i);
    const otherMission = randomUUID();
    await observer.insert(missions).values({ id: otherMission, companyId: input.companyId, ownerAgentId: input.agentId, title: "Independent mission", status: "active" });
    const independent = await Promise.race([
      ensureMissionAgentRuntime(observer, { ...input, missionId: otherMission }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("independent mission was blocked")), 3_000)),
    ]);
    expect(independent.runtime.missionId).toBe(otherMission);
    allowAInsert.resolve();
    const [fromResume, fromOrdinary] = await Promise.all([a, b]);
    expect(fromResume.runtime.id).toBe(fromOrdinary.runtime.id);
    const rows = await observer.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.missionId, input.missionId));
    expect(rows).toHaveLength(1);
    console.log("MISSION_RUNTIME_LOCK_ORDER", JSON.stringify({ resumePid: aPid, waiting, runtimeRows: rows.length }));
  } finally {
    allowAInsert.resolve();
    await Promise.allSettled([a, ...(b ? [b] : [])]);
  }
}, 60_000);

it("locks the referenced mission even when a caller supplies another company", async () => {
  const input = await fixture(), otherCompanyId = randomUUID();
  await observer.insert(companies).values({ id: otherCompanyId, name: "Other company", issuePrefix: `OC${otherCompanyId.replaceAll("-", "").slice(0, 7)}` });
  const aLocked = deferred(), allowAInsert = deferred();
  let aPid = 0;
  const a = withResumeSerialization(resumeDb, { companyId: input.companyId, missionId: input.missionId, runId: input.workflowRunId }, async ({ tx }) => {
    const scoped = tx as unknown as Db;
    const rows = await scoped.execute(sql`select pg_backend_pid() as pid`);
    aPid = Number((rows as unknown as Array<{ pid: number }>)[0]!.pid);
    aLocked.resolve();
    await allowAInsert.promise;
    return ensureMissionAgentRuntime(scoped, input);
  });
  void a.catch(() => {});
  await Promise.race([aLocked.promise, a.then(() => { throw new Error("resume exited before acquiring mission lock"); })]);
  let b: Promise<unknown> | undefined;
  try {
    // Roll back the foreign-company probe regardless of how existing validation behaves.
    b = ordinaryDb.transaction(async (tx) => {
      await ensureMissionAgentRuntime(tx as unknown as Db, { ...input, companyId: otherCompanyId });
      throw new Error("foreign probe rollback");
    });
    void b.catch(() => {});
    const waiting = await waitFor(async () => {
      const rows = await observer.$client`select pg_blocking_pids(pid) as blockers, query from pg_stat_activity where application_name='mission-lock-ordinary'`;
      const row = rows.find((item) => (item.blockers as number[]).includes(aPid));
      return row ? String(row.query) : null;
    }, "foreign-company probe waiting on the referenced mission");
    expect(waiting).toMatch(/select\b[\s\S]*from\s+"missions"[\s\S]*for\s+key\s+share/i);
    allowAInsert.resolve();
    await a;
    await expect(b).rejects.toThrow("foreign probe rollback");
    const rows = await observer.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.missionId, input.missionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.companyId).toBe(input.companyId);
  } finally {
    allowAInsert.resolve();
    await Promise.allSettled([a, ...(b ? [b] : [])]);
  }
}, 60_000);

it("lets resume wait behind an ordinary transaction that already owns the mission key lock", async () => {
  const input = await fixture();
  const bInserted = deferred(), allowBCommit = deferred();
  let bPid = 0;
  const b = ordinaryDb.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    const rows = await scoped.execute(sql`select pg_backend_pid() as pid`);
    bPid = Number((rows as unknown as Array<{ pid: number }>)[0]!.pid);
    const result = await ensureMissionAgentRuntime(scoped, input);
    bInserted.resolve();
    await allowBCommit.promise;
    return result;
  });
  void b.catch(() => {});
  await Promise.race([bInserted.promise, b.then(() => { throw new Error("ordinary transaction exited before its gate"); })]);
  let a: ReturnType<typeof ensureMissionAgentRuntime> | undefined;
  try {
    a = withResumeSerialization(resumeDb, { companyId: input.companyId, missionId: input.missionId, runId: input.workflowRunId },
      async ({ tx }) => ensureMissionAgentRuntime(tx as unknown as Db, input));
    void a.catch(() => {});
    const waiting = await waitFor(async () => {
      const rows = await observer.$client`select pg_blocking_pids(pid) as blockers, query from pg_stat_activity where application_name='mission-lock-resume'`;
      const row = rows.find((item) => (item.blockers as number[]).includes(bPid));
      return row ? String(row.query) : null;
    }, "resume waiting for the ordinary mission lock");
    expect(waiting).toMatch(/select\b[\s\S]*from\s+"missions"[\s\S]*for\s+update/i);
    allowBCommit.resolve();
    const [fromOrdinary, fromResume] = await Promise.all([b, a]);
    expect(fromResume.runtime.id).toBe(fromOrdinary.runtime.id);
    const rows = await observer.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.missionId, input.missionId));
    expect(rows).toHaveLength(1);
  } finally {
    allowBCommit.resolve();
    await Promise.allSettled([b, ...(a ? [a] : [])]);
  }
}, 60_000);

it("preserves the caller transaction's rollback boundary", async () => {
  const input = await fixture();
  await expect(observer.transaction(async (tx) => {
    await ensureMissionAgentRuntime(tx as unknown as Db, input);
    throw new Error("rollback marker");
  })).rejects.toThrow("rollback marker");
  const rows = await observer.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.missionId, input.missionId));
  expect(rows).toHaveLength(0);
}, 60_000);
