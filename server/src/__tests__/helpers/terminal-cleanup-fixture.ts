import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import * as schema from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { runningProcesses } from "../../adapters/utils.js";

export async function terminalDatabase() {
  const require = createRequire(import.meta.url);
  const ormRequire = createRequire(require.resolve("drizzle-orm"));
  const dbRequire = createRequire(require.resolve("@paperclipai/db"));
  const { PGlite } = await import(ormRequire.resolve("@electric-sql/pglite"));
  const { generateDrizzleJson, generateMigration } = dbRequire("drizzle-kit/api");
  const client = new PGlite();
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
  // drizzle-kit 은 복합 UNIQUE INDEX(FK 대상)를 모든 ALTER TABLE 보다 나중에 내보내므로
  // PGlite 는 FK 추가 시 대상 인덱스를 찾지 못한다. 생성된 DDL 의 문 순서만 재배열한다:
  // 테이블·타입 생성 → 인덱스 DDL 전부 → 나머지(FK 등 ALTER) 순. 스키마/마이그레이션 변경 없음.
  const firstAlter = statements.findIndex((statement: string) => /^ALTER TABLE /i.test(statement.trim()));
  const isIndexDdl = (statement: string) => /^CREATE (UNIQUE )?INDEX /i.test(statement.trim());
  const ordered = firstAlter === -1 ? statements : [
    ...statements.slice(0, firstAlter).filter((statement: string) => !isIndexDdl(statement)),
    ...statements.filter(isIndexDdl),
    ...statements.slice(firstAlter).filter((statement: string) => !isIndexDdl(statement)),
  ];
  await client.exec(ordered.join(";\n"));
  return { db: drizzle(client, { schema }) as unknown as Db, close: () => client.close(), transactionOpen: () => client.isInTransaction() };
}

export async function seedTerminal(db: Db) {
  const [company] = await db.insert(schema.companies).values({ name: "Terminal", issuePrefix: randomUUID() }).returning();
  const [agent] = await db.insert(schema.agents).values({ companyId: company.id, name: "Worker", status: "running" }).returning();
  const [mission] = await db.insert(schema.missions).values({ companyId: company.id, ownerAgentId: agent.id, title: "Mission", status: "active" }).returning();
  const [issue] = await db.insert(schema.issues).values({ companyId: company.id, missionId: mission.id, title: "Work", status: "in_progress", assigneeAgentId: agent.id }).returning();
  const [heartbeat] = await db.insert(schema.heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, status: "running", processPid: 12345 }).returning();
  const [runtime] = await db.insert(schema.missionAgentRuntimes).values({ companyId: company.id, missionId: mission.id, agentId: agent.id,
    adapterType: "process", runtimeKey: randomUUID(), status: "busy", currentIssueId: issue.id, queueDepth: 3,
    stateJson: { bootstrapContextInjected: true, resumeRequestId: randomUUID(), workspaceKey: "keep" }, lastError: "keep error" }).returning();
  await db.insert(schema.agentRuntimeState).values({ agentId: agent.id, companyId: company.id, adapterType: "process", sessionId: "keep session", lastError: "keep error" });
  const now = new Date();
  const cancelHeartbeatRun = vi.fn(async () => undefined);
  const input = { companyId: company.id, missionId: mission.id, status: "completed" as const, now, completedAt: now,
    missionSnapshot: mission, pendingMissionUpdates: { status: "completed", updatedAt: now }, cancelHeartbeatRun };
  return { company, agent, mission, issue, heartbeat, runtime, input };
}

export function childEntry(pid = 12345, graceSec = 0) {
  const child = { pid, killed: false, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((_signal: NodeJS.Signals) => { child.killed = true; return true; }) };
  const entry = { child: child as unknown as ChildProcess, graceSec };
  return { child, entry };
}

export async function terminalState(db: Db) {
  const tables = [schema.missions, schema.issues, schema.heartbeatRuns, schema.agentWakeupRequests, schema.missionAgentRuntimes,
    schema.agents, schema.agentRuntimeState, schema.missionPlanArtifacts, schema.missionSessions, schema.activityLog];
  return Promise.all(tables.map(async (table) => (await db.select().from(table as typeof schema.missions))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
}

export async function readTerminal(db: Db, f: Awaited<ReturnType<typeof seedTerminal>>) {
  const [heartbeat] = await db.select().from(schema.heartbeatRuns).where(eq(schema.heartbeatRuns.id, f.heartbeat.id));
  const [mission] = await db.select().from(schema.missions).where(eq(schema.missions.id, f.mission.id));
  const [runtime] = await db.select().from(schema.missionAgentRuntimes).where(eq(schema.missionAgentRuntimes.id, f.runtime.id));
  return { heartbeat, mission, runtime };
}

export { schema, runningProcesses };
