import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./embedded-postgres.js";

export async function createBoundedReadsTestDb(prefix: string) {
  const tempDb = await startEmbeddedPostgresTestDatabase(prefix);
  const db = createDb(tempDb.connectionString);
  const companyId = await freshCompany(db);
  return { db, tempDb, companyId };
}

export async function freshCompany(db: ReturnType<typeof createDb>) {
  const id = randomUUID();
  await db.insert(companies).values({
    id,
    name: `Co-${id.slice(0, 4)}`,
    status: "active",
    issuePrefix: `C${id.slice(0, 8).toUpperCase()}`,
  });
  return id;
}

export async function freshAgent(db: ReturnType<typeof createDb>, companyId: string) {
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: `agent-${agentId.slice(0, 4)}`,
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  return agentId;
}

export async function seedRun(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
  status: string,
  createdAt: Date,
  overrides: Record<string, unknown> = {},
) {
  const id = randomUUID();
  const issueId = (overrides.issueId as string | undefined) ?? null;
  await db.insert(heartbeatRuns).values({
    id,
    companyId,
    agentId,
    invocationSource: "on_demand",
    status,
    createdAt,
    updatedAt: createdAt,
    issueId,
    contextSnapshot: overrides.contextSnapshot ?? null,
    resultJson: overrides.resultJson ?? null,
    ...overrides,
  } as never);
  return id;
}

export async function seedOpenIssue(
  db: ReturnType<typeof createDb>,
  companyId: string,
  overrides: Record<string, unknown> = {},
) {
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Open issue",
    status: "in_progress",
    priority: "medium",
    issueNumber: 1,
    identifier: `BND-${issueId.slice(0, 4).toUpperCase()}`,
    requestDepth: 0,
    ...overrides,
  } as never);
  return issueId;
}

export async function seedResolvedIssue(
  db: ReturnType<typeof createDb>,
  companyId: string,
  overrides: Record<string, unknown> = {},
) {
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Resolved issue",
    status: "done",
    priority: "medium",
    issueNumber: 1,
    identifier: `BND-${issueId.slice(0, 4).toUpperCase()}`,
    requestDepth: 0,
    ...overrides,
  } as never);
  return issueId;
}

export const getEmbeddedPostgresSupport = () => getEmbeddedPostgresTestSupport();
