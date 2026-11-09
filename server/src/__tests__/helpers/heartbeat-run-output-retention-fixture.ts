import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe } from "vitest";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

export const describeRetentionDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping heartbeat run output retention integration tests: ${support.reason ?? "unsupported environment"}`,
  );
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export const noBackup = async () => false;

export interface RetentionRunSeed {
  status?: string;
  createdAt: Date;
  resultJson?: Record<string, unknown> | null;
  finalizationVersion?: number;
  settledAt?: Date | null;
}

export async function startRetentionTestDb() {
  const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-output-retention-");
  const db: Db = createDb(tempDb.connectionString);
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: `Retention Co ${companyId.slice(0, 8)}`,
    issuePrefix: `RT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
  });
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Retention Agent",
    role: "engineer",
    status: "idle",
    adapterType: "claude_local",
    adapterConfig: { model: "claude-sonnet-4-6", command: "/usr/local/bin/claude", env: {} },
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
  });

  async function seedRun(overrides: RetentionRunSeed): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      status: overrides.status ?? "succeeded",
      createdAt: overrides.createdAt,
      finalizationVersion: overrides.finalizationVersion ?? 0,
      settledAt: overrides.settledAt ?? null,
      resultJson: overrides.resultJson === undefined ? null : overrides.resultJson,
      stdoutExcerpt: "excerpt stays",
    });
    return id;
  }

  async function fetchRun(id: string) {
    const row = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, id))
      .then((rows) => rows[0]);
    if (!row) throw new Error(`run ${id} not found`);
    return row;
  }

  return {
    db,
    companyId,
    agentId,
    seedRun,
    fetchRun,
    cleanup: () => tempDb.cleanup(),
  };
}

export type RetentionTestDb = Awaited<ReturnType<typeof startRetentionTestDb>>;
