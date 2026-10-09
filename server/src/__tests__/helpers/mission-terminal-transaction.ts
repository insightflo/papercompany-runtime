import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issues,
  missionAgentRuntimes, missions, workflowDefinitions, workflowRuns,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";

export type TerminalFixture = Awaited<ReturnType<typeof seedTerminalTransaction>>;
export type QueryTrace = { connection: number; query: string };

export async function startTerminalTransactionDatabase() {
  const temp = await startEmbeddedPostgresTestDatabase("mission-terminal-transaction-");
  let db = createDb(temp.connectionString);
  // Only the newly created isolated cluster's role is changed; production settings are untouched.
  await db.$client.unsafe("alter role paperclip set lock_timeout = '700ms'");
  await db.$client.end({ timeout: 5 });
  db = createDb(temp.connectionString);
  await db.$client.unsafe(`
    create table terminal_test_writes (
      sequence bigserial, relation text, row_id text, status text,
      backend_pid integer, transaction_id bigint
    );
    create function terminal_test_record_write() returns trigger language plpgsql as $$
    begin
      insert into terminal_test_writes values
        (default, TG_TABLE_NAME, NEW.id::text, to_jsonb(NEW)->>'status', pg_backend_pid(), txid_current());
      return NEW;
    end $$;
    create trigger terminal_test_mission after update on missions
      for each row execute function terminal_test_record_write();
    create trigger terminal_test_heartbeat after update on heartbeat_runs
      for each row execute function terminal_test_record_write();
    create trigger terminal_test_runtime after update on mission_agent_runtimes
      for each row execute function terminal_test_record_write();
    create trigger terminal_test_issue after update on issues
      for each row execute function terminal_test_record_write();
    create trigger terminal_test_comment after insert on issue_comments
      for each row execute function terminal_test_record_write();
    create trigger terminal_test_activity after insert on activity_log
      for each row execute function terminal_test_record_write();
  `);
  const trace: QueryTrace[] = [];
  db.$client.options.debug = (connection, query) => { trace.push({ connection, query }); };
  return { db, trace, cleanup: async () => { await db.$client.end({ timeout: 5 }); await temp.cleanup(); } };
}

export async function seedTerminalTransaction(db: ReturnType<typeof createDb>, workflowCreated = false, nested = false) {
  const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID();
  const workflowId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
  const completedAt = new Date("2026-10-09T00:00:00.000Z");
  await db.insert(companies).values({ id: companyId, name: "Terminal transaction test", issuePrefix: `T${companyId.replaceAll("-", "")}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Runner", role: "member", status: "active", adapterType: "codex_local" });
  const [mission] = await db.insert(missions).values({
    id: missionId, companyId, ownerAgentId: agentId, title: "Terminal transaction", status: "active", startedAt: completedAt,
    description: workflowCreated ? "Created automatically for workflow run: fixture" : null,
  }).returning();
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Completed workflow", stepsJson: [] });
  await db.insert(workflowRuns).values({ companyId, workflowId, missionId, status: "completed", triggeredBy: "test", completedAt });
  await db.insert(issues).values({ id: issueId, companyId, missionId, title: "Oversight", status: "in_progress", assigneeAgentId: agentId, originKind: "mission_main_executor_oversight" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "running", invocationSource: "assignment" });
  await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId, executionAgentNameKey: "runner", executionLockedAt: completedAt }).where(eq(issues.id, issueId));
  await db.insert(missionAgentRuntimes).values({ companyId, missionId, agentId, adapterType: "codex_local", runtimeKey: randomUUID(), status: "busy", queueDepth: 1 });
  const sourceId = nested ? randomUUID() : null;
  const actionId = nested ? randomUUID() : null;
  if (sourceId && actionId) {
    await db.insert(issues).values({ id: sourceId, companyId, missionId, title: "Settled source", status: "done", completedAt, originKind: "mission_workflow" });
    await db.insert(issues).values({ id: actionId, companyId, missionId, title: "Resolved owner action", status: "blocked", originKind: "mission_main_executor_unblock", originId: sourceId });
  }
  return { companyId, missionId, issueId, runId, sourceId, actionId, mission, completedAt };
}

export async function terminalState(db: ReturnType<typeof createDb>, f: TerminalFixture) {
  return {
    missions: await db.select().from(missions).where(eq(missions.id, f.missionId)),
    issues: await db.select().from(issues).where(eq(issues.missionId, f.missionId)).orderBy(issues.id),
    runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)),
    runtimes: await db.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.missionId, f.missionId)),
    agents: await db.select().from(agents).where(eq(agents.companyId, f.companyId)),
    comments: await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId)),
    activity: await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId)),
  };
}

export function postgresError(error: unknown): { code?: string; message?: string } {
  let current = error;
  while (current && typeof current === "object") {
    if ("code" in current) return current as { code: string; message?: string };
    current = "cause" in current ? current.cause : null;
  }
  return {};
}
