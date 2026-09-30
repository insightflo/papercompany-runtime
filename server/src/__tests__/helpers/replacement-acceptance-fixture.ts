import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { seedReplacement } from "./replacement-scenario.js";
import { setRunRecoveryFlags } from "./run-reopen-guard-fixture.js";
import { setWorkflowToolStepExecutor } from "../../services/workflow/dag-engine.js";

// Real services and isolated PostgreSQL; the executor only detects unwanted adapter calls.
export function replacementAcceptanceFixture() {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  const peers: ReturnType<typeof createDb>[] = [];
  const executor = vi.fn(async () => { throw new Error("P10 must not execute an adapter"); });

  beforeEach(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    temp = await startEmbeddedPostgresTestDatabase("replacement-acceptance-");
    db = createDb(temp.connectionString);
    await setRunRecoveryFlags(db, true, true);
    setWorkflowToolStepExecutor(executor);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await Promise.all(peers.map(peer => peer.$client.end({ timeout: 5 })));
    await db?.$client.end({ timeout: 5 });
    await temp?.cleanup();
    roots.forEach(root => rmSync(root, { recursive: true, force: true }));
    peers.length = 0;
    roots.length = 0;
    executor.mockClear();
  }, 60_000);

  return {
    get db() { return db; },
    executor,
    async seed() {
      const scenario = await seedReplacement(db);
      roots.push(scenario.tempRoot);
      return scenario;
    },
    peer(applicationName: string) {
      // postgres.js accepts pool size and startup parameters in the connection URL.
      // One named backend per contender makes actual lock overlap observable.
      const url = new URL(temp.connectionString);
      url.searchParams.set("max", "1");
      url.searchParams.set("application_name", applicationName);
      const peer = createDb(url.toString());
      peers.push(peer);
      return peer;
    },
    async snapshot(companyId: string) {
      const out: Record<string, unknown> = {};
      for (const table of ["workflow_runs", "workflow_recovery_authorities", "workflow_terminal_decisions",
        "issues", "agent_wakeup_requests", "heartbeat_runs", "activity_log"]) {
        out[table] = await db.$client.unsafe(`select * from ${table} where company_id = $1 order by id`, [companyId]);
      }
      out.steps = await db.$client.unsafe(`select s.* from workflow_step_runs s
        join workflow_runs r on r.id=s.workflow_run_id where r.company_id=$1 order by s.id`, [companyId]);
      return JSON.parse(JSON.stringify(out));
    },
  };
}
