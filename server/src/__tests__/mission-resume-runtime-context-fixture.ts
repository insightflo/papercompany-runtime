import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

// Use installed DB tooling/Drizzle's PGlite peer without changing dependency manifests.
// Real in-memory PostgreSQL, schema generated from the actual Drizzle tables (including constraints).
export async function runtimeContextFixture() {
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
  // Services use the common Drizzle PostgreSQL query/transaction API, not postgres-js internals.
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, close: () => client.close() };
}

export async function seedRuntimeContext(db: Db) {
  const [company] = await db.insert(schema.companies).values({ name: "Runtime context", issuePrefix: randomUUID() }).returning();
  const [agent] = await db.insert(schema.agents).values({ companyId: company.id, name: "Worker", adapterType: "process" }).returning();
  const [mission] = await db.insert(schema.missions).values({ companyId: company.id, ownerAgentId: agent.id, title: "Resume", status: "active" }).returning();
  const [definition] = await db.insert(schema.workflowDefinitions).values({ companyId: company.id, name: "Runtime", stepsJson: [] }).returning();
  const [run] = await db.insert(schema.workflowRuns).values({ companyId: company.id, missionId: mission.id, workflowId: definition.id, triggeredBy: "manual", status: "running" }).returning();
  const [issue] = await db.insert(schema.issues).values({ companyId: company.id, missionId: mission.id, title: "Work", assigneeAgentId: agent.id }).returning();
  const [step] = await db.insert(schema.workflowStepRuns).values({ workflowRunId: run.id, stepId: "work", issueId: issue.id, executionGeneration: 1 }).returning();
  const [heartbeat] = await db.insert(schema.heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, status: "running", workflowStepRunId: step.id, workflowExecutionGeneration: 1 }).returning();
  const input = {
    companyId: company.id, missionId: mission.id, agentId: agent.id, adapterType: "process",
    workspaceId: randomUUID(), workspaceKey: "/physical/workspace|with:delimiters",
    currentIssueId: issue.id, runId: heartbeat.id, resolvedConfig: { missionRuntimePersistent: true },
    missionSessionId: "stale-pre-resume-session",
  };
  async function resume() {
    const [request] = await db.insert(schema.workflowResumeRequests).values({
      companyId: company.id, missionId: mission.id, workflowRunId: run.id, idempotencyKey: randomUUID(),
      requestHash: "request", snapshotHash: "snapshot", definitionHash: "definition", requestBody: {},
      beforeState: {}, appliedGenerations: { work: 1 }, state: "accepted",
    }).returning();
    await db.update(schema.workflowRuns).set({ metadata: { resumeRequestId: request.id } }).where(eq(schema.workflowRuns.id, run.id));
    await db.update(schema.workflowStepRuns).set({ metadata: { resumeRequestId: request.id } }).where(eq(schema.workflowStepRuns.id, step.id));
    return request.id;
  }
  const rows = () => db.select().from(schema.missionAgentRuntimes).where(eq(schema.missionAgentRuntimes.missionId, mission.id)).orderBy(schema.missionAgentRuntimes.id);
  const lifecycle = (resumeRequestId: string) => ({ companyId: company.id, missionId: mission.id, workflowRunId: run.id, resumeRequestId });
  return { input, run, step, heartbeat, resume, rows, lifecycle };
}
