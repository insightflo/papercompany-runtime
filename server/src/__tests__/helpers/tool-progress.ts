import { randomUUID } from "node:crypto";
import { companies, createDb, toolDefinitions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";

export const policy = {
  version: 1 as const, idleTimeoutMs: 2500, maxDurationMs: 10_000,
  stages: [{ key: "copy", unit: "items" as const }, { key: "encode", unit: "frames" as const }],
};
export const httpConfig = {
  url: "https://example.test/tool", method: "POST", timeoutMs: 120_000,
  auth: { type: "header", headerName: "Authorization", secretId: "fixture", version: "latest" },
  response: { resultField: "result" },
};
export async function progressDatabase() {
  const temp = await startEmbeddedPostgresTestDatabase("tool-progress-test-");
  const db = createDb(temp.connectionString);
  const reader = createDb(temp.connectionString);
  return { db, reader, cleanup: temp.cleanup };
}
export async function progressTool(db: ReturnType<typeof createDb>, adapterType = "builtin", adapterConfig = {}) {
  const [company] = await db.insert(companies).values({ name: "Progress fixture", issuePrefix: `P${randomUUID().slice(0, 7)}` }).returning();
  const [tool] = await db.insert(toolDefinitions).values({ companyId: company.id, name: "progress-fixture", adapterType, adapterConfig }).returning();
  return { companyId: company.id, toolId: tool.id, toolName: tool.name, requestId: randomUUID(), adapterType: adapterType as "builtin" | "http" };
}
export function event(executionId: string, sequence = 1, current = sequence) {
  return { version: 1 as const, executionId, sequence, stage: "copy", unit: "items" as const, current };
}
