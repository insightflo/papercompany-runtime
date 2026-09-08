import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./embedded-postgres.js";
import type { HttpError } from "../../errors.js";

/** drizzle postgres-js 클라이언트 그 자체(Db["$client"]). server 는 postgres 를 직접 의존하지 않는다. */
export type RawSql = Db["$client"];

/**
 * [목적] Task5a1 실행정의 스냅샷(workflow_run_definitions) 테스트 픽스처.
 *   실제 임베디드 PostgreSQL 위에서 company/agent/mission/definition/run 을 시딩하고
 *   여러 커넥션(concurrency 검증용)을 연다. mock DB/트랜잭션/정규화/해시 없음.
 */

export type ExecutionDefinitionFixtureDb = {
  connectionString: string;
  db: Db;
  sql: RawSql;
  openConnection(): Db;
  openRawConnection(): RawSql;
  cleanup(): Promise<void>;
};

export type ExecutionDefinitionFixture =
  | { supported: false; reason: string }
  | ({ supported: true } & ExecutionDefinitionFixtureDb);

export async function startExecutionDefinitionFixture(
  testName: string,
): Promise<ExecutionDefinitionFixture> {
  const support = await getEmbeddedPostgresTestSupport();
  if (!support.supported) {
    return { supported: false, reason: support.reason ?? "embedded Postgres unsupported" };
  }
  const tempDb = await startEmbeddedPostgresTestDatabase(testName);
  const db = createDb(tempDb.connectionString);
  const sql = db.$client;
  return {
    supported: true,
    connectionString: tempDb.connectionString,
    db,
    sql,
    openConnection: () => createDb(tempDb.connectionString),
    openRawConnection: () => createDb(tempDb.connectionString).$client,
    cleanup: async () => {
      await db.$client.end({ timeout: 5 }).catch(() => {});
      await sql.end().catch(() => {});
      await tempDb.cleanup();
    },
  };
}

export type SeededCompany = { companyId: string; agentId: string; missionId: string };

export async function seedCompanyWithMission(
  sql: RawSql,
  issuePrefix: string,
): Promise<SeededCompany> {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  await sql`
    INSERT INTO companies (id, name, issue_prefix)
    VALUES (${companyId}, ${"ExecDef Co " + issuePrefix}, ${issuePrefix})
  `;
  await sql`
    INSERT INTO agents (id, company_id, name)
    VALUES (${agentId}, ${companyId}, ${"ExecDef Owner " + issuePrefix})
  `;
  await sql`
    INSERT INTO missions (id, company_id, owner_agent_id, title)
    VALUES (${missionId}, ${companyId}, ${agentId}, ${"ExecDef Mission " + issuePrefix})
  `;
  return { companyId, agentId, missionId };
}

export async function seedCompanyOnly(sql: RawSql, issuePrefix: string): Promise<{ companyId: string }> {
  const companyId = randomUUID();
  await sql`
    INSERT INTO companies (id, name, issue_prefix)
    VALUES (${companyId}, ${"ExecDef Co " + issuePrefix}, ${issuePrefix})
  `;
  return { companyId };
}

export async function seedWorkflowDefinition(
  sql: RawSql,
  input: {
    companyId: string;
    name?: string;
    stepsJson?: unknown;
    executionMode?: string | null;
    dynamicPlanBootstrapOnly?: boolean;
    source?: string | null;
    sourceKind?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO workflow_definitions
      (id, company_id, name, steps_json, execution_mode, dynamic_plan_bootstrap_only, source, source_kind)
    VALUES (
      ${id}, ${input.companyId}, ${input.name ?? "execdef-workflow"},
      ${JSON.stringify(input.stepsJson ?? [])}, ${input.executionMode ?? null},
      ${input.dynamicPlanBootstrapOnly ?? false}, ${input.source ?? "native"}, ${input.sourceKind ?? "workflow"}
    )
  `;
  return id;
}

export async function seedWorkflowRun(
  sql: RawSql,
  input: {
    workflowId: string;
    companyId: string;
    missionId?: string | null;
    status?: string;
    metadata?: Record<string, unknown>;
    startedAt?: Date | null;
  },
): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO workflow_runs (id, workflow_id, company_id, mission_id, status, triggered_by, metadata, started_at)
    VALUES (
      ${id}, ${input.workflowId}, ${input.companyId}, ${input.missionId ?? null},
      ${input.status ?? "pending"}, 'task5a1', ${JSON.stringify(input.metadata ?? {})}, ${input.startedAt?.toISOString() ?? null}
    )
  `;
  return id;
}

/** 생략 없는 raw alias/unknown 필드를 포함한 정의 steps (JSON 보존 검증용). */
export function richDefinitionStepsJson(): Array<Record<string, unknown>> {
  return [
    {
      id: "fetch-source",
      name: "Fetch source",
      agentId: "",
      dependsOn: "",
      tools: ["web_search"],
      toolArgs: { query: "ai-news", options: { depth: 2, region: "KR" } },
      conditionGroup: { kind: "if", expression: "a == b" },
      legacyNote: "kept-as-is",
    },
    {
      id: "manual-onboarding-publish",
      name: "Publish onboarding hub",
      agentId: "agent-1",
      dependsOn: "fetch-source",
      contract: { deliverable: "hub-page" },
    },
  ];
}

export async function readSnapshotRow(
  sql: RawSql,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await sql`SELECT * FROM workflow_run_definitions WHERE workflow_run_id = ${runId}`;
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

export async function captureHttpError(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("Expected the promise to reject with HttpError");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const HASH_PATTERN = /^[0-9a-f]{64}$/u;
