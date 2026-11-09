// engine-contract 공용 헬퍼 — 인프라(embedded PG)·조회·점유 판정 + seeds.ts 재수출.
// 원칙: 시드는 순수 DB insert 만, 검증은 최종 DB 행만. 서비스 내부 헬퍼/클로저를 import 하지 않는다.
// 점유(lifecycle-active) 판정은 서비스 코드가 아니라 이 파일의 SQL 문(predicate)으로 기술한다 —
// 엔진이 바뀌어도 같은 최종 상태 계약을 검증하기 위함이다.
import { randomUUID } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import { describe } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  workflowRuns,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../helpers/embedded-postgres.js";

export * from "./seeds.js";

const support = await getEmbeddedPostgresTestSupport();
export const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skip engine-contract tests: ${support.reason ?? "embedded-postgres unsupported"}`);
}

export const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;

export interface ContractDb {
  db: Db;
  companyId: string;
  agentId: string;
  temp: EmbeddedPostgresTestDatabase;
}

export interface ContractDbFlags {
  finalizationV1?: boolean;
  runTerminalBoundaryV1?: boolean;
}

export async function startContractDb(prefix: string, flags: ContractDbFlags = {}): Promise<ContractDb> {
  const temp = await startEmbeddedPostgresTestDatabase(prefix);
  const db = createDb(temp.connectionString);
  const companyId = randomUUID();
  const agentId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: `Contract Co ${companyId.slice(0, 8)}`,
    status: "active",
    issuePrefix: `EC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Contract Agent",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  const experimental: Record<string, unknown> = {};
  if (flags.finalizationV1) experimental.enableHeartbeatFinalizationV1 = true;
  if (flags.runTerminalBoundaryV1) experimental.enableRunTerminalBoundaryV1 = true;
  await db.insert(instanceSettings).values({
    singletonKey: "default",
    general: {},
    experimental,
  } as never);
  return { db, companyId, agentId, temp };
}

export async function fetchHeartbeatRun(db: Db, id: string) {
  const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
  return row;
}

export async function fetchWorkflowRun(db: Db, id: string) {
  const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
  return row;
}

export async function fetchStepRun(db: Db, id: string) {
  const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id));
  return row;
}

export async function fetchAgent(db: Db, id: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  return row;
}

/**
 * lifecycle-active 점유 판정 — 서비스 구현과 무관하게 최종 상태 계약으로 기술한다.
 * v1: status='running' 이거나 terminal 이면서 finalization_version=1 이고 settled_at IS NULL.
 * flag OFF(레거시): status='running' 만.
 */
export async function occupiedRunCount(db: Db, agentId: string, v1 = true): Promise<number> {
  const clause = v1
    ? sql`(${heartbeatRuns.status} = 'running' OR (${heartbeatRuns.status} IN ('succeeded','failed','cancelled','timed_out') AND ${heartbeatRuns.finalizationVersion} = 1 AND ${heartbeatRuns.settledAt} IS NULL))`
    : sql`${heartbeatRuns.status} = 'running'`;
  const [row] = await db
    .select({ n: count() })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agentId), clause));
  return Number(row?.n ?? 0);
}
